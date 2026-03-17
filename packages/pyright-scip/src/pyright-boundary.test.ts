import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Event } from 'vscode-jsonrpc';

import { Indexer } from './indexer';
import { IndexOptions } from './MainCommand';
import { applyFilterToOptions } from './main-impl';
import { getFileInfo } from 'pyright-internal/analyzer/analyzerNodeInfo';
import { ParseTreeWalker } from 'pyright-internal/analyzer/parseTreeWalker';
import { ParseNodeType, ImportFromNode, ImportFromAsNode, ParseNode, ParseNodeArray, NameNode } from 'pyright-internal/parser/parseNodes';
import { UriEx } from 'pyright-internal/common/uri/uriUtils';
import { TreeVisitor } from './treeVisitor';
import { scip } from './scip';

const FIXTURE_DIR = path.resolve(os.homedir(), 'python-test-repos');
const UV_WORKSPACE = path.join(FIXTURE_DIR, 'uv-workspace');

class NodeCollector extends ParseTreeWalker {
    nodes: ParseNode[] = [];
    constructor(private predicate: (node: ParseNode) => boolean) {
        super();
    }
    override visitNode(node: ParseNode): ParseNodeArray {
        if (this.predicate(node)) {
            this.nodes.push(node);
        }
        return super.visitNode(node);
    }
}

function findNodes(root: ParseNode, predicate: (node: ParseNode) => boolean): ParseNode[] {
    const collector = new NodeCollector(predicate);
    collector.walk(root);
    return collector.nodes;
}

let indexer: Indexer;
let originalCwd: string;

beforeAll(() => {
    const options: IndexOptions = {
        projectName: 'app',
        projectVersion: '0.1.0',
        dev: false,
        output: '/dev/null',
        cwd: UV_WORKSPACE,
        filter: 'app',
        quiet: true,
        showProgressRateLimit: undefined,
    };

    applyFilterToOptions(options, UV_WORKSPACE);

    originalCwd = process.cwd();
    process.chdir(UV_WORKSPACE);

    indexer = new Indexer({
        ...options,
        projectRoot: UV_WORKSPACE,
        infer: { projectVersionFromCommit: false },
        writeIndex: () => {},
    });

    const token = {
        isCancellationRequested: false,
        onCancellationRequested: Event.None,
    };
    while (indexer.program.analyze(
        { openFilesTimeInMs: 10000, noOpenFilesTimeInMs: 10000 },
        token
    )) {}
});

afterAll(() => {
    process.chdir(originalCwd);
});

