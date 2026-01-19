/**
 * Order book simulation for executable copy trading.
 *
 * Simulates fills against the L2 order book to compute:
 * - VWAP (volume-weighted average price)
 * - Filled shares and notional
 * - Individual fill levels for ExecutableFill records
 *
 * IMPORTANT: This module now uses bookUtils for correct book interpretation.
 * Never assume REST/WS arrays are sorted - always normalize first.
 */

import { TradeSide } from "@prisma/client";
import { fetchOrderBook, type OrderBook } from "../poly/index.js";
import { createChildLogger } from "../log/logger.js";
import {
    normalizeOrderBook,
    type NormalizedBook,
    type NormalizedLevel,
    formatBookSummary,
} from "./bookUtils.js";

// Re-export for use by executor
export { fetchOrderBook, type OrderBook };
export { normalizeOrderBook, type NormalizedBook } from "./bookUtils.js";

const logger = createChildLogger({ module: "book-simulation" });

/**
 * Individual fill at a price level.
 */
export interface FillLevel {
    priceMicros: number;
    shareMicros: bigint;
    notionalMicros: bigint;
}

/**
 * Result of simulating fills against the order book.
 */
export interface SimulationResult {
    /** Whether simulation was successful (book fetched, has liquidity). */
    success: boolean;

    /** Error message if simulation failed. */
    error?: string;

    /** Best bid price in micros. */
    bestBidMicros: number;

    /** Best ask price in micros. */
    bestAskMicros: number;

    /** Mid price in micros. */
    midPriceMicros: number;

    /** Spread in micros (bestAsk - bestBid). */
    spreadMicros: number;

    /** Total available notional within price bounds (micros). */
    availableNotionalMicros: bigint;

    /** Target shares requested (micros). */
    targetShareMicros: bigint;

    /** Actually filled shares (micros). */
    filledShareMicros: bigint;

    /** Actually filled notional (micros). */
    filledNotionalMicros: bigint;

    /** VWAP of fills in micros (0..1_000_000). */
    vwapPriceMicros: number;

    /** Fill ratio in basis points (0..10000). */
    filledRatioBps: number;

    /** Individual fills at each price level. */
    fills: FillLevel[];
}

/**
 * Compute book metrics (best bid/ask/mid/spread) from a pre-fetched order book.
 *
 * CRITICAL: This now uses max(bids) and min(asks) instead of assuming [0] is best.
 * This fixes the bug where unsorted arrays caused "impossible" spreads like $0.01/$0.99.
 */
export function computeBookMetrics(book: OrderBook): {
    bestBidMicros: number;
    bestAskMicros: number;
    midPriceMicros: number;
    spreadMicros: number;
} {
    // Normalize the book - this computes correct best bid/ask using max/min
    const normalized = normalizeOrderBook(book, "REST");
    return {
        bestBidMicros: normalized.bestBidMicros,
        bestAskMicros: normalized.bestAskMicros,
        midPriceMicros: normalized.midPriceMicros,
        spreadMicros: normalized.spreadMicros,
    };
}

/**
 * Simulate fills against a pre-fetched order book.
 * This is the core simulation logic that can be called with an already-fetched book.
 *
 * CRITICAL: This now normalizes and sorts the book before simulation.
 * - BUY: consumes asks sorted ASCENDING by price (cheapest first)
 * - SELL: consumes bids sorted DESCENDING by price (highest first)
 *
 * @param book - Pre-fetched order book
 * @param side - Trade side (BUY or SELL)
 * @param targetShareMicros - Target shares to fill
 * @param maxPriceMicros - Maximum acceptable price for BUY (optional)
 * @param minPriceMicros - Minimum acceptable price for SELL (optional)
 */
