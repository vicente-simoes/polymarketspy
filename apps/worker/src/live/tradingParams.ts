/**
 * Token Trading Params Cache.
 *
 * Provides tick size, minimum order size, and size step constraints for live trading.
 * These parameters are required before submitting any live order to ensure we don't
 * violate exchange constraints.
 *
 * Algorithm:
 * 1. Check in-memory cache
 * 2. Check DB cache (TokenTradingParamsCache)
 * 3. Fetch from API: conditionId → MarketInfo → params
 * 4. Persist to DB and in-memory cache
 */

import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { fetchMarketInfo } from "../poly/client.js";
import { fetchSingleTokenMetadata } from "../enrichment/gamma.js";

const logger = createChildLogger({ module: "trading-params" });

/**
 * Trading parameters for a token.
 */
export interface TradingParams {
    /** Token ID (outcome token). */
    tokenId: string;
    /** Minimum price tick in micros (e.g., 10000 = $0.01). */
    tickSizeMicros: number;
    /** Minimum order size in share-micros (e.g., 5_000_000 = 5 shares). */
    minOrderSizeShareMicros: bigint;
    /** Size step in share-micros (e.g., 1 = 1 micro-share). */
    sizeStepShareMicros: bigint;
}

/**
 * Reasons why trading params may be unavailable.
 */
export type TradingParamsUnavailableReason =
    | "NO_CONDITION_ID"
    | "MARKET_INFO_FETCH_FAILED"
    | "INVALID_MARKET_INFO";

/**
 * Result of fetching trading params.
 */
export type TradingParamsResult =
    | { available: true; params: TradingParams }
    | { available: false; reason: TradingParamsUnavailableReason };

/**
 * In-memory cache entry.
 */
interface CacheEntry {
    params: TradingParams;
    loadedAt: number;
}

/**
 * In-memory cache for trading params.
 * Key: tokenId
 */
const memoryCache = new Map<string, CacheEntry>();

/**
 * Default cache TTL: 30 minutes.
 * Trading params rarely change, so we can cache aggressively.
 */
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Default size step (1 micro-share - most granular possible).
 */
const DEFAULT_SIZE_STEP_SHARE_MICROS = BigInt(1);

/**
 * Get conditionId for a token.
 *
 * First checks TokenMetadataCache, then fetches from Gamma API if needed.
 */
async function getConditionId(tokenId: string): Promise<string | null> {
    const log = logger.child({ tokenId });

    // 1. Check TokenMetadataCache in DB
    const cached = await prisma.tokenMetadataCache.findUnique({
        where: { tokenId },
        select: { conditionId: true },
    });

    if (cached?.conditionId) {
        log.debug({ conditionId: cached.conditionId }, "Found conditionId in cache");
        return cached.conditionId;
    }

    // 2. Fetch from Gamma API
    log.debug("conditionId not in cache, fetching from Gamma");

    try {
        const metadata = await fetchSingleTokenMetadata(tokenId);

        if (!metadata?.conditionId) {
            log.warn("Gamma returned no conditionId for token");
            return null;
        }

        // 3. Persist to TokenMetadataCache
        await prisma.tokenMetadataCache.upsert({
            where: { tokenId },
            create: {
                tokenId,
                conditionId: metadata.conditionId,
                marketId: metadata.marketId,
                marketSlug: metadata.marketSlug,
                outcomeLabel: metadata.outcomeLabel,
                marketTitle: metadata.marketTitle,
                closeTime: metadata.closeTime,
            },
            update: {
                conditionId: metadata.conditionId,
                // Also update other fields if they're more recent
                marketId: metadata.marketId,
                marketSlug: metadata.marketSlug,
                outcomeLabel: metadata.outcomeLabel,
                marketTitle: metadata.marketTitle,
                closeTime: metadata.closeTime,
            },
        });

        log.debug({ conditionId: metadata.conditionId }, "Fetched and cached conditionId");
        return metadata.conditionId;
    } catch (err) {
        log.error({ err }, "Failed to fetch conditionId from Gamma");
        return null;
    }
}

/**
 * Parse tick size from exchange format to micros.
 *
 * Exchange format: decimal string like "0.01"
 * Our format: integer micros like 10000
 */
function parseTickSizeMicros(tickSize: string | undefined): number {
    if (!tickSize) {
        throw new Error("minimum_tick_size missing from market info");
    }

    const parsed = parseFloat(tickSize);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`invalid minimum_tick_size: ${tickSize}`);
    }

    const micros = Math.round(parsed * 1_000_000);
    if (!Number.isFinite(micros) || micros <= 0) {
        throw new Error(`invalid minimum_tick_size after micros conversion: ${tickSize}`);
    }

    return micros;
}

/**
 * Parse minimum order size from exchange format to share-micros.
 *
 * Exchange format: decimal string like "5" (shares)
 * Our format: bigint share-micros like 5_000_000
 */
