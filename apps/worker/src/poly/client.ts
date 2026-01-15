import { request } from "undici";
import { z } from "zod";
import { env } from "../config/env.js";
import { polymarketHighPriorityLimiter, polymarketLowPriorityLimiter } from "../http/limiters.js";
import { createChildLogger } from "../log/logger.js";
import {
    PolymarketTradeSchema,
    type PolymarketTrade,
    PolymarketActivitySchema,
    type PolymarketActivity,
    type OrderBook,
    OrderBookSchema,
    type MarketInfo,
    MarketInfoSchema,
} from "./types.js";

const logger = createChildLogger({ module: "polymarket-api" });

// Cache of tokens that returned 404 (resolved markets)
// Map<tokenId, failedAtTimestamp>
const failedTokenCache = new Map<string, number>();
const FAILED_TOKEN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (resolved markets stay resolved)

// Redis key for persisting resolved tokens across restarts
const RESOLVED_TOKENS_REDIS_KEY = "polymarket:resolved_tokens";

// In-memory set loaded from Redis on startup
let resolvedTokensFromRedis = new Set<string>();
let resolvedTokensLoaded = false;

/**
 * Load resolved tokens from Redis (call once on startup).
 */
export async function loadResolvedTokensFromRedis(redis: { smembers: (key: string) => Promise<string[]> }): Promise<void> {
    try {
        const tokens = await redis.smembers(RESOLVED_TOKENS_REDIS_KEY);
        resolvedTokensFromRedis = new Set(tokens);
        resolvedTokensLoaded = true;
        logger.info({ count: tokens.length }, "Loaded resolved tokens from Redis");
    } catch (err) {
        logger.warn({ err }, "Failed to load resolved tokens from Redis");
    }
}

/**
 * Save a resolved token to Redis.
 */
async function saveResolvedTokenToRedis(tokenId: string, redis?: { sadd: (key: string, value: string) => Promise<number> }): Promise<void> {
    if (!redis) return;
    try {
        await redis.sadd(RESOLVED_TOKENS_REDIS_KEY, tokenId);
        resolvedTokensFromRedis.add(tokenId);
    } catch (err) {
        logger.debug({ err, tokenId }, "Failed to save resolved token to Redis");
    }
}

// Redis instance reference (set via setRedisClient)
let redisClient: { sadd: (key: string, value: string) => Promise<number> } | null = null;

/**
 * Set the Redis client for persisting resolved tokens.
 */
export function setRedisClient(redis: { sadd: (key: string, value: string) => Promise<number> }): void {
    redisClient = redis;
}

function isTokenCached(tokenId: string): boolean {
    // Check Redis-persisted resolved tokens first
    if (resolvedTokensLoaded && resolvedTokensFromRedis.has(tokenId)) {
        return true;
    }

    // Then check in-memory cache
    const failedAt = failedTokenCache.get(tokenId);
    if (!failedAt) return false;
    if (Date.now() - failedAt > FAILED_TOKEN_CACHE_TTL_MS) {
        failedTokenCache.delete(tokenId);
        return false;
    }
    return true;
}

function cacheFailedToken(tokenId: string): void {
    failedTokenCache.set(tokenId, Date.now());
    // Also persist to Redis for cross-restart durability
    saveResolvedTokenToRedis(tokenId, redisClient ?? undefined);
}

/**
 * Make a rate-limited request to Polymarket Data API.
 * Uses high-priority limiter for time-sensitive trade/activity requests.
 */
async function dataApiRequest<T>(
    path: string,
    schema: z.ZodType<T>,
    params?: Record<string, string>
): Promise<T> {
    const url = new URL(path, env.POLYMARKET_DATA_API_BASE_URL);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
    }

    return polymarketHighPriorityLimiter.schedule(async () => {
        logger.debug({ url: url.toString() }, "Data API request (high priority)");
        const response = await request(url.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
        });

        if (response.statusCode !== 200) {
            const body = await response.body.text();
            throw new Error(`Data API error ${response.statusCode}: ${body}`);
        }

        const json = await response.body.json();
        return schema.parse(json);
    });
}

/**
 * Make a rate-limited request to Polymarket CLOB API.
 * Uses low-priority limiter for price/book fetches (not time-sensitive).
 */
async function clobApiRequest<T>(
    path: string,
    schema: z.ZodType<T>,
    params?: Record<string, string>
): Promise<T> {
    const url = new URL(path, env.POLYMARKET_CLOB_BASE_URL);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
    }

    return polymarketLowPriorityLimiter.schedule(async () => {
        logger.debug({ url: url.toString() }, "CLOB API request (low priority)");
        const response = await request(url.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
        });

        if (response.statusCode !== 200) {
            const body = await response.body.text();
            throw new Error(`CLOB API error ${response.statusCode}: ${body}`);
        }

        const json = await response.body.json();
        return schema.parse(json);
    });
}

/**
 * Fetch trades for a wallet address.
 * Returns trades sorted by timestamp descending.
 *
 * Uses the 'user' parameter which returns all trades for the user
 * including those made via proxy wallets.
 */
export async function fetchWalletTrades(
    walletAddress: string,
    options?: {
        limit?: number;
        after?: string; // Unix timestamp (seconds) - only trades after this time
    }
): Promise<PolymarketTrade[]> {
    const params: Record<string, string> = {
        user: walletAddress,
    };

    if (options?.limit) {
        params.limit = options.limit.toString();
    }
    if (options?.after) {
        params.after = options.after;
    }

    try {
        const trades = await dataApiRequest(
            "/trades",
            z.array(PolymarketTradeSchema),
            params
        );
        logger.debug(
            { wallet: walletAddress, count: trades.length },
            "Fetched wallet trades"
        );
        return trades;
    } catch (err) {
        logger.error({ err, wallet: walletAddress }, "Failed to fetch wallet trades");
        throw err;
    }
}

