import { prisma } from "../db/prisma.js";
import { queues } from "../queue/queues.js";
import { getSystemConfig } from "../config/system.js";
import type { CopySourceType, QueueTradeEventGroup } from "./types.js";
import { createHash } from "node:crypto";

type LogFn = (obj: unknown, msg?: string) => void;
export type LoggerLike = {
    debug: LogFn;
    info: LogFn;
    warn: LogFn;
    error: LogFn;
};

export interface EnqueueExecutionResult {
    paperEnqueued: boolean;
    liveEnqueued: boolean;
}

function isDuplicateJobIdError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return /already exists/i.test(err.message) || /duplicat/i.test(err.message);
}

function jobIdFromGroupKey(groupKey: string): string {
    // BullMQ forbids ":" in custom job IDs; groupKey contains ":" separators.
    // Use a stable hash to dedupe retries safely.
    const digest = createHash("sha256").update(groupKey).digest("hex");
    return `group_${digest}`;
}

/**
 * Enqueue a trade group to enabled execution queues (paper and/or live).
 *
 * Designed to ensure:
 * - Paper and live enqueues are attempted independently (no "paper blocks live").
 * - Job IDs are stable per groupKey to avoid accidental duplicates on retries.
 */
export async function enqueueTradeGroupToEnabledQueues(
    group: QueueTradeEventGroup,
    sourceType: CopySourceType,
    bufferedTradeCount: number,
    followedUserId: string,
    log: LoggerLike
): Promise<EnqueueExecutionResult> {
    const systemConfig = await getSystemConfig();

    if (!systemConfig.copyEngineEnabled) {
        log.info(
            {
                copyEngineEnabled: systemConfig.copyEngineEnabled,
                paperTradingEnabled: systemConfig.paperTradingEnabled,
                liveTradingEnabled: systemConfig.liveTradingEnabled,
            },
            "Copy engine disabled; skipping enqueue"
        );
        return { paperEnqueued: false, liveEnqueued: false };
    }

    const shouldEnqueuePaper = systemConfig.paperTradingEnabled;
    let shouldEnqueueLive = systemConfig.liveTradingEnabled;

    // Check per-user live override
    if (shouldEnqueueLive) {
        const user = await prisma.followedUser.findUnique({
            where: { id: followedUserId },
            select: { liveOverride: true, enabled: true },
        });

        if (!user?.enabled || user.liveOverride === "FORCE_OFF") {
            shouldEnqueueLive = false;
        }
    }

    if (!shouldEnqueuePaper && !shouldEnqueueLive) {
        log.info(
            {
                paperTradingEnabled: systemConfig.paperTradingEnabled,
                liveTradingEnabled: systemConfig.liveTradingEnabled,
            },
            "No execution queues enabled; group not enqueued"
        );
        return { paperEnqueued: false, liveEnqueued: false };
    }

    const jobId = jobIdFromGroupKey(group.groupKey);

    const tasks: Array<Promise<{ queue: "paper" | "live"; ok: boolean; err?: unknown }>> = [];

    if (shouldEnqueuePaper) {
        tasks.push(
            queues.copyAttemptGlobal
                .add(
                    "copy-attempt-global",
                    {
                        group,
                        portfolioScope: "EXEC_GLOBAL",
                        sourceType,
                        bufferedTradeCount,
                    },
                    { jobId }
                )
                .then(() => ({ queue: "paper" as const, ok: true }))
                .catch((err) => {
                    if (isDuplicateJobIdError(err)) {
                        log.debug({ jobId }, "Paper job already enqueued (duplicate jobId)");
                        return { queue: "paper" as const, ok: true };
                    }
                    return { queue: "paper" as const, ok: false, err };
                })
        );
    }

    if (shouldEnqueueLive) {
        tasks.push(
            queues.copyAttemptLive
                .add(
                    "copy-attempt-live",
                    {
                        group,
                        portfolioScope: "EXEC_GLOBAL",
                        sourceType,
                        bufferedTradeCount,
                    },
                    { jobId }
                )
                .then(() => ({ queue: "live" as const, ok: true }))
                .catch((err) => {
                    if (isDuplicateJobIdError(err)) {
                        log.debug({ jobId }, "Live job already enqueued (duplicate jobId)");
                        return { queue: "live" as const, ok: true };
                    }
                    return { queue: "live" as const, ok: false, err };
                })
        );
    }

    const outcomes = await Promise.all(tasks);

    const result: EnqueueExecutionResult = { paperEnqueued: false, liveEnqueued: false };
    const failures: Array<{ queue: "paper" | "live"; err?: unknown }> = [];

    for (const outcome of outcomes) {
        if (outcome.ok) {
            if (outcome.queue === "paper") result.paperEnqueued = true;
            if (outcome.queue === "live") result.liveEnqueued = true;
        } else {
            failures.push({ queue: outcome.queue, err: outcome.err });
        }
    }

    if (failures.length > 0) {
        for (const failure of failures) {
            log.error({ err: failure.err, queue: failure.queue, jobId }, "Failed to enqueue job");
        }
        throw new Error("Failed to enqueue trade group to one or more execution queues");
    }

    return result;
}
