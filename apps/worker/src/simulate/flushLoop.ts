/**
 * Flush Loop for Small Trade Buffer
 *
 * Periodically scans all buckets and flushes those that are due.
 * Executed flushes are converted to TradeEventGroups and enqueued
 * for copy attempt processing.
 *
 * When flushes are skipped due to minExec threshold, a CopyAttempt
 * SKIP row is created for visibility in the dashboard.
 */

import { TradeSide, CopyDecision, PortfolioScope } from "@prisma/client";
import { ReasonCodes } from "@copybot/shared";
import { createChildLogger } from "../log/logger.js";
import { prisma } from "../db/prisma.js";
import { queues } from "../queue/queues.js";
import { getGlobalConfig } from "./config.js";
import {
    scanAndFlushDueBuckets,
    flushAllBuckets,
    type Bucket,
    type FlushResult,
} from "./smallTradeBuffer.js";
import { type TradeEventGroup, serializeEventGroup } from "./types.js";

const logger = createChildLogger({ module: "flush-loop" });

/** Flush loop interval in milliseconds */
const FLUSH_LOOP_INTERVAL_MS = 100;

/** Timer reference for cleanup */
let flushLoopTimer: ReturnType<typeof setInterval> | null = null;

/** Flag to prevent concurrent flush runs */
let isFlushRunning = false;

/** Flag for shutdown state */
let isShuttingDown = false;

/**
 * Convert a flushed bucket to a TradeEventGroup for execution.
 */
function bucketToTradeEventGroup(bucket: Bucket): TradeEventGroup {
    const windowStart = new Date(bucket.firstSeenAtMs);

    // Determine the effective side from the net position
    // Positive notional = BUY, Negative = SELL
    // For sameSideOnly mode, bucket.side is already set
    // For netBuySell mode, derive from net position
    let side: TradeSide;
    if (bucket.side) {
        side = bucket.side;
    } else {
        side = bucket.netNotionalMicros >= 0n ? TradeSide.BUY : TradeSide.SELL;
    }

    // Use absolute values for the group (side indicates direction)
    const absNotional = bucket.netNotionalMicros < 0n
        ? -bucket.netNotionalMicros
        : bucket.netNotionalMicros;
    const absShares = bucket.netShareMicros < 0n
        ? -bucket.netShareMicros
        : bucket.netShareMicros;

    const groupKey = `${bucket.followedUserId}:${bucket.tokenId}:${side}:${windowStart.toISOString()}:buffer`;

    return {
        type: "trade",
        groupKey,
        followedUserId: bucket.followedUserId,
        assetId: null, // Buffer trades use tokenId (rawTokenId)
        rawTokenId: bucket.tokenId,
        marketId: bucket.marketId,
        side,
        totalNotionalMicros: absNotional,
        totalShareMicros: absShares,
        vwapPriceMicros: bucket.referencePriceMicros,
        earliestDetectTime: new Date(bucket.firstSeenAtMs),
        windowStart,
        tradeEventIds: bucket.tradeEventIds,
    };
}

/**
 * Record a skipped buffer flush as a CopyAttempt SKIP row.
 * This provides visibility into trades that were buffered but not executed.
 */
async function recordSkippedFlush(bucket: Bucket, reason: string): Promise<void> {
    const log = logger.child({ bucketKey: bucket.key, reason });

    // Determine side from bucket
    let side: TradeSide;
    if (bucket.side) {
        side = bucket.side;
    } else {
        side = bucket.netNotionalMicros >= 0n ? TradeSide.BUY : TradeSide.SELL;
    }

    // Use absolute notional for the record
    const absNotional = bucket.netNotionalMicros < 0n
        ? -bucket.netNotionalMicros
        : bucket.netNotionalMicros;

    const windowStart = new Date(bucket.firstSeenAtMs);
    const groupKey = `${bucket.followedUserId}:${bucket.tokenId}:${side}:${windowStart.toISOString()}:buffer:skipped`;

    try {
        // Check if already recorded (idempotency)
        const existing = await prisma.copyAttempt.findFirst({
            where: {
                portfolioScope: PortfolioScope.EXEC_GLOBAL,
                followedUserId: null,
                groupKey,
            },
        });

        if (existing) {
            log.debug("Skip record already exists");
            return;
        }

        // Create SKIP record
        await prisma.copyAttempt.create({
            data: {
                portfolioScope: PortfolioScope.EXEC_GLOBAL,
                followedUserId: null,
                groupKey,
                decision: CopyDecision.SKIP,
                reasonCodes: [ReasonCodes.BUFFER_FLUSH_BELOW_MIN_EXEC],
                sourceType: "BUFFER",
                bufferedTradeCount: bucket.countTradesBuffered,
                targetNotionalMicros: absNotional,
                filledNotionalMicros: BigInt(0),
                vwapPriceMicros: 0, // No fill occurred
                filledRatioBps: 0,
                theirReferencePriceMicros: bucket.referencePriceMicros,
                midPriceMicrosAtDecision: 0, // No book lookup for skipped flush
            },
        });

        log.info(
            {
                notional: absNotional.toString(),
                tradesCount: bucket.countTradesBuffered,
                tradeEventIds: bucket.tradeEventIds,
            },
            "Recorded skipped buffer flush"
        );
    } catch (err) {
        log.error({ err }, "Failed to record skipped buffer flush");
        // Don't throw - this is a best-effort record
    }
}

