import * as fs from 'fs';

import { scip } from './scip';

/**
 * Sharded parallel indexing (BE-2766).
 *
 * The indexer is single-threaded and ~100% CPU-bound on one core (see the scippy-timeprofile report),
 * so wall time scales with a single core. This module splits the discovered file set into k disjoint
 * shards, each indexed by its own node process, and merges the shard `.scip` outputs into one index.
 *
 * Correctness rests on two facts about the fork:
 *   1. SCIP symbols are declaration-anchored global strings derived from the module path, independent of
 *      which shard emits a file, so a reference in one shard to a definition owned by another shard
 *      resolves to the same symbol string and cross-references match after the merge. The referenced
 *      file is analyzed on-demand by pyright's import resolver even when it is not this shard's tracked
 *      subset, so resolution is preserved.
 *   2. `writeIndex` appends serialized `scip.Index` messages and protobuf repeated-field concatenation
 *      is itself a valid index, so merging shard outputs is a deserialize/dedup/re-emit.
 *
 * The pure functions here (partition, merge, config resolution) are unit-tested in isolation; the
 * process orchestration lives in `main-impl.ts`.
 */

/** Result summary a shard child writes next to its output so the orchestrator can enforce the guard. */
export interface ShardResult {
    /** Total discovered project files (before the shard partition) — identical across shards. */
    total: number;
    /** Files assigned to this shard by the partition. */
    assigned: number;
    /** Documents emitted (files with at least one occurrence). */
    emitted: number;
    /** Files that produced an empty document (no occurrences) and were legitimately not emitted. */
    empty: number;
    /** Files skipped due to a missing parse tree or a walk error — the silent-partial failure path. */
    skipped: number;
}

/**
 * Resolve the effective shard count. `SCIP_DISABLE_SHARDING` is the kill-switch (forces 1, the
 * byte-identical single-process path). Otherwise `--shards` wins, then `SCIP_SHARDS`, else 1.
 */
export function resolveShardCount(
    shardsOption: number | undefined,
    env: Record<string, string | undefined> = process.env
): number {
    if (env.SCIP_DISABLE_SHARDING) {
        return 1;
    }
    const fromEnv = env.SCIP_SHARDS ? parseInt(env.SCIP_SHARDS, 10) : undefined;
    const raw = shardsOption ?? fromEnv ?? 1;
    if (!Number.isFinite(raw) || raw < 1) {
        return 1;
    }
    return Math.floor(raw);
}

/**
 * Per-shard node heap cap (MB). `SCIP_SHARD_MAX_OLD_SPACE` overrides; k=1 never reaches here (untouched
 * single-process path).
 *
 * Measured reality (posthog bf342ab5): a shard's resident set does NOT scale as 1/k. Because a densely
 * interconnected monorepo's import closure spans the whole project, every shard analyzes ~the full
 * dependency graph to resolve its slice's references, so each shard's memory floor is close to a full
 * smoothed run's (~2 GB with BE-2761 trimming), not total/k. A 1024 MB cap is therefore marginal — it
 * completed under a quiet host but OOM-crashed under load (the loud-partial guard caught it, no silent
 * partial). The cap is floored at **2048 MB** so a shard has GC headroom above its ~1 GB active floor and
 * completes reliably. Consequence: the ~4 GB total posture is met at **k = 2** (2 × 2048); higher k
 * trades RAM for parallelism (total ≈ k × 2048 ceiling; smoothing keeps actual below). This is NOT the
 * k × 4096 anti-pattern, but it is honest that sharding does not *reduce* peak RSS for this workload.
 */
export function resolveShardHeapCap(
    k: number,
    env: Record<string, string | undefined> = process.env,
    totalBudgetMb = 4096
): number {
    const override = env.SCIP_SHARD_MAX_OLD_SPACE ? parseInt(env.SCIP_SHARD_MAX_OLD_SPACE, 10) : undefined;
    if (override && Number.isFinite(override) && override > 0) {
        return Math.floor(override);
    }
    return Math.max(2048, Math.round(totalBudgetMb / Math.max(1, k)));
}

