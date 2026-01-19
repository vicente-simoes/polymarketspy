/**
 * Unit tests for bookUtils.
 *
 * Tests verify:
 * - Best bid/ask computation on unsorted books
 * - Sorting correctness for simulation
 * - Sparse book handling (missing bids or asks)
 * - Dust order filtering at extremes
 */

import { describe, it, expect } from "vitest";
import {
    priceToMicros,
    sharesToMicros,
    normalizeBids,
    normalizeAsks,
    computeBestBid,
    computeBestAsk,
    normalizeOrderBook,
    computeAvailableNotional,
    isBookSane,
    formatPriceMicros,
    type NormalizedLevel,
} from "./bookUtils.js";
import type { OrderBook, OrderBookLevel } from "../poly/types.js";

// Helper to create a book level
function level(price: string, size: string): OrderBookLevel {
    return { price, size };
}

// Helper to create a full OrderBook
function book(bids: OrderBookLevel[], asks: OrderBookLevel[]): OrderBook {
    return {
        market: "test-market",
        asset_id: "test-token",
        bids,
        asks,
    };
}

describe("priceToMicros", () => {
    it("converts decimal string to micros", () => {
        expect(priceToMicros("0.5")).toBe(500_000);
        expect(priceToMicros("0.01")).toBe(10_000);
        expect(priceToMicros("0.99")).toBe(990_000);
        expect(priceToMicros("0")).toBe(0);
        expect(priceToMicros("1")).toBe(1_000_000);
    });

    it("converts number to micros", () => {
        expect(priceToMicros(0.5)).toBe(500_000);
        expect(priceToMicros(0.123456)).toBe(123_456);
    });

    it("handles edge cases", () => {
        expect(priceToMicros("")).toBe(0); // NaN → 0
        expect(priceToMicros(NaN)).toBe(0);
        expect(priceToMicros(Infinity)).toBe(0);
    });
});

describe("sharesToMicros", () => {
    it("converts decimal string to BigInt micros", () => {
        expect(sharesToMicros("100")).toBe(BigInt(100_000_000));
        expect(sharesToMicros("1.5")).toBe(BigInt(1_500_000));
        expect(sharesToMicros("0.000001")).toBe(BigInt(1));
    });

    it("handles edge cases", () => {
        expect(sharesToMicros("")).toBe(BigInt(0));
        expect(sharesToMicros(NaN)).toBe(BigInt(0));
    });
});

describe("computeBestBid", () => {
    it("finds max price from unsorted bids", () => {
        const bids = [
            level("0.10", "100"),
            level("0.50", "100"), // This is best
            level("0.30", "100"),
            level("0.01", "100"),
        ];
        expect(computeBestBid(bids)).toBe(500_000);
    });

    it("returns 0 for empty bids", () => {
        expect(computeBestBid([])).toBe(0);
    });

    it("ignores zero-size levels", () => {
        const bids = [
            level("0.99", "0"), // Zero size, should be ignored
            level("0.50", "100"),
        ];
        expect(computeBestBid(bids)).toBe(500_000);
    });

    it("ignores extreme prices (0 and 1)", () => {
        const bids = [
            level("0", "100"), // Price 0, should be ignored
            level("1", "100"), // Price 1, should be ignored
            level("0.50", "100"),
        ];
        expect(computeBestBid(bids)).toBe(500_000);
    });

    it("handles the 'impossible' $0.01 best bid bug scenario", () => {
        // This is the actual bug: [0] = $0.01 but there's a better bid at $0.50
        const bids = [
            level("0.01", "100"), // Was incorrectly treated as "best" due to [0] index
            level("0.50", "500"), // Actually the best bid
            level("0.45", "200"),
        ];
        expect(computeBestBid(bids)).toBe(500_000); // Should be $0.50, not $0.01
    });
});

describe("computeBestAsk", () => {
    it("finds min price from unsorted asks", () => {
        const asks = [
            level("0.90", "100"),
            level("0.50", "100"), // This is best
            level("0.70", "100"),
            level("0.99", "100"),
        ];
        expect(computeBestAsk(asks)).toBe(500_000);
    });

    it("returns 1_000_000 for empty asks", () => {
        expect(computeBestAsk([])).toBe(1_000_000);
    });

    it("ignores zero-size levels", () => {
        const asks = [
            level("0.01", "0"), // Zero size, should be ignored
            level("0.50", "100"),
        ];
        expect(computeBestAsk(asks)).toBe(500_000);
    });

    it("handles the 'impossible' $0.99 best ask bug scenario", () => {
        // This is the actual bug: [0] = $0.99 but there's a better ask at $0.50
        const asks = [
            level("0.99", "100"), // Was incorrectly treated as "best" due to [0] index
            level("0.50", "500"), // Actually the best ask
            level("0.55", "200"),
        ];
        expect(computeBestAsk(asks)).toBe(500_000); // Should be $0.50, not $0.99
    });
});

