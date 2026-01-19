/**
 * Unit tests for bookService.
 *
 * Tests the cache-first book fetching logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getBook, getBookServiceStats, stopBookService, type BookFetchResult } from "./bookService.js";
import { OrderBookCache, resetOrderBookCache } from "../clob-ws/OrderBookCache.js";
import type { NormalizedBook } from "./bookUtils.js";

// Mock the env module with all required fields
vi.mock("../config/env.js", () => ({
    env: {
        CLOB_BOOK_WS_ENABLED: false, // Disable WS for most tests
        LOG_LEVEL: "info",
        DATABASE_URL: "postgresql://test",
        REDIS_URL: "redis://localhost",
        ALCHEMY_WS_URL: "wss://test",
        ALCHEMY_WS_ENABLED: false,
        POLYMARKET_DATA_API_BASE_URL: "https://test",
        POLYMARKET_CLOB_BASE_URL: "https://test",
        GAMMA_API_BASE_URL: "https://test",
        NODE_ENV: "test",
        WORKER_PORT: 8081,
    },
}));

// Mock fetchOrderBook
vi.mock("../poly/index.js", () => ({
    fetchOrderBook: vi.fn(),
}));

// Import the mocked fetchOrderBook
import { fetchOrderBook } from "../poly/index.js";
const mockFetchOrderBook = fetchOrderBook as ReturnType<typeof vi.fn>;

/**
 * Create a mock raw OrderBook (REST API format).
 */
function createMockRawBook(tokenId: string) {
    return {
        market: "0x1234",
        asset_id: tokenId,
        bids: [
            { price: "0.58", size: "1000" },
            { price: "0.57", size: "2000" },
        ],
        asks: [
            { price: "0.60", size: "1000" },
            { price: "0.61", size: "2000" },
        ],
    };
}

describe("bookService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetOrderBookCache();
    });

    afterEach(async () => {
        await stopBookService();
    });

    describe("getBook with WS disabled", () => {
        it("should fetch from REST when WS is disabled", async () => {
            mockFetchOrderBook.mockResolvedValue(createMockRawBook("token1"));

            const result = await getBook("token1");

            expect(result.book).not.toBeNull();
            expect(result.source).toBe("REST");
            expect(result.stale).toBe(false);
            expect(mockFetchOrderBook).toHaveBeenCalledWith("token1");
        });

        it("should normalize the REST response correctly", async () => {
            mockFetchOrderBook.mockResolvedValue(createMockRawBook("token1"));

            const result = await getBook("token1");

            expect(result.book).not.toBeNull();
            expect(result.book!.tokenId).toBe("token1");
            expect(result.book!.bestBidMicros).toBe(580_000); // 0.58
            expect(result.book!.bestAskMicros).toBe(600_000); // 0.60
            expect(result.book!.source).toBe("REST");
        });

        it("should return null when REST returns null", async () => {
            mockFetchOrderBook.mockResolvedValue(null);

            const result = await getBook("token1");

            expect(result.book).toBeNull();
            expect(result.source).toBeNull();
        });

        it("should return null when REST throws", async () => {
            mockFetchOrderBook.mockRejectedValue(new Error("Network error"));

            const result = await getBook("token1");

            expect(result.book).toBeNull();
            expect(result.source).toBeNull();
        });
    });

    describe("getBookServiceStats", () => {
        it("should return stats when WS is disabled", () => {
            const stats = getBookServiceStats();

            expect(stats).not.toBeNull();
            expect(stats.wsEnabled).toBe(false);
            expect(stats.wsConnected).toBe(false);
            expect(stats.cacheSize).toBe(0);
        });
    });

    describe("getBook options", () => {
        it("should respect noWait option", async () => {
            mockFetchOrderBook.mockResolvedValue(createMockRawBook("token1"));

            const start = Date.now();
            const result = await getBook("token1", { noWait: true });
            const elapsed = Date.now() - start;

            // Should be fast (no waiting)
            expect(elapsed).toBeLessThan(100);
            expect(result.book).not.toBeNull();
        });
    });
});

describe("bookService with unsorted REST data", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetOrderBookCache();
    });

    afterEach(async () => {
        await stopBookService();
    });

    it("should handle unsorted bids/asks from REST (the bug scenario)", async () => {
        // REST API sometimes returns unsorted data
        // This was causing the bug where book.bids[0] wasn't the best bid
        const unsortedBook = {
            market: "0x1234",
            asset_id: "token1",
            bids: [
                { price: "0.50", size: "1000" }, // NOT the best bid
                { price: "0.58", size: "1000" }, // This is the best bid
                { price: "0.55", size: "1000" },
            ],
            asks: [
                { price: "0.65", size: "1000" }, // NOT the best ask
                { price: "0.60", size: "1000" }, // This is the best ask
                { price: "0.62", size: "1000" },
            ],
        };

        mockFetchOrderBook.mockResolvedValue(unsortedBook);

        const result = await getBook("token1");

        expect(result.book).not.toBeNull();
        // Should correctly identify best bid/ask despite unsorted input
        expect(result.book!.bestBidMicros).toBe(580_000); // 0.58, not 0.50
        expect(result.book!.bestAskMicros).toBe(600_000); // 0.60, not 0.65
        expect(result.book!.spreadMicros).toBe(20_000); // 0.60 - 0.58 = 0.02
    });

    it("should sort bids descending in normalized output", async () => {
        const unsortedBook = {
            market: "0x1234",
            asset_id: "token1",
            bids: [
                { price: "0.50", size: "1000" },
                { price: "0.58", size: "2000" },
                { price: "0.55", size: "3000" },
            ],
            asks: [{ price: "0.60", size: "1000" }],
        };

        mockFetchOrderBook.mockResolvedValue(unsortedBook);

        const result = await getBook("token1");

        expect(result.book!.bids.length).toBe(3);
        // Bids should be sorted descending (highest first)
        expect(result.book!.bids[0]!.priceMicros).toBe(580_000);
        expect(result.book!.bids[1]!.priceMicros).toBe(550_000);
        expect(result.book!.bids[2]!.priceMicros).toBe(500_000);
    });

    it("should sort asks ascending in normalized output", async () => {
        const unsortedBook = {
            market: "0x1234",
            asset_id: "token1",
            bids: [{ price: "0.58", size: "1000" }],
            asks: [
                { price: "0.65", size: "1000" },
                { price: "0.60", size: "2000" },
                { price: "0.62", size: "3000" },
            ],
        };

        mockFetchOrderBook.mockResolvedValue(unsortedBook);

        const result = await getBook("token1");

        expect(result.book!.asks.length).toBe(3);
        // Asks should be sorted ascending (lowest first)
        expect(result.book!.asks[0]!.priceMicros).toBe(600_000);
        expect(result.book!.asks[1]!.priceMicros).toBe(620_000);
        expect(result.book!.asks[2]!.priceMicros).toBe(650_000);
    });
});
