/**
 * Reconcile processor that consumes q_reconcile jobs.
 *
 * v0.1 WS-first architecture:
 * - On-chain WS events are now CANONICAL (trades created directly from logs)
 * - Reconcile is now only a SAFETY NET, not in the critical path
 *
 * Job types:
 * - alchemy_reconnect: Backfill 5 minutes for all users after WS reconnect
 * - periodic: Safety net backfill (2 minutes) to catch any missed trades
 *
 * Note: Regular polling (every 30s) also acts as a safety net by doing
 * checkpoint-based incremental fetches from the Polymarket API.
 */

import { Worker } from "bullmq";
import { createChildLogger } from "../log/logger.js";
import { QUEUE_NAMES } from "../queue/queues.js";
import { env } from "../config/env.js";
import { type ReconcileJobData } from "../alchemy/types.js";
import { ingestAllUserTrades } from "../ingest/trades.js";
import { ingestAllUserActivity } from "../ingest/activity.js";

const logger = createChildLogger({ module: "reconcile-processor" });

// Parse Redis URL for BullMQ connection config
function parseRedisUrl(url: string) {
    const parsed = new URL(url);
    return {
        host: parsed.hostname,
        port: parseInt(parsed.port || "6379", 10),
        password: parsed.password || undefined,
    };
}

const redisConfig = parseRedisUrl(env.REDIS_URL);

let worker: Worker<ReconcileJobData> | null = null;

/**
 * Handle an individual reconcile job.
 */
async function processJob(job: { data: ReconcileJobData; id?: string }): Promise<void> {
    const { data } = job;
    const log = logger.child({ jobId: job.id, reason: data.reason });

    log.debug("Processing reconcile job");

    switch (data.reason) {
        case "alchemy_reconnect": {
            // Backfill all users after WS reconnection
            // This catches any trades that might have been missed during the disconnect
            const backfillMinutes = data.backfillMinutes ?? 5;
            log.info({ backfillMinutes }, "Processing reconnect backfill");

            await ingestAllUserTrades({ backfillMinutes });
            await ingestAllUserActivity({ backfillMinutes });

            log.info("Reconnect backfill complete");
            break;
        }

        case "periodic": {
            // Safety net backfill - catches any trades missed by WS
            // Note: Regular polling (30s) also serves as a safety net
            const backfillMinutes = data.backfillMinutes ?? 2;
            log.debug({ backfillMinutes }, "Processing periodic backfill");

            await ingestAllUserTrades({ backfillMinutes });
            await ingestAllUserActivity({ backfillMinutes });

            log.debug("Periodic backfill complete");
            break;
        }

        default:
            log.warn({ reason: data.reason }, "Unknown reconcile reason");
    }
}

/**
 * Start the reconcile worker.
 *
 * v0.1: This worker is now a safety net only. Primary trade detection
 * happens via WS subscription which creates canonical trades directly.
 */
export function startReconcileWorker(): void {
    if (worker) {
        logger.warn("Reconcile worker already running");
        return;
    }

    worker = new Worker<ReconcileJobData>(
        QUEUE_NAMES.RECONCILE,
        async (job) => {
            await processJob({ data: job.data, id: job.id });
        },
        {
            connection: redisConfig,
            concurrency: 3, // Lower concurrency to reduce parallel API calls
        }
    );

    worker.on("failed", (job, err) => {
        logger.error(
            { jobId: job?.id, err: err.message },
            "Reconcile job failed"
        );
    });

    worker.on("error", (err) => {
        logger.error({ err: err.message }, "Reconcile worker error");
    });

    logger.info("Reconcile worker started");
}

/**
 * Flush any pending work before shutdown.
 * v0.1: No-op since batching is no longer used.
 */
export async function flushPendingReconciles(): Promise<void> {
    // No-op - batching removed in v0.1 WS-first architecture
    logger.debug("Flush reconciles (no-op in v0.1)");
}

/**
 * Stop the reconcile worker.
 */
export async function stopReconcileWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
        logger.info("Reconcile worker stopped");
    }
}
