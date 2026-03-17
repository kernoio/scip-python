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

        test('cross-package class and function imports resolve to global symbols', () => {
            const mainDoc = index.documents.find(d => d.relative_path.endsWith('main.py'));
            if (!mainDoc) {
                throw new Error(clue(`[${fixtureName}] main.py not found in documents`, {
                    'documents': index.documents.map(d => d.relative_path),
                }));
            }

            const globalOccSymbols = new Set(
                mainDoc.occurrences
                    .filter(o => o.symbol && !o.symbol.startsWith('local '))
                    .map(o => o.symbol)
            );

            const hasConfigRef = [...globalOccSymbols].some(s => s.includes('/Config#'));
            const hasProcessDataRef = [...globalOccSymbols].some(s => s.includes('/process_data().'));

            if (!hasConfigRef || !hasProcessDataRef) {
                throw new Error(clue(
                    `[${fixtureName}] Cross-package imports (Config, process_data) not resolved to global symbols`,
                    {
                        'has Config ref': hasConfigRef,
                        'has process_data ref': hasProcessDataRef,
                        'global symbols in main.py': [...globalOccSymbols].sort(),
                        'all occurrences': mainDoc.occurrences.map(o => o.symbol),
                    }
                ));
            }
        });

        test('cross-package variable, constant, and type alias imports resolve to global symbols', () => {
            if (fixtureName !== 'uv-workspace') return;

            const mainDoc = index.documents.find(d => d.relative_path.endsWith('main.py'));
            if (!mainDoc) {
                throw new Error('main.py not found');
            }

            const globalOccSymbols = new Set(
                mainDoc.occurrences
                    .filter(o => o.symbol && !o.symbol.startsWith('local '))
                    .map(o => o.symbol)
            );

            const checks = {
                'DEFAULT_NAME (constant)': [...globalOccSymbols].some(s => s.includes('DEFAULT_NAME')),
                'logger (variable)': [...globalOccSymbols].some(s => s.includes('logger')),
                'ConfigOrDict (type alias)': [...globalOccSymbols].some(s => s.includes('ConfigOrDict')),
            };

            const failures = Object.entries(checks).filter(([_, ok]) => !ok);
            if (failures.length > 0) {
                throw new Error(clue(
                    'Non-class/function imports did not resolve to global symbols',
                    {
                        ...Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v ? 'PASS' : 'FAIL'])),
                        'global symbols in main.py': [...globalOccSymbols].sort(),
                        'all occurrences': mainDoc.occurrences.map(o => o.symbol),
                    }
                ));
            }
        });

        test('__getattr__ re-exported symbols resolve to global symbols', () => {
            if (fixtureName !== 'uv-workspace') return;

            const mainDoc = index.documents.find(d => d.relative_path.endsWith('main.py'));
            if (!mainDoc) {
                throw new Error('main.py not found');
            }

            const globalOccSymbols = new Set(
                mainDoc.occurrences
                    .filter(o => o.symbol && !o.symbol.startsWith('local '))
                    .map(o => o.symbol)
            );

            const checks = {
                'Helper (class via __getattr__)': [...globalOccSymbols].some(s => s.includes('Helper')),
                'HELPER_VERSION (constant via __getattr__)': [...globalOccSymbols].some(s => s.includes('HELPER_VERSION')),
            };

            const failures = Object.entries(checks).filter(([_, ok]) => !ok);
            if (failures.length > 0) {
                throw new Error(clue(
                    '__getattr__ re-exported symbols did not resolve to global symbols',
                    {
                        ...Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v ? 'PASS' : 'FAIL'])),
                        'global symbols in main.py': [...globalOccSymbols].sort(),
                        'all occurrences': mainDoc.occurrences.map(o => o.symbol),
                    }
                ));
            }
        });

        test('__getattr__ external re-exports via module-level __getattr__ resolve to global symbols', () => {
            if (fixtureName !== 'uv-workspace') return;

            const mainDoc = index.documents.find(d => d.relative_path.endsWith('main.py'));
            if (!mainDoc) {
                throw new Error('main.py not found');
            }

            const globalOccSymbols = new Set(
                mainDoc.occurrences
                    .filter(o => o.symbol && !o.symbol.startsWith('local '))
                    .map(o => o.symbol)
            );

            const hasHandlerRef = [...globalOccSymbols].some(s => s.includes('Handler'));

            if (!hasHandlerRef) {
                throw new Error(clue(
                    'Handler imported from lib.typedefs (via module-level __getattr__) did not resolve to a global symbol',
                    {
                        'has Handler ref': hasHandlerRef,
                        'global symbols in main.py': [...globalOccSymbols].sort(),
                        'all occurrences': mainDoc.occurrences.map(o => o.symbol),
                    }
                ));
            }
        });

        test('__getattr__ submodule class re-export resolves to global symbol (from lib.plugins import AuthProvider)', () => {
            if (fixtureName !== 'uv-workspace') return;

            const mainDoc = index.documents.find(d => d.relative_path.endsWith('main.py'));
            if (!mainDoc) {
                throw new Error('main.py not found');
            }

            const globalOccSymbols = new Set(
                mainDoc.occurrences
                    .filter(o => o.symbol && !o.symbol.startsWith('local '))
                    .map(o => o.symbol)
            );

            const hasAuthProviderRef = [...globalOccSymbols].some(s => s.includes('AuthProvider'));

            if (!hasAuthProviderRef) {
                throw new Error(clue(
                    'AuthProvider imported via lib.plugins __getattr__ (not directly in __init__.py) did not resolve to a global symbol',
                    {
                        'has AuthProvider ref': hasAuthProviderRef,
                        'global symbols in main.py': [...globalOccSymbols].sort(),
                        'all occurrences': mainDoc.occurrences.map(o => o.symbol),
                    }
                ));
            }
        });
    });
}

