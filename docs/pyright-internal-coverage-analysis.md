# pyright-internal Coverage Analysis for SCIP Indexing

Date: 2025-03-13
Corpus: langflow (1929 Python files, 41MB SCIP index)

## Goal

Determine how much of pyright-internal is actually needed to run the SCIP
indexer (`indexAction`), to scope a Kotlin port of the Python type-checking
pipeline.

## Methodology

Three increasingly precise analyses were performed:

1. **esbuild** (module-level treeshaking) — which files are transitively imported
2. **Rollup** (function-level treeshaking) — which top-level declarations are statically reachable
3. **V8 runtime coverage** — which code actually executes when indexing langflow

## Results Summary

| Approach | Kept | Removed |
|----------|------|---------|
| esbuild module-level | 125/148 files (84%) | 23 files |
| Rollup function-level | ~80K/121K lines (66%) | ~41K lines |
| V8 runtime coverage | ~61% of bundle bytes | ~39% |

## Runtime Coverage by Directory

| Directory | Coverage | Files | Verdict |
|-----------|----------|-------|---------|
| parser/ | 81% | 8 | Must port — full Python parser |
| analyzer/ | 69% | 58 | Core type system, ~30% dead branches |
| localization/ | 52% | 1 | Error messages, could stub |
| common/ | 42% | 30 | Utilities, port as needed |
| (root) | 42% | 2 | PyrightFileSystem only |
| languageService/ | 11% | 18 | Almost entirely skippable |
| commands/ | 9% | 1 | Skip |

## Files Not Needed At All (not in bundle)

30 files / ~9,417 lines — server infrastructure, CLI, background workers:

- (root): backgroundAnalysis, backgroundAnalysisBase, backgroundThreadBase,
  languageServerBase, nodeMain, nodeServer, pyright, server, workspaceFactory
- analyzer/: analysis, backgroundAnalysisProgram, importResult,
  packageTypeReport, packageTypeVerifier, service
- commands/: commandController, commandResult, commands, createTypeStub,
  quickActionCommand, restartServer
- common/: chokidarFileWatcherProvider, deferred, envVarUtils, extensions,
  fileBasedCancellationUtils, progressReporter, uriParser
- languageService/: analyzerServiceExecutor, codeActionProvider

## languageService/ Detail (11% coverage — candidate for removal)

| File | Coverage | Notes |
|------|----------|-------|
| hoverProvider.ts | 68% | Used by treeVisitor for doc extraction |
| tooltipUtils.ts | 83% | Used by hoverProvider |
| documentSymbolProvider.ts | 44% | Partially used |
| All others | 2-18% | Completions, rename, imports, references — LSP only |

## Per-File Coverage (analyzer/ — the core)

High coverage (>70%, must port):
- typeEvaluator.ts: 74% (42K samples — the beast)
- binder.ts: 92%
- types.ts: 90%
- typeUtils.ts: 85%
- typeGuards.ts: 86%
- codeFlowEngine.ts: 84%
- tokenizer.ts: 86%
- checker.ts: 54% (large file, still significant absolute coverage)
- constraintSolver.ts: 78%
- dataClasses.ts: 78%
- parseTreeWalker.ts: 89%

Low coverage (<30%, candidates for removal/stubbing):
- tracePrinter.ts: 3%
- codeFlowUtils.ts: 1%
- testWalker.ts: 11%
- cacheManager.ts: 13%
- functionTransform.ts: 13%
- importStatementUtils.ts: 19%
- pythonPathUtils.ts: 25%
- program.ts: 29% (large file, but only env-setup paths used)

## Porting Estimate

For a Kotlin SCIP indexer:
- 66 files with >50% coverage: ~84,455 lines (the core)
- 52 files with 1-49% coverage: ~27,162 lines (partial, can be stubbed)
- 30 files not needed: ~9,417 lines (skip entirely)

## Reproduction

```bash
# 1. Clone langflow into test-repos/
git clone --depth 1 https://github.com/langflow-ai/langflow.git test-repos/langflow

# 2. Run indexer with v8 coverage
cd test-repos/langflow
NODE_V8_COVERAGE=/tmp/v8-coverage node ../../packages/pyright-scip/index.js \
  index . --project-name=langflow --project-version=0.0.0 \
  --output=/tmp/langflow.scip --environment=/tmp/empty-env.json --quiet

# 3. Analyze (scripts in /tmp/ from the session that produced this)
node /tmp/analyze-tree.mjs        # esbuild metafile analysis
node /tmp/v8-deep-coverage.mjs    # v8 + source-map coverage
```