/**
 * Deterministically partition `files` into k disjoint shards whose union is the input set. Files that
 * share a group key (their package/directory) are kept together to maximize intra-shard symbol
 * resolution and minimize cross-shard dependency re-parsing; groups are balanced across shards by
 * longest-processing-time bin-packing on file count. The result is a stable function of
 * (files, k, groupKey) — every shard child computes the identical partition and keeps its own index,
 * which is what guarantees the shards are disjoint and complete.
 */
export function partitionFiles(files: string[], k: number, groupKey: (file: string) => string): string[][] {
    const shardCount = Math.max(1, Math.floor(k));
    const sorted = [...new Set(files)].sort();

    if (shardCount === 1) {
        return [sorted];
    }

    // Group by package/directory key.
    const groups = new Map<string, string[]>();
    for (const file of sorted) {
        const key = groupKey(file);
        const bucket = groups.get(key);
        if (bucket) {
            bucket.push(file);
        } else {
            groups.set(key, [file]);
        }
    }

    // Largest groups first (tie-break on key) for a good LPT balance.
    const orderedGroups = [...groups.entries()].sort((a, b) => {
        if (b[1].length !== a[1].length) {
            return b[1].length - a[1].length;
        }
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

    const bins: string[][] = Array.from({ length: shardCount }, () => []);
    const binSizes = new Array(shardCount).fill(0);
    for (const [, groupFiles] of orderedGroups) {
        // Assign to the currently-smallest bin (tie-break lowest index) — deterministic.
        let target = 0;
        for (let i = 1; i < shardCount; i++) {
            if (binSizes[i] < binSizes[target]) {
                target = i;
            }
        }
        bins[target].push(...groupFiles);
        binSizes[target] += groupFiles.length;
    }

    // Stable order within each shard.
    for (const bin of bins) {
        bin.sort();
    }
    return bins;
}

/**
 * Merge shard `.scip` files into a single index via `writeIndex`, reproducing the single-process output
 * structure: one metadata message, then the concatenated documents, then the deduplicated external
 * symbols. Cross-shard reference handling: an external symbol recorded by one shard that is actually
 * defined by a document in another shard is dropped from `external_symbols` (it has an in-project
 * definition), matching single-process semantics where such a symbol is never external.
 */
export function mergeShardIndexes(
    shardOutputs: string[],
    writeIndex: (index: scip.Index) => void
): { documents: number; externalSymbols: number } {
    const externalSymbols = new Map<string, scip.SymbolInformation>();
    const definedSymbols = new Set<string>();
    let documentCount = 0;
    let wroteMetadata = false;

    for (const shardPath of shardOutputs) {
        const shardIndex = scip.Index.deserializeBinary(fs.readFileSync(shardPath));

        if (!wroteMetadata && shardIndex.has_metadata) {
            writeIndex(new scip.Index({ metadata: shardIndex.metadata }));
            wroteMetadata = true;
        }

        if (shardIndex.documents.length > 0) {
            for (const doc of shardIndex.documents) {
                for (const occ of doc.occurrences) {
                    if (occ.symbol && (occ.symbol_roles & scip.SymbolRole.Definition) > 0) {
                        definedSymbols.add(occ.symbol);
                    }
                }
            }
            writeIndex(new scip.Index({ documents: shardIndex.documents }));
            documentCount += shardIndex.documents.length;
        }

        for (const sym of shardIndex.external_symbols) {
            if (!externalSymbols.has(sym.symbol)) {
                externalSymbols.set(sym.symbol, sym);
            }
        }
    }

    const merged = new scip.Index();
    merged.external_symbols = Array.from(externalSymbols.values()).filter((sym) => !definedSymbols.has(sym.symbol));
    writeIndex(merged);

    return { documents: documentCount, externalSymbols: merged.external_symbols.length };
}
