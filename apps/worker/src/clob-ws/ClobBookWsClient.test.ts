/**
 * Unit tests for ClobBookWsClient internal logic.
 *
 * Note: Full WebSocket integration tests require a mock server setup.
 * These tests focus on the delta application and book state management logic
 * that can be tested without a live WebSocket connection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OrderBookCache, resetOrderBookCache } from "./OrderBookCache.js";
import {
    priceToMicros,
    sharesToMicros,
    type NormalizedLevel,
} from "../simulate/bookUtils.js";

describe("ClobBookWsClient delta logic", () => {
    // Test the delta application logic that would be used by the client
    // This mirrors the internal applyLevelUpdates behavior

    function applyLevelUpdates(
        levels: Map<number, bigint>,
        updates: Array<{ price: string; size: string }> | Record<string, string | number>
    ): void {
        if (Array.isArray(updates)) {
            for (const level of updates) {
                const priceMicros = priceToMicros(level.price);
                const sizeMicros = sharesToMicros(level.size);

                if (sizeMicros === BigInt(0)) {
                    levels.delete(priceMicros);
                } else {
                    levels.set(priceMicros, sizeMicros);
                }
            }
        } else {
            for (const [priceStr, sizeVal] of Object.entries(updates)) {
                const priceMicros = priceToMicros(priceStr);
                const sizeMicros = sharesToMicros(sizeVal);

                if (sizeMicros === BigInt(0)) {
                    levels.delete(priceMicros);
                } else {
                    levels.set(priceMicros, sizeMicros);
                }
            }
        }
    }

    describe("applyLevelUpdates with array format", () => {
        it("adds new levels", () => {
            const levels = new Map<number, bigint>();

            applyLevelUpdates(levels, [
                { price: "0.50", size: "100" },
                { price: "0.48", size: "200" },
            ]);

            expect(levels.size).toBe(2);
            expect(levels.get(500_000)).toBe(BigInt(100_000_000));
            expect(levels.get(480_000)).toBe(BigInt(200_000_000));
        });

        it("updates existing levels", () => {
            const levels = new Map<number, bigint>();
            levels.set(500_000, BigInt(100_000_000));

            applyLevelUpdates(levels, [{ price: "0.50", size: "300" }]);

            expect(levels.size).toBe(1);
            expect(levels.get(500_000)).toBe(BigInt(300_000_000));
        });

        it("removes levels with size 0", () => {
            const levels = new Map<number, bigint>();
            levels.set(500_000, BigInt(100_000_000));
            levels.set(480_000, BigInt(200_000_000));

            applyLevelUpdates(levels, [{ price: "0.50", size: "0" }]);

            expect(levels.size).toBe(1);
            expect(levels.has(500_000)).toBe(false);
            expect(levels.has(480_000)).toBe(true);
        });
    });

    describe("applyLevelUpdates with object format", () => {
        it("adds new levels from object", () => {
            const levels = new Map<number, bigint>();

            applyLevelUpdates(levels, { "0.50": 100, "0.48": 200 });

            expect(levels.size).toBe(2);
            expect(levels.get(500_000)).toBe(BigInt(100_000_000));
            expect(levels.get(480_000)).toBe(BigInt(200_000_000));
        });

        it("handles string values in object format", () => {
            const levels = new Map<number, bigint>();

            applyLevelUpdates(levels, { "0.50": "100", "0.48": "200" });

            expect(levels.size).toBe(2);
            expect(levels.get(500_000)).toBe(BigInt(100_000_000));
        });

        it("removes levels with size 0 from object", () => {
            const levels = new Map<number, bigint>();
            levels.set(500_000, BigInt(100_000_000));

            applyLevelUpdates(levels, { "0.50": 0 });

            expect(levels.size).toBe(0);
        });
    });

    describe("book state to NormalizedBook conversion", () => {
        function stateToNormalizedBook(
            tokenId: string,
            bids: Map<number, bigint>,
            asks: Map<number, bigint>,
            updatedAt: number
        ) {
            const bidLevels: NormalizedLevel[] = [];
            const askLevels: NormalizedLevel[] = [];

            for (const [priceMicros, sizeMicros] of bids.entries()) {
                if (sizeMicros > BigInt(0) && priceMicros > 0 && priceMicros < 1_000_000) {
                    bidLevels.push({ priceMicros, sizeMicros });
                }
            }

            for (const [priceMicros, sizeMicros] of asks.entries()) {
                if (sizeMicros > BigInt(0) && priceMicros > 0 && priceMicros < 1_000_000) {
                    askLevels.push({ priceMicros, sizeMicros });
                }
            }

            // Sort: bids descending, asks ascending
            bidLevels.sort((a, b) => b.priceMicros - a.priceMicros);
            askLevels.sort((a, b) => a.priceMicros - b.priceMicros);

            const bestBidMicros = bidLevels.length > 0 ? bidLevels[0]!.priceMicros : 0;
            const bestAskMicros = askLevels.length > 0 ? askLevels[0]!.priceMicros : 1_000_000;
            const midPriceMicros = Math.round((bestBidMicros + bestAskMicros) / 2);
            const spreadMicros = bestAskMicros - bestBidMicros;

            return {
                tokenId,
                bids: bidLevels,
                asks: askLevels,
                bestBidMicros,
                bestAskMicros,
                midPriceMicros,
                spreadMicros,
                updatedAt,
                source: "WS" as const,
            };
        }

        it("converts maps to sorted arrays", () => {
            const bids = new Map<number, bigint>();
            bids.set(470_000, BigInt(200_000_000));
            bids.set(480_000, BigInt(100_000_000));
            bids.set(460_000, BigInt(300_000_000));

            const asks = new Map<number, bigint>();
            asks.set(530_000, BigInt(200_000_000));
            asks.set(520_000, BigInt(100_000_000));
            asks.set(540_000, BigInt(300_000_000));

            const book = stateToNormalizedBook("token1", bids, asks, Date.now());

            // Bids should be sorted descending
            expect(book.bids[0]!.priceMicros).toBe(480_000);
            expect(book.bids[1]!.priceMicros).toBe(470_000);
            expect(book.bids[2]!.priceMicros).toBe(460_000);

            // Asks should be sorted ascending
            expect(book.asks[0]!.priceMicros).toBe(520_000);
            expect(book.asks[1]!.priceMicros).toBe(530_000);
            expect(book.asks[2]!.priceMicros).toBe(540_000);
        });

        it("computes correct best bid/ask", () => {
            const bids = new Map<number, bigint>();
            bids.set(480_000, BigInt(100_000_000));

            const asks = new Map<number, bigint>();
            asks.set(520_000, BigInt(100_000_000));

            const book = stateToNormalizedBook("token1", bids, asks, Date.now());

            expect(book.bestBidMicros).toBe(480_000);
            expect(book.bestAskMicros).toBe(520_000);
            expect(book.midPriceMicros).toBe(500_000);
            expect(book.spreadMicros).toBe(40_000);
        });

        it("handles empty bids", () => {
            const bids = new Map<number, bigint>();
            const asks = new Map<number, bigint>();
            asks.set(520_000, BigInt(100_000_000));

            const book = stateToNormalizedBook("token1", bids, asks, Date.now());

            expect(book.bestBidMicros).toBe(0);
            expect(book.bestAskMicros).toBe(520_000);
        });

        it("handles empty asks", () => {
            const bids = new Map<number, bigint>();
            bids.set(480_000, BigInt(100_000_000));
            const asks = new Map<number, bigint>();

            const book = stateToNormalizedBook("token1", bids, asks, Date.now());

            expect(book.bestBidMicros).toBe(480_000);
            expect(book.bestAskMicros).toBe(1_000_000);
        });

        it("filters out invalid prices (0 and 1)", () => {
            const bids = new Map<number, bigint>();
            bids.set(0, BigInt(100_000_000)); // Invalid
            bids.set(1_000_000, BigInt(100_000_000)); // Invalid
            bids.set(480_000, BigInt(100_000_000)); // Valid

            const asks = new Map<number, bigint>();
            asks.set(520_000, BigInt(100_000_000));

            const book = stateToNormalizedBook("token1", bids, asks, Date.now());

            expect(book.bids.length).toBe(1);
            expect(book.bids[0]!.priceMicros).toBe(480_000);
        });

        it("filters out zero size levels", () => {
            const bids = new Map<number, bigint>();
            bids.set(480_000, BigInt(0)); // Zero size
            bids.set(470_000, BigInt(100_000_000)); // Valid

            const asks = new Map<number, bigint>();
            asks.set(520_000, BigInt(100_000_000));

            const book = stateToNormalizedBook("token1", bids, asks, Date.now());

            expect(book.bids.length).toBe(1);
            expect(book.bids[0]!.priceMicros).toBe(470_000);
        });

        it("sets source to WS", () => {
            const book = stateToNormalizedBook(
                "token1",
                new Map(),
                new Map(),
                Date.now()
            );

            expect(book.source).toBe("WS");
        });
    });
});

describe("OrderBookCache integration with WS updates", () => {
    let cache: OrderBookCache;

    beforeEach(() => {
        resetOrderBookCache();
        cache = new OrderBookCache({
            freshnessMs: 100,
            firstSnapshotWaitMs: 200,
        });
    });

    afterEach(() => {
        cache.stop();
    });

    it("cache receives WS-sourced updates", () => {
        cache.update({
            tokenId: "token1",
            bids: [{ priceMicros: 480_000, sizeMicros: BigInt(100_000_000) }],
            asks: [{ priceMicros: 520_000, sizeMicros: BigInt(100_000_000) }],
            bestBidMicros: 480_000,
            bestAskMicros: 520_000,
            midPriceMicros: 500_000,
            spreadMicros: 40_000,
            updatedAt: Date.now(),
            source: "WS",
        });

        const book = cache.get("token1");
        expect(book).not.toBeNull();
        expect(book!.source).toBe("WS");
        expect(cache.isFresh("token1")).toBe(true);
    });

    it("getFreshOrWait resolves when WS update arrives", async () => {
        cache.ensureSubscribed("token1");

        // Start waiting
        const waitPromise = cache.getFreshOrWait("token1", { waitMs: 500 });

        // Simulate WS update arriving
        setTimeout(() => {
            cache.update({
                tokenId: "token1",
                bids: [{ priceMicros: 480_000, sizeMicros: BigInt(100_000_000) }],
                asks: [{ priceMicros: 520_000, sizeMicros: BigInt(100_000_000) }],
                bestBidMicros: 480_000,
                bestAskMicros: 520_000,
                midPriceMicros: 500_000,
                spreadMicros: 40_000,
                updatedAt: Date.now(),
                source: "WS",
            });
        }, 50);

        const result = await waitPromise;
        expect(result).not.toBeNull();
        expect(result!.source).toBe("WS");
    });
});
