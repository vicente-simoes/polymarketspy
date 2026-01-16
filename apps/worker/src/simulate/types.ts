/**
 * Types for event aggregation and executable simulation.
 *
 * Aggregation groups multiple fills within a 2000ms window into a single
 * copy attempt to avoid treating many tiny fills as separate orders.
 */

import { TradeSide, ActivityType } from "@prisma/client";

/**
 * Aggregation window in milliseconds (per planning.md).
 */
export const AGGREGATION_WINDOW_MS = 2000;

/**
 * Pending event in the aggregation buffer.
 */
export interface PendingTradeEvent {
    type: "trade";
    tradeEventId: string;
    followedUserId: string;
    /** Polymarket asset ID (may be null for WS-first trades before enrichment) */
    assetId: string | null;
    /** On-chain outcome token ID (always set for WS-first trades) */
    rawTokenId: string | null;
    marketId: string | null;
    side: TradeSide;
    priceMicros: number;
    shareMicros: bigint;
    notionalMicros: bigint;
    detectTime: Date;
    eventTime: Date;
}

/**
 * Get the effective token ID for a trade event.
 * Prefers rawTokenId (on-chain) over assetId (API).
 */
export function getEffectiveTokenId(event: PendingTradeEvent): string | null {
    return event.rawTokenId ?? event.assetId;
}

/**
 * Pending activity event in the aggregation buffer.
 */
export interface PendingActivityEvent {
    type: "activity";
    activityEventId: string;
    followedUserId: string;
    activityType: ActivityType;
    assetIds: string[];
    detectTime: Date;
    eventTime: Date;
}

/**
 * Union type for pending events.
 */
export type PendingEvent = PendingTradeEvent | PendingActivityEvent;

/**
 * Aggregated trade group ready for executable simulation.
 *
 * Group key format: <followedUserId>:<tokenId>:<side>:<windowStartIso>
 * where tokenId = rawTokenId ?? assetId
 */
export interface TradeEventGroup {
    type: "trade";
    groupKey: string;
    followedUserId: string;
    /** Polymarket asset ID (may be null for WS-first trades) */
    assetId: string | null;
    /** On-chain outcome token ID (always set for WS-first trades) */
    rawTokenId: string | null;
    marketId: string | null;
    side: TradeSide;

    /** Summed notional across all trades in the group (micros). */
    totalNotionalMicros: bigint;

    /** Summed shares across all trades in the group (micros). */
    totalShareMicros: bigint;

    /** Volume-weighted average price (their reference price). */
    vwapPriceMicros: number;

    /** Earliest detect time for FIFO ordering. */
    earliestDetectTime: Date;

    /** Window start time (bucketed). */
    windowStart: Date;

    /** Individual trade event IDs in this group. */
    tradeEventIds: string[];
}

/**
 * Aggregated activity group ready for executable simulation.
 *
 * Group key format: <followedUserId>:<type>:<sortedAssetIds>:<windowStartIso>
 */
export interface ActivityEventGroup {
    type: "activity";
    groupKey: string;
    followedUserId: string;
    activityType: ActivityType;
    assetIds: string[];

    /** Earliest detect time for FIFO ordering. */
    earliestDetectTime: Date;

    /** Window start time (bucketed). */
    windowStart: Date;

    /** Individual activity event IDs in this group. */
    activityEventIds: string[];
}

/**
 * Union type for event groups.
 */
export type EventGroup = TradeEventGroup | ActivityEventGroup;

/**
 * Serializable trade group for queue payloads (BigInt/Date as strings).
 */
export interface QueueTradeEventGroup {
    type: "trade";
    groupKey: string;
    followedUserId: string;
    assetId: string | null;
    rawTokenId: string | null;
    marketId: string | null;
    side: TradeSide;
    totalNotionalMicros: string;
    totalShareMicros: string;
    vwapPriceMicros: number;
    earliestDetectTime: string;
    windowStart: string;
    tradeEventIds: string[];
}

/**
 * Serializable activity group for queue payloads (Date as strings).
 */
export interface QueueActivityEventGroup {
    type: "activity";
    groupKey: string;
    followedUserId: string;
    activityType: ActivityType;
    assetIds: string[];
    earliestDetectTime: string;
    windowStart: string;
    activityEventIds: string[];
}

/**
 * Union type for queue-safe event groups.
 */
export type QueueEventGroup = QueueTradeEventGroup | QueueActivityEventGroup;

/**
 * Job payload for q_group_events queue (trade).
 */
export interface GroupTradeJobData {
    tradeEventId: string;
    followedUserId: string;
}

/**
 * Job payload for q_group_events queue (activity).
 */
export interface GroupActivityJobData {
    activityEventId: string;
    followedUserId: string;
    activityType: string;
}

/**
 * Union type for group job payloads.
 */
export type GroupJobData = GroupTradeJobData | GroupActivityJobData;

/**
 * Type guard for trade job data.
 */
export function isTradeJobData(data: GroupJobData): data is GroupTradeJobData {
    return "tradeEventId" in data;
}

/**
 * Type guard for activity job data.
 */
export function isActivityJobData(data: GroupJobData): data is GroupActivityJobData {
    return "activityEventId" in data;
}

/**
 * Job payload for copy attempt queues.
 */
export interface CopyAttemptJobData {
    group: QueueEventGroup;
    portfolioScope: "EXEC_USER" | "EXEC_GLOBAL";
}

/**
 * Serialize an event group for queue transport.
 */
export function serializeEventGroup(group: EventGroup): QueueEventGroup {
    if (group.type === "trade") {
        return {
            type: "trade",
            groupKey: group.groupKey,
            followedUserId: group.followedUserId,
            assetId: group.assetId,
            rawTokenId: group.rawTokenId,
            marketId: group.marketId,
            side: group.side,
            totalNotionalMicros: group.totalNotionalMicros.toString(),
            totalShareMicros: group.totalShareMicros.toString(),
            vwapPriceMicros: group.vwapPriceMicros,
            earliestDetectTime: group.earliestDetectTime.toISOString(),
            windowStart: group.windowStart.toISOString(),
            tradeEventIds: group.tradeEventIds,
        };
    }

    return {
        type: "activity",
        groupKey: group.groupKey,
        followedUserId: group.followedUserId,
        activityType: group.activityType,
        assetIds: group.assetIds,
        earliestDetectTime: group.earliestDetectTime.toISOString(),
        windowStart: group.windowStart.toISOString(),
        activityEventIds: group.activityEventIds,
    };
}

/**
 * Deserialize a queue payload into an in-memory event group.
 */
export function deserializeEventGroup(group: QueueEventGroup): EventGroup {
    if (group.type === "trade") {
        return {
            type: "trade",
            groupKey: group.groupKey,
            followedUserId: group.followedUserId,
            assetId: group.assetId,
            rawTokenId: group.rawTokenId,
            marketId: group.marketId,
            side: group.side,
            totalNotionalMicros: BigInt(group.totalNotionalMicros),
            totalShareMicros: BigInt(group.totalShareMicros),
            vwapPriceMicros: group.vwapPriceMicros,
            earliestDetectTime: new Date(group.earliestDetectTime),
            windowStart: new Date(group.windowStart),
            tradeEventIds: group.tradeEventIds,
        };
    }

    return {
        type: "activity",
        groupKey: group.groupKey,
        followedUserId: group.followedUserId,
        activityType: group.activityType,
        assetIds: group.assetIds,
        earliestDetectTime: new Date(group.earliestDetectTime),
        windowStart: new Date(group.windowStart),
        activityEventIds: group.activityEventIds,
    };
}
