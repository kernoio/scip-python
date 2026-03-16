import * as fs from 'fs';
import * as path from 'path';

import { scip } from './scip';
import { diffSnapshot, formatSnapshot, writeSnapshot } from './lib';
import { Input } from './lsif-typescript/Input';
import { join } from 'path';
import { IndexOptions, SnapshotOptions, mainCommand } from './MainCommand';
import { detect, detectAction, ProjectNode } from './detectCommand';
import { sendStatus, setQuiet, setShowProgressRateLimit } from './status';
import { Indexer } from './indexer';
import { exit } from 'process';

function findProjectNodeByName(nodes: ProjectNode[], name: string): ProjectNode | undefined {
    const normalized = name.toLowerCase().replace(/[_.-]+/g, '-');
    for (const node of nodes) {
        if (node.name === normalized) {
            return node;
        }
        if (node.subProjects) {
            const found = findProjectNodeByName(node.subProjects, name);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

function collectAllProjectPaths(nodes: ProjectNode[]): string[] {
    const paths: string[] = [];
    for (const node of nodes) {
        paths.push(node.path);
        if (node.subProjects) {
            paths.push(...collectAllProjectPaths(node.subProjects));
        }
    }
    return paths;
}

function collectAllNodes(nodes: ProjectNode[]): ProjectNode[] {
    const result: ProjectNode[] = [];
    for (const node of nodes) {
        result.push(node);
        if (node.subProjects) {
            result.push(...collectAllNodes(node.subProjects));
        }
    }
    return result;
}

export function applyFilterToOptions(options: IndexOptions, repoRoot: string): void {
    const topology = detect(repoRoot);
    const target = findProjectNodeByName(topology.projects, options.filter!);
    if (!target) {
        throw new Error(`Package "${options.filter}" not found in workspace topology at ${repoRoot}`);
    }

    const allNodes = collectAllNodes(topology.projects);
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
    options.extraPaths = [targetRoot, ...siblingAbsPaths];
}

function runSingleThreaded(options: IndexOptions, outputFile: string): void {
    const projectRoot = options.cwd;
    const environment = options.environment;
    const output = fs.openSync(outputFile, 'w');

    try {
        const indexer = new Indexer({
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
}

export function indexAction(options: IndexOptions): void {
    setQuiet(options.quiet);
    if (options.showProgressRateLimit !== undefined) {
        setShowProgressRateLimit(options.showProgressRateLimit);
    }

    options.cwd = path.resolve(options.cwd);
    const projectRoot = options.cwd;

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
