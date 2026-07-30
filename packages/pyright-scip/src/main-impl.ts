import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { scip } from './scip';
import { diffSnapshot, formatSnapshot, writeSnapshot } from './lib';
import { Input } from './lsif-typescript/Input';
import { join } from 'path';
import { IndexOptions, SnapshotOptions, mainCommand } from './MainCommand';
import { detect, detectAction, FlatProjectNode } from './detectCommand';
import { sendStatus, setQuiet, setShowProgressRateLimit } from './status';
import { Indexer } from './indexer';
import { mergeShardIndexes, resolveShardCount, resolveShardHeapCap, ShardResult } from './sharding';
import { exit } from 'process';

function findProjectNodeByName(nodes: FlatProjectNode[], name: string): FlatProjectNode | undefined {
    const normalized = name.toLowerCase().replace(/[_.-]+/g, '-');
    return nodes.find((n) => n.name === normalized);
}

function collectAllNodes(workspaces: ReturnType<typeof detect>['workspaces']): FlatProjectNode[] {
    return workspaces.flatMap((ws) => ws.projects);
}

export function applyFilterToOptions(options: IndexOptions, repoRoot: string): void {
    const topology = detect(repoRoot);
    const allNodes = collectAllNodes(topology.workspaces);
    const target = findProjectNodeByName(allNodes, options.filter!);
    if (!target) {
        throw new Error(`Package "${options.filter}" not found in workspace topology at ${repoRoot}`);
    }

    const ancestor = allNodes.find((n) => n.path !== target.path && target.path.startsWith(n.path === '.' ? '' : n.path + '/'));
    const siblingNodes = allNodes.filter((n) => n.path !== target.path && n !== ancestor);

    const siblingAbsPaths = siblingNodes
        .map((n) => {
            const abs = path.resolve(repoRoot, n.path);
            const srcDir = path.join(abs, 'src');
            return fs.existsSync(srcDir) ? srcDir : abs;
        });

    options.siblingPackages = siblingNodes
        .map((n) => {
            const abs = path.resolve(repoRoot, n.path);
            const srcDir = path.join(abs, 'src');
            return { name: n.name, srcPath: fs.existsSync(srcDir) ? srcDir : abs };
        });
    options.workspaceRoot = path.resolve(repoRoot, ancestor ? ancestor.path : '.');

    const targetAbs = path.resolve(repoRoot, target.path);
    const targetSrc = path.join(targetAbs, 'src');
    const targetRoot = fs.existsSync(targetSrc) ? targetSrc : targetAbs;
    options.targetOnly = targetAbs;
    options.targetSourceRoot = targetRoot;
    options.extraPaths = [targetRoot, ...siblingAbsPaths, ...(options.extraPaths ?? [])];
}

function runSingleThreaded(options: IndexOptions, outputFile: string): void {
    const projectRoot = options.cwd;
    const environment = options.environment;
    const output = fs.openSync(outputFile, 'w');

    let indexer: Indexer;
    try {
        indexer = new Indexer({
            ...options,
            projectRoot,
            environment,
            infer: options.infer ?? { projectVersionFromCommit: true },
            writeIndex: (partialIndex: scip.Index): void => {
                fs.writeSync(output, partialIndex.serializeBinary());
            },
        });

        sendStatus(`Indexing ${projectRoot} with version ${indexer.scipConfig.projectVersion}`);
        indexer.index();
    } catch (e) {
        fs.closeSync(output);
        throw e;
    }

    fs.closeSync(output);

    // Shard child: record the emit accounting for the orchestrator's cross-shard loud-partial guard.
    if (options.shardResultPath) {
        const result: ShardResult = {
            total: indexer.totalProjectFiles,
            assigned: indexer.shardFiles.size,
            emitted: indexer.emittedDocuments,
            empty: indexer.emptyDocuments,
            skipped: indexer.skippedFiles,
        };
        fs.writeFileSync(options.shardResultPath, JSON.stringify(result));
    }
}

