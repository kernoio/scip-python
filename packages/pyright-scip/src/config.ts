import * as TOML from '@iarna/toml';
import * as JSONC from 'jsonc-parser';
import { findPythonSearchPaths, getTypeShedFallbackPath } from 'pyright-internal/analyzer/pythonPathUtils';
import { ImportLogger } from 'pyright-internal/analyzer/importLogger';

import { CommandLineOptions } from 'pyright-internal/common/commandLineOptions';
import { ConfigOptions } from 'pyright-internal/common/configOptions';
import { FullAccessHost } from 'pyright-internal/common/fullAccessHost';
import { Host } from 'pyright-internal/common/host';
import { defaultStubsDirectory } from 'pyright-internal/common/pathConsts';
import { combinePaths } from 'pyright-internal/common/pathUtils';
import { RealTempFile } from 'pyright-internal/common/realFileSystem';
import { PyrightFileSystem } from 'pyright-internal/pyrightFileSystem';
import { createServiceProvider } from 'pyright-internal/common/serviceProviderExtensions';
import { Uri } from 'pyright-internal/common/uri/uri';
import { forEachAncestorDirectory, getFileSpec, isDirectory } from 'pyright-internal/common/uri/uriUtils';
import { ScipConfig } from './lib';
import { sendStatus } from './status';

const configFileNames = ['scip-pyrightconfig.json', 'pyrightconfig.json'];
const pyprojectTomlName = 'pyproject.toml';

export class ScipPyrightConfig {
    fs: PyrightFileSystem;
    _serviceProvider: ReturnType<typeof createServiceProvider>;
    _configFilePath: Uri | undefined;
    _configOptions: ConfigOptions;

    _console: Console = console;
    _typeCheckingMode = 'basic';

    constructor(scipConfig: ScipConfig, fs: PyrightFileSystem, tempFile: RealTempFile) {
        this.fs = fs;
        this._serviceProvider = createServiceProvider(fs, tempFile);

        this._configOptions = new ConfigOptions(Uri.file(scipConfig.projectRoot, this._serviceProvider));
        this._configOptions.checkOnlyOpenFiles = false;
        this._configOptions.indexing = true;
        this._configOptions.useLibraryCodeForTypes = false;
        this._configOptions.verboseOutput = false;
    }

    getConfigOptions(): ConfigOptions {
        const host = new FullAccessHost(this._serviceProvider);

        const options = new CommandLineOptions(process.cwd(), false);

        let config = this._getConfigOptions(host, options);
        config.checkOnlyOpenFiles = false;
        config.indexing = true;
        config.useLibraryCodeForTypes = false;
        config.verboseOutput = false;
        config.typeshedPath = this._configOptions.typeshedPath || getTypeShedFallbackPath(this.fs);

        return config;
    }

