/**
 * Book utilities for correct order book interpretation.
 *
 * CRITICAL: Never assume arrays from REST/WS are sorted.
 * Always use these utilities to:
 * - Compute best bid/ask using max/min
 * - Sort levels before simulation consumes them
 */

import type { OrderBook, OrderBookLevel } from "../poly/types.js";

/**
 * Normalized level with integer micros (no floats).
 */
export interface NormalizedLevel {
    priceMicros: number; // 0..1_000_000
    sizeMicros: bigint;
}

/**
 * Normalized order book with computed metrics.
 */
export interface NormalizedBook {
    tokenId: string;

    /** Bids sorted descending by price (best bid first). */
    bids: NormalizedLevel[];

    /** Asks sorted ascending by price (best ask first). */
    asks: NormalizedLevel[];

    /** Best bid price (max of all bids), or 0 if no bids. */
    bestBidMicros: number;

    /** Best ask price (min of all asks), or 1_000_000 if no asks. */
    bestAskMicros: number;

    /** Mid price = (bestBid + bestAsk) / 2. */
    midPriceMicros: number;

    /** Spread = bestAsk - bestBid. */
    spreadMicros: number;

    /** Timestamp when this book was captured/updated. */
    updatedAt: number;

    /** Source of the book data. */
    source: "REST" | "WS";
}

/**
 * Convert price string/number (0-1) to micros (0-1,000,000).
 */
export function priceToMicros(price: string | number): number {
    const p = typeof price === "string" ? parseFloat(price) : price;
    if (!Number.isFinite(p)) return 0;
    return Math.round(p * 1_000_000);
}

/**
 * Convert shares string/number to micros (BigInt).
 */
export function sharesToMicros(shares: string | number): bigint {
    const s = typeof shares === "string" ? parseFloat(shares) : shares;
    if (!Number.isFinite(s)) return BigInt(0);
    return BigInt(Math.round(s * 1_000_000));
}

/**
 * Convert an OrderBookLevel to NormalizedLevel.
 */
export function normalizeLevel(level: OrderBookLevel): NormalizedLevel {
    return {
        priceMicros: priceToMicros(level.price),
        sizeMicros: sharesToMicros(level.size),
    };
}

/**
 * Normalize and sort bids (descending by price - best bid first).
 * Filters out levels with zero size or invalid prices.
 */
export function normalizeBids(levels: OrderBookLevel[]): NormalizedLevel[] {
    return levels
        .map(normalizeLevel)
        .filter((l) => l.sizeMicros > BigInt(0) && l.priceMicros > 0 && l.priceMicros < 1_000_000)
        .sort((a, b) => b.priceMicros - a.priceMicros); // Descending
}

/**
 * Normalize and sort asks (ascending by price - best ask first).
 * Filters out levels with zero size or invalid prices.
 */
export function normalizeAsks(levels: OrderBookLevel[]): NormalizedLevel[] {
    return levels
        .map(normalizeLevel)
        .filter((l) => l.sizeMicros > BigInt(0) && l.priceMicros > 0 && l.priceMicros < 1_000_000)
        .sort((a, b) => a.priceMicros - b.priceMicros); // Ascending
}

/**
 * Compute best bid from unsorted levels.
 * Returns 0 if no valid bids.
 */
export function computeBestBid(levels: OrderBookLevel[]): number {
    let best = 0;
    for (const level of levels) {
        const priceMicros = priceToMicros(level.price);
        const sizeMicros = sharesToMicros(level.size);
        // Only consider levels with actual liquidity and valid price
        if (sizeMicros > BigInt(0) && priceMicros > 0 && priceMicros < 1_000_000) {
            if (priceMicros > best) {
                best = priceMicros;
            }
        }
    }
    return best;
}

/**
 * Compute best ask from unsorted levels.
 * Returns 1_000_000 if no valid asks.
 */
export function computeBestAsk(levels: OrderBookLevel[]): number {
    let best = 1_000_000;
    for (const level of levels) {
        const priceMicros = priceToMicros(level.price);
        const sizeMicros = sharesToMicros(level.size);
        // Only consider levels with actual liquidity and valid price
        if (sizeMicros > BigInt(0) && priceMicros > 0 && priceMicros < 1_000_000) {
            if (priceMicros < best) {
                best = priceMicros;
            }
        }
    }
    return best;
}