export function indexAction(options: IndexOptions): void {
    setQuiet(options.quiet);
    if (options.showProgressRateLimit !== undefined) {
        setShowProgressRateLimit(options.showProgressRateLimit);
    }

    options.cwd = path.resolve(options.cwd);
    const projectRoot = options.cwd;

    // Sharded parallel indexing (BE-2766). A shard child (shardCount > 1) runs the single-process path
    // below over its slice and never re-shards. Otherwise, if the effective shard count is > 1, this
    // process is the orchestrator: it spawns k shard children and merges their outputs. k=1 / the
    // SCIP_DISABLE_SHARDING kill-switch fall through to the untouched single-process path, which keeps
    // the sequential fallback byte-identical to a current-main build.
    const isShardChild = (options.shardCount ?? 1) > 1;
    if (!isShardChild) {
        const shards = resolveShardCount(options.shards);
        if (shards > 1) {
            runShardedOrchestrator(options, shards);
            return;
        }
    }

    if (options.filter) {
        applyFilterToOptions(options, projectRoot);
    }

    const originalWorkdir = process.cwd();
    process.chdir(projectRoot);

    const outputFile = path.isAbsolute(options.output) ? options.output : path.join(projectRoot, options.output);

    try {
        runSingleThreaded(options, outputFile);
    } catch (e) {
        console.warn(
            '\n\nExperienced Fatal Error While Indexing:\nPlease create an issue at github.com/sourcegraph/scip-python:',
            e
        );
        process.chdir(originalWorkdir);
        exit(1);
    }

    process.chdir(originalWorkdir);
}

/**
 * Build the argv for a shard child: the same `index` invocation as the orchestrator received, plus the
 * shard coordinates and a per-shard output/result path, minus `--shards` (a child never re-shards).
 * Filter-derived options are intentionally NOT forwarded — the child re-derives them from `--filter` so
 * it behaves exactly like a normal invocation restricted to its slice.
 */
function buildShardArgs(
    options: IndexOptions,
    scriptPath: string,
    heapCapMb: number,
    shardIndex: number,
    shardCount: number,
    shardOutput: string,
    shardResult: string
): string[] {
    const args: string[] = [`--max-old-space-size=${heapCapMb}`, scriptPath, 'index', options.cwd];
    args.push('--output', shardOutput);
    args.push('--shard-index', String(shardIndex));
    args.push('--shard-count', String(shardCount));
    args.push('--shard-result', shardResult);
    args.push('--project-name', options.projectName ?? '');
    if (options.projectVersion) args.push('--project-version', options.projectVersion);
    if (options.projectNamespace) args.push('--project-namespace', options.projectNamespace);
    if (options.filter) args.push('--filter', options.filter);
    if (options.targetOnly) args.push('--target-only', options.targetOnly);
    if (options.environment) args.push('--environment', options.environment);
    if (options.extraPaths && options.extraPaths.length > 0) {
        args.push('--extra-types-path', ...options.extraPaths);
    }
    if (options.dev) args.push('--dev');
    if (options.quiet) args.push('--quiet');
    if (options.showProgressRateLimit !== undefined) {
        args.push('--show-progress-rate-limit', String(options.showProgressRateLimit));
    }
    return args;
}

/**
 * Orchestrate k parallel shard processes and merge their outputs (BE-2766). Each child indexes its
 * deterministic slice of the discovered file set under a budgeted node heap cap (BE-2761 smoothing stays
 * on, so the total resident set is Σ shard peaks, not k × full-heap). Loud-partial guard across shards:
 * any shard non-zero exit fails loudly; the shard result summaries must agree on the discovered total,
 * cover it exactly (Σ assigned == total), report zero skipped files, and the merged document count must
 * equal Σ emitted — any shortfall is a non-zero exit with no silent partial.
 */