describe("normalizeBids", () => {
    it("sorts bids descending by price", () => {
        const bids = [
            level("0.30", "100"),
            level("0.50", "100"),
            level("0.10", "100"),
        ];
        const sorted = normalizeBids(bids);
        expect(sorted.map((l) => l.priceMicros)).toEqual([500_000, 300_000, 100_000]);
    });

    it("filters out zero-size levels", () => {
        const bids = [
            level("0.50", "0"),
            level("0.30", "100"),
        ];
        const sorted = normalizeBids(bids);
        expect(sorted.length).toBe(1);
        expect(sorted[0]!.priceMicros).toBe(300_000);
    });

    it("filters out price=0 and price=1 levels", () => {
        const bids = [
            level("0", "100"),
            level("1", "100"),
            level("0.50", "100"),
        ];
        const sorted = normalizeBids(bids);
        expect(sorted.length).toBe(1);
        expect(sorted[0]!.priceMicros).toBe(500_000);
    });
});

describe("normalizeAsks", () => {
    it("sorts asks ascending by price", () => {
        const asks = [
            level("0.70", "100"),
            level("0.50", "100"),
            level("0.90", "100"),
        ];
        const sorted = normalizeAsks(asks);
        expect(sorted.map((l) => l.priceMicros)).toEqual([500_000, 700_000, 900_000]);
    });

    it("filters out zero-size levels", () => {
        const asks = [
            level("0.50", "0"),
            level("0.70", "100"),
        ];
        const sorted = normalizeAsks(asks);
        expect(sorted.length).toBe(1);
        expect(sorted[0]!.priceMicros).toBe(700_000);
    });
});

describe("normalizeOrderBook", () => {
    it("normalizes a properly sorted book", () => {
        const rawBook = book(
            [level("0.48", "100"), level("0.47", "200")],
            [level("0.52", "100"), level("0.53", "200")]
        );
        const normalized = normalizeOrderBook(rawBook);

        expect(normalized.tokenId).toBe("test-token");
        expect(normalized.bestBidMicros).toBe(480_000);
        expect(normalized.bestAskMicros).toBe(520_000);
        expect(normalized.midPriceMicros).toBe(500_000);
        expect(normalized.spreadMicros).toBe(40_000); // $0.04
        expect(normalized.source).toBe("REST");
    });

    it("normalizes an UNSORTED book correctly", () => {
        // This is the critical test: unsorted arrays
        const rawBook = book(
            [
                level("0.01", "50"), // Dust at extreme - appears first but NOT best
                level("0.45", "100"),
                level("0.48", "200"), // Actual best bid
                level("0.30", "150"),
            ],
            [
                level("0.99", "50"), // Dust at extreme - appears first but NOT best
                level("0.55", "100"),
                level("0.52", "200"), // Actual best ask
                level("0.70", "150"),
            ]
        );
        const normalized = normalizeOrderBook(rawBook);

        // The bug would have computed: bid=$0.01, ask=$0.99, spread=$0.98
        // Correct computation should be: bid=$0.48, ask=$0.52, spread=$0.04
        expect(normalized.bestBidMicros).toBe(480_000); // NOT 10_000
        expect(normalized.bestAskMicros).toBe(520_000); // NOT 990_000
        expect(normalized.spreadMicros).toBe(40_000); // NOT 980_000
        expect(normalized.midPriceMicros).toBe(500_000);

        // Verify sorting
        expect(normalized.bids[0]!.priceMicros).toBe(480_000); // Best bid first
        expect(normalized.asks[0]!.priceMicros).toBe(520_000); // Best ask first
    });

    it("handles empty bids", () => {
        const rawBook = book([], [level("0.50", "100")]);
        const normalized = normalizeOrderBook(rawBook);

        expect(normalized.bestBidMicros).toBe(0);
        expect(normalized.bestAskMicros).toBe(500_000);
        expect(normalized.bids.length).toBe(0);
    });

    it("handles empty asks", () => {
        const rawBook = book([level("0.50", "100")], []);
        const normalized = normalizeOrderBook(rawBook);

        expect(normalized.bestBidMicros).toBe(500_000);
        expect(normalized.bestAskMicros).toBe(1_000_000);
        expect(normalized.asks.length).toBe(0);
    });

    it("handles completely empty book", () => {
        const rawBook = book([], []);
        const normalized = normalizeOrderBook(rawBook);

        expect(normalized.bestBidMicros).toBe(0);
        expect(normalized.bestAskMicros).toBe(1_000_000);
        expect(normalized.spreadMicros).toBe(1_000_000);
    });

    it("sets source and updatedAt", () => {
        const rawBook = book([level("0.50", "100")], [level("0.50", "100")]);
        const now = Date.now();
        const normalized = normalizeOrderBook(rawBook, "WS", now);

        expect(normalized.source).toBe("WS");
        expect(normalized.updatedAt).toBe(now);
    });
});

