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
            return range[0] === 4 && range[1] === 5;
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
            return range[0] === 4 && range[1] === 21;
        });
        expect(configOccurrence).toBeDefined();
        const symbol = configOccurrence!.symbol;
        expect(symbol).toBe('`lib.core`/Config#');
        expect(symbol).not.toMatch(/^local /);
    });
});
