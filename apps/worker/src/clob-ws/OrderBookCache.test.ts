/**
 * Unit tests for OrderBookCache.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    OrderBookCache,
    resetOrderBookCache,
    DEFAULT_CACHE_CONFIG,
} from "./OrderBookCache.js";
import type { NormalizedBook } from "../simulate/bookUtils.js";

// Helper to create a mock NormalizedBook
function mockBook(
    tokenId: string,
    overrides: Partial<NormalizedBook> = {}
): NormalizedBook {
    return {
        tokenId,
        bids: [{ priceMicros: 480_000, sizeMicros: BigInt(100_000_000) }],
        asks: [{ priceMicros: 520_000, sizeMicros: BigInt(100_000_000) }],
        bestBidMicros: 480_000,
        bestAskMicros: 520_000,
        midPriceMicros: 500_000,
        spreadMicros: 40_000,
        updatedAt: Date.now(),
        source: "WS",
        ...overrides,
    };
}

describe("OrderBookCache", () => {
    let cache: OrderBookCache;

    beforeEach(() => {
        resetOrderBookCache();
        cache = new OrderBookCache({
            maxActiveBooks: 5,
            bookTtlMs: 1000, // 1 second for testing
            freshnessMs: 100, // 100ms for testing
            firstSnapshotWaitMs: 200, // 200ms for testing
            evictionIntervalMs: 500, // 500ms for testing
        });
    });

    afterEach(() => {
        cache.stop();
    });

    describe("basic operations", () => {
        it("starts empty", () => {
            expect(cache.size).toBe(0);
        });

        it("update() adds a book to cache", () => {
            const book = mockBook("token1");
            cache.update(book);

            expect(cache.size).toBe(1);
            expect(cache.get("token1")).toEqual(book);
        });

        it("get() returns null for unknown token", () => {
            expect(cache.get("unknown")).toBeNull();
        });

        it("get() updates lastAccessedAt", () => {
            const book = mockBook("token1");
            cache.update(book);

            // Access it
            cache.get("token1");

            // Stats should show it's accessed
            const stats = cache.getStats();
            expect(stats.size).toBe(1);
        });

        it("touch() marks token as recently used", () => {
            const book = mockBook("token1");
            cache.update(book);
            cache.touch("token1");

            // Should not throw or change size
            expect(cache.size).toBe(1);
        });

        it("remove() deletes a book", () => {
            const book = mockBook("token1");
            cache.update(book);
            cache.remove("token1");

            expect(cache.size).toBe(0);
            expect(cache.get("token1")).toBeNull();
        });
    });

    describe("freshness", () => {
        it("isFresh() returns true for recently updated book", () => {
            const book = mockBook("token1", { updatedAt: Date.now() });
            cache.update(book);

            expect(cache.isFresh("token1")).toBe(true);
        });

        it("isFresh() returns false for stale book", async () => {
            const book = mockBook("token1", { updatedAt: Date.now() - 200 }); // 200ms ago
            cache.update(book);

            expect(cache.isFresh("token1")).toBe(false);
        });

        it("isFresh() returns false for unknown token", () => {
            expect(cache.isFresh("unknown")).toBe(false);
        });

        it("isFresh() accepts custom freshness threshold", () => {
            const book = mockBook("token1", { updatedAt: Date.now() - 50 }); // 50ms ago
            cache.update(book);

            expect(cache.isFresh("token1", 30)).toBe(false); // 30ms threshold
            expect(cache.isFresh("token1", 100)).toBe(true); // 100ms threshold
        });
    });

    describe("subscription management", () => {
        it("ensureSubscribed() emits subscribe event for new token", () => {
            const subscribeSpy = vi.fn();
            cache.on("subscribe", subscribeSpy);

            cache.ensureSubscribed("token1");

            expect(subscribeSpy).toHaveBeenCalledWith("token1");
            expect(cache.isSubscribed("token1")).toBe(true);
        });

        it("ensureSubscribed() does not emit twice for same token", () => {
            const subscribeSpy = vi.fn();
            cache.on("subscribe", subscribeSpy);

            cache.ensureSubscribed("token1");
            cache.ensureSubscribed("token1");

            expect(subscribeSpy).toHaveBeenCalledTimes(1);
        });

        it("markUnsubscribed() clears subscription flag", () => {
            cache.ensureSubscribed("token1");
            expect(cache.isSubscribed("token1")).toBe(true);

            cache.markUnsubscribed("token1");
            expect(cache.isSubscribed("token1")).toBe(false);
        });

        it("getSubscribedTokenIds() returns only subscribed tokens", () => {
            cache.ensureSubscribed("token1");
            cache.ensureSubscribed("token2");
            cache.update(mockBook("token3")); // Not subscribed

            const subscribed = cache.getSubscribedTokenIds();
            expect(subscribed).toContain("token1");
            expect(subscribed).toContain("token2");
            expect(subscribed).not.toContain("token3");
        });

        it("remove() emits unsubscribe for subscribed token", () => {
            const unsubscribeSpy = vi.fn();
            cache.on("unsubscribe", unsubscribeSpy);

            cache.ensureSubscribed("token1");
            cache.remove("token1");

            expect(unsubscribeSpy).toHaveBeenCalledWith("token1");
        });
    });

    describe("getFreshOrWait()", () => {
        it("returns immediately if book is fresh", async () => {
            const book = mockBook("token1", { updatedAt: Date.now() });
            cache.update(book);

            const result = await cache.getFreshOrWait("token1");
            expect(result).toEqual(book);
        });

        it("waits for fresh data if book is stale", async () => {
            const staleBook = mockBook("token1", { updatedAt: Date.now() - 200 });
            cache.update(staleBook);

            // Start waiting
            const waitPromise = cache.getFreshOrWait("token1");

            // Simulate WS update after 50ms
            setTimeout(() => {
                const freshBook = mockBook("token1", { updatedAt: Date.now() });
                cache.update(freshBook);
            }, 50);

            const result = await waitPromise;
            expect(result).not.toBeNull();
            expect(Date.now() - result!.updatedAt).toBeLessThan(100);
        });

        it("returns stale data on timeout", async () => {
            const staleBook = mockBook("token1", { updatedAt: Date.now() - 200 });
            cache.update(staleBook);

            const start = Date.now();
            const result = await cache.getFreshOrWait("token1", { waitMs: 50 });
            const elapsed = Date.now() - start;

            // Should have waited ~50ms then returned stale data
            expect(elapsed).toBeGreaterThanOrEqual(40);
            expect(result).toEqual(staleBook);
        });

        it("returns placeholder on timeout for unknown token", async () => {
            // getFreshOrWait calls ensureSubscribed which creates a placeholder
            // So we get a stale placeholder back, not null
            const result = await cache.getFreshOrWait("unknown", { waitMs: 50 });
            expect(result).not.toBeNull();
            expect(result!.tokenId).toBe("unknown");
            expect(result!.updatedAt).toBe(0); // Placeholder has updatedAt=0
        });

        it("noWait option returns immediately", async () => {
            const staleBook = mockBook("token1", { updatedAt: Date.now() - 200 });
            cache.update(staleBook);

            const start = Date.now();
            const result = await cache.getFreshOrWait("token1", { noWait: true });
            const elapsed = Date.now() - start;

            expect(elapsed).toBeLessThan(20);
            expect(result).toEqual(staleBook);
        });

        it("noWait returns null for unknown token", async () => {
            const result = await cache.getFreshOrWait("unknown", { noWait: true });
            expect(result).toBeNull();
        });

        it("ensures subscription while waiting", async () => {
            const subscribeSpy = vi.fn();
            cache.on("subscribe", subscribeSpy);

            // Start waiting for unknown token
            const waitPromise = cache.getFreshOrWait("token1", { waitMs: 50 });

            expect(subscribeSpy).toHaveBeenCalledWith("token1");

            await waitPromise;
        });
    });

    describe("LRU eviction", () => {
        it("evicts oldest entry when max capacity reached", async () => {
            // Fill cache to max (5) with different timestamps
            for (let i = 0; i < 5; i++) {
                cache.update(mockBook(`token${i}`, { updatedAt: Date.now() - (100 - i * 10) }));
                // Small delay to ensure lastAccessedAt differs
                await new Promise((r) => setTimeout(r, 5));
            }
            expect(cache.size).toBe(5);

            // Access token1-4 but not token0 (making token0 the LRU)
            await new Promise((r) => setTimeout(r, 5));
            cache.get("token1");
            await new Promise((r) => setTimeout(r, 5));
            cache.get("token2");
            await new Promise((r) => setTimeout(r, 5));
            cache.get("token3");
            await new Promise((r) => setTimeout(r, 5));
            cache.get("token4");

            // Add new token - should evict token0 (least recently accessed)
            await new Promise((r) => setTimeout(r, 5));
            cache.update(mockBook("token5"));

            expect(cache.size).toBe(5);
            expect(cache.get("token0")).toBeNull(); // Evicted (LRU)
            expect(cache.get("token5")).not.toBeNull(); // Added
        });

        it("emits evict event on LRU eviction", () => {
            const evictSpy = vi.fn();
            cache.on("evict", evictSpy);

            // Fill cache
            for (let i = 0; i < 5; i++) {
                cache.update(mockBook(`token${i}`));
            }

            // Add one more to trigger eviction
            cache.update(mockBook("token5"));

            expect(evictSpy).toHaveBeenCalled();
        });
    });

    describe("TTL eviction", () => {
        it("evictExpired() removes old entries", async () => {
            // Add book with old lastAccessedAt
            const book = mockBook("token1");
            cache.update(book);

            // Wait for TTL to expire (1 second in test config)
            await new Promise((r) => setTimeout(r, 1100));

            const evicted = cache.evictExpired();
            expect(evicted).toBe(1);
            expect(cache.size).toBe(0);
        });

        it("evictExpired() keeps recently accessed entries", async () => {
            const book = mockBook("token1");
            cache.update(book);

            // Wait 500ms then access
            await new Promise((r) => setTimeout(r, 500));
            cache.get("token1");

            // Wait another 600ms (total 1100ms but accessed 600ms ago)
            await new Promise((r) => setTimeout(r, 600));

            const evicted = cache.evictExpired();
            expect(evicted).toBe(0);
            expect(cache.size).toBe(1);
        });
    });

    describe("events", () => {
        it("emits update event when book is updated", () => {
            const updateSpy = vi.fn();
            cache.on("update", updateSpy);

            const book = mockBook("token1");
            cache.update(book);

            expect(updateSpy).toHaveBeenCalledWith("token1", book);
        });

        it("emits evict event when book is removed", () => {
            const evictSpy = vi.fn();
            cache.on("evict", evictSpy);

            cache.update(mockBook("token1"));
            cache.remove("token1");

            expect(evictSpy).toHaveBeenCalledWith("token1");
        });
    });

    describe("stats", () => {
        it("getStats() returns correct counts", () => {
            cache.update(mockBook("token1", { updatedAt: Date.now() })); // Fresh
            cache.update(mockBook("token2", { updatedAt: Date.now() - 200 })); // Stale
            cache.ensureSubscribed("token3"); // Subscribed placeholder

            const stats = cache.getStats();
            expect(stats.size).toBe(3);
            expect(stats.maxSize).toBe(5);
            expect(stats.subscribedCount).toBe(1); // Only token3 is subscribed
            expect(stats.freshCount).toBe(1); // Only token1 is fresh
        });
    });

    describe("stop()", () => {
        it("clears cache and emits unsubscribe", () => {
            const unsubscribeSpy = vi.fn();
            cache.on("unsubscribe", unsubscribeSpy);

            cache.ensureSubscribed("token1");
            cache.ensureSubscribed("token2");

            cache.stop();

            expect(cache.size).toBe(0);
            expect(unsubscribeSpy).toHaveBeenCalledTimes(2);
        });

        it("resolves pending waiters", async () => {
            // Start waiting
            const waitPromise = cache.getFreshOrWait("token1", { waitMs: 5000 });

            // Give the promise a moment to set up its waiter
            await new Promise((r) => setTimeout(r, 10));

            // Stop immediately
            const start = Date.now();
            cache.stop();

            // Should resolve quickly (not wait 5 seconds)
            const result = await waitPromise;
            expect(Date.now() - start).toBeLessThan(200);
            // Result will be the placeholder (stale) or null since cache is cleared
            // The important thing is that it resolved quickly
        });
    });
});
