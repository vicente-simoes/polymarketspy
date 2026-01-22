/**
 * Processor for q_group_events queue.
 *
 * Consumes trade and activity events, fetches full event data from DB,
 * and feeds them into the aggregator for grouping.
 *
 * When small trade buffering is enabled:
 * - Computes copy notional for the trade
 * - If >= threshold: executes immediately (bypasses aggregator)
 * - If < threshold: buffers in small trade buffer for batching
 */

import { TradeSide, ActivityType } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { createWorker, QUEUE_NAMES, queues } from "../queue/queues.js";
import { addTradeToAggregator, addActivityToAggregator } from "./aggregator.js";
import {
    type GroupJobData,
    type PendingTradeEvent,
    type PendingActivityEvent,
    type TradeEventGroup,
    isTradeJobData,
    isActivityJobData,
    serializeEventGroup,
    getEffectiveTokenId,
} from "./types.js";
import type { ActivityPayload } from "../poly/types.js";
import { ensureSubscribed } from "./bookService.js";
import { getGlobalConfig } from "./config.js";
import { appendTrade, mergeAndFlushBucket, type BufferTradeInput } from "./smallTradeBuffer.js";
import { bucketToTradeEventGroup } from "./flushLoop.js";
import { computeTargetShares } from "./sizing.js";

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
 * Compute raw copy notional (before bankroll cap) for threshold checks.
 * This is a simplified calculation used to determine if a trade is "small".
 */
function computeRawCopyNotional(
    theirNotionalMicros: bigint,
    copyPctNotionalBps: number
): bigint {
    return (theirNotionalMicros * BigInt(copyPctNotionalBps)) / BigInt(10000);
}

/**
 * Create a single-trade group for immediate execution.
 */
function createSingleTradeGroup(
    trade: PendingTradeEvent,
    tokenId: string
): TradeEventGroup {
    const windowStart = new Date();
    const groupKey = `${trade.followedUserId}:${tokenId}:${trade.side}:${windowStart.toISOString()}`;

    // VWAP for single trade is just the trade price
    const vwapPriceMicros = trade.priceMicros;

    return {
        type: "trade",
        groupKey,
        followedUserId: trade.followedUserId,
        assetId: trade.assetId,
        rawTokenId: trade.rawTokenId,
        marketId: trade.marketId,
        side: trade.side,
        totalNotionalMicros: trade.notionalMicros,
        totalShareMicros: trade.shareMicros,
        vwapPriceMicros,
        earliestDetectTime: trade.detectTime,
        windowStart,
        tradeEventIds: [trade.tradeEventId],
    };
}

/**
 * Process a trade event for aggregation.
 *
 * When small trade buffering is enabled:
 * - Computes copy notional for the trade
 * - If >= threshold: executes immediately (bypasses aggregator)
 * - If < threshold: buffers in small trade buffer
 *
 * When buffering is disabled: uses existing 250ms aggregator.
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

    // Create pending event
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

    // Load config to check if buffering is enabled
    const { sizing, smallTradeBuffering } = await getGlobalConfig();

    // If buffering is disabled, use existing aggregator
    if (!smallTradeBuffering.enabled) {
        await addTradeToAggregator(pendingEvent);
        log.debug("Trade added to aggregator (buffering disabled)");
        return;
    }

    // Buffering is enabled - compute copy notional to determine if "small"
    const rawCopyNotional = computeRawCopyNotional(
        trade.notionalMicros,
        sizing.copyPctNotionalBps
    );

    log.debug(
        {
            theirNotional: trade.notionalMicros.toString(),
            rawCopyNotional: rawCopyNotional.toString(),
            threshold: smallTradeBuffering.notionalThresholdMicros,
        },
        "Checking if trade is small"
    );

    // If copy notional >= threshold, check if there's an existing bucket to merge with
    if (rawCopyNotional >= BigInt(smallTradeBuffering.notionalThresholdMicros)) {
        // First, check if there's a bucket with pending small trades for this position
        const copyShareMicros = computeTargetShares(rawCopyNotional, trade.priceMicros);
        const bufferInput: BufferTradeInput = {
            followedUserId,
            tokenId: effectiveTokenId,
            marketId: trade.marketId,
            side: trade.side,
            copyNotionalMicros: rawCopyNotional,
            copyShareMicros,
            priceMicros: trade.priceMicros,
            tradeEventId: trade.id,
        };

        const mergeResult = await mergeAndFlushBucket(bufferInput, smallTradeBuffering);

        if (mergeResult && mergeResult.executed) {
            // Large trade was merged with existing small trades and flushed
            log.info(
                {
                    rawCopyNotional: rawCopyNotional.toString(),
                    mergedCount: mergeResult.bucket.countTradesBuffered,
                },
                "Large trade merged with pending small trades and flushed"
            );

            // Convert merged bucket to group and enqueue
            const group = bucketToTradeEventGroup(mergeResult.bucket);
            const queueGroup = serializeEventGroup(group);

            await queues.copyAttemptGlobal.add("copy-attempt-global", {
                group: queueGroup,
                portfolioScope: "EXEC_GLOBAL",
                sourceType: "BUFFER",
                bufferedTradeCount: mergeResult.bucket.countTradesBuffered,
            });

            return;
        }

        // No existing bucket to merge with - execute immediately as single trade
        log.info(
            { rawCopyNotional: rawCopyNotional.toString() },
            "Trade above threshold, executing immediately"
        );

        // Create a single-trade group and enqueue for immediate execution
        const group = createSingleTradeGroup(pendingEvent, effectiveTokenId);
        const queueGroup = serializeEventGroup(group);

        await queues.copyAttemptGlobal.add("copy-attempt-global", {
            group: queueGroup,
            portfolioScope: "EXEC_GLOBAL",
            sourceType: "IMMEDIATE",
            bufferedTradeCount: 1,
        });

        return;
    }

    // Trade is "small" - add to buffer
    const copyShareMicros = computeTargetShares(rawCopyNotional, trade.priceMicros);

    const bufferInput: BufferTradeInput = {
        followedUserId,
        tokenId: effectiveTokenId,
        marketId: trade.marketId,
        side: trade.side,
        copyNotionalMicros: rawCopyNotional,
        copyShareMicros,
        priceMicros: trade.priceMicros,
        tradeEventId: trade.id,
    };

    const result = await appendTrade(bufferInput, smallTradeBuffering);

    if (result.buffered) {
        log.debug({ bucketKey: result.bucketKey }, "Trade buffered (small trade)");
    }

    // If a flush was triggered (e.g., opposite side in sameSideOnly mode),
    // we'll handle the execution in the flush loop (step 6)
    if (result.flushTriggered) {
        log.debug(
            { reason: result.flushTriggered.reason, executed: result.flushTriggered.executed },
            "Buffer flush triggered"
        );
    }
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
