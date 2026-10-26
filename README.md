# scip-python

Sourcegraph fork of [pyright](https://github.com/microsoft/pyright) focused on generating [SCIP](https://github.com/sourcegraph/scip) for python projects.

Project is primarily an addition to Pyright. At this time, there are no substantial changes to the `pyright` library.

## Kerno additions

This is Kerno's fork (`kernoio/scip-python`) of Sourcegraph's scip-python. It exists so that Kerno can run the indexer over arbitrary customer and benchmark repositories: it needs to discover the project layout before indexing, index a single package out of a monorepo, and finish large repositories within a bounded memory and time budget. The upstream introduction below predates these changes and no longer holds ("no substantial changes to the `pyright` library"): the fork upgrades `pyright-internal` and changes how symbols are classified, resolved and emitted.

All CLI examples below are run from `packages/pyright-scip` after `npm run build` (output in `dist/scip-python.js`), or with the released `scip-python.js` bundle (see Build and release). Option definitions live in `packages/pyright-scip/src/MainCommand.ts`.

### `detect`: project topology and import heatmap

```
scip-python detect [path]
```

Walks `path` (default: current directory), skipping `node_modules`, virtualenvs, caches, `dist`, `build`, and test directories (`tests`, `test`, `testing`, `__tests__`, `fixtures`), finds project markers (`pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile`) and prints a JSON description of the workspaces to stdout. It does not index anything. Implementation: `src/detectCommand.ts`.

Each workspace has `root`, `type` and `projects`. Each project has `name`, `path`, `parent`, `children`, `producesArtifacts`, `languages`, `buildTool`, `buildFiles` (manifest and lock files found), `dependencies`, and `config` (`configFile`, `type`). Projects may also carry an import heatmap:

- `packageImports`: third-party imports, as `directory -> package -> imported name -> count`. A whole-module import is counted under `*`.
- `moduleImports`: imports of modules inside the repository, same shape.

Example, for a repository containing `pyproject.toml` (project `svc`, depending on `requests`) and `svc/a.py` with `import requests`, `from requests import get` and `from svc import b`:

```
$ node dist/scip-python.js detect ./my-repo
{
  "tool": "python",
  "workspaces": [
    {
      "root": ".",
      "type": "standalone",
      "projects": [
        {
          "name": "svc",
          "path": ".",
          "parent": null,
          "children": [],
          "producesArtifacts": true,
          "languages": ["python"],
          "buildTool": "pip",
          "buildFiles": ["pyproject.toml"],
          "dependencies": [],
          "config": { "configFile": "pyproject.toml", "type": "python" },
          "packageImports": { "svc": { "requests": { "*": 1, "get": 1 } } },
          "moduleImports": { "svc": { "svc": { "b": 1 } } }
        }
      ]
    }
  ]
}
```

The `tool`/`workspaces` envelope is shared with scip-typescript's `detect` (see `detect.schema.json` in that repository). TOML parse failures are logged to stderr as `[scip-python detect] failed to parse TOML at <file>`.

### `index --filter`: one package from a monorepo

```
scip-python index ./my-monorepo --filter my-package --project-name my-package --output my-package.scip
```

`--filter <package-name>` indexes the single named package from a monorepo workspace, resolving imports of sibling workspace packages from their source. Use names as reported by `detect`. Output is a SCIP index at `--output` (default `index.scip`, relative to the indexed path).

Other Kerno-era changes to `index`:

- The directory to index is a positional argument (`index [path]`); the upstream `--cwd` option was removed.
- `--extra-types-path <paths...>` adds extra paths (for example third-party stubs) to type resolution.
- Symbols are classified as in-repository or external by file path rather than by module-name heuristics, and external symbols carry `SymbolRole.External`.
- Django and Django REST Framework stubs are bundled in the typeshed fallback, and TypeVar bound types from external packages are resolved.
- Pyproject parsing is tolerant (a missing or broken `pyproject.toml` does not abort indexing) and a failure on one file does not fail the whole run.

### Bounded-memory indexing (on by default)

Without this, a large repository grew resident memory until pyright's cache eviction dropped every parse tree, after which scip-python silently skipped the evicted files and still exited 0, producing a partial index. The emit loop now re-parses evicted files on demand, releases each file's parse and bind info after its document is built, and trims the type cache every 250 files only when the heap nears its cap. Measured in the commit message on a 12,589-file repository: complete index at a 4096 MB heap with peak RSS of about 3,975 MB, where the previous behaviour silently emitted 4,480 documents at the same cap.

Environment variables (`src/indexer.ts`):

| Variable | Effect |
| --- | --- |
| `SCIP_DISABLE_MEMORY_SMOOTHING` | Restores the previous (legacy) behaviour. |
| `SCIP_MEMORY_TRIM_EVERY` | Number of files between trim checks (default 250). |

### `--shards`: parallel indexing

```
scip-python index ./my-repo --project-name my-repo --shards 4 --output index.scip
```

Splits the discovered files into `n` disjoint shards (files in the same package or directory stay together, balanced by file count), indexes each in its own node process, and merges the outputs into one index. Default is 1, which is the unchanged single-process path. Each shard gets a heap cap of `max(2048, 4096 / n)` MB, so sharding increases parallelism but does not reduce total memory. The orchestrator checks the per-shard result summaries and aborts with a non-zero exit if a shard failed, skipped files, or the merged document count does not equal the summed shard counts, instead of writing a silently partial index. On success it prints, for example:

```
Sharded indexing: 2 shards, per-shard heap cap 2048 MB (...)
Sharded index complete: 3 documents (of 3 project files; 0 empty, 0 skipped), 0 external symbols. Wrote SCIP index to index.scip
```

Environment variables (`src/sharding.ts`):

| Variable | Effect |
| --- | --- |
| `SCIP_SHARDS` | Shard count if `--shards` is not given. |
| `SCIP_DISABLE_SHARDING` | Forces the single-process path regardless of the above. |
| `SCIP_SHARD_MAX_OLD_SPACE` | Per-shard node heap cap in MB. |

`--shard-index`, `--shard-count` and `--shard-result` are internal flags set by the orchestrator on its child processes; do not pass them by hand.

### Build and release

- Workflow: `.github/workflows/release.yml`. It runs on every push to `main`.
- Version: a CalVer tag `YYYY.M.D` (for example `2026.7.30`), with `.N` appended for further releases on the same day. The tag is created and pushed by the workflow.
- Steps: `npm ci`, `npm run bundle` in `packages/pyright-scip` (webpack), then `scip-python.js` and `typeshed-fallback/` are zipped.
- Output: a GitHub release on this repository with the asset `scip-python.zip`. Unzip it and run `node scip-python.js <command>`; `typeshed-fallback/` must stay next to the script.
- Local build: `cd packages/pyright-scip && npm ci && npm run build-agent` (development) or `npm run build` (production). See `packages/pyright-scip/AGENTS.md` for the test commands.
- Not published to npm: this fork does not publish to npm or Docker Hub. The upstream workflows that did (`scip-release.yml`, `scip-docker.yml`) were removed in commit `efe81d92b` ("remove upstream workflows"). The `@sourcegraph/scip-python` name and version 0.6.6 in `packages/pyright-scip/package.json` are inherited from upstream and are not used for distribution; the release workflow does not bump them.
- Consumption: the only consumer is kernoio/aicore, which downloads `scip-python.zip` from the GitHub release whose tag is pinned in `pythonAsset` (`repo = "kernoio/scip-python"`, `version = "<tag>"`) in `agent/libs/scip/src/main/kotlin/io/kerno/scip/tools/ScipTool.kt`. aicore fetches the release by that exact tag, verifies the asset against the sha256 digest GitHub reports, and caches it under `<kerno home>/assets/scip/tools/scip-python/<tag>/`.
- Rolling out a new indexer build: merge to `main` here, note the CalVer tag the workflow creates (Releases page), then update `version` in `pythonAsset` in kernoio/aicore. aicore keeps using the previously pinned tag until that change is merged.
- Because the workflow triggers on every push to `main`, merging any change to `main`, including documentation, cuts a release.

### Syncing with upstream pyright

`dev/sync_pyright.sh` adds `https://github.com/microsoft/pyright` as the `upstream` remote, mirrors its `main` into a local `pyright-mirror` branch, and merges that into a new `pyright-sync-<date>` branch, recording the mirrored commit in `pyright-last-commit`. The script predates the Kerno changes and checks out the branch `scip`, whereas this fork's default branch is `main`; adjust before use. The fork has also moved `pyright-internal` from 1.1.301 to 1.1.408 outside this script, so expect substantial conflicts. This repository has no remote pointing at `sourcegraph/scip-python`; there is no automated sync.

## Pre-requisites

scip-python only supports Python 3.10+.

```
$ # Install scip-python
$ npm install -g @sourcegraph/scip-python
```

scip-python requires Node v16 or newer. See the [Dockerfile](https://github.com/sourcegraph/scip-python/blob/scip/Dockerfile.autoindex) for an exact SHA that is tested.

scip-python uses `pip` to attempt to determine the versions and names of the packages available in your environment. If you do not use pip to install the packages, you can instead use the `--environment` flag to supply a list of packages to use as the environment. This will skip any calls out to pip to determine the state of your env. See [Environment](##-environment) for more information.


## Usage

```
$ npm install @sourcegraph/scip-python

$ # NOTE: make sure to activate your virtual environment before running
$ scip-python index . --project-name=$MY_PROJECT

$ # Make sure to point towards the sourcegraph instance you're interested in uploading to.
$ #     more information at https://github.com/sourcegraph/src-cli
$ src code-intel upload
```

If you hit an out-of-memory error, increase the memory limit using the environment variable `NODE_OPTIONS="--max-old-space-size=8192"` to increase the heap size limit to 8GB (or higher, if needed).

### target-only

To run scip-python over only a particular directory, you can use the `--target-only` flag. Example:

```
$ scip-python index . --project-name=$MY_PROJECT --target-only=src/subdir
```

### project-namespace

Additionally, if your project is loaded with some prefix, you can use the `--project-namespace` to put a namespace before all the generated symbols for this project.

```
$ scip-python index . --project-name=$MY_PROJECT --project-namespace=implicit.namespace
```

Now all symbols will have `implicit.namespace` prepended to their symbol, so that you can use it for cross repository navigation, even if the directory structure in your current project does not explicitly show `implicit/namespace/myproject/__init__.py`.

## Environment

The environment file format is a JSON list of `PythonPackage`s. The `PythonPackage` has the following form:

```json
{
    "name": "PyYAML",
    "version": "6.0",
    "files": [
      "PyYAML-6.0.dist-info/INSTALLER",
      ...
      "yaml/__init__.py",
      "yaml/composer.py",
      "yaml/tokens.py",
      ...
    ]
},
```

Where:
- `name`:
  - The name of the package. Often times this is the same as the module, but is not always the case.
  - For example, `PyYAML` is the name of the package, but the module is `yaml` (i.e. `import yaml`).
- `version`:
  - The vesion of the package. This is used to generate stable references to external packages.
- `files`:
  - A list of all the files that are a member of this package.
  - Some packages declare multiple modules, so these should all be included.

The environment file should be a list of these packages:

```json
[
  { "name": "PyYAML", "version": "6.0", "files": [...] },
  { "name": "pytorch", "version": "3.0", "files": [..] },
  ...
]
```

To use the environment file, you should call scip-python like so:

```
$ scip-python index --project-name=$MY_PROJECT --environment=path/to/env.json
```

If you're just using pip, this should not be required. We should calculate this from the pip environment. If you experience any bugs, please report them. The goal is that we support standard pip installation without additional configuration. If there is other python tooling that can generate this information, you can file an issue and we'll see if we can support it as well.

## Sourcegraph Example Configuration

Using the usage example above may be quite simple to add a CI pipeline (perhaps using the `sourcegraph/scip-python:autoindex`) image
and uploading the corresponding index.scip file to Sourcegraph only for commits that you are intersted in (whether that's only HEAD
or every branch).

However, if you're interested in using the Auto-Indexing feature, an example configuration skeleton can be found below:

```
{
    "index_jobs": [
        {
            "indexer": "sourcegraph/scip-python:autoindex",
            "local_steps": [
                "pip install . || true",
            ],
            "indexer_args": [
              "scip-python", "index", ".",
              "--project-name", "<your name here>",
              "--project-version", "_"
            ],
            "steps": [],
            "outfile": "",
            "root": ""
        }
    ],
    "shared_steps": []
}
```

## To compare upstream from pyright

You can go to the following [Sourcegraph
link](https://sourcegraph.com/github.com/sourcegraph/scip-python/-/compare/pyright-mirror...scip)
to compare the changes we've made from pyright.

The changes are almost exclusively in the folder `packages/pyright-scip/` and various `package.json` files
due to adding some additional dependencies.

In general, we've tried to make very little changes to anything inside of the pyright packages.
The only changes that are inside there at this point are:
- Not bail out of indexing if it's taking a long time
- Not throw away indexed files if memory usage gets high
- Allow parsing of some additional files

## Contributing

See [pyright-scip/CONTRIBUTING.md](./packages/pyright-scip/CONTRIBUTING.md).
