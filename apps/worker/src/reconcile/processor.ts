/**
 * Reconcile processor that consumes q_reconcile jobs.
 *
 * Handles three types of reconcile jobs:
 * - alchemy_event: Fast single-wallet fetch triggered by Alchemy WS detection
 * - alchemy_reconnect: Backfill 5 minutes for all users after WS reconnect
 * - periodic: Safety net backfill (2 minutes) triggered by timer
 *
 * For alchemy_event jobs, events are batched by wallet to reduce API calls.
 */

import { Worker } from "bullmq";
import { createChildLogger } from "../log/logger.js";
import { QUEUE_NAMES } from "../queue/queues.js";
import { env } from "../config/env.js";
import { type ReconcileJobData } from "../alchemy/types.js";
import { ingestTradesForWalletFast, ingestAllUserTrades } from "../ingest/trades.js";
import { ingestAllUserActivity } from "../ingest/activity.js";
import { recordLatency } from "./latency.js";
import {
    addToBatch,
    setBatchCallback,
    flushAllBatches,
    type BatchedEvent,
} from "./batcher.js";

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
 * Process a batch of events for a single wallet.
 * Called by the batcher when a batch is ready.
 */
async function processBatch(walletAddress: string, events: BatchedEvent[]): Promise<void> {
    const log = logger.child({ wallet: walletAddress, eventCount: events.length });
    log.debug("Processing batched reconcile");

    // Find the earliest alchemy detect time for latency tracking
    const earliestDetect = events.reduce(
        (earliest, e) => (e.alchemyDetectTime < earliest ? e.alchemyDetectTime : earliest),
        events[0]!.alchemyDetectTime
    );

    try {
        // Fast fetch trades for this wallet
        const result = await ingestTradesForWalletFast(walletAddress, {
            alchemyDetectTime: earliestDetect,
        });

        const fetchTime = new Date();

        // Record latency if we found new trades
        // Note: We estimate eventTime as ~2s before detection (typical Polygon block time)
        // The real eventTime would require looking up the inserted trades
        if (result.newCount > 0) {
            // For more accurate latency, we'd need to look up the actual trade event times
            // For now, estimate based on typical Polygon finality
            const estimatedEventTime = new Date(earliestDetect.getTime() - 2000);
            recordLatency({
                eventTime: estimatedEventTime,
                alchemyDetectTime: earliestDetect,
                canonicalFetchTime: fetchTime,
            });
        }

        log.info(
            { newCount: result.newCount, latencyMs: result.latencyMs },
            "Batched reconcile complete"
        );
    } catch (err) {
        log.error({ err }, "Failed to process batched reconcile");
    }
}

/**
 * Handle an individual reconcile job.
 */
async function processJob(job: { data: ReconcileJobData; id?: string }): Promise<void> {
    const { data } = job;
    const log = logger.child({ jobId: job.id, reason: data.reason });

    log.debug("Processing reconcile job");

    switch (data.reason) {
        case "alchemy_event": {
            // Batch by wallet for efficiency
            if (!data.walletAddress || !data.txHash) {
                log.warn("alchemy_event missing wallet or txHash");
                return;
            }

            const alchemyDetectTime = new Date(data.triggeredAt);
            addToBatch({
                txHash: data.txHash,
                walletAddress: data.walletAddress,
                alchemyDetectTime,
            });
            break;
        }

        case "alchemy_reconnect": {
            // Backfill all users after reconnection
            const backfillMinutes = data.backfillMinutes ?? 5;
            log.info({ backfillMinutes }, "Processing reconnect backfill");

            await ingestAllUserTrades({ backfillMinutes });
            await ingestAllUserActivity({ backfillMinutes });

            log.info("Reconnect backfill complete");
            break;
        }

        case "periodic": {
            // Safety net backfill
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
 */
export function startReconcileWorker(): void {
    if (worker) {
        logger.warn("Reconcile worker already running");
        return;
    }

    // Set up batch callback before starting worker
    setBatchCallback(processBatch);

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
 * Flush any pending batches before shutdown.
 */
export async function flushPendingReconciles(): Promise<void> {
    await flushAllBatches();
    logger.debug("Flushed pending reconcile batches");
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