describe('pyright-internal boundary: uv-workspace --filter app', () => {

    it('reports correct file metadata for app/main.py', () => {
        const mainPyPath = path.join(UV_WORKSPACE, 'app', 'src', 'app', 'main.py');
        const sourceFile = indexer.program.getSourceFile(UriEx.file(mainPyPath));
        expect(sourceFile).toBeDefined();

        const tree = sourceFile!.getParseResults()!.parserOutput.parseTree;
        const fileInfo = getFileInfo(tree);
        expect(fileInfo).toBeDefined();

        expect(fileInfo!.moduleName).toBe('app.main');
        expect(fileInfo!.fileUri.getFilePath()).toBe(mainPyPath);
    });

    it('resolves Config import alias to a declaration in lib/src/lib/core.py', () => {
        const mainPyPath = path.join(UV_WORKSPACE, 'app', 'src', 'app', 'main.py');
        const sourceFile = indexer.program.getSourceFile(UriEx.file(mainPyPath));
        const tree = sourceFile!.getParseResults()!.parserOutput.parseTree;

        const importFromNodes = findNodes(tree, (n) => n.nodeType === ParseNodeType.ImportFrom) as ImportFromNode[];
        const libCoreImport = importFromNodes.find((n) =>
            n.d.module.d.nameParts.map((p: any) => p.d.value).join('.') === 'lib.core'
        );
        expect(libCoreImport).toBeDefined();

        const configImport = libCoreImport!.d.imports.find(
            (imp: any) => imp.d.name.d.value === 'Config'
        ) as ImportFromAsNode;
        expect(configImport).toBeDefined();

        const evaluator = indexer.program.evaluator!;
        const declInfo = evaluator.getDeclInfoForNameNode(configImport.d.name as NameNode);
        expect(declInfo).toBeDefined();
        expect(declInfo!.decls.length).toBeGreaterThan(0);

        const resolved = evaluator.resolveAliasDeclaration(declInfo!.decls[0], true);
        expect(resolved).toBeDefined();

        const expectedLibCorePath = path.join(UV_WORKSPACE, 'lib', 'src', 'lib', 'core.py');
        expect(resolved!.uri.getFilePath()).toBe(expectedLibCorePath);
    });

    it('reports correct file metadata for the resolved Config declaration in lib', () => {
        const mainPyPath = path.join(UV_WORKSPACE, 'app', 'src', 'app', 'main.py');
        const sourceFile = indexer.program.getSourceFile(UriEx.file(mainPyPath));
        const tree = sourceFile!.getParseResults()!.parserOutput.parseTree;

        const importFromNodes = findNodes(tree, (n) => n.nodeType === ParseNodeType.ImportFrom) as ImportFromNode[];
        const libCoreImport = importFromNodes.find((n) =>
            n.d.module.d.nameParts.map((p: any) => p.d.value).join('.') === 'lib.core'
        );

        const configImport = libCoreImport!.d.imports.find(
            (imp: any) => imp.d.name.d.value === 'Config'
        ) as ImportFromAsNode;

        const evaluator = indexer.program.evaluator!;
        const declInfo = evaluator.getDeclInfoForNameNode(configImport.d.name as NameNode);
        const resolved = evaluator.resolveAliasDeclaration(declInfo!.decls[0], true);

        const resolvedNode = resolved!.node;
        expect(resolvedNode).toBeDefined();

        const resolvedFileInfo = getFileInfo(resolvedNode!);
        expect(resolvedFileInfo).toBeDefined();

        const expectedLibCorePath = path.join(UV_WORKSPACE, 'lib', 'src', 'lib', 'core.py');
        expect(resolvedFileInfo!.fileUri.getFilePath()).toBe(expectedLibCorePath);
        expect(resolvedFileInfo!.moduleName).toBe('lib.core');
    });
});