describe('intra-package cross-module resolution', () => {
    let libIndex: scip.Index;

    beforeAll(() => {
        const fixturePath = path.join(FIXTURE_DIR, 'uv-workspace');
        libIndex = runIndexer(fixturePath, 'lib', os.tmpdir());
    });

    test('lib __init__ imports from lib.core resolve to global symbols', () => {
        const initDoc = libIndex.documents.find(d => d.relative_path.endsWith('__init__.py'));
        if (!initDoc) {
            throw new Error(clue('lib __init__.py not found', {
                'documents': libIndex.documents.map(d => d.relative_path),
            }));
        }

        const globalOccSymbols = new Set(
            initDoc.occurrences
                .filter(o => o.symbol && !o.symbol.startsWith('local '))
                .map(o => o.symbol)
        );

        const hasConfigRef = [...globalOccSymbols].some(s => s.includes('/Config#'));
        const hasProcessDataRef = [...globalOccSymbols].some(s => s.includes('/process_data().'));

        if (!hasConfigRef || !hasProcessDataRef) {
            throw new Error(clue(
                'Intra-package imports in __init__.py did not resolve to global symbols',
                {
                    'has Config ref': hasConfigRef,
                    'has process_data ref': hasProcessDataRef,
                    'global symbols': [...globalOccSymbols].sort(),
                    'all occurrences': initDoc.occurrences.map(o => o.symbol),
                }
            ));
        }
    });

    test('lib core.py definitions are global symbols', () => {
        const coreDoc = libIndex.documents.find(d => d.relative_path.endsWith('core.py'));
        if (!coreDoc) {
            throw new Error(clue('lib core.py not found', {
                'documents': libIndex.documents.map(d => d.relative_path),
            }));
        }

        const globalOccSymbols = new Set(
            coreDoc.occurrences
                .filter(o => o.symbol && !o.symbol.startsWith('local '))
                .map(o => o.symbol)
        );

        const hasConfigDef = [...globalOccSymbols].some(s => s.includes('/Config#'));
        const hasProcessDataDef = [...globalOccSymbols].some(s => s.includes('/process_data().'));
        const hasProcessorDef = [...globalOccSymbols].some(s => s.includes('/Processor#'));

        if (!hasConfigDef || !hasProcessDataDef || !hasProcessorDef) {
            throw new Error(clue(
                'lib core.py definitions not emitted as global symbols',
                {
                    'has Config': hasConfigDef,
                    'has process_data': hasProcessDataDef,
                    'has Processor': hasProcessorDef,
                    'global symbols': [...globalOccSymbols].sort(),
                    'all occurrences': coreDoc.occurrences.map(o => o.symbol),
                }
            ));
        }
    });

    test('intra-package references share symbols with definitions', () => {
        const initDoc = libIndex.documents.find(d => d.relative_path.endsWith('__init__.py'));
        const coreDoc = libIndex.documents.find(d => d.relative_path.endsWith('core.py'));
        if (!initDoc || !coreDoc) {
            throw new Error('Missing documents');
        }

        const initGlobalSymbols = new Set(
            initDoc.occurrences
                .filter(o => o.symbol && !o.symbol.startsWith('local '))
                .map(o => o.symbol)
        );
        const coreGlobalSymbols = new Set(
            coreDoc.occurrences
                .filter(o => o.symbol && !o.symbol.startsWith('local '))
                .map(o => o.symbol)
        );

        const shared = [...initGlobalSymbols].filter(s => coreGlobalSymbols.has(s));
        const sharedNonModule = shared.filter(s => !s.includes('/__init__:'));

        if (sharedNonModule.length === 0) {
            throw new Error(clue(
                'No shared symbols between __init__.py references and core.py definitions',
                {
                    'init global symbols': [...initGlobalSymbols].sort(),
                    'core global symbols': [...coreGlobalSymbols].sort(),
                    'shared': shared,
                }
            ));
        }
    });
});

