import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as TOML from '@iarna/toml';
import { Event } from 'vscode-jsonrpc';

import { Program } from 'pyright-internal/analyzer/program';
import { ImportResolver } from 'pyright-internal/analyzer/importResolver';
import { createFromRealFileSystem, RealTempFile } from 'pyright-internal/common/realFileSystem';
import { ConfigOptions } from 'pyright-internal/common/configOptions';
import { TreeVisitor } from './treeVisitor';
import { FullAccessHost } from 'pyright-internal/common/fullAccessHost';
import { UriEx } from 'pyright-internal/common/uri/uriUtils';
import { createServiceProvider } from 'pyright-internal/common/serviceProviderExtensions';
import * as url from 'url';
import { ScipConfig } from './lib';
import { SourceFile } from 'pyright-internal/analyzer/sourceFile';
import { getFileInfo } from 'pyright-internal/analyzer/analyzerNodeInfo';
import { Counter } from './lsif-typescript/Counter';
import { PyrightFileSystem } from 'pyright-internal/pyrightFileSystem';
import { version } from 'package.json';
import { FileMatcher } from './FileMatcher';
import { sendStatus, StatusUpdater, withStatus } from './status';
import { scip } from './scip';
import { ScipPyrightConfig } from './config';
import { setProjectNamespace } from './symbols';

export class Indexer {
    program: Program;
    importResolver: ImportResolver;
    counter: Counter;
    pyrightConfig: ConfigOptions;
    projectFiles: Set<string>;

    public static inferProjectInfo(
        inferProjectVersionFromCommit: boolean,
        getPyprojectTomlContents: () => string | undefined
    ): { name: string | undefined; version: string | undefined } {
        let name = undefined;
        let version = undefined;
        try {
            const pyprojectTomlContents = getPyprojectTomlContents();
            if (pyprojectTomlContents) {
                const tomlMap = TOML.parse(pyprojectTomlContents);
                // See: https://packaging.python.org/en/latest/specifications/declaring-project-metadata/#specification
                let project = tomlMap['project'] as TOML.JsonMap | undefined;
                if (project) {
                    name = project['name'];
                    version = project['version'];
                }
                if (!name || !version) {
                    // See: https://python-poetry.org/docs/pyproject/
                    let tool = tomlMap['tool'] as TOML.JsonMap | undefined;
                    if (tool) {
                        let toolPoetry = tool['poetry'] as TOML.JsonMap | undefined;
                        if (toolPoetry) {
                            name = name ?? toolPoetry['name'];
                            version = version ?? toolPoetry['version'];
                        }
                    }
                }
            }
        } catch (_) {}
        name = typeof name === 'string' ? name : undefined;
        version = typeof version === 'string' ? version : undefined;
        if (!version && inferProjectVersionFromCommit) {
            try {
                version = child_process.execSync('git rev-parse HEAD').toString().trim();
            } catch (_) {}
        }
        return { name, version };
    }

    constructor(public scipConfig: ScipConfig) {
        this.counter = new Counter();

        // TODO: Consider using the same setup that is used by pyright `[tool.pyright]`
        //  The only problem is we probably _do_ want to try and analyze those tools.
        //
        //  Perhaps we should add `[tool.scip-python]` to the section and just use the same logic.
        //  I think that could be a pretty elegant solution to the problem (since you would already
        //  have the same methods of configuring, you might just want to change the include/exclude)
        //
        // private _getConfigOptions(host: Host, commandLineOptions: CommandLineOptions): ConfigOptions {
        const tempFile = new RealTempFile();
        let fs = new PyrightFileSystem(createFromRealFileSystem(tempFile));
        const serviceProvider = createServiceProvider(fs, tempFile);
        let config = new ScipPyrightConfig(scipConfig, fs, tempFile);
        this.pyrightConfig = config.getConfigOptions();

        if (scipConfig.extraPaths && scipConfig.extraPaths.length > 0) {
            const existing = this.pyrightConfig.defaultExtraPaths ?? [];
            this.pyrightConfig.defaultExtraPaths = [...existing, ...scipConfig.extraPaths.map((p) => UriEx.file(p))];
        }

        if (!scipConfig.projectName || !scipConfig.projectVersion) {
            const { name, version } = Indexer.inferProjectInfo(
                scipConfig.infer.projectVersionFromCommit,
                (): string | undefined => {
                    const tomlPath = config.findPyprojectTomlFileHereOrUp(scipConfig.projectRoot);
                    if (tomlPath) {
                        return fs.readFileSync(tomlPath, 'utf8');
                    }
                    return undefined;
                }
            );
            if (!scipConfig.projectName && name) {
                scipConfig.projectName = name;
            }
            if (!scipConfig.projectVersion && version) {
                scipConfig.projectVersion = version;
            }
        }

        const matcher = new FileMatcher(this.pyrightConfig, fs);
        this.projectFiles = new Set(matcher.matchFiles(this.pyrightConfig.include, this.pyrightConfig.exclude));
        if (scipConfig.targetOnly) {
            this.pyrightConfig.workspaceOnlyImports = true;
            scipConfig.targetOnly = path.resolve(scipConfig.targetOnly);
            const targetFiles: Set<string> = new Set();
            for (const file of this.projectFiles) {
                if (file.startsWith(scipConfig.targetOnly)) {
                    targetFiles.add(file);
                }
            }
            this.projectFiles = targetFiles;
        }

        sendStatus(`Total Project Files ${this.projectFiles.size}`);

        const host = new FullAccessHost(serviceProvider);
        this.importResolver = new ImportResolver(serviceProvider, this.pyrightConfig, host);

        this.program = new Program(this.importResolver, this.pyrightConfig, serviceProvider, undefined, true);
        this.program.setTrackedFiles([...this.projectFiles].map((p) => UriEx.file(p)));

        if (scipConfig.projectNamespace) {
            setProjectNamespace(scipConfig.projectName, this.scipConfig.projectNamespace!);
        }
    }

