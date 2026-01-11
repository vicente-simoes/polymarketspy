import { request } from "undici";
import { z } from "zod";
import { env } from "../config/env.js";
import { polymarketLimiter } from "../http/limiters.js";
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

/**
 * Make a rate-limited request to Polymarket Data API.
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

    return polymarketLimiter.schedule(async () => {
        logger.debug({ url: url.toString() }, "Data API request");
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

    return polymarketLimiter.schedule(async () => {
        logger.debug({ url: url.toString() }, "CLOB API request");
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
 * Returns trades sorted by match_time descending.
 */
export async function fetchWalletTrades(
    walletAddress: string,
    options?: {
        limit?: number;
        after?: string; // ISO timestamp - only trades after this time
    }
): Promise<PolymarketTrade[]> {
    const params: Record<string, string> = {
        maker_address: walletAddress,
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
        after?: string; // ISO timestamp - only activity after this time
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
        return nonTradeActivities;
    } catch (err) {
        logger.error({ err, wallet: walletAddress }, "Failed to fetch wallet activity");
        throw err;
    }
}

/**
 * Fetch order book for a token/asset.
 */
export async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
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
 * Fetch current prices for multiple tokens.
 */
export async function fetchPrices(
    tokenIds: string[]
): Promise<Map<string, number>> {
    const prices = new Map<string, number>();

    // CLOB API allows fetching prices for individual tokens
    // Batch them if possible, otherwise fetch individually
    for (const tokenId of tokenIds) {
        try {
            const book = await fetchOrderBook(tokenId);
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
            logger.warn({ err, tokenId }, "Failed to fetch price for token");
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
