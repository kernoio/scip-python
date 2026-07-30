import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { scip } from './scip';
import { mergeShardIndexes, partitionFiles, resolveShardCount, resolveShardHeapCap } from './sharding';

const pyrightScipDir = path.resolve(__dirname, '..');
const indexJs = path.join(pyrightScipDir, 'index.js');

// ---------------------------------------------------------------------------
// Pure unit tests (no subprocess) — partition, config resolution, merge/dedup.
// ---------------------------------------------------------------------------

describe('partitionFiles', () => {
    const files = ['a/one.py', 'a/two.py', 'a/three.py', 'b/one.py', 'b/two.py', 'c/only.py', 'd/x.py', 'd/y.py'];
    const dirKey = (f: string) => path.dirname(f);

    test('k=1 returns the whole sorted set', () => {
        const shards = partitionFiles(files, 1, dirKey);
        expect(shards).toHaveLength(1);
        expect(shards[0]).toEqual([...files].sort());
    });

    test('partition is complete and disjoint for k in {2,3,4}', () => {
        for (const k of [2, 3, 4]) {
            const shards = partitionFiles(files, k, dirKey);
            expect(shards).toHaveLength(k);
            const union = shards.flat().sort();
            expect(union).toEqual([...files].sort());
            // disjoint: no file appears twice.
            const seen = new Set<string>();
            for (const f of shards.flat()) {
                expect(seen.has(f)).toBe(false);
                seen.add(f);
            }
        }
    });

    test('keeps files that share a directory in the same shard (package coherence)', () => {
        const shards = partitionFiles(files, 4, dirKey);
        for (const dir of ['a', 'b', 'c', 'd']) {
            const owningShards = shards.filter((s) => s.some((f) => path.dirname(f) === dir));
            expect(owningShards).toHaveLength(1);
        }
    });

    test('is deterministic — identical output across repeated and reordered input', () => {
        const a = partitionFiles(files, 3, dirKey);
        const b = partitionFiles([...files].reverse(), 3, dirKey);
        expect(b).toEqual(a);
    });

    test('balances shards by file count (LPT)', () => {
        const shards = partitionFiles(files, 2, dirKey);
        const sizes = shards.map((s) => s.length).sort((x, y) => x - y);
        // 8 files across 4 dirs of sizes {3,2,2,1} → balanced 4/4.
        expect(sizes[1] - sizes[0]).toBeLessThanOrEqual(1);
    });
});

describe('resolveShardCount', () => {
    test('defaults to 1 (single-process fallback)', () => {
        expect(resolveShardCount(undefined, {})).toBe(1);
    });
    test('--shards wins over env', () => {
        expect(resolveShardCount(4, { SCIP_SHARDS: '2' })).toBe(4);
    });
    test('SCIP_SHARDS applies when option absent', () => {
        expect(resolveShardCount(undefined, { SCIP_SHARDS: '8' })).toBe(8);
    });
    test('SCIP_DISABLE_SHARDING is the kill-switch (forces 1)', () => {
        expect(resolveShardCount(8, { SCIP_DISABLE_SHARDING: '1', SCIP_SHARDS: '4' })).toBe(1);
    });
    test('non-positive / garbage resolves to 1', () => {
        expect(resolveShardCount(0, {})).toBe(1);
        expect(resolveShardCount(-3, {})).toBe(1);
        expect(resolveShardCount(undefined, { SCIP_SHARDS: 'nope' })).toBe(1);
    });
});

describe('resolveShardHeapCap', () => {
    test('k=2 fits the ~4GB total posture (2 x 2048), NOT k x 4096', () => {
        expect(resolveShardHeapCap(2, {})).toBe(2048);
    });
    test('floors at 2048 MB so a posthog-scale shard has GC headroom and completes reliably', () => {
        // Memory does not divide by k for a dense import closure, so the per-shard floor holds.
        expect(resolveShardHeapCap(4, {})).toBe(2048);
        expect(resolveShardHeapCap(8, {})).toBe(2048);
    });
    test('SCIP_SHARD_MAX_OLD_SPACE overrides', () => {
        expect(resolveShardHeapCap(4, { SCIP_SHARD_MAX_OLD_SPACE: '3000' })).toBe(3000);
    });
});

