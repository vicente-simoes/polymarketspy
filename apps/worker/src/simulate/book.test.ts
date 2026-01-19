/**
 * Unit tests for book simulation.
 *
 * Tests the simulateBookFillsFromBook function that simulates fills
 * against a pre-fetched order book.
 */

import { describe, it, expect } from "vitest";
import { TradeSide } from "@prisma/client";
import { simulateBookFillsFromBook, computeBookMetrics, type OrderBook } from "./book.js";

/**
 * Create a mock order book for testing.
 */
function createMockBook(overrides: Partial<OrderBook> = {}): OrderBook {
    return {
        market: "0x1234",
        asset_id: "token123",
        bids: [
            { price: "0.58", size: "1000" },
            { price: "0.57", size: "2000" },
            { price: "0.55", size: "5000" },
        ],
        asks: [
            { price: "0.60", size: "1000" },
            { price: "0.61", size: "2000" },
            { price: "0.65", size: "5000" },
        ],
        ...overrides,
    };
}

describe("computeBookMetrics", () => {
    it("should compute correct metrics from book", () => {
        const book = createMockBook();
        const metrics = computeBookMetrics(book);

        expect(metrics.bestBidMicros).toBe(580_000); // 0.58
        expect(metrics.bestAskMicros).toBe(600_000); // 0.60
        expect(metrics.midPriceMicros).toBe(590_000); // (0.58 + 0.60) / 2 = 0.59
        expect(metrics.spreadMicros).toBe(20_000); // 0.60 - 0.58 = 0.02
    });

    it("should handle empty bids", () => {
        const book = createMockBook({ bids: [] });
        const metrics = computeBookMetrics(book);

        expect(metrics.bestBidMicros).toBe(0);
        expect(metrics.bestAskMicros).toBe(600_000);
        expect(metrics.midPriceMicros).toBe(300_000); // (0 + 0.60) / 2
    });

    it("should handle empty asks", () => {
        const book = createMockBook({ asks: [] });
        const metrics = computeBookMetrics(book);

        expect(metrics.bestBidMicros).toBe(580_000);
        expect(metrics.bestAskMicros).toBe(1_000_000); // Default max
        expect(metrics.midPriceMicros).toBe(790_000); // (0.58 + 1.0) / 2
    });
});

describe("simulateBookFillsFromBook", () => {
    describe("BUY orders", () => {
        it("should fill BUY order when asks are within bounds", () => {
            const book = createMockBook();
            // BUY: consume asks
            // Target: 500 shares at max price 610000 ($0.61)
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.BUY,
                BigInt(500_000_000), // 500 shares in micros
                610_000 // max price $0.61
            );

            expect(result.success).toBe(true);
            expect(result.filledShareMicros).toBeGreaterThan(BigInt(0));
            // Should fill from first ask at $0.60, possibly second at $0.61
            expect(result.vwapPriceMicros).toBeLessThanOrEqual(610_000);
        });

        it("should fill nothing when max price is too low (the bug scenario)", () => {
            const book = createMockBook();
            // This simulates the bug: max price = 15000 (from mid=0 bug)
            // Best ask is at 600000, so nothing should fill
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.BUY,
                BigInt(100_000_000), // 100 shares
                15_000 // max price $0.015 (the bug value!)
            );

            expect(result.success).toBe(true); // Book exists, but...
            expect(result.filledShareMicros).toBe(BigInt(0)); // No fills!
            expect(result.availableNotionalMicros).toBe(BigInt(0)); // Nothing within bounds
        });

        it("should fill correctly with realistic max price (the fix)", () => {
            const book = createMockBook();
            // With the fix: max price computed from real mid
            // mid = 590000, theirRef = 600000
            // maxVsTheirFill = 600000 + 10000 = 610000
            // maxVsMid = 590000 + 15000 = 605000
            // maxPriceMicros = min(610000, 605000) = 605000
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.BUY,
                BigInt(100_000_000), // 100 shares
                605_000 // max price $0.605 (realistic bound)
            );

            expect(result.success).toBe(true);
            expect(result.filledShareMicros).toBeGreaterThan(BigInt(0));
            // Should fill from first ask at $0.60 which is within bounds
            expect(result.vwapPriceMicros).toBe(600_000); // Only first level
        });

        it("should compute VWAP correctly across multiple levels", () => {
            const book = createMockBook();
            // Target more shares than first level to get multi-level fill
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.BUY,
                BigInt(2000_000_000), // 2000 shares (more than first ask)
                620_000 // max price $0.62 to include multiple levels
            );

            expect(result.success).toBe(true);
            // Should fill from $0.60 (1000) and $0.61 (1000)
            // VWAP should be between 0.60 and 0.61
            expect(result.vwapPriceMicros).toBeGreaterThanOrEqual(600_000);
            expect(result.vwapPriceMicros).toBeLessThanOrEqual(610_000);
        });
    });

    describe("SELL orders", () => {
        it("should fill SELL order when bids are within bounds", () => {
            const book = createMockBook();
            // SELL: consume bids
            // Target: 500 shares at min price 570000 ($0.57)
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.SELL,
                BigInt(500_000_000), // 500 shares in micros
                undefined,
                570_000 // min price $0.57
            );

            expect(result.success).toBe(true);
            expect(result.filledShareMicros).toBeGreaterThan(BigInt(0));
            // Should fill from first bid at $0.58
            expect(result.vwapPriceMicros).toBeGreaterThanOrEqual(570_000);
        });

        it("should fill nothing when min price is too high", () => {
            const book = createMockBook();
            // Min price higher than any bid
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.SELL,
                BigInt(100_000_000), // 100 shares
                undefined,
                900_000 // min price $0.90 (higher than any bid)
            );

            expect(result.success).toBe(true); // Book exists
            expect(result.filledShareMicros).toBe(BigInt(0)); // No fills
            expect(result.availableNotionalMicros).toBe(BigInt(0));
        });
    });

    describe("edge cases", () => {
        it("should handle empty book", () => {
            const book = createMockBook({ bids: [], asks: [] });
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.BUY,
                BigInt(100_000_000)
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("Empty order book");
        });

        it("should handle book with only bids (no asks) for BUY", () => {
            const book = createMockBook({ asks: [] });
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.BUY,
                BigInt(100_000_000)
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("No asks");
        });

        it("should handle book with only asks (no bids) for SELL", () => {
            const book = createMockBook({ bids: [] });
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.SELL,
                BigInt(100_000_000)
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("No bids");
        });

        it("should cap fill ratio at 100%", () => {
            const book = createMockBook();
            // Request less than available
            const result = simulateBookFillsFromBook(
                book,
                TradeSide.BUY,
                BigInt(500_000_000), // 500 shares
                1_000_000 // high max price to fill all
            );

            expect(result.success).toBe(true);
            expect(result.filledRatioBps).toBeLessThanOrEqual(10000);
        });
    });
});
