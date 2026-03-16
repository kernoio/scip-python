/*
 * typeEvaluatorWithTracker.ts
 *
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Wraps type evaluator to track performance of internal calls.
 */

import { LogLevel } from '../common/console';
import { isDebugMode } from '../common/core';
import { LogTracker } from '../common/logTracker';
import { timingStats } from '../common/timing';
import { ImportLookup } from './analyzerFileInfo';
import { createTypeEvaluator, EvaluatorOptions } from './typeEvaluator';

// We don't want to track calls from the type evaluator itself, but only entry points.
export function createTypeEvaluatorWithTracker(
    importLookup: ImportLookup,
    evaluatorOptions: EvaluatorOptions,
    logger: LogTracker
) {
    function wrapWithLogger<T extends (...args: any[]) => any>(func: T): (...args: Parameters<T>) => ReturnType<T> {
        if (evaluatorOptions.logCalls && logger.logLevel === LogLevel.Log) {
            return (...args: Parameters<T>): ReturnType<T> => {
                return logger.log(
                    func.name,
                    () => {
                        return timingStats.typeEvaluationTime.timeOperation(func, ...args);
                    },
                    evaluatorOptions.minimumLoggingThreshold,
                    /* logParsingPerf */ true
                );
            };
        } else if (!isDebugMode()) {
            return timingStats.typeEvaluationTime.timeOperation.bind(timingStats.typeEvaluationTime, func);
        } else {
            return func;
        }
    }

    // Wrap all functions with either a logger or a timer.
    importLookup = wrapWithLogger(importLookup);
    const evaluator = createTypeEvaluator(importLookup, evaluatorOptions, wrapWithLogger);

    // Track these apis external usages when logging is on. otherwise, it should be noop.
    const keys = Object.keys(evaluator);
    keys.forEach((k) => {
        const entry = (evaluator as any)[k];
        if (typeof entry === 'function' && entry.name) {
            // Only wrap functions that aren't wrapped already.
            (evaluator as any)[k] = wrapWithLogger(entry);
        }
    });

    return evaluator;
}
