/**
 * Small Trade Buffer Module
 *
 * Buffers small copy trades and flushes them in batches to reduce
 * distortion from per-trade minimums and improve live execution.
 *
 * Uses Redis for persistence across worker restarts.
 */

import type Redis from "ioredis";
import { TradeSide } from "@prisma/client";
import { createChildLogger } from "../log/logger.js";
import type { SmallTradeBuffering } from "@copybot/shared";
import { SmallTradeNettingMode } from "@copybot/shared";

const logger = createChildLogger({ module: "small-trade-buffer" });

// Redis key prefix for bucket storage
const BUCKET_KEY_PREFIX = "stb:bucket:";
// Redis key for the set of active bucket keys
const ACTIVE_BUCKETS_KEY = "stb:active_buckets";
// TTL for bucket keys (10 minutes - safety net beyond maxBufferMs)
const BUCKET_TTL_SECONDS = 600;

/**
 * Bucket state stored in Redis.
 */
export interface Bucket {
    /** Bucket key (followedUserId:tokenId:side or followedUserId:tokenId for netBuySell) */
    key: string;
    /** Followed user ID */
    followedUserId: string;
    /** Token ID (rawTokenId or assetId) */
    tokenId: string;
    /** Market ID (if known) */
    marketId: string | null;
    /** Side (for sameSideOnly mode) */
    side: TradeSide | null;
    /** Net notional in micros (signed: positive=BUY, negative=SELL) */
    netNotionalMicros: bigint;
    /** Net shares in micros (signed) */
    netShareMicros: bigint;
    /** Timestamp when bucket was first created */
    firstSeenAtMs: number;
    /** Timestamp of last update */
    lastUpdatedAtMs: number;
    /** Count of trades buffered in this bucket */
    countTradesBuffered: number;
    /** Reference price (VWAP of buffered trades) for share conversion */
    referencePriceMicros: number;
    /** Trade event IDs included in this bucket */
    tradeEventIds: string[];
}

/**
 * Serialized bucket for Redis storage.
 */
interface SerializedBucket {
    key: string;
    followedUserId: string;
    tokenId: string;
    marketId: string | null;
    side: TradeSide | null;
    netNotionalMicros: string;
    netShareMicros: string;
    firstSeenAtMs: number;
    lastUpdatedAtMs: number;
    countTradesBuffered: number;
    referencePriceMicros: number;
    tradeEventIds: string[];
}

/**
 * Flush reason for metrics and logging.
 */
export type FlushReason =
    | "threshold"
    | "quiet"
    | "maxTime"
    | "oppositeSide"
    | "shutdown";

/**
 * Result of a flush operation.
 */
export interface FlushResult {
    bucket: Bucket;
    reason: FlushReason;
    executed: boolean;
    skippedBelowMinExec: boolean;
}

/**
 * Metrics/counters for observability.
 */
export interface BufferMetrics {
    bufferedTrades: number;
    immediateTrades: number;
    flushedBuckets: number;
    flushReasonThreshold: number;
    flushReasonQuiet: number;
    flushReasonMaxTime: number;
    flushReasonOppositeSide: number;
    flushReasonShutdown: number;
    skippedFlushBelowMin: number;
}

// In-memory metrics (reset on worker restart)
const metrics: BufferMetrics = {
    bufferedTrades: 0,
    immediateTrades: 0,
    flushedBuckets: 0,
    flushReasonThreshold: 0,
    flushReasonQuiet: 0,
    flushReasonMaxTime: 0,
    flushReasonOppositeSide: 0,
    flushReasonShutdown: 0,
    skippedFlushBelowMin: 0,
};

// Redis client reference
let redis: Redis | null = null;

/**
 * Set the Redis client for buffer persistence.
 */
export function setBufferRedisClient(client: Redis): void {
    redis = client;
    logger.info("Buffer Redis client set");
}

/**
 * Serialize a bucket for Redis storage.
 */
function serializeBucket(bucket: Bucket): string {
    const serialized: SerializedBucket = {
        ...bucket,
        netNotionalMicros: bucket.netNotionalMicros.toString(),
        netShareMicros: bucket.netShareMicros.toString(),
    };
    return JSON.stringify(serialized);
}

/**
 * Deserialize a bucket from Redis storage.
 */