    private _getConfigOptions(host: Host, commandLineOptions: CommandLineOptions): ConfigOptions {
        const optionRoot = commandLineOptions.executionRoot;
        let projectRoot: Uri = Uri.is(optionRoot)
            ? optionRoot
            : typeof optionRoot === 'string' && optionRoot.length > 0
            ? Uri.file(optionRoot, this._serviceProvider)
            : Uri.file(process.cwd(), this._serviceProvider);

        let configFilePath: Uri | undefined;
        let pyprojectFilePath: Uri | undefined;

        if (commandLineOptions.configFilePath) {
            configFilePath = projectRoot.resolvePaths(commandLineOptions.configFilePath);
            if (!this.fs.existsSync(configFilePath)) {
                this._console.info(`Configuration file not found at ${configFilePath.toUserVisibleString()}.`);
                configFilePath = projectRoot;
            } else {
                if (configFilePath.lastExtension.endsWith('.json')) {
                    projectRoot = configFilePath.getDirectory();
                } else {
                    projectRoot = configFilePath;
                    configFilePath = this._findConfigFile(configFilePath);
                    if (!configFilePath) {
                        this._console.info(`Configuration file not found at ${projectRoot.toUserVisibleString()}.`);
                    }
                }
            }
        } else if (commandLineOptions.executionRoot) {
            configFilePath = this._findConfigFile(projectRoot);

            if (!configFilePath && !commandLineOptions.fromLanguageServer) {
                configFilePath = this._findConfigFileHereOrUp(projectRoot);
            }

            if (configFilePath) {
                projectRoot = configFilePath.getDirectory();
            } else {
                sendStatus(`No configuration file found.`);
                configFilePath = undefined;
            }
        }

        if (!configFilePath) {
            pyprojectFilePath = this._findPyprojectTomlFile(projectRoot);

            if (!pyprojectFilePath && !commandLineOptions.fromLanguageServer) {
                pyprojectFilePath = this.findPyprojectTomlFileHereOrUp(projectRoot);
            }

            if (pyprojectFilePath) {
                projectRoot = pyprojectFilePath.getDirectory();
                sendStatus(`pyproject.toml file found at ${projectRoot.toUserVisibleString()}.`);
            } else {
                sendStatus(`No pyproject.toml file found.`);
            }
        }

        const configOptions = new ConfigOptions(projectRoot);
        const defaultExcludes = [
            '**/node_modules',
            '**/__pycache__',
            '**/.*',
            '**/tests',
            '**/test',
            '**/testing',
            '**/__tests__',
            '**/test_*.py',
            '**/*_test.py',
            '**/conftest.py',
        ];

        if (commandLineOptions.configSettings.pythonPath) {
            configOptions.pythonPath = Uri.file(commandLineOptions.configSettings.pythonPath, this._serviceProvider);
        }

        configOptions.defaultPythonPlatform = commandLineOptions.configSettings.pythonPlatform;
        configOptions.defaultPythonVersion = commandLineOptions.configSettings.pythonVersion;
        configOptions.ensureDefaultExtraPaths(
            this.fs,
            commandLineOptions.configSettings.autoSearchPaths || false,
            commandLineOptions.configSettings.extraPaths
        );

        if (commandLineOptions.configSettings.includeFileSpecs.length > 0) {
            commandLineOptions.configSettings.includeFileSpecs.forEach((fileSpec) => {
                configOptions.include.push(getFileSpec(projectRoot, fileSpec));
            });
        }

        if (commandLineOptions.configSettings.excludeFileSpecs.length > 0) {
            commandLineOptions.configSettings.excludeFileSpecs.forEach((fileSpec) => {
                configOptions.exclude.push(getFileSpec(projectRoot, fileSpec));
            });
        }

        if (commandLineOptions.configSettings.ignoreFileSpecs.length > 0) {
            commandLineOptions.configSettings.ignoreFileSpecs.forEach((fileSpec) => {
                configOptions.ignore.push(getFileSpec(projectRoot, fileSpec));
            });
        }

        if (!configFilePath && commandLineOptions.executionRoot) {
            const execRoot = typeof commandLineOptions.executionRoot === 'string'
                ? Uri.file(commandLineOptions.executionRoot, this._serviceProvider)
                : commandLineOptions.executionRoot as Uri;

            if (commandLineOptions.configSettings.includeFileSpecs.length === 0) {
                configOptions.include.push(getFileSpec(execRoot, '.'));
            }

            if (commandLineOptions.configSettings.excludeFileSpecs.length === 0) {
                defaultExcludes.forEach((exclude) => {
                    configOptions.exclude.push(getFileSpec(execRoot, exclude));
                });
            }
        }

        this._configFilePath = configFilePath || pyprojectFilePath;

        let configJsonObj: object | undefined;
        if (configFilePath) {
            this._console.info(`Loading configuration file at ${configFilePath.toUserVisibleString()}`);
            configJsonObj = this._parseJsonConfigFile(configFilePath);
        } else if (pyprojectFilePath) {
            sendStatus(`Loading pyproject.toml file at ${pyprojectFilePath.toUserVisibleString()}`);
            configJsonObj = this._parsePyprojectTomlFile(pyprojectFilePath);
        }

        if (configJsonObj) {
            const configFileDir = this._configFilePath!.getDirectory();

            configOptions.initializeFromJson(
                configJsonObj,
                configFileDir,
                this._serviceProvider,
                host
            );

            if (configOptions.include.length === 0) {
                this._console.info(`No include entries specified; assuming ${configFileDir.toUserVisibleString()}`);
                configOptions.include.push(getFileSpec(configFileDir, '.'));
            }

            if (configOptions.exclude.length === 0) {
                defaultExcludes.forEach((exclude) => {
                    this._console.info(`Auto-excluding ${exclude}`);
                    configOptions.exclude.push(getFileSpec(configFileDir, exclude));
                });

                if (configOptions.autoExcludeVenv === undefined) {
                    configOptions.autoExcludeVenv = true;
                }
            }
        } else {
            configOptions.autoExcludeVenv = true;
            configOptions.applyDiagnosticOverrides(commandLineOptions.configSettings.diagnosticSeverityOverrides);
        }

        if (commandLineOptions.configSettings.analyzeUnannotatedFunctions !== undefined) {
            configOptions.diagnosticRuleSet.analyzeUnannotatedFunctions =
                commandLineOptions.configSettings.analyzeUnannotatedFunctions;
        }

        const reportDuplicateSetting = (settingName: string, configValue: number | string | boolean) => {
            const settingSource = commandLineOptions.fromLanguageServer
                ? 'the client settings'
                : 'a command-line option';
            this._console.warn(
                `The ${settingName} has been specified in both the config file and ` +
                    `${settingSource}. The value in the config file (${configValue}) ` +
                    `will take precedence`
            );
        };

        if (commandLineOptions.configSettings.venvPath) {
            if (!configOptions.venvPath) {
                configOptions.venvPath = projectRoot.resolvePaths(commandLineOptions.configSettings.venvPath);
            } else {
                reportDuplicateSetting('venvPath', configOptions.venvPath.toUserVisibleString());
            }
        }

        if (commandLineOptions.configSettings.typeshedPath) {
            if (!configOptions.typeshedPath) {
                configOptions.typeshedPath = projectRoot.resolvePaths(commandLineOptions.configSettings.typeshedPath);
            } else {
                reportDuplicateSetting('typeshedPath', configOptions.typeshedPath.toUserVisibleString());
            }
        }

        configOptions.verboseOutput = commandLineOptions.configSettings.verboseOutput ?? configOptions.verboseOutput;
        configOptions.checkOnlyOpenFiles = !!commandLineOptions.languageServerSettings.checkOnlyOpenFiles;
        configOptions.autoImportCompletions = !!commandLineOptions.languageServerSettings.autoImportCompletions;
        configOptions.indexing = !!commandLineOptions.languageServerSettings.indexing;
        configOptions.taskListTokens = commandLineOptions.languageServerSettings.taskListTokens;
        configOptions.logTypeEvaluationTime = !!commandLineOptions.languageServerSettings.logTypeEvaluationTime;
        configOptions.typeEvaluationTimeThreshold = commandLineOptions.languageServerSettings.typeEvaluationTimeThreshold;

        if (configOptions.useLibraryCodeForTypes === undefined) {
            configOptions.useLibraryCodeForTypes = !!commandLineOptions.configSettings.useLibraryCodeForTypes;
        } else if (commandLineOptions.configSettings.useLibraryCodeForTypes !== undefined) {
            reportDuplicateSetting('useLibraryCodeForTypes', configOptions.useLibraryCodeForTypes);
        }

        if (commandLineOptions.configSettings.stubPath) {
            if (!configOptions.stubPath) {
                configOptions.stubPath = projectRoot.resolvePaths(commandLineOptions.configSettings.stubPath);
            } else {
                reportDuplicateSetting('stubPath', configOptions.stubPath.toUserVisibleString());
            }
        }

        if (configOptions.stubPath) {
            if (!this.fs.existsSync(configOptions.stubPath) || !isDirectory(this.fs, configOptions.stubPath)) {
                this._console.warn(`stubPath ${configOptions.stubPath.toUserVisibleString()} is not a valid directory.`);
            }
        } else {
            configOptions.stubPath = projectRoot.resolvePaths(defaultStubsDirectory);
        }

        if (configOptions.venvPath) {
            if (!this.fs.existsSync(configOptions.venvPath) || !isDirectory(this.fs, configOptions.venvPath)) {
                this._console.error(`venvPath ${configOptions.venvPath.toUserVisibleString()} is not a valid directory.`);
            }

            configOptions.venv = configOptions.venv ?? this._configOptions.venv;
            if (configOptions.venv) {
                const fullVenvPath = configOptions.venvPath.resolvePaths(configOptions.venv);

                if (!this.fs.existsSync(fullVenvPath) || !isDirectory(this.fs, fullVenvPath)) {
                    this._console.error(
                        `venv ${configOptions.venv} subdirectory not found in venv path ${configOptions.venvPath.toUserVisibleString()}.`
                    );
                } else {
                    const importLogger = new ImportLogger();
                    if (findPythonSearchPaths(this.fs, configOptions, host, importLogger) === undefined) {
                        this._console.error(
                            `site-packages directory cannot be located for venvPath ` +
                                `${configOptions.venvPath.toUserVisibleString()} and venv ${configOptions.venv}.`
                        );

                        if (configOptions.verboseOutput) {
                            importLogger.getLogs().forEach((diag) => {
                                this._console.error(`  ${diag}`);
                            });
                        }
                    }
                }
            }
        }

        if (configOptions.venv) {
            if (!configOptions.venvPath) {
                this._console.warn(`venvPath not specified, so venv settings will be ignored.`);
            }
        }

        if (configOptions.typeshedPath) {
            if (!this.fs.existsSync(configOptions.typeshedPath) || !isDirectory(this.fs, configOptions.typeshedPath)) {
                this._console.error(`typeshedPath ${configOptions.typeshedPath.toUserVisibleString()} is not a valid directory.`);
            }
        }

        return configOptions;
    }