describe("computeAvailableNotional", () => {
    it("computes total notional for BUY (asks)", () => {
        const levels: NormalizedLevel[] = [
            { priceMicros: 500_000, sizeMicros: BigInt(100_000_000) }, // 100 shares @ $0.50 = $50
            { priceMicros: 510_000, sizeMicros: BigInt(200_000_000) }, // 200 shares @ $0.51 = $102
        ];
        // Total = $50 + $102 = $152 = 152_000_000 micros
        const total = computeAvailableNotional(levels, "BUY");
        expect(total).toBe(BigInt(152_000_000));
    });

    it("respects maxPriceMicros for BUY", () => {
        const levels: NormalizedLevel[] = [
            { priceMicros: 500_000, sizeMicros: BigInt(100_000_000) }, // 100 @ $0.50
            { priceMicros: 600_000, sizeMicros: BigInt(100_000_000) }, // 100 @ $0.60 - excluded
        ];
        const total = computeAvailableNotional(levels, "BUY", 550_000);
        // Only first level included: 100 * 0.50 = $50
        expect(total).toBe(BigInt(50_000_000));
    });

    it("respects minPriceMicros for SELL", () => {
        const levels: NormalizedLevel[] = [
            { priceMicros: 500_000, sizeMicros: BigInt(100_000_000) }, // 100 @ $0.50
            { priceMicros: 400_000, sizeMicros: BigInt(100_000_000) }, // 100 @ $0.40 - excluded
        ];
        const total = computeAvailableNotional(levels, "SELL", undefined, 450_000);
        // Only first level included: 100 * 0.50 = $50
        expect(total).toBe(BigInt(50_000_000));
    });
});

describe("isBookSane", () => {
    it("returns true for a normal book", () => {
        const rawBook = book(
            [level("0.48", "100")],
            [level("0.52", "100")]
        );
        const normalized = normalizeOrderBook(rawBook);
        expect(isBookSane(normalized)).toBe(true);
    });

    it("returns false for empty bids", () => {
        const rawBook = book([], [level("0.52", "100")]);
        const normalized = normalizeOrderBook(rawBook);
        expect(isBookSane(normalized)).toBe(false);
    });

    it("returns false for empty asks", () => {
        const rawBook = book([level("0.48", "100")], []);
        const normalized = normalizeOrderBook(rawBook);
        expect(isBookSane(normalized)).toBe(false);
    });

    it("returns false for spread > $0.20", () => {
        const rawBook = book(
            [level("0.10", "100")],
            [level("0.90", "100")]
        );
        const normalized = normalizeOrderBook(rawBook);
        expect(isBookSane(normalized)).toBe(false); // spread = $0.80
    });

    it("returns false for crossed book (bid >= ask)", () => {
        // This shouldn't happen in practice but we should detect it
        const rawBook = book(
            [level("0.60", "100")],
            [level("0.50", "100")]
        );
        const normalized = normalizeOrderBook(rawBook);
        expect(isBookSane(normalized)).toBe(false);
    });

    it("allows custom max spread", () => {
        const rawBook = book(
            [level("0.10", "100")],
            [level("0.50", "100")]
        );
        const normalized = normalizeOrderBook(rawBook);
        // Spread is $0.40 = 400_000 micros
        expect(isBookSane(normalized, 300_000)).toBe(false);
        expect(isBookSane(normalized, 500_000)).toBe(true);
    });
});

describe("formatPriceMicros", () => {
    it("formats price as dollar string", () => {
        expect(formatPriceMicros(500_000)).toBe("$0.5000");
        expect(formatPriceMicros(10_000)).toBe("$0.0100");
        expect(formatPriceMicros(990_000)).toBe("$0.9900");
    });
});

describe("real-world bug scenario", () => {
    it("correctly handles the $0.01/$0.99 bug case from logs", () => {
        // Reproduce the exact scenario from the implementation plan:
        // REST book returned unsorted arrays where [0] was NOT the best price
        const rawBook = book(
            // Bids: $0.01 at index 0 but real best bid is deeper
            [
                level("0.01", "1000"), // This was incorrectly used as "best bid"
                level("0.50", "5000"), // This is the actual best bid
                level("0.49", "3000"),
                level("0.48", "2000"),
            ],
            // Asks: $0.99 at index 0 but real best ask is deeper
            [
                level("0.99", "1000"), // This was incorrectly used as "best ask"
                level("0.52", "5000"), // This is the actual best ask
                level("0.53", "3000"),
                level("0.54", "2000"),
            ]
        );

        const normalized = normalizeOrderBook(rawBook);

        // Before fix: bid=$0.01 (10_000), ask=$0.99 (990_000), spread=$0.98 (980_000), mid=$0.50
        // After fix:  bid=$0.50 (500_000), ask=$0.52 (520_000), spread=$0.02 (20_000), mid=$0.51
        expect(normalized.bestBidMicros).toBe(500_000); // $0.50
        expect(normalized.bestAskMicros).toBe(520_000); // $0.52
        expect(normalized.spreadMicros).toBe(20_000); // $0.02
        expect(normalized.midPriceMicros).toBe(510_000); // $0.51

        // This spread should pass the default $0.02 spread filter
        expect(normalized.spreadMicros).toBeLessThanOrEqual(20_000);

        // Verify the book is now considered "sane"
        expect(isBookSane(normalized)).toBe(true);
    });
});
