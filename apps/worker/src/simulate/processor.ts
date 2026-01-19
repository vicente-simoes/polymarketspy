/**
 * Processor for q_group_events queue.
 *
 * Consumes trade and activity events, fetches full event data from DB,
 * and feeds them into the aggregator for grouping.
 */

import { TradeSide, ActivityType } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { createWorker, QUEUE_NAMES } from "../queue/queues.js";
import { addTradeToAggregator, addActivityToAggregator } from "./aggregator.js";
import {
    type GroupJobData,
    type PendingTradeEvent,
    type PendingActivityEvent,
    isTradeJobData,
    isActivityJobData,
} from "./types.js";
import type { ActivityPayload } from "../poly/types.js";
import { ensureSubscribed } from "./bookService.js";

const logger = createChildLogger({ module: "group-events-processor" });

/**
 * Worker that processes group events (trades and activities).
 * Fetches full event data and adds to aggregator.
 */
export const groupEventsWorker = createWorker<GroupJobData>(
    QUEUE_NAMES.GROUP_EVENTS,
    async (job) => {
        const payload = job.data;

        if (isTradeJobData(payload)) {
            await processTradeForAggregation(payload.tradeEventId, payload.followedUserId, job.id);
        } else if (isActivityJobData(payload)) {
            await processActivityForAggregation(
                payload.activityEventId,
                payload.followedUserId,
                payload.activityType,
                job.id
            );
        } else {
            logger.warn({ payload }, "Unknown payload type in group events queue");
        }
    }
);

/**
 * Process a trade event for aggregation.
 */
async function processTradeForAggregation(
    tradeEventId: string,
    followedUserId: string,
    jobId?: string
): Promise<void> {
    const log = logger.child({ tradeEventId, followedUserId, jobId });

    // Fetch the trade event
    const trade = await prisma.tradeEvent.findUnique({
        where: { id: tradeEventId },
    });

    if (!trade) {
        log.error("Trade event not found");
        throw new Error(`Trade event not found: ${tradeEventId}`);
    }

    if (!trade.isCanonical) {
        log.debug("Skipping non-canonical trade for aggregation");
        return;
    }

    // Need at least one token identifier (rawTokenId for WS-first, assetId for API)
    const effectiveTokenId = trade.rawTokenId ?? trade.assetId;
    if (!effectiveTokenId) {
        log.warn("Trade has no token ID (neither rawTokenId nor assetId), skipping aggregation");
        return;
    }

    // Pre-subscribe to WS book updates for this token
    // This warms the cache so it's ready when the group flushes to executor
    ensureSubscribed(effectiveTokenId);

    // Create pending event for aggregator
    const pendingEvent: PendingTradeEvent = {
        type: "trade",
        tradeEventId: trade.id,
        followedUserId,
        assetId: trade.assetId,
        rawTokenId: trade.rawTokenId,
        marketId: trade.marketId,
        side: trade.side,
        priceMicros: trade.priceMicros,
        shareMicros: trade.shareMicros,
        notionalMicros: trade.notionalMicros,
        detectTime: trade.detectTime,
        eventTime: trade.eventTime,
    };

    // Add to aggregator
    await addTradeToAggregator(pendingEvent);
    log.debug("Trade added to aggregator");
}

/**
 * Process an activity event for aggregation.
 */
async function processActivityForAggregation(
    activityEventId: string,
    followedUserId: string,
    activityTypeStr: string,
    jobId?: string
): Promise<void> {
    const log = logger.child({ activityEventId, followedUserId, activityType: activityTypeStr, jobId });

    // Fetch the activity event
    const activity = await prisma.activityEvent.findUnique({
        where: { id: activityEventId },
    });

    if (!activity) {
        log.error("Activity event not found");
        throw new Error(`Activity event not found: ${activityEventId}`);
    }

    if (!activity.isCanonical) {
        log.debug("Skipping non-canonical activity for aggregation");
        return;
    }

    // Parse the payload to get asset IDs
    const payload = activity.payloadJson as unknown as ActivityPayload;
    if (!payload || !payload.assets || payload.assets.length === 0) {
        log.warn("Activity has no assets, skipping aggregation");
        return;
    }

    const assetIds = payload.assets.map((a) => a.assetId);

    // Create pending event for aggregator
    const pendingEvent: PendingActivityEvent = {
        type: "activity",
        activityEventId: activity.id,
        followedUserId,
        activityType: activity.type,
        assetIds,
        detectTime: activity.detectTime,
        eventTime: activity.eventTime,
    };

    // Add to aggregator
    await addActivityToAggregator(pendingEvent);
    log.debug("Activity added to aggregator");
}

/**
 * Start the group events worker.
 */
export function startGroupEventsWorker(): void {
    logger.info("Starting group events worker");
    // Worker is automatically started when created
}
