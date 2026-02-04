/**
 * Copy attempt workers for paper (q_copy_attempt_global) and live (q_copy_attempt_live) queues.
 *
 * Processes event groups and executes copy attempts for the single global
 * executable portfolio.
 */

import { PortfolioScope } from "@prisma/client";
import { createChildLogger } from "../log/logger.js";
import { createWorker, QUEUE_NAMES } from "../queue/queues.js";
import { executeCopyAttempt, type CopyAttemptOptions } from "./executor.js";
import { executeLiveCopyAttempt } from "../live/executor.js";
import { deserializeEventGroup } from "./types.js";
import type { CopyAttemptJobData } from "./types.js";
import { getSystemConfig } from "../config/system.js";

const logger = createChildLogger({ module: "copy-workers" });

/**
 * Global copy attempt worker.
 * Processes groups in FIFO order for EXEC_GLOBAL portfolio scope.
 *
 * Note: BullMQ processes jobs in order by default when concurrency is 1.
 * For strict FIFO ordering by detectTime, we could use delayed jobs or
 * sorted sets, but for v0 the queue order is sufficient.
 */
export const copyAttemptGlobalWorker = createWorker<CopyAttemptJobData>(
    QUEUE_NAMES.COPY_ATTEMPT_GLOBAL,
    async (job) => {
        const { portfolioScope, sourceType, bufferedTradeCount } = job.data;
        const group = deserializeEventGroup(job.data.group);
        const log = logger.child({
            groupKey: group.groupKey,
            scope: portfolioScope,
            sourceType,
            jobId: job.id,
        });

        if (portfolioScope !== "EXEC_GLOBAL") {
            log.warn("Unexpected portfolio scope in global worker");
            return;
        }

        log.debug("Processing global copy attempt");

        const systemConfig = await getSystemConfig();
        if (!systemConfig.copyEngineEnabled || !systemConfig.paperTradingEnabled) {
            log.info(
                {
                    copyEngineEnabled: systemConfig.copyEngineEnabled,
                    paperTradingEnabled: systemConfig.paperTradingEnabled,
                },
                "Paper execution disabled; skipping copy attempt"
            );
            return;
        }

        // Build options from job data
        const options: CopyAttemptOptions = {
            sourceType,
            bufferedTradeCount,
        };

        try {
            const result = await executeCopyAttempt(group, PortfolioScope.EXEC_GLOBAL, options);

            log.info(
                {
                    decision: result.decision,
                    reasonCodes: result.reasonCodes,
                    filledRatio: result.filledRatioBps,
                },
                "Global copy attempt complete"
            );
        } catch (err) {
            log.error({ err }, "Global copy attempt failed");
            throw err;
        }
    }
);

/**
 * Live copy attempt worker.
 * Processes groups in FIFO order for live order execution.
 *
 * Note: Concurrency is always 1 for live trading to ensure
 * serialized order submission per wallet.
 *
 * Only processes trade groups (not activities - those are not copied live).
 */
export const copyAttemptLiveWorker = createWorker<CopyAttemptJobData>(
    QUEUE_NAMES.COPY_ATTEMPT_LIVE,
    async (job) => {
        const { sourceType, bufferedTradeCount } = job.data;
        const group = deserializeEventGroup(job.data.group);
        const log = logger.child({
            groupKey: group.groupKey,
            sourceType,
            jobId: job.id,
        });

        // Live executor only handles trade groups
        if (group.type !== "trade") {
            log.debug({ type: group.type }, "Skipping non-trade group in live executor");
            return;
        }

        log.debug("Processing live copy attempt");

        const systemConfig = await getSystemConfig();
        if (!systemConfig.copyEngineEnabled || !systemConfig.liveTradingEnabled) {
            log.info(
                {
                    copyEngineEnabled: systemConfig.copyEngineEnabled,
                    liveTradingEnabled: systemConfig.liveTradingEnabled,
                },
                "Live execution disabled; skipping copy attempt"
            );
            return;
        }

        try {
            const result = await executeLiveCopyAttempt(group, {
                sourceType,
                bufferedTradeCount,
            });

            log.info(
                {
                    decision: result.decision,
                    reasonCodes: result.reasonCodes,
                    liveOrderId: result.liveOrderId,
                    clobOrderId: result.clobOrderId,
                },
                "Live copy attempt complete"
            );
        } catch (err) {
            log.error({ err }, "Live copy attempt failed");
            throw err;
        }
    },
    { concurrency: 1 }
);

/**
 * Start copy attempt workers (paper + live).
 */
export function startCopyAttemptWorkers(): void {
    logger.info("Starting copy attempt workers (paper + live)");
    // Workers are automatically started when created
}
