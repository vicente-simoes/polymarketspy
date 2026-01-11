import { createWorker } from "../queue/queues.js";
import { QUEUE_NAMES } from "../queue/queues.js";
import { applyShadowTrade, applyShadowActivity } from "./shadow.js";
import { createChildLogger } from "../log/logger.js";
import { queues } from "../queue/queues.js";

const logger = createChildLogger({ module: "portfolio-processor" });

/**
 * Payload for trade event processing.
 */
interface ProcessTradePayload {
    tradeEventId: string;
    followedUserId: string;
}

/**
 * Payload for activity event processing.
 */
interface ProcessActivityPayload {
    activityEventId: string;
    followedUserId: string;
    activityType: string;
}

/**
 * Union type for ingest events queue payloads.
 */
type IngestEventPayload = ProcessTradePayload | ProcessActivityPayload;

/**
 * Type guard to check if payload is a trade event.
 */
function isTradePayload(payload: IngestEventPayload): payload is ProcessTradePayload {
    return "tradeEventId" in payload;
}

/**
 * Type guard to check if payload is an activity event.
 */
function isActivityPayload(payload: IngestEventPayload): payload is ProcessActivityPayload {
    return "activityEventId" in payload;
}

/**
 * Worker that processes ingested events (trades and activities).
 *
 * For trades:
 * 1. Apply to shadow ledger
 * 2. Enqueue for aggregation (executable simulation)
 * 3. Enqueue for portfolio snapshot update
 *
 * For activities (MERGE/SPLIT/REDEEM):
 * 1. Apply to shadow ledger
 * 2. Enqueue for aggregation (if applicable)
 * 3. Enqueue for portfolio snapshot update
 */
export const ingestEventsWorker = createWorker<IngestEventPayload>(
    QUEUE_NAMES.INGEST_EVENTS,
    async (job) => {
        const payload = job.data;

        if (isTradePayload(payload)) {
            await processTradeEvent(payload, job.id);
        } else if (isActivityPayload(payload)) {
            await processActivityEvent(payload, job.id);
        } else {
            logger.warn({ payload }, "Unknown payload type in ingest queue");
        }
    }
);

/**
 * Process a trade event.
 */
async function processTradeEvent(
    payload: ProcessTradePayload,
    jobId?: string
): Promise<void> {
    const { tradeEventId, followedUserId } = payload;
    const log = logger.child({ tradeEventId, followedUserId, jobId });

    // Step 1: Apply to shadow ledger
    log.debug("Applying trade to shadow ledger");
    await applyShadowTrade(tradeEventId, followedUserId);

    // Step 2: Enqueue for aggregation / executable simulation
    log.debug("Enqueueing trade for aggregation");
    await queues.groupEvents.add("aggregate-trade", {
        tradeEventId,
        followedUserId,
    });

    // Step 3: Enqueue for portfolio snapshot update
    await queues.portfolioApply.add("update-snapshot", {
        portfolioScope: "SHADOW_USER",
        followedUserId,
        eventType: "trade",
        eventId: tradeEventId,
    });

    log.debug("Trade event processed");
}

/**
 * Process an activity event (MERGE/SPLIT/REDEEM).
 */
async function processActivityEvent(
    payload: ProcessActivityPayload,
    jobId?: string
): Promise<void> {
    const { activityEventId, followedUserId, activityType } = payload;
    const log = logger.child({ activityEventId, followedUserId, activityType, jobId });

    // Step 1: Apply to shadow ledger
    log.debug("Applying activity to shadow ledger");
    await applyShadowActivity(activityEventId, followedUserId);

    // Step 2: Enqueue for aggregation (MERGE/SPLIT can be copied if applicable)
    // For now, we only aggregate trades. Activity aggregation can be added later.
    if (activityType === "MERGE" || activityType === "SPLIT") {
        log.debug("Enqueueing activity for aggregation");
        await queues.groupEvents.add("aggregate-activity", {
            activityEventId,
            followedUserId,
            activityType,
        });
    }

    // Step 3: Enqueue for portfolio snapshot update
    await queues.portfolioApply.add("update-snapshot", {
        portfolioScope: "SHADOW_USER",
        followedUserId,
        eventType: "activity",
        eventId: activityEventId,
    });

    log.debug("Activity event processed");
}

/**
 * Start portfolio workers.
 */
export function startPortfolioWorkers(): void {
    logger.info("Starting portfolio workers");
    // Worker is automatically started when created
}
