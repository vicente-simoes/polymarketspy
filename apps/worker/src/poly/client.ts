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
import { computeBestBid, computeBestAsk } from "../simulate/bookUtils.js";

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
 * Check whether a token has been cached as resolved (e.g. its order book 404'd).
 * Useful for prioritizing resolution/settlement checks without spamming Gamma.
 */
export function isResolvedTokenCached(tokenId: string): boolean {
    return isTokenCached(tokenId);
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
 * Fetch trades for a wallet address (single page).
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
        before?: string; // Unix timestamp (seconds) - only trades before this time
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
    if (options?.before) {
        params.before = options.before;
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

export type PaginatedWalletFetchResult<T> = {
    items: T[];
    pagesFetched: number;
    exhausted: boolean;
    hitMaxPages: boolean;
    stalled: boolean;
    nextBefore?: string;
    minTimestamp?: number;
    maxTimestamp?: number;
};

function tradeDedupeKey(trade: PolymarketTrade): string {
    if (trade.id) return `id:${trade.id}`;
    const txHash = trade.transactionHash ?? trade.transaction_hash ?? "unknown";
    const assetId = trade.assetId ?? trade.asset ?? trade.asset_id ?? "unknown";
    const ts = getTradeTimestamp(trade);
    const size =
        typeof trade.size === "string"
            ? trade.size
            : trade.size != null
              ? String(trade.size)
              : "unknown";
    return `${txHash}_${ts ?? "unknown"}_${trade.side}_${assetId}_${size}`;
}

function activityDedupeKey(activity: PolymarketActivity): string {
    const txHash = activity.transactionHash ?? "unknown";
    const asset = activity.asset ?? "unknown";
    return `${txHash}_${activity.timestamp}_${activity.type}_${asset}`;
}

/**
 * Fetch ALL trades for a wallet address with pagination.
 * Loops through pages until all trades in the time window are retrieved.
 *
 * This prevents the "lossy fetch" problem where >limit trades exist
 * in the catch-up window and older ones get permanently skipped.
 *
 * @param walletAddress - The wallet to fetch trades for
 * @param options.after - Only fetch trades after this timestamp (Unix seconds)
 * @param options.before - Only fetch trades before this timestamp (Unix seconds); used to resume pagination
 * @param options.maxPages - Safety limit on number of pages (default: 10)
 * @param options.pageSize - Number of trades per page (default: 100)
 * @returns Result containing trades and pagination metadata
 */
export async function fetchAllWalletTrades(
    walletAddress: string,
    options?: {
        after?: string;
        before?: string;
        maxPages?: number;
        pageSize?: number;
    }
): Promise<PaginatedWalletFetchResult<PolymarketTrade>> {
    const maxPages = options?.maxPages ?? 10;
    const pageSize = options?.pageSize ?? 100;
    const maxProbePageSize = 1000;
    const afterBoundSecondsRaw = options?.after != null ? Number(options.after) : undefined;
    const afterBoundSeconds = Number.isFinite(afterBoundSecondsRaw)
        ? (afterBoundSecondsRaw as number)
        : undefined;
    const items: PolymarketTrade[] = [];
    const seen = new Set<string>();
    let currentBefore: string | undefined = options?.before;
    let pagesFetched = 0;
    let exhausted = false;
    let stalled = false;
    let minTimestamp: number | undefined = undefined;
    let maxTimestamp: number | undefined = undefined;

    while (pagesFetched < maxPages) {
        const beforeForThisPage = currentBefore;
        const trades = await fetchWalletTrades(walletAddress, {
            before: currentBefore,
            limit: pageSize,
        });

        if (trades.length === 0) {
            exhausted = true;
            break;
        }

        let newUnique = 0;
        for (const trade of trades) {
            const key = tradeDedupeKey(trade);
            if (seen.has(key)) continue;
            seen.add(key);

            const ts = getTradeTimestamp(trade);
            if (afterBoundSeconds != null && ts != null && ts < afterBoundSeconds) {
                continue;
            }

            items.push(trade);
            newUnique++;

            if (ts == null) continue;
            minTimestamp = minTimestamp == null ? ts : Math.min(minTimestamp, ts);
            maxTimestamp = maxTimestamp == null ? ts : Math.max(maxTimestamp, ts);
        }

        pagesFetched++;

        // If we got fewer than pageSize, we've exhausted the results
        if (trades.length < pageSize) {
            exhausted = true;
            break;
        }

        // Find the oldest timestamp in this batch for the next page
        // Trades are sorted descending, so oldest is last
        const oldestTrade = trades[trades.length - 1];
        if (!oldestTrade) {
            stalled = true;
            break;
        }
        const oldestTimestamp = getTradeTimestamp(oldestTrade);

        if (oldestTimestamp === null) {
            logger.warn({ wallet: walletAddress }, "Trade missing timestamp, stopping pagination");
            stalled = true;
            break;
        }

        // Do NOT subtract 1 second here: if >pageSize trades share the same second,
        // subtracting 1 would permanently skip the remainder. We dedupe instead.
        currentBefore = oldestTimestamp.toString();

        // Even if the Data API ignores `after`, we can stop once we've paged past our lower bound.
        if (afterBoundSeconds != null && oldestTimestamp < afterBoundSeconds) {
            exhausted = true;
            break;
        }

        if (
            beforeForThisPage &&
            currentBefore === beforeForThisPage &&
            newUnique === 0
        ) {
            const beforeSeconds = Number(beforeForThisPage);
            const fallbackBefore =
                Number.isFinite(beforeSeconds) && beforeSeconds > 0
                    ? (beforeSeconds - 1).toString()
                    : undefined;

            const probeLimit = Math.min(pageSize * 5, maxProbePageSize);
            if (probeLimit > pageSize && pagesFetched < maxPages) {
                logger.warn(
                    { wallet: walletAddress, before: beforeForThisPage, probeLimit },
                    "Pagination stalled; probing with larger page size"
                );

                const probeTrades = await fetchWalletTrades(walletAddress, {
                    before: beforeForThisPage,
                    limit: probeLimit,
                });
                pagesFetched++;

                if (probeTrades.length === 0) {
                    exhausted = true;
                    break;
                }

                let probeNewUnique = 0;
                for (const trade of probeTrades) {
                    const key = tradeDedupeKey(trade);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const ts = getTradeTimestamp(trade);
                    if (afterBoundSeconds != null && ts != null && ts < afterBoundSeconds) {
                        continue;
                    }

                    items.push(trade);
                    probeNewUnique++;
                    if (ts == null) continue;
                    minTimestamp = minTimestamp == null ? ts : Math.min(minTimestamp, ts);
                    maxTimestamp = maxTimestamp == null ? ts : Math.max(maxTimestamp, ts);
                }

                if (probeTrades.length < probeLimit) {
                    exhausted = true;
                    logger.debug(
                        {
                            wallet: walletAddress,
                            probeLimit,
                            tradesThisPage: probeTrades.length,
                            probeNewUnique,
                            totalSoFar: items.length,
                        },
                        "Probe page exhausted pagination"
                    );
                    break;
                }

                const probeOldest = probeTrades[probeTrades.length - 1];
                const probeOldestTimestamp = probeOldest
                    ? getTradeTimestamp(probeOldest)
                    : null;

                if (probeOldestTimestamp == null) {
                    stalled = true;
                    logger.warn(
                        { wallet: walletAddress },
                        "Trade missing timestamp during probe; stopping pagination"
                    );
                    break;
                }

                if (Number.isFinite(beforeSeconds) && probeOldestTimestamp < beforeSeconds) {
                    currentBefore = probeOldestTimestamp.toString();
                } else if (fallbackBefore) {
                    currentBefore = fallbackBefore;
                    logger.warn(
                        { wallet: walletAddress, before: beforeForThisPage, fallbackBefore },
                        "Pagination pinned at timestamp boundary; decrementing before by 1s to continue"
                    );
                } else {
                    stalled = true;
                    break;
                }
            } else if (fallbackBefore) {
                currentBefore = fallbackBefore;
                logger.warn(
                    { wallet: walletAddress, before: beforeForThisPage, fallbackBefore },
                    "Pagination pinned at timestamp boundary; decrementing before by 1s to continue"
                );
            } else {
                stalled = true;
                break;
            }

            if (afterBoundSeconds != null) {
                const currentBeforeSeconds = Number(currentBefore);
                if (
                    Number.isFinite(currentBeforeSeconds) &&
                    currentBeforeSeconds < afterBoundSeconds
                ) {
                    exhausted = true;
                    break;
                }
            }

            continue;
        }

        logger.debug(
            {
                wallet: walletAddress,
                page: pagesFetched,
                tradesThisPage: trades.length,
                newUnique,
                totalSoFar: items.length,
                nextBefore: currentBefore,
            },
            "Fetched trade page"
        );
    }

    const hitMaxPages = pagesFetched >= maxPages && !exhausted && !stalled;
    if (hitMaxPages) {
        logger.warn(
            { wallet: walletAddress, maxPages, totalTrades: items.length },
            "Hit max pages limit during trade pagination"
        );
    }

    logger.debug(
        {
            wallet: walletAddress,
            totalTrades: items.length,
            pages: pagesFetched,
            exhausted,
            stalled,
            hitMaxPages,
        },
        "Completed paginated trade fetch"
    );

    return {
        items,
        pagesFetched,
        exhausted,
        stalled,
        hitMaxPages,
        nextBefore: !exhausted && !stalled ? currentBefore : undefined,
        minTimestamp,
        maxTimestamp,
    };
}

/**
 * Extract Unix timestamp (seconds) from a trade object.
 */
function getTradeTimestamp(trade: PolymarketTrade): number | null {
    if (typeof trade.timestamp === "number") {
        return trade.timestamp;
    }
    if (trade.match_time) {
        const matchMs = new Date(trade.match_time).getTime();
        return Number.isFinite(matchMs) ? Math.floor(matchMs / 1000) : null;
    }
    return null;
}

/**
 * Fetch activity (MERGE/SPLIT/REDEEM) for a wallet address (single page).
 * Returns activity events sorted by timestamp descending.
 */
export async function fetchWalletActivity(
    walletAddress: string,
    options?: {
        limit?: number;
        after?: string; // Unix timestamp (seconds) - only activity after this time
        before?: string; // Unix timestamp (seconds) - only activity before this time
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
    if (options?.before) {
        params.before = options.before;
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
 * Fetch ALL activity for a wallet address with pagination.
 * Loops through pages until all activity in the time window is retrieved.
 *
 * @param walletAddress - The wallet to fetch activity for
 * @param options.after - Only fetch activity after this timestamp (Unix seconds)
 * @param options.before - Only fetch activity before this timestamp (Unix seconds); used to resume pagination
 * @param options.maxPages - Safety limit on number of pages (default: 10)
 * @param options.pageSize - Number of activities per page (default: 100)
 * @returns Result containing activity and pagination metadata
 */
export async function fetchAllWalletActivity(
    walletAddress: string,
    options?: {
        after?: string;
        before?: string;
        maxPages?: number;
        pageSize?: number;
    }
): Promise<PaginatedWalletFetchResult<PolymarketActivity>> {
    const maxPages = options?.maxPages ?? 10;
    const pageSize = options?.pageSize ?? 100;
    const maxProbePageSize = 1000;
    const afterBoundSecondsRaw = options?.after != null ? Number(options.after) : undefined;
    const afterBoundSeconds = Number.isFinite(afterBoundSecondsRaw)
        ? (afterBoundSecondsRaw as number)
        : undefined;
    const items: PolymarketActivity[] = [];
    const seen = new Set<string>();
    let currentBefore: string | undefined = options?.before;
    let pagesFetched = 0;
    let exhausted = false;
    let stalled = false;
    let minTimestamp: number | undefined = undefined;
    let maxTimestamp: number | undefined = undefined;

    while (pagesFetched < maxPages) {
        const beforeForThisPage = currentBefore;
        const activities = await fetchWalletActivity(walletAddress, {
            before: currentBefore,
            limit: pageSize,
        });

        if (activities.length === 0) {
            exhausted = true;
            break;
        }

        let newUnique = 0;
        for (const activity of activities) {
            const key = activityDedupeKey(activity);
            if (seen.has(key)) continue;
            seen.add(key);

            const ts = activity.timestamp;
            if (afterBoundSeconds != null && ts < afterBoundSeconds) {
                continue;
            }

            items.push(activity);
            newUnique++;

            minTimestamp = minTimestamp == null ? ts : Math.min(minTimestamp, ts);
            maxTimestamp = maxTimestamp == null ? ts : Math.max(maxTimestamp, ts);
        }

        pagesFetched++;

        // If we got fewer than pageSize, we've exhausted the results
        if (activities.length < pageSize) {
            exhausted = true;
            break;
        }

        // Find the oldest timestamp in this batch for the next page
        // Activities are sorted descending, so oldest is last
        const oldestActivity = activities[activities.length - 1];
        const oldestTimestamp = oldestActivity?.timestamp;

        if (oldestTimestamp === undefined) {
            logger.warn({ wallet: walletAddress }, "Activity missing timestamp, stopping pagination");
            stalled = true;
            break;
        }

        // Same reasoning as trades: don't subtract 1s to avoid skipping same-second bursts.
        currentBefore = oldestTimestamp.toString();

        // Even if the Data API ignores `after`, we can stop once we've paged past our lower bound.
        if (afterBoundSeconds != null && oldestTimestamp < afterBoundSeconds) {
            exhausted = true;
            break;
        }

        if (
            beforeForThisPage &&
            currentBefore === beforeForThisPage &&
            newUnique === 0
        ) {
            const beforeSeconds = Number(beforeForThisPage);
            const fallbackBefore =
                Number.isFinite(beforeSeconds) && beforeSeconds > 0
                    ? (beforeSeconds - 1).toString()
                    : undefined;

            const probeLimit = Math.min(pageSize * 5, maxProbePageSize);
            if (probeLimit > pageSize && pagesFetched < maxPages) {
                logger.warn(
                    { wallet: walletAddress, before: beforeForThisPage, probeLimit },
                    "Activity pagination stalled; probing with larger page size"
                );

                const probeActivities = await fetchWalletActivity(walletAddress, {
                    before: beforeForThisPage,
                    limit: probeLimit,
                });
                pagesFetched++;

                if (probeActivities.length === 0) {
                    exhausted = true;
                    break;
                }

                let probeNewUnique = 0;
                for (const activity of probeActivities) {
                    const key = activityDedupeKey(activity);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const ts = activity.timestamp;
                    if (afterBoundSeconds != null && ts < afterBoundSeconds) {
                        continue;
                    }

                    items.push(activity);
                    probeNewUnique++;
                    minTimestamp = minTimestamp == null ? ts : Math.min(minTimestamp, ts);
                    maxTimestamp = maxTimestamp == null ? ts : Math.max(maxTimestamp, ts);
                }

                if (probeActivities.length < probeLimit) {
                    exhausted = true;
                    logger.debug(
                        {
                            wallet: walletAddress,
                            probeLimit,
                            activitiesThisPage: probeActivities.length,
                            probeNewUnique,
                            totalSoFar: items.length,
                        },
                        "Probe page exhausted activity pagination"
                    );
                    break;
                }

                const probeOldest = probeActivities[probeActivities.length - 1];
                const probeOldestTimestamp = probeOldest?.timestamp;

                if (probeOldestTimestamp == null) {
                    stalled = true;
                    logger.warn(
                        { wallet: walletAddress },
                        "Activity missing timestamp during probe; stopping pagination"
                    );
                    break;
                }

                if (Number.isFinite(beforeSeconds) && probeOldestTimestamp < beforeSeconds) {
                    currentBefore = probeOldestTimestamp.toString();
                } else if (fallbackBefore) {
                    currentBefore = fallbackBefore;
                    logger.warn(
                        { wallet: walletAddress, before: beforeForThisPage, fallbackBefore },
                        "Activity pagination pinned at timestamp boundary; decrementing before by 1s to continue"
                    );
                } else {
                    stalled = true;
                    break;
                }
            } else if (fallbackBefore) {
                currentBefore = fallbackBefore;
                logger.warn(
                    { wallet: walletAddress, before: beforeForThisPage, fallbackBefore },
                    "Activity pagination pinned at timestamp boundary; decrementing before by 1s to continue"
                );
            } else {
                stalled = true;
                break;
            }

            if (afterBoundSeconds != null) {
                const currentBeforeSeconds = Number(currentBefore);
                if (
                    Number.isFinite(currentBeforeSeconds) &&
                    currentBeforeSeconds < afterBoundSeconds
                ) {
                    exhausted = true;
                    break;
                }
            }

            continue;
        }

        logger.debug(
            {
                wallet: walletAddress,
                page: pagesFetched,
                activitiesThisPage: activities.length,
                newUnique,
                totalSoFar: items.length,
                nextBefore: currentBefore,
            },
            "Fetched activity page"
        );
    }

    const hitMaxPages = pagesFetched >= maxPages && !exhausted && !stalled;
    if (hitMaxPages) {
        logger.warn(
            { wallet: walletAddress, maxPages, totalActivity: items.length },
            "Hit max pages limit during activity pagination"
        );
    }

    logger.debug(
        {
            wallet: walletAddress,
            totalActivity: items.length,
            pages: pagesFetched,
            exhausted,
            stalled,
            hitMaxPages,
        },
        "Completed paginated activity fetch"
    );

    return {
        items,
        pagesFetched,
        exhausted,
        stalled,
        hitMaxPages,
        nextBefore: !exhausted && !stalled ? currentBefore : undefined,
        minTimestamp,
        maxTimestamp,
    };
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

            // Calculate midpoint price using proper max/min (NOT [0] index)
            const bestBidMicros = computeBestBid(book.bids);
            const bestAskMicros = computeBestAsk(book.asks);

            // Convert back to decimal 0-1 for this API
            const bestBid = bestBidMicros / 1_000_000;
            const bestAsk = bestAskMicros / 1_000_000;

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