export function simulateBookFillsFromBook(
    book: OrderBook,
    side: TradeSide,
    targetShareMicros: bigint,
    maxPriceMicros?: number,
    minPriceMicros?: number
): SimulationResult {
    const log = logger.child({ assetId: book.asset_id, side, targetShares: targetShareMicros.toString() });

    // Normalize the book - this sorts levels and computes correct best bid/ask
    const normalized = normalizeOrderBook(book, "REST");
    const { bestBidMicros, bestAskMicros, midPriceMicros, spreadMicros } = normalized;

    log.debug({ book: formatBookSummary(normalized) }, "Normalized book for simulation");

    // Initialize result
    const result: SimulationResult = {
        success: false,
        bestBidMicros,
        bestAskMicros,
        midPriceMicros,
        spreadMicros,
        availableNotionalMicros: BigInt(0),
        targetShareMicros,
        filledShareMicros: BigInt(0),
        filledNotionalMicros: BigInt(0),
        vwapPriceMicros: 0,
        filledRatioBps: 0,
        fills: [],
    };

    // Check if book has liquidity
    if (normalized.bids.length === 0 && normalized.asks.length === 0) {
        result.error = "Empty order book";
        log.warn("Empty order book");
        return result;
    }

    // Choose which side of the book to consume (already sorted by normalizeOrderBook)
    // BUY: consume asks (sorted ascending by price - cheapest first)
    // SELL: consume bids (sorted descending by price - highest first)
    const levels: NormalizedLevel[] = side === TradeSide.BUY ? normalized.asks : normalized.bids;

    if (levels.length === 0) {
        result.error = `No ${side === TradeSide.BUY ? "asks" : "bids"} in book`;
        log.warn(result.error);
        return result;
    }

    // Simulate fills against sorted levels
    let remainingShares = targetShareMicros;
    let totalFilledShares = BigInt(0);
    let totalFilledNotional = BigInt(0);

    for (const level of levels) {
        // Check price bounds
        if (side === TradeSide.BUY && maxPriceMicros !== undefined) {
            if (level.priceMicros > maxPriceMicros) {
                // Price too high, stop consuming (sorted ascending, no cheaper levels after)
                break;
            }
        }
        if (side === TradeSide.SELL && minPriceMicros !== undefined) {
            if (level.priceMicros < minPriceMicros) {
                // Price too low, stop consuming (sorted descending, no higher levels after)
                break;
            }
        }

        // Add to available notional (within bounds)
        const levelNotional = (level.sizeMicros * BigInt(level.priceMicros)) / BigInt(1_000_000);
        result.availableNotionalMicros += levelNotional;

        // Fill from this level
        if (remainingShares > BigInt(0)) {
            const fillShares = remainingShares < level.sizeMicros ? remainingShares : level.sizeMicros;
            const fillNotional = (fillShares * BigInt(level.priceMicros)) / BigInt(1_000_000);

            result.fills.push({
                priceMicros: level.priceMicros,
                shareMicros: fillShares,
                notionalMicros: fillNotional,
            });

            totalFilledShares += fillShares;
            totalFilledNotional += fillNotional;
            remainingShares -= fillShares;
        }
    }

    result.filledShareMicros = totalFilledShares;
    result.filledNotionalMicros = totalFilledNotional;

    // Compute VWAP
    if (totalFilledShares > BigInt(0)) {
        // VWAP = totalNotional / totalShares
        // In micros: (totalNotional_micros * 1_000_000) / totalShares_micros
        result.vwapPriceMicros = Number(
            (totalFilledNotional * BigInt(1_000_000)) / totalFilledShares
        );
    }

    // Compute fill ratio in basis points
    if (targetShareMicros > BigInt(0)) {
        result.filledRatioBps = Number(
            (totalFilledShares * BigInt(10000)) / targetShareMicros
        );
        // Cap at 10000 (100%)
        if (result.filledRatioBps > 10000) {
            result.filledRatioBps = 10000;
        }
    }

    result.success = true;

    log.debug(
        {
            bestBid: result.bestBidMicros,
            bestAsk: result.bestAskMicros,
            spread: result.spreadMicros,
            filled: totalFilledShares.toString(),
            vwap: result.vwapPriceMicros,
            fillRatio: result.filledRatioBps,
        },
        "Book simulation complete"
    );

    return result;
}

/**
 * Simulate fills against a pre-normalized order book.
 *
 * This is the preferred method when you already have a NormalizedBook (e.g., from cache).
 * Avoids double normalization.
 *
 * @param normalizedBook - Pre-normalized order book
 * @param side - Trade side (BUY or SELL)
 * @param targetShareMicros - Target shares to fill
 * @param maxPriceMicros - Maximum acceptable price for BUY (optional)
 * @param minPriceMicros - Minimum acceptable price for SELL (optional)
 */