/**
 * Normalize an OrderBook from REST API into a NormalizedBook.
 * This is the canonical way to interpret any book payload.
 *
 * @param book - Raw order book from REST API
 * @param source - Source of the book ("REST" or "WS")
 * @param updatedAt - Timestamp when book was captured (defaults to now)
 */
export function normalizeOrderBook(
    book: OrderBook,
    source: "REST" | "WS" = "REST",
    updatedAt: number = Date.now()
): NormalizedBook {
    // Normalize and sort levels
    const bids = normalizeBids(book.bids);
    const asks = normalizeAsks(book.asks);

    // Compute best bid/ask using max/min (NOT array[0])
    const bestBidMicros = computeBestBid(book.bids);
    const bestAskMicros = computeBestAsk(book.asks);

    // Compute mid and spread
    const midPriceMicros = Math.round((bestBidMicros + bestAskMicros) / 2);
    const spreadMicros = bestAskMicros - bestBidMicros;

    return {
        tokenId: book.asset_id,
        bids,
        asks,
        bestBidMicros,
        bestAskMicros,
        midPriceMicros,
        spreadMicros,
        updatedAt,
        source,
    };
}

/**
 * Compute book metrics from a NormalizedBook.
 * Provided for API compatibility with existing code.
 */
export function getBookMetrics(book: NormalizedBook): {
    bestBidMicros: number;
    bestAskMicros: number;
    midPriceMicros: number;
    spreadMicros: number;
} {
    return {
        bestBidMicros: book.bestBidMicros,
        bestAskMicros: book.bestAskMicros,
        midPriceMicros: book.midPriceMicros,
        spreadMicros: book.spreadMicros,
    };
}

/**
 * Get levels for simulation based on trade side.
 * - BUY: returns asks sorted ascending (consume cheapest first)
 * - SELL: returns bids sorted descending (consume highest first)
 */
export function getLevelsForSide(
    book: NormalizedBook,
    side: "BUY" | "SELL"
): NormalizedLevel[] {
    return side === "BUY" ? book.asks : book.bids;
}

/**
 * Compute total available notional within price bounds.
 *
 * @param levels - Sorted levels (asks ascending for BUY, bids descending for SELL)
 * @param side - Trade side
 * @param maxPriceMicros - Max price for BUY (optional)
 * @param minPriceMicros - Min price for SELL (optional)
 */
export function computeAvailableNotional(
    levels: NormalizedLevel[],
    side: "BUY" | "SELL",
    maxPriceMicros?: number,
    minPriceMicros?: number
): bigint {
    let total = BigInt(0);

    for (const level of levels) {
        // Check price bounds
        if (side === "BUY" && maxPriceMicros !== undefined) {
            if (level.priceMicros > maxPriceMicros) break; // Sorted ascending, no more valid
        }
        if (side === "SELL" && minPriceMicros !== undefined) {
            if (level.priceMicros < minPriceMicros) break; // Sorted descending, no more valid
        }

        // Add notional: size * price / 1_000_000
        const levelNotional = (level.sizeMicros * BigInt(level.priceMicros)) / BigInt(1_000_000);
        total += levelNotional;
    }

    return total;
}

/**
 * Check if a book appears "sane" (spread is reasonable).
 * Used for sanity checks and logging.
 *
 * @param book - Normalized book
 * @param maxSpreadMicros - Maximum acceptable spread (default $0.20 = 200_000)
 */
export function isBookSane(book: NormalizedBook, maxSpreadMicros = 200_000): boolean {
    // Check we have liquidity on both sides
    if (book.bids.length === 0 || book.asks.length === 0) {
        return false;
    }

    // Check spread is positive and within bounds
    if (book.spreadMicros <= 0 || book.spreadMicros > maxSpreadMicros) {
        return false;
    }

    // Check best bid < best ask (crossed book = invalid)
    if (book.bestBidMicros >= book.bestAskMicros) {
        return false;
    }

    return true;
}

/**
 * Format price micros as dollar string for logging.
 */
export function formatPriceMicros(priceMicros: number): string {
    return `$${(priceMicros / 1_000_000).toFixed(4)}`;
}

/**
 * Format book summary for logging.
 */
export function formatBookSummary(book: NormalizedBook): string {
    return `bid=${formatPriceMicros(book.bestBidMicros)} ask=${formatPriceMicros(book.bestAskMicros)} mid=${formatPriceMicros(book.midPriceMicros)} spread=${formatPriceMicros(book.spreadMicros)} bids=${book.bids.length} asks=${book.asks.length} source=${book.source}`;
}