    private _findConfigFile(searchPath: Uri): Uri | undefined {
        for (const name of configFileNames) {
            const fileName = searchPath.resolvePaths(name);
            if (this.fs.existsSync(fileName)) {
                return fileName;
            }
        }
        return undefined;
    }

    private _findConfigFileHereOrUp(searchPath: Uri): Uri | undefined {
        return forEachAncestorDirectory(searchPath, (ancestor) => this._findConfigFile(ancestor));
    }

    private _findPyprojectTomlFile(searchPath: Uri): Uri | undefined {
        const fileName = searchPath.resolvePaths(pyprojectTomlName);
        if (this.fs.existsSync(fileName)) {
            return fileName;
        }
        return undefined;
    }

    public findPyprojectTomlFileHereOrUp(searchPath: string | Uri): Uri | undefined {
        const uriPath = typeof searchPath === 'string' ? Uri.file(searchPath, this._serviceProvider) : searchPath;
        return forEachAncestorDirectory(uriPath, (ancestor) => this._findPyprojectTomlFile(ancestor));
    }

    private _parseJsonConfigFile(configPath: Uri): object | undefined {
        return this._attemptParseFile(configPath, (fileContents) => {
            const errors: JSONC.ParseError[] = [];
            const result = JSONC.parse(fileContents, errors, { allowTrailingComma: true });
            if (errors.length > 0) {
                throw new Error('Errors parsing JSON file');
            }

            return result;
        });
    }

