/**
 * Token Trading Params Cache
 *
 * This module provides trading constraint parameters (tick size, min order size)
 * required for live order placement. It implements a two-layer cache:
 * 1. In-memory cache (5 min TTL) for hot path optimization
 * 2. DB cache (6 hour TTL) for durability
 *
 * On cache miss, fetches from Polymarket CLOB API and caches for all tokens
 * in the same condition (batch optimization for YES/NO pairs).
 *
 * Follows fail-closed pattern: returns unavailable if constraints cannot be
 * determined, which causes LiveExecutor to SKIP the order.
 */

import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { fetchMarketInfo } from "../poly/client.js";
import { fetchTokenMetadata } from "../enrichment/gamma.js";

const logger = createChildLogger({ module: "trading-params" });

// ─── Type Definitions ─────────────────────────────────────────────────────────

/**
 * Token trading params from exchange.
 */
export interface TradingParams {
    tokenId: string;
    /** Minimum price increment in micros (e.g., 10_000 for $0.01 tick) */
    tickSizeMicros: number;
    /** Minimum order size in share micros (e.g., 1_000_000 for 1 share) */
    minOrderSizeShareMicros: bigint;
    /** Size must be multiple of this (default 1, may adjust on rejection) */
    sizeStepShareMicros: bigint;
}

/**
 * Result of getTradingParams - discriminated union for fail-closed pattern.
 */
export type TradingParamsResult =
    | { available: true; params: TradingParams }
    | { available: false; reason: TradingParamsUnavailableReason };

/**
 * Reasons why trading params may be unavailable.
 */
export type TradingParamsUnavailableReason =
    | "CONDITION_ID_MISSING"
    | "ENRICHMENT_FAILED"
    | "MARKET_INFO_FETCH_FAILED"
    | "MARKET_INFO_INVALID"
    | "MARKET_NOT_ACCEPTING_ORDERS";

/**
 * In-memory cache entry.
 */
interface MemoryCacheEntry {
    params: TradingParams;
    fetchedAt: number; // Date.now() timestamp
}

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
    /** DB cache TTL - refresh params older than this (6 hours) */
    DB_CACHE_TTL_MS: 6 * 60 * 60 * 1000,

    /** In-memory cache TTL (5 minutes) for hot path optimization */
    MEMORY_CACHE_TTL_MS: 5 * 60 * 1000,

    /** Default size step (1 micro-share) until rejection proves otherwise */
    DEFAULT_SIZE_STEP_SHARE_MICROS: BigInt(1),
};

// ─── In-Memory Cache ──────────────────────────────────────────────────────────

const memoryCache = new Map<string, MemoryCacheEntry>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get trading params for a token.
 *
 * Cache hierarchy:
 * 1. In-memory cache (5 min TTL) - fastest
 * 2. DB cache (6 hour TTL) - durable
 * 3. API fetch + batch persist for all tokens in condition
 *
 * @param tokenId - The outcome token ID
 * @returns Trading params or unavailable reason
 */
export async function getTradingParams(
    tokenId: string
): Promise<TradingParamsResult> {
    const log = logger.child({ tokenId });

    // ─── Layer 1: In-Memory Cache ─────────────────────────────────────────────
    const memEntry = memoryCache.get(tokenId);
    if (memEntry && Date.now() - memEntry.fetchedAt < CONFIG.MEMORY_CACHE_TTL_MS) {
        log.debug("Trading params from memory cache");
        return { available: true, params: memEntry.params };
    }

    // ─── Layer 2: DB Cache ────────────────────────────────────────────────────
    const dbEntry = await prisma.tokenTradingParamsCache.findUnique({
        where: { tokenId },
    });

    if (dbEntry && isCacheFresh(dbEntry.updatedAt)) {
        const params: TradingParams = {
            tokenId: dbEntry.tokenId,
            tickSizeMicros: dbEntry.tickSizeMicros,
            minOrderSizeShareMicros: dbEntry.minOrderSizeShareMicros,
            sizeStepShareMicros: dbEntry.sizeStepShareMicros,
        };

        // Promote to memory cache
        memoryCache.set(tokenId, { params, fetchedAt: Date.now() });
        log.debug("Trading params from DB cache");
        return { available: true, params };
    }

    // ─── Layer 3: Fetch from API ──────────────────────────────────────────────
    log.info("Trading params cache miss, fetching from API");
    return fetchAndCacheTradingParams(tokenId);
}

