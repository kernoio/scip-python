import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { scip } from './scip';

const FIXTURE_DIR = path.resolve(os.homedir(), 'python-test-repos');
const pyrightScipDir = path.resolve(__dirname, '..');
const indexJs = path.join(pyrightScipDir, 'index.js');

const FIXTURES: Record<string, { filter: string; appDocs: string[] }> = {
    'uv-workspace': {
        filter: 'app',
        appDocs: ['app/src/app/__init__.py', 'app/src/app/main.py'],
    },
    'poetry-path-deps': {
        filter: 'app',
        appDocs: ['app/src/app/__init__.py', 'app/src/app/main.py'],
    },
    'pdm-workspace': {
        filter: 'app',
        appDocs: ['app/src/app/__init__.py', 'app/src/app/main.py'],
    },
    'setuptools-multi-package': {
        filter: 'app',
        appDocs: ['app/src/app/__init__.py', 'app/src/app/main.py'],
    },
    'namespace-packages': {
        filter: 'acme-app',
        appDocs: ['acme-app/src/acme/app/__init__.py', 'acme-app/src/acme/app/main.py'],
    },
};

function clue(description: string, context: Record<string, unknown>): string {
    const lines = [description, ''];
    for (const [key, value] of Object.entries(context)) {
        const formatted = Array.isArray(value)
            ? value.length === 0 ? '(empty)' : '\n' + value.map(v => `    ${v}`).join('\n')
            : String(value);
        lines.push(`  ${key}: ${formatted}`);
    }
    return lines.join('\n');
}

function collectGlobalSymbols(idx: scip.Index): string[] {
    const symbols = new Set<string>();
    for (const doc of idx.documents) {
        for (const occ of doc.occurrences) {
            if (occ.symbol && !occ.symbol.startsWith('local ')) {
                symbols.add(occ.symbol);
            }
        }
        for (const info of doc.symbols) {
            if (info.symbol && !info.symbol.startsWith('local ')) {
                symbols.add(info.symbol);
            }
        }
    }
    return Array.from(symbols).sort();
}

const tmpFiles: string[] = [];

function runIndexer(fixturePath: string, filter: string, cwd: string): scip.Index {
    const tmpFile = path.join(os.tmpdir(), `scip-test-${Date.now()}-${Math.random().toString(36).slice(2)}.scip`);
    tmpFiles.push(tmpFile);
    execSync(
        `node ${indexJs} index --cwd ${fixturePath} --filter ${filter} --project-name ${filter} --output ${tmpFile} --quiet`,
        { cwd }
    );
    return scip.Index.deserializeBinary(fs.readFileSync(tmpFile));
}

afterAll(() => {
    for (const f of tmpFiles) {
        try { fs.unlinkSync(f); } catch (_) {}
    }
});

for (const [fixtureName, { filter, appDocs }] of Object.entries(FIXTURES)) {
    describe(fixtureName, () => {
        let index: scip.Index;

        beforeAll(() => {
            const fixturePath = path.join(FIXTURE_DIR, fixtureName);
            index = runIndexer(fixturePath, filter, os.tmpdir());
        });

        test('produces documents only for the filtered package', () => {
            const actual = index.documents.map(d => d.relative_path).sort();
            const expected = [...appDocs].sort();
            if (actual.length !== expected.length || !expected.every((p, i) => p === actual[i])) {
                throw new Error(clue(`[${fixtureName}] Wrong documents produced`, {
                    expected,
                    actual,
                }));
            }
        });

        test('generates global symbols', () => {
            const allSymbols: string[] = [];
            for (const doc of index.documents) {
                for (const occ of doc.occurrences) {
                    if (occ.symbol) allSymbols.push(occ.symbol);
                }
                for (const info of doc.symbols) {
                    if (info.symbol) allSymbols.push(info.symbol);
                }
            }
            const globalSymbols = allSymbols.filter(s => !s.startsWith('local '));
            if (globalSymbols.length < 3) {
                throw new Error(clue(`[${fixtureName}] Too few global symbols`, {
                    'global symbol count': globalSymbols.length,
                    'all symbols': allSymbols,
                    'document paths': index.documents.map(d => d.relative_path),
                }));
            }
        });

        test('includes expected definition symbols', () => {
            const globalSymbols = collectGlobalSymbols(index);
            const hasInit = globalSymbols.some(s => s.includes('/__init__:'));
            const hasFn = globalSymbols.some(s => s.endsWith('.') || s.endsWith('():'));
            if (!hasInit || !hasFn) {
                throw new Error(clue(`[${fixtureName}] Missing expected symbol descriptors`, {
                    'has __init__ descriptor': hasInit,
                    'has function descriptor': hasFn,
                    'actual symbols': globalSymbols,
                }));
            }
        });

        test('excludes lib package from documents', () => {
            const libDocs = index.documents.map(d => d.relative_path).filter(p => p.includes('lib/'));
            if (libDocs.length > 0) {
                throw new Error(clue(`[${fixtureName}] Lib package documents found but should be excluded`, {
                    'all document paths': index.documents.map(d => d.relative_path),
                }));
            }
        });
    });
}

test('resolves with consistent output regardless of invocation directory', () => {
    const fixturePath = path.join(FIXTURE_DIR, 'uv-workspace');
    const filter = FIXTURES['uv-workspace'].filter;

    const firstIndex = runIndexer(fixturePath, filter, pyrightScipDir);
    const secondIndex = runIndexer(fixturePath, filter, os.tmpdir());

    const firstDocs = firstIndex.documents.map(d => d.relative_path).sort();
    const secondDocs = secondIndex.documents.map(d => d.relative_path).sort();

    if (firstDocs.length !== secondDocs.length || !firstDocs.every((p, i) => p === secondDocs[i])) {
        throw new Error(clue('Document sets differ between runs', {
            'first run docs': firstDocs,
            'second run docs': secondDocs,
        }));
    }

    const firstSymbols = collectGlobalSymbols(firstIndex);
    const secondSymbols = collectGlobalSymbols(secondIndex);

    if (
        firstSymbols.length !== secondSymbols.length ||
        !firstSymbols.every((s: string, i: number) => s === secondSymbols[i])
    ) {
        throw new Error(clue('Symbol sets differ between runs', {
            'first run symbols': firstSymbols,
            'second run symbols': secondSymbols,
        }));
    }
});