    private _attemptParseFile(
        filePath: Uri,
        parseCallback: (contents: string, attempt: number) => object | undefined
    ): object | undefined {
        let fileContents = '';
        let parseAttemptCount = 0;

        while (true) {
            try {
                fileContents = this.fs.readFileSync(filePath, 'utf8');
            } catch {
                this._console.error(`Config file "${filePath.toUserVisibleString()}" could not be read.`);
                return undefined;
            }

            let parseFailed = false;
            try {
                return parseCallback(fileContents, parseAttemptCount + 1);
            } catch (e: any) {
                parseFailed = true;
            }

            if (!parseFailed) {
                break;
            }

            if (parseAttemptCount++ >= 5) {
                this._console.error(`Config file "${filePath.toUserVisibleString()}" could not be parsed. Verify that format is correct.`);
                return undefined;
            }
        }

        return undefined;
    }

    private _parsePyprojectTomlFile(pyprojectPath: Uri): object | undefined {
        return this._attemptParseFile(pyprojectPath, (fileContents, attemptCount) => {
            try {
                const configObj = TOML.parse(fileContents);
                if (configObj && configObj.tool && (configObj.tool as TOML.JsonMap).scip) {
                    return (configObj.tool as TOML.JsonMap).scip as object;
                }

                if (configObj && configObj.tool && (configObj.tool as TOML.JsonMap).pyright) {
                    return (configObj.tool as TOML.JsonMap).pyright as object;
                }
            } catch (e: any) {
                this._console.error(`Pyproject file parse attempt ${attemptCount} error: ${JSON.stringify(e)}`);
                throw e;
            }

            this._console.error(`Pyproject file "${pyprojectPath.toUserVisibleString()}" is missing "[tool.pyright]" section.`);
            return undefined;
        });
    }
}