/**
 * Batch prefetch trading params for multiple tokens.
 * Useful when processing multiple copy attempts.
 *
 * @param tokenIds - Array of token IDs to prefetch
 */
export async function prefetchTradingParams(tokenIds: string[]): Promise<void> {
    if (tokenIds.length === 0) return;

    const log = logger.child({ tokenCount: tokenIds.length });
    log.debug("Prefetching trading params");

    // Check which tokens are missing from memory cache
    const missingTokenIds = tokenIds.filter((tokenId) => {
        const memEntry = memoryCache.get(tokenId);
        return !memEntry || Date.now() - memEntry.fetchedAt >= CONFIG.MEMORY_CACHE_TTL_MS;
    });

    if (missingTokenIds.length === 0) {
        log.debug("All tokens already in memory cache");
        return;
    }

    // Check DB cache for missing tokens
    const dbEntries = await prisma.tokenTradingParamsCache.findMany({
        where: { tokenId: { in: missingTokenIds } },
    });

    const now = Date.now();
    const stillMissing: string[] = [];

    for (const tokenId of missingTokenIds) {
        const dbEntry = dbEntries.find((e) => e.tokenId === tokenId);
        if (dbEntry && isCacheFresh(dbEntry.updatedAt)) {
            // Promote to memory cache
            memoryCache.set(tokenId, {
                params: {
                    tokenId: dbEntry.tokenId,
                    tickSizeMicros: dbEntry.tickSizeMicros,
                    minOrderSizeShareMicros: dbEntry.minOrderSizeShareMicros,
                    sizeStepShareMicros: dbEntry.sizeStepShareMicros,
                },
                fetchedAt: now,
            });
        } else {
            stillMissing.push(tokenId);
        }
    }

    // Fetch remaining from API (in parallel, grouped by condition to avoid dupes)
    // For simplicity, fetch sequentially - batch optimization happens within fetchAndCacheTradingParams
    for (const tokenId of stillMissing) {
        await fetchAndCacheTradingParams(tokenId);
    }

    log.debug({ prefetched: tokenIds.length - stillMissing.length, fetched: stillMissing.length },
        "Prefetch complete");
}

/**
 * Force refresh params for a token (e.g., after rejection suggests stale data).
 *
 * @param tokenId - The token ID to refresh
 * @returns Fresh trading params or unavailable reason
 */
export async function refreshTradingParams(
    tokenId: string
): Promise<TradingParamsResult> {
    const log = logger.child({ tokenId });
    log.info("Force refreshing trading params");

    // Clear from memory cache
    memoryCache.delete(tokenId);

    // Fetch fresh from API (will also update DB)
    return fetchAndCacheTradingParams(tokenId);
}

/**
 * Clear memory cache (for testing or manual intervention).
 */
export function clearMemoryCache(): void {
    memoryCache.clear();
    logger.info("Memory cache cleared");
}

// ─── Internal Functions ───────────────────────────────────────────────────────

/**
 * Fetch trading params from API via conditionId lookup.
 * On success, writes params for ALL tokens in the condition (batch optimization).
 */