    public index(): void {
        const projectModulePrefixes = new Set<string>();
        const moduleSrcRoot = this.scipConfig.targetSourceRoot ?? this.scipConfig.projectRoot;
        for (const filepath of this.projectFiles) {
            const rel = path.relative(moduleSrcRoot, filepath);
            const topLevel = rel.split(path.sep)[0];
            if (topLevel && topLevel !== '.' && topLevel !== '..') {
                projectModulePrefixes.add(topLevel);
            }
        }
        for (const sibling of this.scipConfig.siblingPackages ?? []) {
            for (const entry of fs.readdirSync(sibling.srcPath)) {
                if (fs.statSync(path.join(sibling.srcPath, entry)).isDirectory()) {
                    projectModulePrefixes.add(entry);
                }
            }
        }

        const token = {
            isCancellationRequested: false,
            onCancellationRequested: Event.None,
        };

        const targetOnly = this.scipConfig.targetOnly;
        let failedAnalysis = 0;
        let safe_analyze = () => {
            try {
                return this.program.analyze({ openFilesTimeInMs: 10000, noOpenFilesTimeInMs: 10000 }, token, targetOnly);
            } catch (e) {
                // Allow 100 failed attempts before we give up analysis.
                //  This shouldn't happen often because it means there's a bug in pyright that
                //  completely stops execution. You'll at least get some output even if it is failing.
                sendStatus(`  Analysis partially failed with (${failedAnalysis}/100): ${e}`);
                if (failedAnalysis++ < 100) {
                    return true;
                } else {
                    sendStatus(`  Cancelling analysis, but continuing to write index. Please file an issue`);
                    return false;
                }
            }
        };

        const analyzer_fn = (progress: StatusUpdater) => {
            while (safe_analyze()) {
                const filesCompleted = this.program.getFileCount() - this.program.getFilesToAnalyzeCount().files;
                const filesTotal = this.program.getFileCount();
                progress.message(`${filesCompleted} / ${filesTotal}`);
            }
        };

        const globalSymbols = new Map();

        // Emit metadata
        this.scipConfig.writeIndex(
            new scip.Index({
                metadata: new scip.Metadata({
                    project_root: url.pathToFileURL(this.getProjectRoot()).toString(),
                    text_document_encoding: scip.TextEncoding.UTF8,
                    tool_info: new scip.ToolInfo({
                        name: 'scip-python',
                        version,
                        arguments: [],
                    }),
                }),
            })
        );

        let projectSourceFiles: SourceFile[] = [];

        withStatus('Collect project source files', () => {
            for (const filepath of this.projectFiles) {
                const sourceFile = this.program.getSourceFile(UriEx.file(filepath));
                if (!sourceFile) {
                    continue;
                }

                if (filepath.indexOf(this.getProjectRoot()) != 0) {
                    continue;
                }

                projectSourceFiles.push(sourceFile);
            }
        });

        withStatus('Analyze project and dependencies', analyzer_fn);

        this.program.getSourceFileInfoList().forEach((f: any) => f.sourceFile.stripForIndexing());

        let externalSymbols: Map<string, scip.SymbolInformation> = new Map();
        const BATCH_SIZE = 50;
        withStatus('Parse and emit SCIP', (progress) => {
            const typeEvaluator = this.program.evaluator!;
            let batch: scip.Document[] = [];

            const flushBatch = () => {
                if (batch.length === 0) {
                    return;
                }
                this.scipConfig.writeIndex(new scip.Index({ documents: batch }));
                batch = [];
            };

            projectSourceFiles.forEach((sourceFile, index) => {
                progress.progress(`(${index}/${projectSourceFiles.length}): ${sourceFile.getUri().getFilePath()}`);

                const filepath = sourceFile.getUri().getFilePath();
                let doc = new scip.Document({
                    relative_path: path.relative(this.getProjectRoot(), filepath),
                });

                const parseResults = sourceFile.getParseResults();
                const tree = parseResults?.parserOutput.parseTree!;

                let visitor = new TreeVisitor({
                    document: doc,
                    externalSymbols,
                    sourceFile: sourceFile,
                    evaluator: typeEvaluator,
                    program: this.program,
                    pyrightConfig: this.pyrightConfig,
                    scipConfig: this.scipConfig,
                    globalSymbols,
                    projectModulePrefixes,
                });

                try {
                    visitor.walk(tree);
                } catch (e) {
                    throw {
                        currentFilepath: sourceFile.getUri().getFilePath(),
                        error: e,
                    };
                }

                if (doc.occurrences.length === 0) {
                    return;
                }

                for (const sym of doc.symbols) {
                    sym.documentation = [];
                }

                batch.push(doc);
                if (batch.length >= BATCH_SIZE) {
                    flushBatch();
                }
            });

            flushBatch();
        });

        withStatus('Writing external symbols to SCIP index', () => {
            const externalSymbolIndex = new scip.Index();
            externalSymbolIndex.external_symbols = Array.from(externalSymbols.values());
            for (const sym of externalSymbolIndex.external_symbols) {
                sym.documentation = [];
            }
            this.scipConfig.writeIndex(externalSymbolIndex);
        });

        sendStatus(`Sucessfully wrote SCIP index to ${this.scipConfig.output}`);
    }

    private getProjectRoot(): string {
        if (this.scipConfig.workspaceRoot) {
            return this.scipConfig.workspaceRoot;
        }
        if (this.scipConfig.targetOnly && this.scipConfig.targetOnly !== '') {
            return this.scipConfig.targetOnly;
        }
        return this.scipConfig.projectRoot;
    }
}
