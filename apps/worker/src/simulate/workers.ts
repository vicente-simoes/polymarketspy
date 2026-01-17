/**
 * Copy attempt worker for q_copy_attempt_global queue.
 *
 * Processes event groups and executes copy attempts for the single global
 * executable portfolio.
 */

import { PortfolioScope } from "@prisma/client";
import { createChildLogger } from "../log/logger.js";
import { createWorker, QUEUE_NAMES } from "../queue/queues.js";
import { executeCopyAttempt } from "./executor.js";
import { deserializeEventGroup } from "./types.js";
import type { CopyAttemptJobData } from "./types.js";

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
        const { portfolioScope } = job.data;
        const group = deserializeEventGroup(job.data.group);
        const log = logger.child({
            groupKey: group.groupKey,
            scope: portfolioScope,
            jobId: job.id,
        });

        if (portfolioScope !== "EXEC_GLOBAL") {
            log.warn("Unexpected portfolio scope in global worker");
            return;
        }

        log.debug("Processing global copy attempt");

        try {
            const result = await executeCopyAttempt(group, PortfolioScope.EXEC_GLOBAL);

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
 * Start copy attempt workers.
 */
export function startCopyAttemptWorkers(): void {
    logger.info("Starting copy attempt workers");
    // Workers are automatically started when created
}