describe('pyright-internal boundary: __getattr__ re-exports', () => {

    it('resolves Helper import from lib (via __getattr__) to a declaration', () => {
        const mainPyPath = path.join(UV_WORKSPACE, 'app', 'src', 'app', 'main.py');
        const sourceFile = indexer.program.getSourceFile(UriEx.file(mainPyPath));
        const tree = sourceFile!.getParseResults()!.parserOutput.parseTree;

        const importFromNodes = findNodes(tree, (n) => n.nodeType === ParseNodeType.ImportFrom) as ImportFromNode[];
        const libImport = importFromNodes.find((n) =>
            n.d.module.d.nameParts.map((p: any) => p.d.value).join('.') === 'lib' &&
            n.d.imports.some((imp: any) => imp.d.name.d.value === 'Helper')
        );
        expect(libImport).toBeDefined();

        const helperImport = libImport!.d.imports.find(
            (imp: any) => imp.d.name.d.value === 'Helper'
        ) as ImportFromAsNode;
        expect(helperImport).toBeDefined();

        const evaluator = indexer.program.evaluator!;
        const declInfo = evaluator.getDeclInfoForNameNode(helperImport.d.name as NameNode);
        console.log('[__getattr__ debug] declInfo:', declInfo ? `${declInfo.decls.length} decls` : 'undefined');
        if (declInfo) {
            for (const decl of declInfo.decls) {
                console.log(`  decl type=${decl.type} node=${decl.node?.nodeType} uri=${decl.uri?.getFilePath()}`);
                const resolved = evaluator.resolveAliasDeclaration(decl, true);
                console.log(`  resolved: type=${resolved?.type} node=${resolved?.node?.nodeType} uri=${resolved?.uri?.getFilePath()}`);
            }
        }

        const symbolWithScope = evaluator.lookUpSymbolRecursive(helperImport, 'Helper', true);
        console.log('[__getattr__ debug] symbolWithScope:', symbolWithScope ? 'found' : 'undefined');
        if (symbolWithScope) {
            const allDecls = symbolWithScope.symbol.getDeclarations();
            console.log(`  all declarations: ${allDecls.length}`);
            for (const decl of allDecls) {
                console.log(`  decl type=${decl.type} node=${decl.node?.nodeType} uri=${decl.uri?.getFilePath()}`);
            }
        }

        expect(declInfo).toBeDefined();
    });

    it('can resolve lib.helpers module in program', () => {
        const helpersPath = path.join(UV_WORKSPACE, 'lib', 'src', 'lib', 'helpers.py');
        const sourceFile = indexer.program.getSourceFile(UriEx.file(helpersPath));
        console.log('[helpers debug] sourceFile exists:', !!sourceFile);
        if (sourceFile) {
            const tree = sourceFile.getParseResults()?.parserOutput.parseTree;
            if (tree) {
                const fileInfo = getFileInfo(tree);
                console.log('[helpers debug] moduleName:', fileInfo?.moduleName);
            }
        }

        const initPath = path.join(UV_WORKSPACE, 'lib', 'src', 'lib', '__init__.py');
        const initFile = indexer.program.getSourceFile(UriEx.file(initPath));
        console.log('[init debug] sourceFile exists:', !!initFile);
        if (initFile) {
            const tree = initFile.getParseResults()?.parserOutput.parseTree;
            if (tree) {
                const fileInfo = getFileInfo(tree);
                console.log('[init debug] moduleName:', fileInfo?.moduleName);
            }
            console.log('[init debug] moduleSymbolTable entries:');
            const symTable = initFile.getModuleSymbolTable();
            if (symTable) {
                symTable.forEach((sym, name) => {
                    console.log(`  ${name}: ${sym.getDeclarations().map(d => `type=${d.type}`).join(', ')}`);
                });
            } else {
                console.log('  moduleSymbolTable is NULL');
            }
        }
    });

    it('lib.helpers.py is NOT in project files (expected for --filter app)', () => {
        const helpersInProjectFiles = [...indexer.projectFiles].some(f => f.includes('helpers.py'));
        expect(helpersInProjectFiles).toBe(false);
    });

    it('resolves Handler import from lib.typedefs (module-level __getattr__) to a declaration', () => {
        const mainPyPath = path.join(UV_WORKSPACE, 'app', 'src', 'app', 'main.py');
        const sourceFile = indexer.program.getSourceFile(UriEx.file(mainPyPath));
        const tree = sourceFile!.getParseResults()!.parserOutput.parseTree;

        const importFromNodes = findNodes(tree, (n) => n.nodeType === ParseNodeType.ImportFrom) as ImportFromNode[];
        const typedefsImport = importFromNodes.find((n) =>
            n.d.module.d.nameParts.map((p: any) => p.d.value).join('.') === 'lib.typedefs' &&
            n.d.imports.some((imp: any) => imp.d.name.d.value === 'Handler')
        );
        expect(typedefsImport).toBeDefined();

        const handlerImport = typedefsImport!.d.imports.find(
            (imp: any) => imp.d.name.d.value === 'Handler'
        ) as ImportFromAsNode;
        expect(handlerImport).toBeDefined();

        const evaluator = indexer.program.evaluator!;
        const declInfo = evaluator.getDeclInfoForNameNode(handlerImport.d.name as NameNode);
        console.log('[lib.typedefs __getattr__ debug] declInfo:', declInfo ? `${declInfo.decls.length} decls` : 'undefined');
        if (declInfo) {
            for (const decl of declInfo.decls) {
                console.log(`  decl type=${decl.type} node=${decl.node?.nodeType} uri=${decl.uri?.getFilePath()}`);
                const resolved = evaluator.resolveAliasDeclaration(decl, true);
                console.log(`  resolved: type=${resolved?.type} node=${resolved?.node?.nodeType} uri=${resolved?.uri?.getFilePath()}`);
            }
        }

        const typedefsPath = path.join(UV_WORKSPACE, 'lib', 'src', 'lib', 'typedefs.py');
        const typedefsFile = indexer.program.getSourceFile(UriEx.file(typedefsPath));
        console.log('[lib.typedefs debug] sourceFile exists:', !!typedefsFile);
        if (typedefsFile) {
            const typedefsTree = typedefsFile.getParseResults()?.parserOutput.parseTree;
            const fileInfo = getFileInfo(typedefsTree!);
            console.log('[lib.typedefs debug] moduleName:', fileInfo?.moduleName);
            const symTable = typedefsFile.getModuleSymbolTable();
            if (symTable) {
                symTable.forEach((sym, name) => {
                    console.log(`  ${name}: ${sym.getDeclarations().map(d => `type=${d.type}`).join(', ')}`);
                });
            } else {
                console.log('  moduleSymbolTable is NULL');
            }
        }

        expect(declInfo).toBeDefined();
    });

    it('resolves AuthProvider import from lib.plugins to a declaration', () => {
        const mainPyPath = path.join(UV_WORKSPACE, 'app', 'src', 'app', 'main.py');
        const sourceFile = indexer.program.getSourceFile(UriEx.file(mainPyPath));
        const tree = sourceFile!.getParseResults()!.parserOutput.parseTree;

        const importFromNodes = findNodes(tree, (n) => n.nodeType === ParseNodeType.ImportFrom) as ImportFromNode[];
        const pluginsImport = importFromNodes.find((n) =>
            n.d.module.d.nameParts.map((p: any) => p.d.value).join('.') === 'lib.plugins' &&
            n.d.imports.some((imp: any) => imp.d.name.d.value === 'AuthProvider')
        );
        expect(pluginsImport).toBeDefined();

        const authProviderImport = pluginsImport!.d.imports.find(
            (imp: any) => imp.d.name.d.value === 'AuthProvider'
        ) as ImportFromAsNode;
        expect(authProviderImport).toBeDefined();

        const evaluator = indexer.program.evaluator!;
        const declInfo = evaluator.getDeclInfoForNameNode(authProviderImport.d.name as NameNode);
        console.log('[lib.plugins debug] declInfo:', declInfo ? `${declInfo.decls.length} decls` : 'undefined');
        if (declInfo) {
            for (const decl of declInfo.decls) {
                console.log(`  decl type=${decl.type} node=${decl.node?.nodeType} uri=${decl.uri?.getFilePath()}`);
                const resolved = evaluator.resolveAliasDeclaration(decl, true);
                console.log(`  resolved: type=${resolved?.type} node=${resolved?.node?.nodeType} uri=${resolved?.uri?.getFilePath()}`);
            }
        }

        const pluginsInitPath = path.join(UV_WORKSPACE, 'lib', 'src', 'lib', 'plugins', '__init__.py');
        const pluginsInitFile = indexer.program.getSourceFile(UriEx.file(pluginsInitPath));
        console.log('[lib.plugins __init__ debug] sourceFile exists:', !!pluginsInitFile);
        if (pluginsInitFile) {
            const symTable = pluginsInitFile.getModuleSymbolTable();
            if (symTable) {
                symTable.forEach((sym, name) => {
                    console.log(`  ${name}: ${sym.getDeclarations().map(d => `type=${d.type}`).join(', ')}`);
                });
            } else {
                console.log('  moduleSymbolTable is NULL');
            }
        }

        expect(declInfo).toBeDefined();
    });

    it('resolveAliasDeclarationWithInfo provides more detail for __getattr__ imports', () => {
        const mainPyPath = path.join(UV_WORKSPACE, 'app', 'src', 'app', 'main.py');
        const sourceFile = indexer.program.getSourceFile(UriEx.file(mainPyPath));
        const tree = sourceFile!.getParseResults()!.parserOutput.parseTree;

        const importFromNodes = findNodes(tree, (n) => n.nodeType === ParseNodeType.ImportFrom) as ImportFromNode[];
        const libImport = importFromNodes.find((n) =>
            n.d.module.d.nameParts.map((p: any) => p.d.value).join('.') === 'lib' &&
            n.d.imports.some((imp: any) => imp.d.name.d.value === 'Helper')
        );

        const helperImport = libImport!.d.imports.find(
            (imp: any) => imp.d.name.d.value === 'Helper'
        ) as ImportFromAsNode;

        const evaluator = indexer.program.evaluator!;
        const symbolWithScope = evaluator.lookUpSymbolRecursive(helperImport, 'Helper', true);
        const allDecls = symbolWithScope!.symbol.getDeclarations();
        const aliasDecl = allDecls.find((d: any) => d.type === 8);

        if (aliasDecl) {
            const resolvedInfo = evaluator.resolveAliasDeclarationWithInfo(aliasDecl, true, {});
            console.log('[resolveWithInfo] result:', resolvedInfo ? 'exists' : 'undefined');
            if (resolvedInfo) {
                console.log('[resolveWithInfo] declaration:', resolvedInfo.declaration ? `type=${resolvedInfo.declaration.type} node=${resolvedInfo.declaration.node?.nodeType}` : 'undefined');
                console.log('[resolveWithInfo] isPrivate:', resolvedInfo.isPrivate);
            }
        }

        const type = evaluator.getTypeOfExpression(helperImport.d.name as any);
        console.log('[type debug] category:', type?.type?.category);
        console.log('[type debug] shared?.declaration?.node:', (type?.type as any)?.shared?.declaration?.node?.nodeType);
    });
});