function parseMinOrderSizeShareMicros(minOrderSize: string | undefined): bigint {
    if (!minOrderSize) {
        throw new Error("minimum_order_size missing from market info");
    }

    const parsed = parseFloat(minOrderSize);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`invalid minimum_order_size: ${minOrderSize}`);
    }

    const shareMicros = Math.round(parsed * 1_000_000);
    if (!Number.isFinite(shareMicros) || shareMicros <= 0) {
        throw new Error(`invalid minimum_order_size after micros conversion: ${minOrderSize}`);
    }

    return BigInt(shareMicros);
}

/**
 * Fetch trading params from the exchange and cache them.
 */
async function fetchAndCacheTradingParams(
    tokenId: string,
    conditionId: string
): Promise<TradingParamsResult> {
    const log = logger.child({ tokenId, conditionId });

    try {
        // 1. Fetch market info from CLOB API
        log.debug("Fetching market info from CLOB API");
        const marketInfo = await fetchMarketInfo(conditionId);

        // 2. Parse tick size / min size (fail closed if missing/invalid)
        let tickSizeMicros: number;
        let minOrderSizeShareMicros: bigint;
        try {
            tickSizeMicros = parseTickSizeMicros(marketInfo.minimum_tick_size);
            minOrderSizeShareMicros = parseMinOrderSizeShareMicros(marketInfo.minimum_order_size);
        } catch (err) {
            log.error(
                {
                    err,
                    rawTickSize: marketInfo.minimum_tick_size,
                    rawMinOrderSize: marketInfo.minimum_order_size,
                },
                "Market info missing/invalid tick/min size; failing closed"
            );
            return { available: false, reason: "INVALID_MARKET_INFO" };
        }

        // 4. Size step = 1 micro-share (default, no known constraint from exchange)
        const sizeStepShareMicros = DEFAULT_SIZE_STEP_SHARE_MICROS;

        log.info(
            {
                tickSizeMicros,
                minOrderSizeShareMicros: minOrderSizeShareMicros.toString(),
                sizeStepShareMicros: sizeStepShareMicros.toString(),
                rawTickSize: marketInfo.minimum_tick_size,
                rawMinOrderSize: marketInfo.minimum_order_size,
            },
            "Parsed trading params from market info"
        );

        // 5. Write to DB cache for all tokens in this condition (best-effort)
        const knownTokensInCondition = await prisma.tokenMetadataCache.findMany({
            where: { conditionId },
            select: { tokenId: true },
        });
        const tokenIdsToCache = [
            tokenId,
            ...knownTokensInCondition.map((row) => row.tokenId),
        ];
        const uniqueTokenIdsToCache = [...new Set(tokenIdsToCache)].filter((id) => id.length > 0);

        await prisma.$transaction(
            uniqueTokenIdsToCache.map((id) =>
                prisma.tokenTradingParamsCache.upsert({
                    where: { tokenId: id },
                    create: {
                        tokenId: id,
                        tickSizeMicros,
                        minOrderSizeShareMicros,
                        sizeStepShareMicros,
                    },
                    update: {
                        tickSizeMicros,
                        minOrderSizeShareMicros,
                        sizeStepShareMicros,
                    },
                })
            )
        );

        const params: TradingParams = {
            tokenId,
            tickSizeMicros,
            minOrderSizeShareMicros,
            sizeStepShareMicros,
        };

        // 6. Update in-memory cache for all cached tokens
        const loadedAt = Date.now();
        for (const id of uniqueTokenIdsToCache) {
            memoryCache.set(id, {
                params: { ...params, tokenId: id },
                loadedAt,
            });
        }

        return { available: true, params };
    } catch (err) {
        log.error({ err }, "Failed to fetch market info");
        return { available: false, reason: "MARKET_INFO_FETCH_FAILED" };
    }
}

/**
 * Get trading params from DB cache.
 */
async function getFromDbCache(tokenId: string): Promise<TradingParams | null> {
    const cached = await prisma.tokenTradingParamsCache.findUnique({
        where: { tokenId },
    });

    if (!cached) {
        return null;
    }

    return {
        tokenId: cached.tokenId,
        tickSizeMicros: cached.tickSizeMicros,
        minOrderSizeShareMicros: cached.minOrderSizeShareMicros,
        sizeStepShareMicros: cached.sizeStepShareMicros,
    };
}

/**
 * Get trading params for a token.
 *
 * Checks in-memory cache first, then DB cache, then fetches from API.
 * Returns unavailable result if params cannot be determined.
 */
export async function getTradingParams(tokenId: string): Promise<TradingParamsResult> {
    const log = logger.child({ tokenId });

    // 1. Check in-memory cache
    const memCached = memoryCache.get(tokenId);
    if (memCached && Date.now() - memCached.loadedAt < DEFAULT_CACHE_TTL_MS) {
        log.debug("Returning trading params from memory cache");
        return { available: true, params: memCached.params };
    }

    // 2. Check DB cache
    const dbCached = await getFromDbCache(tokenId);
    if (dbCached) {
        // Update memory cache
        memoryCache.set(tokenId, {
            params: dbCached,
            loadedAt: Date.now(),
        });
        log.debug("Returning trading params from DB cache");
        return { available: true, params: dbCached };
    }

    // 3. Need to fetch from API - get conditionId first
    const conditionId = await getConditionId(tokenId);
    if (!conditionId) {
        log.warn("Cannot get trading params: no conditionId available");
        return { available: false, reason: "NO_CONDITION_ID" };
    }

    // 4. Fetch from API
    return fetchAndCacheTradingParams(tokenId, conditionId);
}