function runShardedOrchestrator(options: IndexOptions, shardCount: number): void {
    const projectRoot = options.cwd;
    const outputFile = path.isAbsolute(options.output) ? options.output : path.join(projectRoot, options.output);
    const scriptPath = require.main?.filename ?? process.argv[1];
    const heapCapMb = resolveShardHeapCap(shardCount);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-shards-'));
    const shardOutputs: string[] = [];
    const shardResults: string[] = [];
    const shardLogs: string[] = [];
    for (let i = 0; i < shardCount; i++) {
        shardOutputs.push(path.join(tmpDir, `shard-${i}.scip`));
        shardResults.push(path.join(tmpDir, `shard-${i}.result.json`));
        shardLogs.push(path.join(tmpDir, `shard-${i}.log`));
    }

    const cleanup = () => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
    };

    sendStatus(
        `Sharded indexing: ${shardCount} shards, per-shard heap cap ${heapCapMb} MB (total budget ~${
            heapCapMb * shardCount
        } MB ceiling; BE-2761 smoothing bounds each shard well below its cap)`
    );

    const exitCodes: (number | null)[] = new Array(shardCount).fill(undefined);
    const spawnErrors: (Error | undefined)[] = new Array(shardCount).fill(undefined);
    const settled: boolean[] = new Array(shardCount).fill(false);
    let remaining = shardCount;

    const settle = (idx: number) => {
        if (settled[idx]) {
            return;
        }
        settled[idx] = true;
        if (--remaining === 0) {
            finalize();
        }
    };

    const finalize = () => {
        const failed: number[] = [];
        for (let i = 0; i < shardCount; i++) {
            if (spawnErrors[i] || exitCodes[i] !== 0) {
                failed.push(i);
            }
        }
        if (failed.length > 0) {
            for (const i of failed) {
                console.error(
                    `\n[scip-python] index: shard ${i}/${shardCount} FAILED (exit=${exitCodes[i]}${
                        spawnErrors[i] ? `, error=${spawnErrors[i]!.message}` : ''
                    }). Shard log tail:`
                );
                try {
                    const log = fs.readFileSync(shardLogs[i], 'utf8');
                    console.error(log.split('\n').slice(-25).join('\n'));
                } catch (_) {}
            }
            console.error(`\n[scip-python] index: aborting with non-zero exit — no partial index written.`);
            cleanup();
            exit(1);
        }

        // Read shard result summaries and enforce the cross-shard loud-partial guard.
        const results: ShardResult[] = [];
        for (let i = 0; i < shardCount; i++) {
            try {
                results.push(JSON.parse(fs.readFileSync(shardResults[i], 'utf8')) as ShardResult);
            } catch (e) {
                console.error(`\n[scip-python] index: shard ${i} produced no result summary — aborting.`);
                cleanup();
                exit(1);
            }
        }
        const total = results[0].total;
        const totalsAgree = results.every((r) => r.total === total);
        const assignedSum = results.reduce((a, r) => a + r.assigned, 0);
        const emittedSum = results.reduce((a, r) => a + r.emitted, 0);
        const emptySum = results.reduce((a, r) => a + r.empty, 0);
        const skippedSum = results.reduce((a, r) => a + r.skipped, 0);

        if (!totalsAgree || assignedSum !== total || skippedSum !== 0) {
            console.error(
                `\n[scip-python] index: cross-shard guard FAILED — total=${total} totalsAgree=${totalsAgree} ` +
                    `assignedSum=${assignedSum} emittedSum=${emittedSum} emptySum=${emptySum} skippedSum=${skippedSum}. ` +
                    `A file was dropped or skipped across shards — aborting with non-zero exit.`
            );
            cleanup();
            exit(1);
        }

        // Merge shard outputs into the final index.
        const output = fs.openSync(outputFile, 'w');
        let merged: { documents: number; externalSymbols: number };
        try {
            merged = mergeShardIndexes(shardOutputs, (partialIndex: scip.Index): void => {
                fs.writeSync(output, partialIndex.serializeBinary());
            });
        } catch (e) {
            fs.closeSync(output);
            console.error(`\n[scip-python] index: shard merge failed — aborting.`, e);
            cleanup();
            exit(1);
        }
        fs.closeSync(output);

        if (merged.documents !== emittedSum) {
            console.error(
                `\n[scip-python] index: merged document count ${merged.documents} != summed shard emit ${emittedSum} — aborting.`
            );
            cleanup();
            exit(1);
        }

        sendStatus(
            `Sharded index complete: ${merged.documents} documents (of ${total} project files; ${emptySum} empty, ` +
                `0 skipped), ${merged.externalSymbols} external symbols. Wrote SCIP index to ${outputFile}`
        );
        cleanup();
        exit(0);
    };

    for (let i = 0; i < shardCount; i++) {
        const logFd = fs.openSync(shardLogs[i], 'w');
        const args = buildShardArgs(options, scriptPath, heapCapMb, i, shardCount, shardOutputs[i], shardResults[i]);
        try {
            const child = child_process.spawn(process.execPath, args, {
                cwd: projectRoot,
                stdio: ['ignore', logFd, logFd],
            });
            const idx = i;
            child.on('exit', (code) => {
                exitCodes[idx] = code;
                try {
                    fs.closeSync(logFd);
                } catch (_) {}
                settle(idx);
            });
            child.on('error', (err) => {
                spawnErrors[idx] = err;
                exitCodes[idx] = exitCodes[idx] ?? -1;
                try {
                    fs.closeSync(logFd);
                } catch (_) {}
                settle(idx);
            });
        } catch (err) {
            spawnErrors[i] = err instanceof Error ? err : new Error(String(err));
            exitCodes[i] = -1;
            try {
                fs.closeSync(logFd);
            } catch (_) {}
            settle(i);
        }
    }
}