/**
 * Fetch activity (MERGE/SPLIT/REDEEM) for a wallet address.
 * Returns activity events sorted by timestamp descending.
 */
export async function fetchWalletActivity(
    walletAddress: string,
    options?: {
        limit?: number;
        after?: string; // Unix timestamp (seconds) - only activity after this time
    }
): Promise<PolymarketActivity[]> {
    const params: Record<string, string> = {
        user: walletAddress,
    };

    if (options?.limit) {
        params.limit = options.limit.toString();
    }
    if (options?.after) {
        params.after = options.after;
    }

    try {
        const activities = await dataApiRequest(
            "/activity",
            z.array(PolymarketActivitySchema),
            params
        );

        // Filter out TRADE type - we handle those via trades endpoint
        const nonTradeActivities = activities.filter(
            (a) => a.type !== "TRADE"
        );

        logger.debug(
            { wallet: walletAddress, count: nonTradeActivities.length },
            "Fetched wallet activity"
        );
        // Cast needed due to Zod transform type inference limitations
        return nonTradeActivities as PolymarketActivity[];
    } catch (err) {
        logger.error({ err, wallet: walletAddress }, "Failed to fetch wallet activity");
        throw err;
    }
}

/**
 * Fetch order book for a token/asset.
 * Returns null if the token is cached as failed (resolved market) or returns 404.
 */
export async function fetchOrderBook(tokenId: string): Promise<OrderBook | null> {
    // Check if token recently failed (resolved market)
    if (isTokenCached(tokenId)) {
        logger.debug({ tokenId }, "Skipping cached failed token");
        return null;
    }

    try {
        const book = await clobApiRequest("/book", OrderBookSchema, {
            token_id: tokenId,
        });
        logger.debug(
            { tokenId, bids: book.bids.length, asks: book.asks.length },
            "Fetched order book"
        );
        return book;
    } catch (err) {
        // Cache 404s (resolved markets)
        if (err instanceof Error && err.message.includes("404")) {
            cacheFailedToken(tokenId);
            logger.debug({ tokenId }, "Token orderbook not found, caching");
            return null;
        }
        logger.error({ err, tokenId }, "Failed to fetch order book");
        throw err;
    }
}

/**
 * Fetch market info by condition ID.
 */
export async function fetchMarketInfo(conditionId: string): Promise<MarketInfo> {
    try {
        const market = await clobApiRequest("/markets/" + conditionId, MarketInfoSchema);
        logger.debug({ conditionId }, "Fetched market info");
        return market;
    } catch (err) {
        logger.error({ err, conditionId }, "Failed to fetch market info");
        throw err;
    }
}

/**
 * Small delay between price fetches to spread API load
 * and allow higher-priority requests (trades) to interleave.
 */
const PRICE_FETCH_DELAY_MS = 150;

/**
 * Fetch current prices for multiple tokens.
 * Adds delays between fetches to avoid burst pressure on the rate limiter.
 */
export async function fetchPrices(
    tokenIds: string[]
): Promise<Map<string, number>> {
    const prices = new Map<string, number>();

    // CLOB API allows fetching prices for individual tokens
    // Fetch individually with delays to spread load
    for (let i = 0; i < tokenIds.length; i++) {
        const tokenId = tokenIds[i]!;

        try {
            const book = await fetchOrderBook(tokenId);

            // Skip if token is cached as failed (resolved market)
            if (!book) {
                continue;
            }

            // Calculate midpoint price
            const bestBid =
                book.bids.length > 0 ? parseFloat(book.bids[0]!.price) : 0;
            const bestAsk =
                book.asks.length > 0 ? parseFloat(book.asks[0]!.price) : 1;

            if (bestBid > 0 && bestAsk < 1) {
                prices.set(tokenId, (bestBid + bestAsk) / 2);
            } else if (bestBid > 0) {
                prices.set(tokenId, bestBid);
            } else if (bestAsk < 1) {
                prices.set(tokenId, bestAsk);
            } else {
                prices.set(tokenId, 0.5); // Default fallback
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.warn({ error: errMsg, tokenId }, "Failed to fetch price for token");
        }

        // Add delay between fetches to spread load (skip after last item)
        if (i < tokenIds.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, PRICE_FETCH_DELAY_MS));
        }
    }

    return prices;
}

/**
 * Convert price decimal (0-1) to micros (0-1,000,000).
 */
export function priceToMicros(price: string | number): number {
    const p = typeof price === "string" ? parseFloat(price) : price;
    return Math.round(p * 1_000_000);
}

/**
 * Convert shares decimal string to micros.
 * Shares are typically in "units" already, but may have decimals.
 */
export function sharesToMicros(shares: string | number): bigint {
    const s = typeof shares === "string" ? parseFloat(shares) : shares;
    return BigInt(Math.round(s * 1_000_000));
}

/**
 * Convert USDC amount to micros (6 decimals = 1:1 mapping for USDC).
 */
export function usdcToMicros(usdc: string | number): bigint {
    const u = typeof usdc === "string" ? parseFloat(usdc) : usdc;
    return BigInt(Math.round(u * 1_000_000));
}
