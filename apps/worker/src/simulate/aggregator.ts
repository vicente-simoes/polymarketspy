/**
 * Event aggregator for grouping fills within a 2000ms window.
 *
 * This module buffers incoming events and flushes them as groups after
 * the aggregation window expires. Groups are keyed by:
 * - Trades: (followedUserId, assetId, side)
 * - Activities: (followedUserId, type, involvedAssets)
 *
 * Group key format (locked):
 *   <followedUserId>:<assetId>:<side>:<windowStartIso>
 */

import { TradeSide, ActivityType } from "@prisma/client";
import { createChildLogger } from "../log/logger.js";
import { queues } from "../queue/queues.js";
import {
    AGGREGATION_WINDOW_MS,
    type PendingTradeEvent,
    type PendingActivityEvent,
    type TradeEventGroup,
    type ActivityEventGroup,
    serializeEventGroup,
} from "./types.js";

const logger = createChildLogger({ module: "aggregator" });

/**
 * In-memory buffer for pending events.
 * Key is the aggregation key (without timestamp), value is array of events.
 */
interface AggregationBuffer {
    trades: Map<string, PendingTradeEvent[]>;
    activities: Map<string, PendingActivityEvent[]>;
    timers: Map<string, NodeJS.Timeout>;
}

const buffer: AggregationBuffer = {
    trades: new Map(),
    activities: new Map(),
    timers: new Map(),
};

/**
 * Generate aggregation key for a trade (without timestamp).
 */
function getTradeAggKey(followedUserId: string, assetId: string, side: TradeSide): string {
    return `${followedUserId}:${assetId}:${side}`;
}

/**
 * Generate aggregation key for an activity (without timestamp).
 */
function getActivityAggKey(
    followedUserId: string,
    activityType: ActivityType,
    assetIds: string[]
): string {
    const sortedAssets = [...assetIds].sort().join(",");
    return `${followedUserId}:${activityType}:${sortedAssets}`;
}

/**
 * Generate full group key with timestamp bucket.
 */
function getGroupKey(aggKey: string, windowStart: Date): string {
    return `${aggKey}:${windowStart.toISOString()}`;
}

/**
 * Get the window start time for an event (bucketed to AGGREGATION_WINDOW_MS).
 */
function getWindowStart(detectTime: Date): Date {
    const ms = detectTime.getTime();
    const bucketMs = Math.floor(ms / AGGREGATION_WINDOW_MS) * AGGREGATION_WINDOW_MS;
    return new Date(bucketMs);
}

/**
 * Flush a trade aggregation group.
 */
async function flushTradeGroup(aggKey: string): Promise<void> {
    const events = buffer.trades.get(aggKey);
    if (!events || events.length === 0) {
        buffer.trades.delete(aggKey);
        buffer.timers.delete(aggKey);
        return;
    }

    // Clear the buffer and timer
    buffer.trades.delete(aggKey);
    const timer = buffer.timers.get(aggKey);
    if (timer) {
        clearTimeout(timer);
        buffer.timers.delete(aggKey);
    }

    // Use the first event to get common properties
    const first = events[0]!;
    const windowStart = getWindowStart(first.detectTime);
    const groupKey = getGroupKey(aggKey, windowStart);

    // Compute aggregated values
    let totalNotionalMicros = BigInt(0);
    let totalShareMicros = BigInt(0);
    let earliestDetectTime = first.detectTime;
    const tradeEventIds: string[] = [];

    for (const event of events) {
        totalNotionalMicros += event.notionalMicros;
        totalShareMicros += event.shareMicros;
        if (event.detectTime < earliestDetectTime) {
            earliestDetectTime = event.detectTime;
        }
        tradeEventIds.push(event.tradeEventId);
    }

    // Compute VWAP (volume-weighted average price)
    // VWAP = totalNotional / totalShares
    // Result is in micros (0..1_000_000)
    let vwapPriceMicros = 0;
    if (totalShareMicros > BigInt(0)) {
        // (totalNotional * 1_000_000) / totalShares to maintain precision
        vwapPriceMicros = Number(
            (totalNotionalMicros * BigInt(1_000_000)) / totalShareMicros
        );
    }

    const group: TradeEventGroup = {
        type: "trade",
        groupKey,
        followedUserId: first.followedUserId,
        assetId: first.assetId,
        marketId: first.marketId,
        side: first.side,
        totalNotionalMicros,
        totalShareMicros,
        vwapPriceMicros,
        earliestDetectTime,
        windowStart,
        tradeEventIds,
    };

    logger.info(
        {
            groupKey,
            eventCount: events.length,
            totalNotional: totalNotionalMicros.toString(),
            vwap: vwapPriceMicros,
        },
        "Flushing trade group"
    );

    const queueGroup = serializeEventGroup(group);

    // Enqueue for per-user executable simulation
    await queues.copyAttemptUser.add("copy-attempt-user", {
        group: queueGroup,
        portfolioScope: "EXEC_USER",
    });

    // Enqueue for global executable simulation
    await queues.copyAttemptGlobal.add("copy-attempt-global", {
        group: queueGroup,
        portfolioScope: "EXEC_GLOBAL",
    });
}

/**
 * Flush an activity aggregation group.
 */