function snapshotAction(snapshotRoot: string, options: SnapshotOptions): void {
    const subdir: string = options.only;
    const inputDirectory = path.resolve(join(snapshotRoot, 'input'));
    const outputDirectory = path.resolve(join(snapshotRoot, 'output'));

    let snapshotDirectories = fs.readdirSync(inputDirectory);
    if (subdir) {
        console.assert(snapshotDirectories.find((val) => val === subdir) !== undefined);
        snapshotDirectories = [subdir];
    }

    for (const snapshotDir of snapshotDirectories) {
        let projectRoot = join(inputDirectory, snapshotDir);
        console.assert(fs.lstatSync(projectRoot).isDirectory());
        console.log(`Output path = ${options.output}`);

        runSingleThreaded({
            projectName: options.projectName,
            projectVersion: options.projectVersion,
            projectNamespace: options.projectNamespace,
            environment: options.environment ? path.resolve(options.environment) : undefined,
            dev: options.dev,
            output: path.join(projectRoot, options.output),
            cwd: projectRoot,
            targetOnly: options.targetOnly,
            infer: { projectVersionFromCommit: false },
            quiet: options.quiet,
            showProgressRateLimit: undefined,
        }, path.join(projectRoot, options.output));

        const scipIndexPath = path.join(projectRoot, options.output);
        const scipIndex = scip.Index.deserializeBinary(fs.readFileSync(scipIndexPath));

        let hasDiff = false;
        for (const doc of scipIndex.documents) {
            if (doc.relative_path.startsWith('..')) {
                continue;
            }

            const inputPath = path.join(projectRoot, doc.relative_path);
            const input = Input.fromFile(inputPath);
            const obtained = formatSnapshot(input, doc, scipIndex.external_symbols);
            const relativeToInputDirectory = path.relative(projectRoot, inputPath);
            const outputPath = path.resolve(outputDirectory, snapshotDir, relativeToInputDirectory);

            if (options.check) {
                const diffResult = diffSnapshot(outputPath, obtained);
                hasDiff = hasDiff || diffResult === 'different';
            } else {
                writeSnapshot(outputPath, obtained);
            }
        }
        if (hasDiff) {
            exit(1);
        }
    }
}

export function main(argv: string[]): void {
    const command = mainCommand(
        indexAction,
        snapshotAction,
        (_) => {
            throw 'not yet implemented';
        },
        detectAction
    );
    command.parse(argv);
}