describe('langflow lfx intra-package resolution', () => {
    let lfxIndex: scip.Index;

    beforeAll(() => {
        const fixturePath = path.join(FIXTURE_DIR, 'langflow');
        lfxIndex = runIndexer(fixturePath, 'lfx', os.tmpdir());
    });

    test('produces documents for lfx package', () => {
        if (lfxIndex.documents.length < 10) {
            throw new Error(clue('Too few lfx documents', {
                'document count': lfxIndex.documents.length,
                'documents': lfxIndex.documents.map(d => d.relative_path),
            }));
        }
    });

    test('class imports within lfx resolve to global symbols', () => {
        const agentDoc = lfxIndex.documents.find(d => d.relative_path.includes('agents/agent.py'));
        if (!agentDoc) {
            throw new Error(clue('agent.py not found', {
                'documents': lfxIndex.documents.map(d => d.relative_path).slice(0, 20),
            }));
        }

        const globalSymbols = new Set(
            agentDoc.occurrences
                .filter(o => o.symbol && !o.symbol.startsWith('local '))
                .map(o => o.symbol)
        );

        const hasCallbackClassRef = [...globalSymbols].some(s => s.includes('/AgentAsyncHandler#'));
        if (!hasCallbackClassRef) {
            throw new Error(clue(
                'Class import AgentAsyncHandler not resolved to global symbol',
                { 'global symbols': [...globalSymbols].sort() }
            ));
        }
    });

    test('variable and re-export imports within lfx resolve to global symbols', () => {
        const agentDoc = lfxIndex.documents.find(d => d.relative_path.includes('agents/agent.py'));
        if (!agentDoc) {
            throw new Error(clue('agent.py not found', {
                'documents': lfxIndex.documents.map(d => d.relative_path).slice(0, 20),
            }));
        }

        const globalSymbols = new Set(
            agentDoc.occurrences
                .filter(o => o.symbol && !o.symbol.startsWith('local '))
                .map(o => o.symbol)
        );

        const checks = {
            'InputTypes (TypeAlias)': [...globalSymbols].some(s => s.includes('InputTypes')),
            'logger (module variable)': [...globalSymbols].some(s => s.includes('/logger')),
            'MESSAGE_SENDER_AI (constant)': [...globalSymbols].some(s => s.includes('MESSAGE_SENDER_AI')),
        };

        const failures = Object.entries(checks).filter(([_, ok]) => !ok);
        if (failures.length > 0) {
            throw new Error(clue(
                'Non-class imports in agent.py did not resolve to global symbols',
                {
                    ...Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v ? 'PASS' : 'FAIL'])),
                    'global symbols': [...globalSymbols].sort(),
                    'all symbols': agentDoc.occurrences.map(o => o.symbol),
                }
            ));
        }
    });

    test('lfx-wide cross-module resolution produces mostly global symbols', () => {
        let globalCount = 0;
        let localCount = 0;
        for (const doc of lfxIndex.documents) {
            for (const occ of doc.occurrences) {
                if (occ.symbol.startsWith('local ')) localCount++;
                else globalCount++;
            }
        }

        const globalRatio = globalCount / (globalCount + localCount);
        if (globalRatio < 0.3) {
            throw new Error(clue(
                'Too few global symbols across lfx index — cross-module resolution likely broken',
                {
                    'global occurrences': globalCount,
                    'local occurrences': localCount,
                    'global ratio': `${(globalRatio * 100).toFixed(1)}%`,
                }
            ));
        }
    });
});

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