function deserializeBucket(json: string): Bucket {
    const parsed: SerializedBucket = JSON.parse(json);
    return {
        ...parsed,
        netNotionalMicros: BigInt(parsed.netNotionalMicros),
        netShareMicros: BigInt(parsed.netShareMicros),
    };
}

/**
 * Generate bucket key based on netting mode.
 */
export function generateBucketKey(
    followedUserId: string,
    tokenId: string,
    side: TradeSide,
    nettingMode: "sameSideOnly" | "netBuySell"
): string {
    if (nettingMode === "sameSideOnly") {
        return `${followedUserId}:${tokenId}:${side}`;
    }
    // netBuySell: single bucket per (user, token)
    return `${followedUserId}:${tokenId}`;
}

/**
 * Get a bucket from Redis.
 */
export async function getBucket(key: string): Promise<Bucket | null> {
    if (!redis) {
        logger.warn("Redis not initialized, cannot get bucket");
        return null;
    }

    const redisKey = BUCKET_KEY_PREFIX + key;
    const data = await redis.get(redisKey);
    if (!data) return null;

    try {
        return deserializeBucket(data);
    } catch (err) {
        logger.error({ err, key }, "Failed to deserialize bucket");
        return null;
    }
}

/**
 * Save a bucket to Redis.
 */
async function saveBucket(bucket: Bucket): Promise<void> {
    if (!redis) {
        logger.warn("Redis not initialized, cannot save bucket");
        return;
    }

    const redisKey = BUCKET_KEY_PREFIX + bucket.key;
    const data = serializeBucket(bucket);

    // Use pipeline for atomic operation
    const pipeline = redis.pipeline();
    pipeline.set(redisKey, data, "EX", BUCKET_TTL_SECONDS);
    pipeline.sadd(ACTIVE_BUCKETS_KEY, bucket.key);
    await pipeline.exec();
}

/**
 * Delete a bucket from Redis.
 */
async function deleteBucket(key: string): Promise<void> {
    if (!redis) return;

    const redisKey = BUCKET_KEY_PREFIX + key;
    const pipeline = redis.pipeline();
    pipeline.del(redisKey);
    pipeline.srem(ACTIVE_BUCKETS_KEY, key);
    await pipeline.exec();
}

/**
 * Get all active bucket keys.
 */
export async function getActiveBucketKeys(): Promise<string[]> {
    if (!redis) return [];
    return redis.smembers(ACTIVE_BUCKETS_KEY);
}

/**
 * Get all active buckets.
 */
export async function getAllBuckets(): Promise<Bucket[]> {
    const keys = await getActiveBucketKeys();
    const buckets: Bucket[] = [];

    for (const key of keys) {
        const bucket = await getBucket(key);
        if (bucket) {
            buckets.push(bucket);
        } else {
            // Clean up orphaned key
            if (redis) {
                await redis.srem(ACTIVE_BUCKETS_KEY, key);
            }
        }
    }

    return buckets;
}

/**
 * Input for appending a trade to the buffer.
 */
export interface BufferTradeInput {
    followedUserId: string;
    tokenId: string;
    marketId: string | null;
    side: TradeSide;
    /** Copy notional in micros (always positive) */
    copyNotionalMicros: bigint;
    /** Copy shares in micros (always positive) */
    copyShareMicros: bigint;
    /** Price in micros */
    priceMicros: number;
    /** Trade event ID */
    tradeEventId: string;
}

/**
 * Result of appending a trade to the buffer.
 */
export interface AppendResult {
    /** Whether the trade was buffered (true) or should execute immediately (false) */
    buffered: boolean;
    /** If buffered, the bucket key */
    bucketKey?: string;
    /** If a flush was triggered (e.g., opposite side), the flush result */
    flushTriggered?: FlushResult;
}

/**
 * Append a trade to the buffer.
 * Returns whether the trade was buffered or should execute immediately.
 */