/**
 * Force refresh trading params from API (bypasses cache).
 *
 * Use this when you suspect params may have changed or after
 * receiving an exchange rejection due to constraint violation.
 */
export async function refreshTradingParams(tokenId: string): Promise<TradingParamsResult> {
    const log = logger.child({ tokenId });
    log.debug("Force refreshing trading params");

    // Clear memory cache entry
    memoryCache.delete(tokenId);

    // Get conditionId (may use cached value)
    const conditionId = await getConditionId(tokenId);
    if (!conditionId) {
        log.warn("Cannot refresh trading params: no conditionId available");
        return { available: false, reason: "NO_CONDITION_ID" };
    }

    // Fetch fresh from API
    return fetchAndCacheTradingParams(tokenId, conditionId);
}

/**
 * Get trading params with freshness check.
 *
 * Returns cached value if fresh enough, otherwise refreshes from API.
 *
 * @param tokenId - Token to get params for
 * @param maxAgeMs - Maximum acceptable age of cached params (default: 30 minutes)
 */
export async function getOrRefreshTradingParams(
    tokenId: string,
    maxAgeMs: number = DEFAULT_CACHE_TTL_MS
): Promise<TradingParamsResult> {
    const log = logger.child({ tokenId, maxAgeMs });

    // Check in-memory cache with custom TTL
    const memCached = memoryCache.get(tokenId);
    if (memCached && Date.now() - memCached.loadedAt < maxAgeMs) {
        log.debug("Returning trading params from memory cache (fresh)");
        return { available: true, params: memCached.params };
    }

    // Check DB cache - but we need to know when it was updated
    const dbCached = await prisma.tokenTradingParamsCache.findUnique({
        where: { tokenId },
    });

    if (dbCached) {
        const age = Date.now() - dbCached.updatedAt.getTime();
        if (age < maxAgeMs) {
            const params: TradingParams = {
                tokenId: dbCached.tokenId,
                tickSizeMicros: dbCached.tickSizeMicros,
                minOrderSizeShareMicros: dbCached.minOrderSizeShareMicros,
                sizeStepShareMicros: dbCached.sizeStepShareMicros,
            };

            // Update memory cache
            memoryCache.set(tokenId, {
                params,
                loadedAt: Date.now(),
            });

            log.debug({ ageMs: age }, "Returning trading params from DB cache (fresh)");
            return { available: true, params };
        }

        log.debug({ ageMs: age }, "DB cache is stale, refreshing");
    }

    // Need to refresh
    return refreshTradingParams(tokenId);
}

/**
 * Prefetch trading params for multiple tokens.
 *
 * Useful for warming the cache before a batch of live trades.
 * Fetches in parallel with concurrency limit.
 */
export async function prefetchTradingParams(tokenIds: string[]): Promise<void> {
    const log = logger.child({ tokenCount: tokenIds.length });
    log.debug("Prefetching trading params");

    // Dedupe and filter already-cached tokens
    const uniqueTokenIds = [...new Set(tokenIds)];
    const uncachedTokenIds = uniqueTokenIds.filter((tokenId) => {
        const cached = memoryCache.get(tokenId);
        return !cached || Date.now() - cached.loadedAt >= DEFAULT_CACHE_TTL_MS;
    });

    if (uncachedTokenIds.length === 0) {
        log.debug("All tokens already cached");
        return;
    }

    log.debug({ uncachedCount: uncachedTokenIds.length }, "Fetching uncached tokens");

    // Fetch with limited concurrency to avoid overwhelming the API
    const CONCURRENCY = 3;
    const results: TradingParamsResult[] = [];

    for (let i = 0; i < uncachedTokenIds.length; i += CONCURRENCY) {
        const batch = uncachedTokenIds.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map((tokenId) => getTradingParams(tokenId))
        );
        results.push(...batchResults);

        // Small delay between batches
        if (i + CONCURRENCY < uncachedTokenIds.length) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    const available = results.filter((r) => r.available).length;
    const unavailable = results.length - available;

    log.info(
        { total: uncachedTokenIds.length, available, unavailable },
        "Prefetch complete"
    );
}

/**
 * Clear the in-memory cache.
 *
 * Useful for testing or when you want to force DB lookups.
 */
export function clearMemoryCache(): void {
    memoryCache.clear();
    logger.debug("Trading params memory cache cleared");
}

/**
 * Get cache statistics for diagnostics.
 */
export function getCacheStats(): {
    memoryCacheSize: number;
    memoryCacheTokenIds: string[];
} {
    return {
        memoryCacheSize: memoryCache.size,
        memoryCacheTokenIds: [...memoryCache.keys()],
    };
}
