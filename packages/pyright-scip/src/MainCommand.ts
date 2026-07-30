import { Command, InvalidArgumentError } from 'commander';
import packageJson from '../package.json';

export interface IndexOptions {
    projectName: string;
    projectVersion: string;
    projectNamespace?: string;
    environment?: string;
    dev: boolean;
    output: string;
    cwd: string;
    targetOnly?: string;
    filter?: string;
    extraPaths?: string[];
    infer?: { projectVersionFromCommit: boolean };

    // Sharded parallel indexing (BE-2766). `shards` is the orchestrator directive (spawn k shard
    // processes); `shardIndex`/`shardCount` are set by the orchestrator on each child so it indexes only
    // its slice of the discovered file set. A child (shardCount > 1) never itself re-shards.
    shards?: number;
    shardIndex?: number;
    shardCount?: number;
    shardResultPath?: string;

    siblingPackages?: Array<{ name: string; srcPath: string }>;
    workspaceRoot?: string;
    targetSourceRoot?: string;

    quiet: boolean;
    showProgressRateLimit: number | undefined;
}

export interface SnapshotOptions extends IndexOptions {
    only: string;
    check: boolean;
    index: boolean;
}

export interface EnvironmentOptions {
    output: string;
}

export interface DetectOptions {
    cwd: string;
}

export const DEFAULT_OUTPUT_FILE = 'index.scip';

const parseOptionalNum = (value: string) => {
    if (value === undefined) {
        return undefined;
    }

    // parseInt takes a string and a radix
    const parsedValue = parseFloat(value);
    if (isNaN(parsedValue)) {
        throw new InvalidArgumentError('Not a number.');
    }
    return parsedValue;
};

const parseOptionalInt = (value: string) => {
    if (value === undefined) {
        return undefined;
    }
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) {
        throw new InvalidArgumentError('Not an integer.');
    }
    return parsedValue;
};

export function mainCommand(
    indexAction: (options: IndexOptions) => void,
    snapshotAction: (dir: string, options: SnapshotOptions) => void,
    environmentAction?: (options: EnvironmentOptions) => void,
    detectAction?: (options: DetectOptions) => void
): Command {
    const command = new Command();
    command.name('scip-python').version(packageJson.version).description('SCIP indexer for Python');

    command
        .command('index')
        .argument('[path]', 'directory to index (defaults to current working directory)')
        .option(
            '--project-name <name>',
            'The name of the current project, pypi name if applicable. The default empty project name only supports repository-local code navigation in Sourcegraph.',
            ''
        )
        .option(
            '--project-version <version>',
            'The version of the current project. If not provided, defaults to the current git revision (if found).'
        )
        .option('--project-namespace <namespace>', 'A prefix to prepend to all module definitions in the current index')
        .option('--target-only <path>', 'limit analysis to the following path')
        .option(
            '--output <path>',
            'Path to the output file. If this path is relative, it is interpreted relative to the value for --cwd.',
            DEFAULT_OUTPUT_FILE
        )
        .option('--filter <package-name>', 'index a single named package from a monorepo workspace')
        .option('--quiet', 'run without logging and status information', false)
        .option(
            '--show-progress-rate-limit <limit>',
            'minimum number of seconds between progress messages in the output.',
            parseOptionalNum
        )
        .option('--environment <json-file>', 'the environment json file (experimental)')
        .option('--dev', 'run in developer mode (experimental)', false)
        .option('--extra-types-path <paths...>', 'additional paths to include when resolving types')
        .option(
            '--shards <n>',
            'index in n parallel shard processes and merge the outputs (default 1 = single process). ' +
                'Also settable via SCIP_SHARDS; SCIP_DISABLE_SHARDING forces single-process.',
            parseOptionalInt
        )
        .option('--shard-index <i>', '[internal] this shard process index (set by the orchestrator)', parseOptionalInt)
        .option('--shard-count <k>', '[internal] total shard count (set by the orchestrator)', parseOptionalInt)
        .option('--shard-result <path>', '[internal] path to write this shard result summary json')
        .action((path, parsedOptions) => {
            parsedOptions.cwd = path || process.cwd();
            if (parsedOptions.extraTypesPath) {
                parsedOptions.extraPaths = Array.isArray(parsedOptions.extraTypesPath)
                    ? parsedOptions.extraTypesPath
                    : [parsedOptions.extraTypesPath];
            }
            if (parsedOptions.shardResult) {
                parsedOptions.shardResultPath = parsedOptions.shardResult;
            }
            indexAction(parsedOptions as IndexOptions);
        });

    command
        .command('snapshot-dir')
        .addHelpText('before', '[Unstable implementation detail, use at your own risk!]')
        .argument('<path>', 'the directory containing `input` directories')
        .option('--check', 'whether to update or check', false)
        .option('--only <name>', 'only generate snapshots for <name>')
        .option('--project-name <name>', 'the name of the current project, pypi name if applicable', '')
        .option('--project-version <version>', 'the name of the current project, pypi name if applicable', '')
        .option(
            '--output <path>',
            'Path to the output file. If this path is relative, it is interpreted relative to the value for --cwd.',
            DEFAULT_OUTPUT_FILE
        )
        .option('--environment <json-file>', 'the environment json file (experimental)')
        .option('--no-index', 'skip indexing (use existing index.scip)')
        .option('--quiet', 'run without logging and status information', false)
        .option(
            '--show-progress-rate-limit <limit>',
            'minimum number of seconds between progress messages in the output.',
            parseOptionalNum
        )
        .action((dir, parsedOptions) => {
            snapshotAction(dir, parsedOptions as SnapshotOptions);
        });

    command
        .command('environment-dump')
        .requiredOption('--output <path>', 'the output path for the json file')
        .action((parsedOptions) => {
            environmentAction!(parsedOptions as EnvironmentOptions);
        });

    command
        .command('detect')
        .argument('[path]', 'root directory to detect Python projects in')
        .action((path, parsedOptions) => {
            parsedOptions.cwd = path || process.cwd();
            detectAction!(parsedOptions as DetectOptions);
        });

    return command;
}