export async function appendTrade(
    input: BufferTradeInput,
    config: SmallTradeBuffering
): Promise<AppendResult> {
    const { followedUserId, tokenId, marketId, side, copyNotionalMicros, copyShareMicros, priceMicros, tradeEventId } = input;

    // Check if this trade is "small" (should be buffered)
    if (copyNotionalMicros >= BigInt(config.notionalThresholdMicros)) {
        metrics.immediateTrades++;
        logger.debug(
            { followedUserId, tokenId, side, notional: copyNotionalMicros.toString() },
            "Trade above threshold, executing immediately"
        );
        return { buffered: false };
    }

    const bucketKey = generateBucketKey(followedUserId, tokenId, side, config.nettingMode);
    const now = Date.now();

    // Get existing bucket
    let bucket = await getBucket(bucketKey);
    let flushTriggered: FlushResult | undefined;

    // Handle sameSideOnly mode: check if opposite side bucket exists
    if (config.nettingMode === SmallTradeNettingMode.SAME_SIDE_ONLY) {
        const oppositeSide = side === TradeSide.BUY ? TradeSide.SELL : TradeSide.BUY;
        const oppositeKey = generateBucketKey(followedUserId, tokenId, oppositeSide, config.nettingMode);
        const oppositeBucket = await getBucket(oppositeKey);

        if (oppositeBucket && oppositeBucket.countTradesBuffered > 0) {
            // Flush opposite bucket before creating new one
            logger.debug({ oppositeKey }, "Flushing opposite side bucket");
            flushTriggered = await flushBucket(oppositeKey, "oppositeSide", config);
        }
    }

    // Signed notional: BUY is positive, SELL is negative
    const signedNotional = side === TradeSide.BUY ? copyNotionalMicros : -copyNotionalMicros;
    const signedShares = side === TradeSide.BUY ? copyShareMicros : -copyShareMicros;

    if (!bucket) {
        // Create new bucket
        bucket = {
            key: bucketKey,
            followedUserId,
            tokenId,
            marketId,
            side: config.nettingMode === SmallTradeNettingMode.SAME_SIDE_ONLY ? side : null,
            netNotionalMicros: signedNotional,
            netShareMicros: signedShares,
            firstSeenAtMs: now,
            lastUpdatedAtMs: now,
            countTradesBuffered: 1,
            referencePriceMicros: priceMicros,
            tradeEventIds: [tradeEventId],
        };
    } else {
        // Update existing bucket
        const newNetNotional = bucket.netNotionalMicros + signedNotional;
        const newNetShares = bucket.netShareMicros + signedShares;

        // Update VWAP reference price
        const totalNotional = absBI(bucket.netNotionalMicros) + absBI(signedNotional);
        const weightedPrice =
            totalNotional > 0n
                ? Number(
                      (absBI(bucket.netNotionalMicros) * BigInt(bucket.referencePriceMicros) +
                          absBI(signedNotional) * BigInt(priceMicros)) /
                          totalNotional
                  )
                : priceMicros;

        bucket = {
            ...bucket,
            netNotionalMicros: newNetNotional,
            netShareMicros: newNetShares,
            lastUpdatedAtMs: now,
            countTradesBuffered: bucket.countTradesBuffered + 1,
            referencePriceMicros: weightedPrice,
            tradeEventIds: [...bucket.tradeEventIds, tradeEventId],
        };
    }

    await saveBucket(bucket);
    metrics.bufferedTrades++;

    logger.debug(
        {
            bucketKey,
            netNotional: bucket.netNotionalMicros.toString(),
            count: bucket.countTradesBuffered,
        },
        "Trade buffered"
    );

    return { buffered: true, bucketKey, flushTriggered };
}

/**
 * Helper for BigInt absolute value.
 */
function absBI(n: bigint): bigint {
    return n < 0n ? -n : n;
}

/**
 * Determine if a bucket should be flushed and why.
 */
export function shouldFlush(
    bucket: Bucket,
    config: SmallTradeBuffering,
    now: number
): FlushReason | null {
    const absNotional = absBI(bucket.netNotionalMicros);

    // 1. Notional threshold reached
    if (absNotional >= BigInt(config.flushMinNotionalMicros)) {
        return "threshold";
    }

    // 2. Max time reached
    const age = now - bucket.firstSeenAtMs;
    if (age >= config.maxBufferMs) {
        return "maxTime";
    }

    // 3. Quiet time reached (only if above min exec)
    const timeSinceLastUpdate = now - bucket.lastUpdatedAtMs;
    if (
        timeSinceLastUpdate >= config.quietFlushMs &&
        absNotional >= BigInt(config.minExecNotionalMicros)
    ) {
        return "quiet";
    }

    return null;
}

