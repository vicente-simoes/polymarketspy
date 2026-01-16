/**
 * Enrichment processor for WS-first trades.
 *
 * This module runs periodically to enrich trades that were created from
 * on-chain events but are missing market metadata.
 *
 * Flow:
 * 1. Poll for trades with enrichmentStatus = PENDING
 * 2. Collect unique rawTokenIds that need metadata
 * 3. Check TokenMetadataCache for existing metadata
 * 4. Fetch missing metadata from Gamma API
 * 5. Update TokenMetadataCache and TradeEvent records
 * 6. Set enrichmentStatus = ENRICHED
 */

import { EnrichmentStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { fetchTokenMetadata, type TokenMetadata } from "./gamma.js";

const logger = createChildLogger({ module: "enrichment" });

/**
 * Enrichment configuration.
 */
const CONFIG = {
    /** How often to run enrichment (ms) */
    POLL_INTERVAL_MS: 15_000, // 15 seconds

    /** Max trades to process per batch */
    BATCH_SIZE: 50,

    /** Max retries before marking FAILED */
    MAX_RETRIES: 5,

    /** Delay between retry attempts (ms) */
    RETRY_DELAY_MS: 60_000, // 1 minute
};

/**
 * Track retry counts for tokens that fail enrichment.
 * Map<tokenId, retryCount>
 */
const retryCount = new Map<string, number>();

/**
 * Module state.
 */
let isRunning = false;
let pollTimeout: NodeJS.Timeout | null = null;

/**
 * Get token metadata from cache or fetch from API.
 */
async function getOrFetchTokenMetadata(
    tokenIds: string[]
): Promise<Map<string, TokenMetadata>> {
    const result = new Map<string, TokenMetadata>();
    const missingTokenIds: string[] = [];

    // Check cache first
    for (const tokenId of tokenIds) {
        const cached = await prisma.tokenMetadataCache.findUnique({
            where: { tokenId },
        });

        if (cached && cached.marketTitle) {
            // Cache hit - convert to TokenMetadata
            result.set(tokenId, {
                tokenId: cached.tokenId,
                conditionId: cached.conditionId ?? "",
                marketId: cached.marketId,
                marketSlug: cached.marketSlug,
                outcomeLabel: cached.outcomeLabel ?? "Unknown",
                marketTitle: cached.marketTitle,
                closeTime: cached.closeTime,
            });
        } else {
            missingTokenIds.push(tokenId);
        }
    }

    if (missingTokenIds.length === 0) {
        return result;
    }

    // Fetch missing from Gamma API
    logger.debug(
        { cached: result.size, missing: missingTokenIds.length },
        "Fetching missing token metadata"
    );

    try {
        const fetched = await fetchTokenMetadata(missingTokenIds);

        // Save to cache and add to result
        for (const [tokenId, metadata] of fetched) {
            // Upsert to cache
            await prisma.tokenMetadataCache.upsert({
                where: { tokenId },
                create: {
                    tokenId: metadata.tokenId,
                    conditionId: metadata.conditionId,
                    marketId: metadata.marketId,
                    marketSlug: metadata.marketSlug,
                    outcomeLabel: metadata.outcomeLabel,
                    marketTitle: metadata.marketTitle,
                    closeTime: metadata.closeTime,
                },
                update: {
                    conditionId: metadata.conditionId,
                    marketId: metadata.marketId,
                    marketSlug: metadata.marketSlug,
                    outcomeLabel: metadata.outcomeLabel,
                    marketTitle: metadata.marketTitle,
                    closeTime: metadata.closeTime,
                },
            });

            result.set(tokenId, metadata);

            // Clear retry count on success
            retryCount.delete(tokenId);
        }

        // Track tokens that weren't found
        for (const tokenId of missingTokenIds) {
            if (!fetched.has(tokenId)) {
                const count = (retryCount.get(tokenId) ?? 0) + 1;
                retryCount.set(tokenId, count);
                logger.warn(
                    { tokenId, retryCount: count },
                    "Token not found in Gamma API"
                );
            }
        }
    } catch (err) {
        logger.error({ err }, "Failed to fetch token metadata from Gamma");
        // Don't throw - allow partial enrichment
    }

    return result;
}

/**
 * Process a batch of pending trades.
 */
async function processPendingTrades(): Promise<number> {
    // Find pending trades
    const pendingTrades = await prisma.tradeEvent.findMany({
        where: {
            enrichmentStatus: EnrichmentStatus.PENDING,
            rawTokenId: { not: null },
        },
        take: CONFIG.BATCH_SIZE,
        orderBy: { detectTime: "asc" }, // Process oldest first
    });

    if (pendingTrades.length === 0) {
        return 0;
    }

    logger.debug({ count: pendingTrades.length }, "Processing pending trades");

    // Collect unique token IDs
    const tokenIds = [...new Set(
        pendingTrades
            .map((t) => t.rawTokenId)
            .filter((id): id is string => id !== null)
    )];

    // Filter out tokens that have exceeded retry limit
    const tokenIdsToFetch = tokenIds.filter((id) => {
        const count = retryCount.get(id) ?? 0;
        return count < CONFIG.MAX_RETRIES;
    });

    // Get metadata (from cache or API)
    const metadata = await getOrFetchTokenMetadata(tokenIdsToFetch);

    // Update trades
    let enrichedCount = 0;
    let failedCount = 0;

    for (const trade of pendingTrades) {
        if (!trade.rawTokenId) continue;

        const tokenMetadata = metadata.get(trade.rawTokenId);
        const retries = retryCount.get(trade.rawTokenId) ?? 0;

        if (tokenMetadata) {
            // Enrich the trade
            await prisma.tradeEvent.update({
                where: { id: trade.id },
                data: {
                    marketId: tokenMetadata.marketId,
                    assetId: trade.rawTokenId, // Set assetId = rawTokenId
                    conditionId: tokenMetadata.conditionId,
                    enrichmentStatus: EnrichmentStatus.ENRICHED,
                    enrichedAt: new Date(),
                },
            });

            enrichedCount++;
            logger.debug(
                {
                    tradeId: trade.id,
                    tokenId: trade.rawTokenId,
                    market: tokenMetadata.marketTitle.slice(0, 30),
                },
                "Enriched trade"
            );
        } else if (retries >= CONFIG.MAX_RETRIES) {
            // Mark as failed after max retries
            await prisma.tradeEvent.update({
                where: { id: trade.id },
                data: {
                    enrichmentStatus: EnrichmentStatus.FAILED,
                    enrichedAt: new Date(),
                },
            });

            failedCount++;
            logger.warn(
                { tradeId: trade.id, tokenId: trade.rawTokenId, retries },
                "Marked trade enrichment as FAILED"
            );
        }
        // Otherwise, leave as PENDING for next attempt
    }

    if (enrichedCount > 0 || failedCount > 0) {
        logger.info(
            { enriched: enrichedCount, failed: failedCount, pending: pendingTrades.length },
            "Enrichment batch complete"
        );
    }

    return enrichedCount;
}

/**
 * Run one enrichment cycle.
 */
async function runEnrichmentCycle(): Promise<void> {
    try {
        const enriched = await processPendingTrades();

        // If we enriched a full batch, there might be more - run again soon
        if (enriched >= CONFIG.BATCH_SIZE) {
            scheduleNextCycle(1000); // 1 second
        } else {
            scheduleNextCycle(CONFIG.POLL_INTERVAL_MS);
        }
    } catch (err) {
        logger.error({ err }, "Enrichment cycle failed");
        scheduleNextCycle(CONFIG.POLL_INTERVAL_MS);
    }
}

/**
 * Schedule the next enrichment cycle.
 */
function scheduleNextCycle(delayMs: number): void {
    if (!isRunning) return;

    if (pollTimeout) {
        clearTimeout(pollTimeout);
    }

    pollTimeout = setTimeout(() => {
        runEnrichmentCycle().catch((err) => {
            logger.error({ err }, "Unhandled error in enrichment cycle");
        });
    }, delayMs);
}

/**
 * Start the enrichment processor.
 */
export function startEnrichmentProcessor(): void {
    if (isRunning) {
        logger.warn("Enrichment processor already running");
        return;
    }

    isRunning = true;
    logger.info("Starting enrichment processor");

    // Start first cycle after a short delay
    scheduleNextCycle(5000);
}

/**
 * Stop the enrichment processor.
 */
export function stopEnrichmentProcessor(): void {
    isRunning = false;

    if (pollTimeout) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
    }

    logger.info("Enrichment processor stopped");
}

/**
 * Get enrichment stats for monitoring.
 */
export async function getEnrichmentStats(): Promise<{
    pendingCount: number;
    failedCount: number;
    cachedTokens: number;
}> {
    const [pendingCount, failedCount, cachedTokens] = await Promise.all([
        prisma.tradeEvent.count({
            where: { enrichmentStatus: EnrichmentStatus.PENDING },
        }),
        prisma.tradeEvent.count({
            where: { enrichmentStatus: EnrichmentStatus.FAILED },
        }),
        prisma.tokenMetadataCache.count(),
    ]);

    return { pendingCount, failedCount, cachedTokens };
}