describe('mergeShardIndexes', () => {
    // Build a shard `.scip` the way a real shard writes it: metadata, then documents, then external
    // symbols, each an appended serialized scip.Index message.
    function writeShard(
        file: string,
        opts: {
            metadata?: boolean;
            docs?: { path: string; defs?: string[]; refs?: string[] }[];
            external?: string[];
        }
    ): void {
        const chunks: Buffer[] = [];
        if (opts.metadata) {
            chunks.push(
                Buffer.from(
                    new scip.Index({
                        metadata: new scip.Metadata({
                            project_root: 'file:///repo',
                            tool_info: new scip.ToolInfo({ name: 'scip-python', version: 'test', arguments: [] }),
                        }),
                    }).serializeBinary()
                )
            );
        }
        if (opts.docs && opts.docs.length > 0) {
            const documents = opts.docs.map(
                (d) =>
                    new scip.Document({
                        relative_path: d.path,
                        occurrences: [
                            ...(d.defs ?? []).map(
                                (s) =>
                                    new scip.Occurrence({
                                        symbol: s,
                                        symbol_roles: scip.SymbolRole.Definition,
                                        range: [0, 0, 1],
                                    })
                            ),
                            ...(d.refs ?? []).map(
                                (s) => new scip.Occurrence({ symbol: s, symbol_roles: 0, range: [1, 0, 1] })
                            ),
                        ],
                    })
            );
            chunks.push(Buffer.from(new scip.Index({ documents }).serializeBinary()));
        }
        if (opts.external && opts.external.length > 0) {
            const idx = new scip.Index();
            idx.external_symbols = opts.external.map((s) => new scip.SymbolInformation({ symbol: s }));
            chunks.push(Buffer.from(idx.serializeBinary()));
        }
        fs.writeFileSync(file, Buffer.concat(chunks));
    }

    let tmpDir: string;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-merge-test-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('concatenates documents from all shards and writes one metadata', () => {
        const s0 = path.join(tmpDir, 's0.scip');
        const s1 = path.join(tmpDir, 's1.scip');
        writeShard(s0, { metadata: true, docs: [{ path: 'a/x.py', defs: ['A#'] }] });
        writeShard(s1, { metadata: true, docs: [{ path: 'b/y.py', defs: ['B#'] }] });

        const out = path.join(tmpDir, 'out.scip');
        const fd = fs.openSync(out, 'w');
        const stats = mergeShardIndexes([s0, s1], (idx) => fs.writeSync(fd, idx.serializeBinary()));
        fs.closeSync(fd);

        expect(stats.documents).toBe(2);
        const merged = scip.Index.deserializeBinary(fs.readFileSync(out));
        expect(merged.documents.map((d) => d.relative_path).sort()).toEqual(['a/x.py', 'b/y.py']);
        expect(merged.has_metadata).toBe(true);
        expect(merged.metadata.tool_info.version).toBe('test');
    });

    test('deduplicates external_symbols across shards', () => {
        const s0 = path.join(tmpDir, 's0.scip');
        const s1 = path.join(tmpDir, 's1.scip');
        writeShard(s0, { metadata: true, docs: [{ path: 'a/x.py' }], external: ['ext.Foo#', 'ext.Bar#'] });
        writeShard(s1, { metadata: true, docs: [{ path: 'b/y.py' }], external: ['ext.Bar#', 'ext.Baz#'] });

        const out = path.join(tmpDir, 'out.scip');
        const fd = fs.openSync(out, 'w');
        const stats = mergeShardIndexes([s0, s1], (idx) => fs.writeSync(fd, idx.serializeBinary()));
        fs.closeSync(fd);

        expect(stats.externalSymbols).toBe(3);
        const merged = scip.Index.deserializeBinary(fs.readFileSync(out));
        expect(merged.external_symbols.map((s) => s.symbol).sort()).toEqual(['ext.Bar#', 'ext.Baz#', 'ext.Foo#']);
    });

    test('drops an external symbol that is defined by a document in another shard (cross-shard ref)', () => {
        // Shard 0 references `proj.User#` (recorded as external because its defining file lives in shard
        // 1); shard 1 defines `proj.User#` in its document. The merge must NOT keep it in external_symbols.
        const s0 = path.join(tmpDir, 's0.scip');
        const s1 = path.join(tmpDir, 's1.scip');
        writeShard(s0, {
            metadata: true,
            docs: [{ path: 'api/v.py', refs: ['proj.User#'] }],
            external: ['proj.User#'],
        });
        writeShard(s1, { metadata: true, docs: [{ path: 'core/m.py', defs: ['proj.User#'] }] });

        const out = path.join(tmpDir, 'out.scip');
        const fd = fs.openSync(out, 'w');
        const stats = mergeShardIndexes([s0, s1], (idx) => fs.writeSync(fd, idx.serializeBinary()));
        fs.closeSync(fd);

        expect(stats.externalSymbols).toBe(0);
        const merged = scip.Index.deserializeBinary(fs.readFileSync(out));
        expect(merged.external_symbols).toHaveLength(0);
        // The definition survives as a document symbol; the reference resolves to the same global string.
        expect(merged.documents.flatMap((d) => d.occurrences.map((o) => o.symbol))).toContain('proj.User#');
    });
});

