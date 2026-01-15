/**
 * Market price snapshot loop.
 *
 * Every 30 seconds:
 * 1. Get all held assetIds across all portfolios
 * 2. Fetch current prices for those assets
 * 3. Upsert MarketPriceSnapshot bucketed to 30-second intervals
 */

import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { fetchPrices, priceToMicros } from "../poly/client.js";

const logger = createChildLogger({ module: "price-snapshot" });

/** Price refresh interval in milliseconds.
 * Increased from 30s to 120s to reduce API pressure.
 * Price accuracy at 2-minute granularity is sufficient for paper trading.
 */
const PRICE_REFRESH_INTERVAL_MS = 120_000;

let priceRefreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Get the 30-second bucket time for a given timestamp.
 */
function getBucketTime(timestamp: Date): Date {
    const ms = timestamp.getTime();
    const bucketMs = Math.floor(ms / PRICE_REFRESH_INTERVAL_MS) * PRICE_REFRESH_INTERVAL_MS;
    return new Date(bucketMs);
}

/**
 * Get all unique assetIds that are held across any portfolio.
 * An asset is "held" if the sum of shareDeltaMicros != 0.
 */
async function getHeldAssetIds(): Promise<string[]> {
    // Get all positions with non-zero holdings
    const positions = await prisma.ledgerEntry.groupBy({
        by: ["assetId"],
        where: {
            assetId: { not: null },
        },
        _sum: {
            shareDeltaMicros: true,
        },
    });

    // Filter to only those with non-zero sum
    const heldAssets: string[] = [];
    for (const pos of positions) {
        if (pos.assetId && pos._sum.shareDeltaMicros && pos._sum.shareDeltaMicros !== BigInt(0)) {
            heldAssets.push(pos.assetId);
        }
    }

    return heldAssets;
}

/**
 * Refresh prices for all held assets and write snapshots.
 */
async function refreshPrices(): Promise<void> {
    const log = logger.child({ operation: "refresh" });

    try {
        // 1. Get held assets
        const assetIds = await getHeldAssetIds();

        if (assetIds.length === 0) {
            log.debug("No held assets, skipping price refresh");
            return;
        }

        log.debug({ assetCount: assetIds.length }, "Refreshing prices for held assets");

        // 2. Fetch current prices
        const prices = await fetchPrices(assetIds);

        // 3. Write snapshots
        const bucketTime = getBucketTime(new Date());
        let successCount = 0;

        for (const [assetId, price] of prices.entries()) {
            try {
                await prisma.marketPriceSnapshot.upsert({
                    where: {
                        assetId_bucketTime: {
                            assetId,
                            bucketTime,
                        },
                    },
                    create: {
                        assetId,
                        bucketTime,
                        midpointPriceMicros: priceToMicros(price),
                    },
                    update: {
                        midpointPriceMicros: priceToMicros(price),
                    },
                });
                successCount++;
            } catch (err) {
                log.warn({ err, assetId }, "Failed to write price snapshot");
            }
        }

        log.info(
            { assetCount: assetIds.length, successCount, bucketTime },
            "Price refresh complete"
        );
    } catch (err) {
        log.error({ err }, "Price refresh failed");
    }
}

/**
 * Start the price refresh loop.
 */
export function startPriceRefreshLoop(): void {
    if (priceRefreshTimer) {
        logger.warn("Price refresh loop already running");
        return;
    }

    logger.info(
        { intervalMs: PRICE_REFRESH_INTERVAL_MS },
        "Starting price refresh loop"
    );

    // Run immediately, then on interval
    refreshPrices().catch((err) => {
        logger.error({ err }, "Initial price refresh failed");
    });

    priceRefreshTimer = setInterval(() => {
        refreshPrices().catch((err) => {
            logger.error({ err }, "Scheduled price refresh failed");
        });
    }, PRICE_REFRESH_INTERVAL_MS);
}

/**
 * Stop the price refresh loop.
 */
export function stopPriceRefreshLoop(): void {
    if (priceRefreshTimer) {
        clearInterval(priceRefreshTimer);
        priceRefreshTimer = null;
        logger.info("Price refresh loop stopped");
    }
}

/**
 * Get the latest price for an asset.
 */
export async function getLatestPrice(assetId: string): Promise<number | null> {
    const snapshot = await prisma.marketPriceSnapshot.findFirst({
        where: { assetId },
        orderBy: { bucketTime: "desc" },
    });

    return snapshot?.midpointPriceMicros ?? null;
}

/**
 * Get the latest prices for multiple assets.
 */
export async function getLatestPrices(assetIds: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();

    // Get most recent snapshot for each asset
    for (const assetId of assetIds) {
        const price = await getLatestPrice(assetId);
        if (price !== null) {
            prices.set(assetId, price);
        }
    }

    return prices;
}