async function fetchAndCacheTradingParams(
    tokenId: string
): Promise<TradingParamsResult> {
    const log = logger.child({ tokenId });

    // ─── Step 1: Resolve conditionId ──────────────────────────────────────────
    const conditionId = await resolveConditionId(tokenId);
    if (!conditionId) {
        log.warn("Cannot resolve conditionId for token");
        return { available: false, reason: "CONDITION_ID_MISSING" };
    }

    // ─── Step 2: Fetch MarketInfo ─────────────────────────────────────────────
    const paramsMap = await fetchAndParseMarketInfo(conditionId);
    if (!paramsMap) {
        return { available: false, reason: "MARKET_INFO_FETCH_FAILED" };
    }

    // Check if the paramsMap indicates market not accepting orders
    if (paramsMap.size === 0) {
        return { available: false, reason: "MARKET_NOT_ACCEPTING_ORDERS" };
    }

    // ─── Step 3: Batch persist all tokens in condition ────────────────────────
    const allParams = Array.from(paramsMap.values());
    if (allParams.length > 0) {
        await persistTradingParamsBatch(allParams);
    }

    // ─── Step 4: Return result for requested token ────────────────────────────
    const params = paramsMap.get(tokenId);
    if (!params) {
        log.warn({ conditionId, tokensFound: paramsMap.size },
            "Token not found in MarketInfo response");
        return { available: false, reason: "MARKET_INFO_INVALID" };
    }

    // Update memory cache
    memoryCache.set(tokenId, { params, fetchedAt: Date.now() });

    log.info({
        tickSizeMicros: params.tickSizeMicros,
        minOrderSizeShareMicros: params.minOrderSizeShareMicros.toString(),
        tokensInCondition: paramsMap.size,
    }, "Cached trading params from API");

    return { available: true, params };
}

/**
 * Look up conditionId from TokenMetadataCache, with fallback to enrichment.
 */
async function resolveConditionId(tokenId: string): Promise<string | null> {
    const log = logger.child({ tokenId });

    // ─── Check TokenMetadataCache first ───────────────────────────────────────
    const cached = await prisma.tokenMetadataCache.findUnique({
        where: { tokenId },
        select: { conditionId: true },
    });

    if (cached?.conditionId) {
        return cached.conditionId;
    }

    // ─── Attempt enrichment via Gamma API ─────────────────────────────────────
    log.info("conditionId missing, attempting enrichment");

    try {
        const metadata = await fetchTokenMetadata([tokenId]);
        const tokenMeta = metadata.get(tokenId);

        if (tokenMeta?.conditionId) {
            // Persist to cache
            await prisma.tokenMetadataCache.upsert({
                where: { tokenId },
                create: {
                    tokenId,
                    conditionId: tokenMeta.conditionId,
                    marketId: tokenMeta.marketId,
                    marketSlug: tokenMeta.marketSlug,
                    outcomeLabel: tokenMeta.outcomeLabel,
                    marketTitle: tokenMeta.marketTitle,
                    closeTime: tokenMeta.closeTime,
                },
                update: {
                    conditionId: tokenMeta.conditionId,
                    marketId: tokenMeta.marketId,
                    marketSlug: tokenMeta.marketSlug,
                    outcomeLabel: tokenMeta.outcomeLabel,
                    marketTitle: tokenMeta.marketTitle,
                    closeTime: tokenMeta.closeTime,
                },
            });

            log.info({ conditionId: tokenMeta.conditionId },
                "Enriched token metadata with conditionId");
            return tokenMeta.conditionId;
        }

        log.warn("Enrichment did not return conditionId");
        return null;
    } catch (err) {
        log.error({ err }, "Enrichment failed");
        return null;
    }
}

/**
 * Fetch MarketInfo from CLOB API and parse tick/min constraints.
 *
 * @returns Map of tokenId -> TradingParams for all tokens in the market,
 *          or null on fetch/parse failure,
 *          or empty Map if market not accepting orders
 */