// ---------------------------------------------------------------------------
// Integration tests (spawn the built index.js). Self-contained temp corpus so
// no fixture venv / network is required — all symbols are repository-local.
// ---------------------------------------------------------------------------

function makeCorpus(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-shard-corpus-'));
    const write = (rel: string, body: string) => {
        const p = path.join(root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body);
    };
    write('proj/__init__.py', 'VERSION = "1.0"\n');
    write('proj/core/__init__.py', '');
    write('proj/core/models.py', 'class User:\n    def __init__(self, name: str):\n        self.name = name\n');
    write('proj/core/config.py', 'DEFAULT_LIMIT = 10\n\n\ndef make_config():\n    return {"limit": DEFAULT_LIMIT}\n');
    write('proj/api/__init__.py', '');
    write(
        'proj/api/views.py',
        'from proj.core.models import User\nfrom proj.core.config import make_config\n\n\ndef get_user(name: str) -> User:\n    make_config()\n    return User(name)\n'
    );
    write('proj/util/__init__.py', '');
    write('proj/util/helpers.py', 'def helper(value):\n    return value + 1\n');
    return root;
}

// A workspace with TWO top-level project packages (`app`, `lib`) where `app` imports from `lib`.
// The dir-partition splits `app/` and `lib/` into different shards at k=2, so a shard computing its
// project-module-prefix set from only its slice (the pre-fix bug) would misclassify the cross-package
// reference's symbol scheme. This is the exact shape that regressed in review (BE-2766 finding #1).
function makeMultiPackageCorpus(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-shard-mpkg-'));
    const write = (rel: string, body: string) => {
        const p = path.join(root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body);
    };
    write('lib/__init__.py', '');
    write('lib/core.py', 'class Config:\n    value = 1\n\n\ndef process_data(x):\n    return x\n');
    write('app/__init__.py', '');
    write(
        'app/main.py',
        'from lib.core import Config, process_data\n\n\ndef run() -> Config:\n    process_data(1)\n    return Config()\n'
    );
    return root;
}

function runIndex(root: string, extraArgs: string[], env: Record<string, string> = {}): Buffer {
    const out = path.join(os.tmpdir(), `scip-shard-out-${Date.now()}-${Math.random().toString(36).slice(2)}.scip`);
    execFileSync(
        process.execPath,
        [
            indexJs,
            'index',
            root,
            '--project-name',
            'proj',
            '--project-version',
            'testv',
            '--output',
            out,
            '--quiet',
            ...extraArgs,
        ],
        { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] }
    );
    const buf = fs.readFileSync(out);
    fs.unlinkSync(out);
    return buf;
}

