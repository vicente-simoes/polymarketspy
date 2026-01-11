import { createWorker } from "../queue/queues.js";
import { QUEUE_NAMES } from "../queue/queues.js";
import { applyShadowTrade } from "./shadow.js";
import { createChildLogger } from "../log/logger.js";
import { queues } from "../queue/queues.js";

const logger = createChildLogger({ module: "portfolio-processor" });

interface ProcessTradePayload {
    tradeEventId: string;
    followedUserId: string;
}

/**
 * Worker that processes ingested trade events.
 * 1. Apply to shadow ledger
 * 2. Enqueue for aggregation (executable simulation)
 */
export const ingestEventsWorker = createWorker<ProcessTradePayload>(
    QUEUE_NAMES.INGEST_EVENTS,
    async (job) => {
        const { tradeEventId, followedUserId } = job.data;
        const log = logger.child({ tradeEventId, followedUserId, jobId: job.id });

        // Step 1: Apply to shadow ledger
        log.debug("Applying to shadow ledger");
        await applyShadowTrade(tradeEventId, followedUserId);

        // Step 2: Enqueue for aggregation / executable simulation
        log.debug("Enqueueing for aggregation");
        await queues.groupEvents.add("aggregate-trade", {
            tradeEventId,
            followedUserId,
        });

        log.debug("Trade event processed");
    }
);

/**
 * Start portfolio workers.
 */
export function startPortfolioWorkers(): void {
    logger.info("Starting portfolio workers");
    // Worker is automatically started when created
}