/**
 * Flush a bucket.
 */
export async function flushBucket(
    key: string,
    reason: FlushReason,
    config: SmallTradeBuffering
): Promise<FlushResult> {
    const bucket = await getBucket(key);

    if (!bucket) {
        logger.warn({ key }, "Bucket not found for flush");
        return {
            bucket: {
                key,
                followedUserId: "",
                tokenId: "",
                marketId: null,
                side: null,
                netNotionalMicros: 0n,
                netShareMicros: 0n,
                firstSeenAtMs: 0,
                lastUpdatedAtMs: 0,
                countTradesBuffered: 0,
                referencePriceMicros: 0,
                tradeEventIds: [],
            },
            reason,
            executed: false,
            skippedBelowMinExec: false,
        };
    }

    const absNotional = absBI(bucket.netNotionalMicros);
    let executed = false;
    let skippedBelowMinExec = false;

    // Check min exec threshold
    if (absNotional < BigInt(config.minExecNotionalMicros)) {
        skippedBelowMinExec = true;
        metrics.skippedFlushBelowMin++;
        logger.info(
            { key, reason, notional: absNotional.toString(), minExec: config.minExecNotionalMicros },
            "Skipping flush: below min exec threshold"
        );
    } else {
        executed = true;
        metrics.flushedBuckets++;
        logger.info(
            { key, reason, notional: bucket.netNotionalMicros.toString(), count: bucket.countTradesBuffered },
            "Flushing bucket"
        );
    }

    // Update reason-specific metrics
    switch (reason) {
        case "threshold":
            metrics.flushReasonThreshold++;
            break;
        case "quiet":
            metrics.flushReasonQuiet++;
            break;
        case "maxTime":
            metrics.flushReasonMaxTime++;
            break;
        case "oppositeSide":
            metrics.flushReasonOppositeSide++;
            break;
        case "shutdown":
            metrics.flushReasonShutdown++;
            break;
    }

    // Delete bucket from Redis
    await deleteBucket(key);

    return { bucket, reason, executed, skippedBelowMinExec };
}

/**
 * Scan all buckets and flush any that are due.
 * Returns list of flush results for buckets that were executed.
 */
export async function scanAndFlushDueBuckets(
    config: SmallTradeBuffering
): Promise<FlushResult[]> {
    const buckets = await getAllBuckets();
    const now = Date.now();
    const results: FlushResult[] = [];

    for (const bucket of buckets) {
        const reason = shouldFlush(bucket, config, now);
        if (reason) {
            const result = await flushBucket(bucket.key, reason, config);
            if (result.executed) {
                results.push(result);
            }
        }
    }

    return results;
}

/**
 * Flush all buckets (for graceful shutdown).
 */
export async function flushAllBuckets(
    config: SmallTradeBuffering
): Promise<FlushResult[]> {
    const buckets = await getAllBuckets();
    const results: FlushResult[] = [];

    for (const bucket of buckets) {
        const result = await flushBucket(bucket.key, "shutdown", config);
        results.push(result);
    }

    return results;
}

/**
 * Get buffer statistics for health endpoint.
 */
export async function getBufferStats(): Promise<{
    activeBucketsCount: number;
    pendingNotionalTotalMicros: bigint;
    metrics: BufferMetrics;
}> {
    const buckets = await getAllBuckets();
    let pendingNotionalTotalMicros = 0n;

    for (const bucket of buckets) {
        pendingNotionalTotalMicros += absBI(bucket.netNotionalMicros);
    }

    return {
        activeBucketsCount: buckets.length,
        pendingNotionalTotalMicros,
        metrics: { ...metrics },
    };
}

/**
 * Get metrics (for health endpoint).
 */
export function getMetrics(): BufferMetrics {
    return { ...metrics };
}

/**
 * Reset metrics (for testing).
 */
export function resetMetrics(): void {
    metrics.bufferedTrades = 0;
    metrics.immediateTrades = 0;
    metrics.flushedBuckets = 0;
    metrics.flushReasonThreshold = 0;
    metrics.flushReasonQuiet = 0;
    metrics.flushReasonMaxTime = 0;
    metrics.flushReasonOppositeSide = 0;
    metrics.flushReasonShutdown = 0;
    metrics.skippedFlushBelowMin = 0;
}
