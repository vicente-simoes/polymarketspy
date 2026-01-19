/**
 * Order book simulation for executable copy trading.
 *
 * Simulates fills against the L2 order book to compute:
 * - VWAP (volume-weighted average price)
 * - Filled shares and notional
 * - Individual fill levels for ExecutableFill records
 */

import { TradeSide } from "@prisma/client";
import { fetchOrderBook, priceToMicros, sharesToMicros, type OrderBook } from "../poly/index.js";
import { createChildLogger } from "../log/logger.js";

// Re-export for use by executor
export { fetchOrderBook, type OrderBook };

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
 */
export function computeBookMetrics(book: OrderBook): {
    bestBidMicros: number;
    bestAskMicros: number;
    midPriceMicros: number;
    spreadMicros: number;
} {
    const bestBidMicros = book.bids.length > 0 ? priceToMicros(book.bids[0]!.price) : 0;
    const bestAskMicros = book.asks.length > 0 ? priceToMicros(book.asks[0]!.price) : 1_000_000;
    const midPriceMicros = Math.round((bestBidMicros + bestAskMicros) / 2);
    const spreadMicros = bestAskMicros - bestBidMicros;

    return { bestBidMicros, bestAskMicros, midPriceMicros, spreadMicros };
}

/**
 * Simulate fills against a pre-fetched order book.
 * This is the core simulation logic that can be called with an already-fetched book.
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

    // Compute book metrics
    const { bestBidMicros, bestAskMicros, midPriceMicros, spreadMicros } = computeBookMetrics(book);

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
    if (book.bids.length === 0 && book.asks.length === 0) {
        result.error = "Empty order book";
        log.warn("Empty order book");
        return result;
    }

    // Choose which side of the book to consume
    // BUY: consume asks (ascending price)
    // SELL: consume bids (descending price)
    const levels = side === TradeSide.BUY ? book.asks : book.bids;

    if (levels.length === 0) {
        result.error = `No ${side === TradeSide.BUY ? "asks" : "bids"} in book`;
        log.warn(result.error);
        return result;
    }

    // Simulate fills
    let remainingShares = targetShareMicros;
    let totalFilledShares = BigInt(0);
    let totalFilledNotional = BigInt(0);

    for (const level of levels) {
        const levelPrice = priceToMicros(level.price);
        const levelSize = sharesToMicros(level.size);

        // Check price bounds
        if (side === TradeSide.BUY && maxPriceMicros !== undefined) {
            if (levelPrice > maxPriceMicros) {
                // Price too high, stop consuming
                break;
            }
        }
        if (side === TradeSide.SELL && minPriceMicros !== undefined) {
            if (levelPrice < minPriceMicros) {
                // Price too low, stop consuming
                break;
            }
        }

        // Add to available notional (within bounds)
        const levelNotional = (levelSize * BigInt(levelPrice)) / BigInt(1_000_000);
        result.availableNotionalMicros += levelNotional;

        // Fill from this level
        if (remainingShares > BigInt(0)) {
            const fillShares = remainingShares < levelSize ? remainingShares : levelSize;
            const fillNotional = (fillShares * BigInt(levelPrice)) / BigInt(1_000_000);

            result.fills.push({
                priceMicros: levelPrice,
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