export function simulateFromNormalizedBook(
    normalizedBook: NormalizedBook,
    side: TradeSide,
    targetShareMicros: bigint,
    maxPriceMicros?: number,
    minPriceMicros?: number
): SimulationResult {
    const log = logger.child({
        tokenId: normalizedBook.tokenId,
        side,
        targetShares: targetShareMicros.toString(),
        source: normalizedBook.source,
    });

    const { bestBidMicros, bestAskMicros, midPriceMicros, spreadMicros } = normalizedBook;

    log.debug({ book: formatBookSummary(normalizedBook) }, "Using pre-normalized book for simulation");

    // Initialize result
    const result: SimulationResult = {
        success: false,
        bestBidMicros,
        bestAskMicros,
        midPriceMicros,
        spreadMicros,
        availableNotionalMicros: BigInt(0),
        targetShareMicros,
        filledShareMicros: BigInt(0),
        filledNotionalMicros: BigInt(0),
        vwapPriceMicros: 0,
        filledRatioBps: 0,
        fills: [],
    };

    // Check if book has liquidity
    if (normalizedBook.bids.length === 0 && normalizedBook.asks.length === 0) {
        result.error = "Empty order book";
        log.warn("Empty order book");
        return result;
    }

    // Choose which side of the book to consume (already sorted in NormalizedBook)
    // BUY: consume asks (sorted ascending by price - cheapest first)
    // SELL: consume bids (sorted descending by price - highest first)
    const levels: NormalizedLevel[] = side === TradeSide.BUY ? normalizedBook.asks : normalizedBook.bids;

    if (levels.length === 0) {
        result.error = `No ${side === TradeSide.BUY ? "asks" : "bids"} in book`;
        log.warn(result.error);
        return result;
    }

    // Simulate fills against sorted levels
    let remainingShares = targetShareMicros;
    let totalFilledShares = BigInt(0);
    let totalFilledNotional = BigInt(0);

    for (const level of levels) {
        // Check price bounds
        if (side === TradeSide.BUY && maxPriceMicros !== undefined) {
            if (level.priceMicros > maxPriceMicros) {
                // Price too high, stop consuming (sorted ascending, no cheaper levels after)
                break;
            }
        }
        if (side === TradeSide.SELL && minPriceMicros !== undefined) {
            if (level.priceMicros < minPriceMicros) {
                // Price too low, stop consuming (sorted descending, no higher levels after)
                break;
            }
        }

        // Add to available notional (within bounds)
        const levelNotional = (level.sizeMicros * BigInt(level.priceMicros)) / BigInt(1_000_000);
        result.availableNotionalMicros += levelNotional;

        // Fill from this level
        if (remainingShares > BigInt(0)) {
            const fillShares = remainingShares < level.sizeMicros ? remainingShares : level.sizeMicros;
            const fillNotional = (fillShares * BigInt(level.priceMicros)) / BigInt(1_000_000);

            result.fills.push({
                priceMicros: level.priceMicros,
                shareMicros: fillShares,
                notionalMicros: fillNotional,
            });

            totalFilledShares += fillShares;
            totalFilledNotional += fillNotional;
            remainingShares -= fillShares;
        }
    }

    result.filledShareMicros = totalFilledShares;
    result.filledNotionalMicros = totalFilledNotional;

    // Compute VWAP
    if (totalFilledShares > BigInt(0)) {
        // VWAP = totalNotional / totalShares
        // In micros: (totalNotional_micros * 1_000_000) / totalShares_micros
        result.vwapPriceMicros = Number(
            (totalFilledNotional * BigInt(1_000_000)) / totalFilledShares
        );
    }

    // Compute fill ratio in basis points
    if (targetShareMicros > BigInt(0)) {
        result.filledRatioBps = Number(
            (totalFilledShares * BigInt(10000)) / targetShareMicros
        );
        // Cap at 10000 (100%)
        if (result.filledRatioBps > 10000) {
            result.filledRatioBps = 10000;
        }
    }

    result.success = true;

    log.debug(
        {
            bestBid: result.bestBidMicros,
            bestAsk: result.bestAskMicros,
            spread: result.spreadMicros,
            filled: totalFilledShares.toString(),
            vwap: result.vwapPriceMicros,
            fillRatio: result.filledRatioBps,
        },
        "Book simulation complete"
    );

    return result;
}

/**
 * Fetch and analyze order book for an asset.
 * Wrapper around simulateBookFillsFromBook that fetches the book first.
 *
 * @param assetId - Token ID to fetch book for
 * @param side - Trade side (BUY or SELL)
 * @param targetShareMicros - Target shares to fill
 * @param maxPriceMicros - Maximum acceptable price for BUY (optional)
 * @param minPriceMicros - Minimum acceptable price for SELL (optional)
 */
export async function simulateBookFills(
    assetId: string,
    side: TradeSide,
    targetShareMicros: bigint,
    maxPriceMicros?: number,
    minPriceMicros?: number
): Promise<SimulationResult> {
    const log = logger.child({ assetId, side, targetShares: targetShareMicros.toString() });

    // Initialize default failure result
    const failureResult: SimulationResult = {
        success: false,
        bestBidMicros: 0,
        bestAskMicros: 1_000_000,
        midPriceMicros: 500_000,
        spreadMicros: 1_000_000,
        availableNotionalMicros: BigInt(0),
        targetShareMicros,
        filledShareMicros: BigInt(0),
        filledNotionalMicros: BigInt(0),
        vwapPriceMicros: 0,
        filledRatioBps: 0,
        fills: [],
    };

    try {
        // Fetch order book
        const book = await fetchOrderBook(assetId);

        // Check if book exists (null means resolved market or cached failure)
        if (!book) {
            failureResult.error = "Order book not available (market may be resolved)";
            log.warn("Order book not available");
            return failureResult;
        }

        // Delegate to the synchronous helper
        return simulateBookFillsFromBook(book, side, targetShareMicros, maxPriceMicros, minPriceMicros);
    } catch (err) {
        failureResult.error = `Failed to fetch book: ${err}`;
        log.error({ err }, "Book simulation failed");
        return failureResult;
    }
}

/**
 * Compute available notional within price bounds without filling.
 * Used for depth requirement check.
 */
export async function computeAvailableDepth(
    assetId: string,
    side: TradeSide,
    maxPriceMicros?: number,
    minPriceMicros?: number
): Promise<{ available: bigint; success: boolean }> {
    const result = await simulateBookFills(
        assetId,
        side,
        BigInt(0), // Don't actually fill
        maxPriceMicros,
        minPriceMicros
    );

    return {
        available: result.availableNotionalMicros,
        success: result.success,
    };
}