/**
 * Process a flush result by enqueueing for execution or recording skip.
 */
async function processFlushResult(result: FlushResult): Promise<void> {
    if (!result.executed) {
        // Skipped due to below min exec threshold - record for visibility
        if (result.skippedBelowMinExec && result.bucket.countTradesBuffered > 0) {
            await recordSkippedFlush(result.bucket, result.reason);
        }
        return;
    }

    const { bucket, reason } = result;
    const log = logger.child({ bucketKey: bucket.key, reason });

    try {
        // Convert bucket to TradeEventGroup
        const group = bucketToTradeEventGroup(bucket);
        const queueGroup = serializeEventGroup(group);

        // Enqueue for copy attempt processing
        await queues.copyAttemptGlobal.add("copy-attempt-global", {
            group: queueGroup,
            portfolioScope: "EXEC_GLOBAL",
            sourceType: "BUFFER",
            bufferedTradeCount: bucket.countTradesBuffered,
        });

        log.info(
            {
                notional: bucket.netNotionalMicros.toString(),
                tradesCount: bucket.countTradesBuffered,
            },
            "Buffer flush enqueued for execution"
        );
    } catch (err) {
        log.error({ err }, "Failed to enqueue buffer flush for execution");
        throw err;
    }
}

/**
 * Single flush loop tick.
 * Scans all buckets and processes any that are due for flush.
 */
async function runFlushTick(): Promise<void> {
    if (isFlushRunning || isShuttingDown) {
        return;
    }

    isFlushRunning = true;

    try {
        const { smallTradeBuffering } = await getGlobalConfig();

        // Skip if buffering is disabled
        if (!smallTradeBuffering.enabled) {
            return;
        }

        // Scan and flush due buckets
        const results = await scanAndFlushDueBuckets(smallTradeBuffering);

        // Process each executed flush
        for (const result of results) {
            await processFlushResult(result);
        }

        if (results.length > 0) {
            logger.debug({ count: results.length }, "Flush tick processed buckets");
        }
    } catch (err) {
        logger.error({ err }, "Flush tick error");
    } finally {
        isFlushRunning = false;
    }
}

/**
 * Start the flush loop.
 * Should be called after Redis is initialized.
 */
export function startFlushLoop(): void {
    if (flushLoopTimer) {
        logger.warn("Flush loop already running");
        return;
    }

    isShuttingDown = false;
    flushLoopTimer = setInterval(runFlushTick, FLUSH_LOOP_INTERVAL_MS);
    logger.info({ intervalMs: FLUSH_LOOP_INTERVAL_MS }, "Flush loop started");
}

/**
 * Stop the flush loop.
 * Does not flush remaining buckets - use stopFlushLoopGracefully for that.
 */
export function stopFlushLoop(): void {
    if (flushLoopTimer) {
        clearInterval(flushLoopTimer);
        flushLoopTimer = null;
        logger.info("Flush loop stopped");
    }
}

/**
 * Stop the flush loop gracefully, flushing all remaining buckets.
 * Used during worker shutdown.
 */
export async function stopFlushLoopGracefully(): Promise<void> {
    isShuttingDown = true;
    stopFlushLoop();

    logger.info("Flushing all remaining buckets for graceful shutdown");

    try {
        const { smallTradeBuffering } = await getGlobalConfig();

        // Skip if buffering is disabled
        if (!smallTradeBuffering.enabled) {
            logger.info("Buffering disabled, no buckets to flush");
            return;
        }

        // Flush all remaining buckets
        const results = await flushAllBuckets(smallTradeBuffering);

        let executed = 0;
        let skipped = 0;

        for (const result of results) {
            await processFlushResult(result); // Handles both execute and skip recording
            if (result.executed) {
                executed++;
            } else {
                skipped++;
            }
        }

        logger.info(
            { total: results.length, executed, skipped },
            "Graceful shutdown flush complete"
        );
    } catch (err) {
        logger.error({ err }, "Error during graceful shutdown flush");
    }
}