async function flushActivityGroup(aggKey: string): Promise<void> {
    const events = buffer.activities.get(aggKey);
    if (!events || events.length === 0) {
        buffer.activities.delete(aggKey);
        buffer.timers.delete(aggKey);
        return;
    }

    // Clear the buffer and timer
    buffer.activities.delete(aggKey);
    const timer = buffer.timers.get(aggKey);
    if (timer) {
        clearTimeout(timer);
        buffer.timers.delete(aggKey);
    }

    // Use the first event to get common properties
    const first = events[0]!;
    const windowStart = getWindowStart(first.detectTime);
    const groupKey = getGroupKey(aggKey, windowStart);

    // Find earliest detect time
    let earliestDetectTime = first.detectTime;
    const activityEventIds: string[] = [];

    for (const event of events) {
        if (event.detectTime < earliestDetectTime) {
            earliestDetectTime = event.detectTime;
        }
        activityEventIds.push(event.activityEventId);
    }

    const group: ActivityEventGroup = {
        type: "activity",
        groupKey,
        followedUserId: first.followedUserId,
        activityType: first.activityType,
        assetIds: first.assetIds,
        earliestDetectTime,
        windowStart,
        activityEventIds,
    };

    logger.info(
        {
            groupKey,
            eventCount: events.length,
            activityType: first.activityType,
        },
        "Flushing activity group"
    );

    const queueGroup = serializeEventGroup(group);

    // Enqueue for per-user executable simulation
    await queues.copyAttemptUser.add("copy-attempt-user", {
        group: queueGroup,
        portfolioScope: "EXEC_USER",
    });

    // Enqueue for global executable simulation
    await queues.copyAttemptGlobal.add("copy-attempt-global", {
        group: queueGroup,
        portfolioScope: "EXEC_GLOBAL",
    });
}

/**
 * Add a trade event to the aggregation buffer.
 */
export async function addTradeToAggregator(event: PendingTradeEvent): Promise<void> {
    const aggKey = getTradeAggKey(event.followedUserId, event.assetId, event.side);

    // Get or create the buffer for this key
    let events = buffer.trades.get(aggKey);
    if (!events) {
        events = [];
        buffer.trades.set(aggKey, events);
    }

    // Add the event
    events.push(event);

    logger.debug(
        { aggKey, eventCount: events.length, tradeId: event.tradeEventId },
        "Added trade to aggregator"
    );

    // Set or reset the flush timer
    const existingTimer = buffer.timers.get(aggKey);
    if (existingTimer) {
        // Timer already running, event will be flushed with the group
        return;
    }

    // Start a new timer to flush after the window expires
    const timer = setTimeout(async () => {
        try {
            await flushTradeGroup(aggKey);
        } catch (err) {
            logger.error({ err, aggKey }, "Failed to flush trade group");
        }
    }, AGGREGATION_WINDOW_MS);

    buffer.timers.set(aggKey, timer);
}

/**
 * Add an activity event to the aggregation buffer.
 */
export async function addActivityToAggregator(event: PendingActivityEvent): Promise<void> {
    const aggKey = getActivityAggKey(
        event.followedUserId,
        event.activityType,
        event.assetIds
    );

    // Get or create the buffer for this key
    let events = buffer.activities.get(aggKey);
    if (!events) {
        events = [];
        buffer.activities.set(aggKey, events);
    }

    // Add the event
    events.push(event);

    logger.debug(
        { aggKey, eventCount: events.length, activityId: event.activityEventId },
        "Added activity to aggregator"
    );

    // Set or reset the flush timer
    const existingTimer = buffer.timers.get(aggKey);
    if (existingTimer) {
        // Timer already running, event will be flushed with the group
        return;
    }

    // Start a new timer to flush after the window expires
    const timer = setTimeout(async () => {
        try {
            await flushActivityGroup(aggKey);
        } catch (err) {
            logger.error({ err, aggKey }, "Failed to flush activity group");
        }
    }, AGGREGATION_WINDOW_MS);

    buffer.timers.set(aggKey, timer);
}

/**
 * Force flush all pending groups (used on shutdown).
 */
export async function flushAllGroups(): Promise<void> {
    logger.info("Flushing all pending aggregation groups");

    // Flush all trade groups
    const tradeKeys = [...buffer.trades.keys()];
    for (const key of tradeKeys) {
        try {
            await flushTradeGroup(key);
        } catch (err) {
            logger.error({ err, key }, "Failed to flush trade group on shutdown");
        }
    }

    // Flush all activity groups
    const activityKeys = [...buffer.activities.keys()];
    for (const key of activityKeys) {
        try {
            await flushActivityGroup(key);
        } catch (err) {
            logger.error({ err, key }, "Failed to flush activity group on shutdown");
        }
    }

    // Clear all timers
    for (const timer of buffer.timers.values()) {
        clearTimeout(timer);
    }
    buffer.timers.clear();
}

/**
 * Get aggregator stats for health/monitoring.
 */
export function getAggregatorStats(): {
    pendingTradeGroups: number;
    pendingActivityGroups: number;
    pendingTradeEvents: number;
    pendingActivityEvents: number;
} {
    let pendingTradeEvents = 0;
    for (const events of buffer.trades.values()) {
        pendingTradeEvents += events.length;
    }

    let pendingActivityEvents = 0;
    for (const events of buffer.activities.values()) {
        pendingActivityEvents += events.length;
    }

    return {
        pendingTradeGroups: buffer.trades.size,
        pendingActivityGroups: buffer.activities.size,
        pendingTradeEvents,
        pendingActivityEvents,
    };
}