describe('TreeVisitor layer: uv-workspace --filter app', () => {
    const mainPyPath = path.join(UV_WORKSPACE, 'app', 'src', 'app', 'main.py');

    function buildProjectModulePrefixes(): Set<string> {
        const projectModulePrefixes = new Set<string>();
        for (const filepath of indexer.projectFiles) {
            const rel = path.relative(indexer.scipConfig.projectRoot, filepath);
            const topLevel = rel.split(path.sep)[0];
            if (topLevel && topLevel !== '.' && topLevel !== '..') {
                projectModulePrefixes.add(topLevel);
            }
        }
        for (const sibling of indexer.scipConfig.siblingPackages ?? []) {
            for (const entry of fs.readdirSync(sibling.srcPath)) {
                if (fs.statSync(path.join(sibling.srcPath, entry)).isDirectory()) {
                    projectModulePrefixes.add(entry);
                }
            }
        }
        return projectModulePrefixes;
    }

    function buildTreeVisitorDoc(): scip.Document {
        const projectModulePrefixes = buildProjectModulePrefixes();
        const typeEvaluator = indexer.program.evaluator!;
        const doc = new scip.Document({ relative_path: 'app/src/app/main.py' });
        const sourceFile = indexer.program.getSourceFile(UriEx.file(mainPyPath))!;
        const tree = sourceFile.getParseResults()!.parserOutput.parseTree;

        const visitor = new TreeVisitor({
            document: doc,
            externalSymbols: new Map(),
            sourceFile: sourceFile,
            evaluator: typeEvaluator,
            program: indexer.program,
            pyrightConfig: indexer.pyrightConfig,
            scipConfig: indexer.scipConfig,
            globalSymbols: new Map(),
            projectModulePrefixes,
        });
        visitor.walk(tree);
        return doc;
    }

    it('projectModulePrefixes contains only target package modules', () => {
        const projectModulePrefixes = buildProjectModulePrefixes();
        expect(projectModulePrefixes).toEqual(new Set(['app', 'lib']));
    });

    it('TreeVisitor produces scheme symbol (not local) for lib.core module reference', () => {
        const doc = buildTreeVisitorDoc();
        const libOccurrence = doc.occurrences.find((occ) => {
            const range = occ.range;
            return range[0] === 5 && range[1] === 5;
        });
        expect(libOccurrence).toBeDefined();
        const symbol = libOccurrence!.symbol;
        expect(symbol).toMatch(/^`lib\.core`\//);
        expect(symbol).not.toMatch(/^local /);
    });

    it('TreeVisitor produces scheme symbol (not local) for Config import', () => {
        const doc = buildTreeVisitorDoc();
        const configOccurrence = doc.occurrences.find((occ) => {
            const range = occ.range;
            return range[0] === 5 && range[1] === 21;
        });
        expect(configOccurrence).toBeDefined();
        const symbol = configOccurrence!.symbol;
        expect(symbol).toBe('`lib.core`/Config#');
        expect(symbol).not.toMatch(/^local /);
    });
});

describe('pyright-internal boundary: langflow --filter lfx __getattr__ resolution', () => {
    const LANGFLOW = path.join(FIXTURE_DIR, 'langflow');
    let lfxIndexer: Indexer;
    let lfxOrigCwd: string;

    beforeAll(() => {
        const options: IndexOptions = {
            projectName: 'lfx',
            projectVersion: '0.1.0',
            dev: false,
            output: '/dev/null',
            cwd: LANGFLOW,
            filter: 'lfx',
            quiet: true,
            showProgressRateLimit: undefined,
        };

        applyFilterToOptions(options, LANGFLOW);

        lfxOrigCwd = process.cwd();
        process.chdir(LANGFLOW);

        lfxIndexer = new Indexer({
            ...options,
            projectRoot: LANGFLOW,
            infer: { projectVersionFromCommit: false },
            writeIndex: () => {},
        });

        const token = {
            isCancellationRequested: false,
            onCancellationRequested: Event.None,
        };
        while (lfxIndexer.program.analyze(
            { openFilesTimeInMs: 10000, noOpenFilesTimeInMs: 10000 },
            token
        )) {}
    });

    afterAll(() => {
        process.chdir(lfxOrigCwd);
    });

    it('lfx/schema/data.py is in project files and has a sourceFile', () => {
        const dataInProject = [...lfxIndexer.projectFiles].some(f => f.includes('schema/data.py'));
        expect(dataInProject).toBe(true);

        const dataPath = [...lfxIndexer.projectFiles].find(f => f.includes('schema/data.py'))!;
        const sourceFile = lfxIndexer.program.getSourceFile(UriEx.file(dataPath));
        console.log('[lfx data.py] in projectFiles:', dataInProject);
        console.log('[lfx data.py] sourceFile exists:', !!sourceFile);
        expect(sourceFile).toBeDefined();
    });

    it('resolveAliasDeclaration for from lfx.schema import Data/Message (via __getattr__)', () => {
        const savePath = [...lfxIndexer.projectFiles].find(f => f.includes('save_file.py'))!;
        const sourceFile = lfxIndexer.program.getSourceFile(UriEx.file(savePath));
        expect(sourceFile).toBeDefined();
        const tree = sourceFile!.getParseResults()!.parserOutput.parseTree;

        const importFromNodes = findNodes(tree, (n) => n.nodeType === ParseNodeType.ImportFrom) as ImportFromNode[];
        const schemaImport = importFromNodes.find((n) =>
            n.d.module.d.nameParts.map((p: any) => p.d.value).join('.') === 'lfx.schema'
        );
        expect(schemaImport).toBeDefined();

        const evaluator = lfxIndexer.program.evaluator!;
        for (const imp of schemaImport!.d.imports) {
            const name = (imp as any).d.name.d.value;
            const symbolWithScope = evaluator.lookUpSymbolRecursive(imp, name, true);
            console.log(`[lfx.schema] ${name}: symbolWithScope=${symbolWithScope ? 'found' : 'undefined'}`);
            if (!symbolWithScope) continue;

            const decls = symbolWithScope.symbol.getDeclarations();
            console.log(`[lfx.schema] ${name}: ${decls.length} declarations`);
            for (const decl of decls) {
                console.log(`  decl type=${decl.type} node=${decl.node?.nodeType} uri=${decl.uri?.getFilePath()}`);
                const resolved = evaluator.resolveAliasDeclaration(decl, true);
                console.log(`  resolved: ${resolved ? `type=${resolved.type} node=${resolved.node?.nodeType} uri=${resolved.uri?.getFilePath()}` : 'undefined'}`);
            }
        }
    });
});