async function fetchAndParseMarketInfo(
    conditionId: string
): Promise<Map<string, TradingParams> | null> {
    const log = logger.child({ conditionId });

    try {
        const marketInfo = await fetchMarketInfo(conditionId);

        // Check market is active/accepting orders
        if (marketInfo.closed === true || marketInfo.accepting_orders === false) {
            log.warn({ closed: marketInfo.closed, accepting: marketInfo.accepting_orders },
                "Market not available for trading");
            return new Map(); // Empty map signals market not accepting orders
        }

        // Parse tick size: "0.01" -> 10_000 micros
        const tickSizeMicros = parseTickSize(marketInfo.minimum_tick_size);
        if (tickSizeMicros === null) {
            log.error({ raw: marketInfo.minimum_tick_size }, "Failed to parse tick size");
            return null;
        }

        // Parse min order size: "1" -> 1_000_000 micros (1 share)
        const minOrderSizeShareMicros = parseMinOrderSize(marketInfo.minimum_order_size);
        if (minOrderSizeShareMicros === null) {
            log.error({ raw: marketInfo.minimum_order_size }, "Failed to parse min order size");
            return null;
        }

        // Build params for all tokens in this market
        const result = new Map<string, TradingParams>();
        for (const token of marketInfo.tokens) {
            result.set(token.token_id, {
                tokenId: token.token_id,
                tickSizeMicros,
                minOrderSizeShareMicros,
                sizeStepShareMicros: CONFIG.DEFAULT_SIZE_STEP_SHARE_MICROS,
            });
        }

        log.debug({
            tokenCount: result.size,
            tickSizeMicros,
            minOrderSizeShareMicros: minOrderSizeShareMicros.toString(),
        }, "Parsed MarketInfo trading params");

        return result;
    } catch (err) {
        log.error({ err }, "Failed to fetch MarketInfo");
        return null;
    }
}

/**
 * Persist trading params for all tokens in a condition (batch write).
 */
async function persistTradingParamsBatch(params: TradingParams[]): Promise<void> {
    if (params.length === 0) return;

    try {
        // Use Prisma transaction for batch upsert
        await prisma.$transaction(
            params.map((p) =>
                prisma.tokenTradingParamsCache.upsert({
                    where: { tokenId: p.tokenId },
                    create: {
                        tokenId: p.tokenId,
                        tickSizeMicros: p.tickSizeMicros,
                        minOrderSizeShareMicros: p.minOrderSizeShareMicros,
                        sizeStepShareMicros: p.sizeStepShareMicros,
                    },
                    update: {
                        tickSizeMicros: p.tickSizeMicros,
                        minOrderSizeShareMicros: p.minOrderSizeShareMicros,
                        // Note: do NOT overwrite sizeStepShareMicros if it was
                        // updated by rejection learning (future feature)
                    },
                })
            )
        );

        // Also update memory cache for all tokens
        const now = Date.now();
        for (const p of params) {
            memoryCache.set(p.tokenId, { params: p, fetchedAt: now });
        }

        logger.debug({ tokenCount: params.length }, "Persisted trading params batch");
    } catch (err) {
        // Log but don't fail - memory cache is still valid
        logger.error({ err }, "Failed to persist trading params batch");
    }
}

/**
 * Parse tick size string to micros.
 * "0.01" -> 10_000 (represents $0.01 increment)
 * "0.001" -> 1_000
 */
function parseTickSize(raw: string | undefined): number | null {
    if (!raw) {
        // Fail closed: do not assume a default tick size.
        return null;
    }
    const value = parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
        return null;
    }
    return Math.round(value * 1_000_000);
}

/**
 * Parse min order size string to share micros.
 * "1" -> 1_000_000 (1 share in micros)
 * "0.5" -> 500_000 (0.5 shares)
 */
function parseMinOrderSize(raw: string | undefined): bigint | null {
    if (!raw) {
        // Fail closed: do not assume a default minimum size.
        return null;
    }
    const value = parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }
    return BigInt(Math.round(value * 1_000_000));
}

/**
 * Check if DB cache entry is fresh enough.
 */
function isCacheFresh(updatedAt: Date): boolean {
    return Date.now() - updatedAt.getTime() < CONFIG.DB_CACHE_TTL_MS;
}