function docPaths(buf: Buffer): string[] {
    return scip.Index.deserializeBinary(buf)
        .documents.map((d) => d.relative_path)
        .sort();
}
function globalSymbols(buf: Buffer): Set<string> {
    const idx = scip.Index.deserializeBinary(buf);
    const set = new Set<string>();
    for (const doc of idx.documents) {
        for (const occ of doc.occurrences) {
            if (occ.symbol && !occ.symbol.startsWith('local ')) set.add(occ.symbol);
        }
    }
    return set;
}

// These spin up pyright per run; give them room.
jest.setTimeout(180000);

describe('sharding integration (built index.js)', () => {
    let corpus: string;
    let control: Buffer;

    beforeAll(() => {
        corpus = makeCorpus();
        control = runIndex(corpus, []); // unsharded control (current-main code path).
    });
    afterAll(() => {
        fs.rmSync(corpus, { recursive: true, force: true });
    });

    test('k=1 (--shards 1) is byte-identical to the unsharded control', () => {
        const k1 = runIndex(corpus, ['--shards', '1']);
        expect(k1.equals(control)).toBe(true);
    });

    test('SCIP_DISABLE_SHARDING kill-switch is byte-identical to the unsharded control', () => {
        const killed = runIndex(corpus, ['--shards', '4'], { SCIP_DISABLE_SHARDING: '1' });
        expect(killed.equals(control)).toBe(true);
    });

    test('k=2 sharded index has document-count parity with the control', () => {
        const k2 = runIndex(corpus, ['--shards', '2']);
        expect(docPaths(k2)).toEqual(docPaths(control));
    });

    test('k=2 preserves global symbols across the shard boundary (cross-shard references)', () => {
        const k2 = runIndex(corpus, ['--shards', '2']);
        const controlSyms = globalSymbols(control);
        const shardedSyms = globalSymbols(k2);
        // No global symbol from the control is lost at the shard boundary.
        for (const s of controlSyms) {
            expect(shardedSyms.has(s)).toBe(true);
        }
    });

    test('a shard failure is loud: non-zero exit and no output index written', () => {
        const out = path.join(os.tmpdir(), `scip-shard-fail-${Date.now()}.scip`);
        let threw = false;
        try {
            // A non-existent --filter makes every shard child throw in its constructor → loud abort.
            execFileSync(
                process.execPath,
                [
                    indexJs,
                    'index',
                    corpus,
                    '--project-name',
                    'proj',
                    '--project-version',
                    'testv',
                    '--output',
                    out,
                    '--quiet',
                    '--shards',
                    '2',
                    '--filter',
                    'does-not-exist-pkg',
                ],
                { stdio: ['ignore', 'ignore', 'ignore'] }
            );
        } catch (_) {
            threw = true;
        }
        expect(threw).toBe(true);
        expect(fs.existsSync(out)).toBe(false);
        if (fs.existsSync(out)) fs.unlinkSync(out);
    });
});

describe('sharding integration — multi-top-level-package repo (finding #1 regression)', () => {
    let corpus: string;
    beforeAll(() => {
        corpus = makeMultiPackageCorpus();
    });
    afterAll(() => {
        fs.rmSync(corpus, { recursive: true, force: true });
    });

    // The project-module-prefix set (which decides the project-local vs external symbol scheme) must be
    // derived from the FULL project, not a shard's slice — otherwise a shard whose slice omits a sibling
    // top-level package misclassifies cross-package reference symbols. With `app` and `lib` split across
    // shards at k=2, the sharded output must still be byte-identical to the unsharded control.
    test('k=2 is byte-identical to the control when app/ and lib/ are split across shards', () => {
        const control = runIndex(corpus, []);
        const k2 = runIndex(corpus, ['--shards', '2']);
        expect(k2.equals(control)).toBe(true);
    });
});
