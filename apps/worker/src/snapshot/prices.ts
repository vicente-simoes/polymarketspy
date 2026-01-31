/**
 * Current price refresh loop.
 *
 * Every interval:
 * 1. Get all held assetIds across all portfolios
 * 2. Fetch current prices for those assets
 * 3. Upsert CurrentPrice (1 row per asset)
 *
 * Notes:
 * - We intentionally avoid storing time-series rows for prices on the hot path.
 * - Historical price data (if needed) should be stored with explicit retention
 *   and never queried as "latest" via unbounded scans.
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
 * Get all unique assetIds that are held across any portfolio.
 * An asset is "held" if the sum of shareDeltaMicros != 0.
 */
async function getHeldAssetIds(): Promise<string[]> {
    const positions = await prisma.currentPosition.findMany({
        where: { shareMicros: { not: 0n } },
        select: { assetId: true },
    });
    return positions.map((pos) => pos.assetId);
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

        // 3. Write current prices
        let successCount = 0;

        for (const [assetId, price] of prices.entries()) {
            try {
                await prisma.currentPrice.upsert({
                    where: { assetId },
                    create: { assetId, midpointPriceMicros: priceToMicros(price) },
                    update: { midpointPriceMicros: priceToMicros(price) },
                });
                successCount++;
            } catch (err) {
                log.warn({ err, assetId }, "Failed to write current price");
            }
        }

        log.info(
            { assetCount: assetIds.length, successCount },
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
    const price = await prisma.currentPrice.findUnique({
        where: { assetId },
        select: { midpointPriceMicros: true },
    });
    return price?.midpointPriceMicros ?? null;
}

/**
 * Get the latest prices for multiple assets.
 */
export async function getLatestPrices(assetIds: string[]): Promise<Map<string, number>> {
    if (assetIds.length === 0) return new Map();

    const rows = await prisma.currentPrice.findMany({
        where: { assetId: { in: assetIds } },
        select: { assetId: true, midpointPriceMicros: true },
    });

    return new Map(rows.map((row) => [row.assetId, row.midpointPriceMicros]));
}
