/**
 * In-memory order book cache with TTL/LRU eviction.
 *
 * Stores NormalizedBook snapshots keyed by tokenId.
 * Designed to work with both WS (primary) and REST (fallback) sources.
 *
 * Cache rules:
 * - MAX_ACTIVE_BOOKS: Maximum number of books to keep in memory
 * - BOOK_TTL_MS: Evict books not used within this time
 * - FRESHNESS_MS: Consider a book "fresh" if updated within this time
 * - FIRST_SNAPSHOT_WAIT_MS: How long to wait for initial WS snapshot
 */

import { EventEmitter } from "events";
import { createChildLogger } from "../log/logger.js";
import type { NormalizedBook } from "../simulate/bookUtils.js";

const logger = createChildLogger({ module: "order-book-cache" });

/**
 * Waiter entry for getFreshOrWait promises.
 */
interface WaiterEntry {
    tokenId: string;
    resolve: (book: NormalizedBook | null) => void;
    timeout: NodeJS.Timeout;
    freshnessMs: number;
}

/**
 * Cache configuration (can be overridden via constructor).
 */
export interface OrderBookCacheConfig {
    /** Maximum number of active books to cache. Default: 200 */
    maxActiveBooks: number;

    /** Evict books not accessed within this time (ms). Default: 10 minutes */
    bookTtlMs: number;

    /** Consider book "fresh" if updated within this time (ms). Default: 2 seconds */
    freshnessMs: number;

    /** How long to wait for first WS snapshot (ms). Default: 500ms */
    firstSnapshotWaitMs: number;

    /** How often to run eviction sweep (ms). Default: 30 seconds */
    evictionIntervalMs: number;
}

/**
 * Default cache configuration.
 */
export const DEFAULT_CACHE_CONFIG: OrderBookCacheConfig = {
    maxActiveBooks: 200,
    bookTtlMs: 10 * 60 * 1000, // 10 minutes
    freshnessMs: 2_000, // 2 seconds
    firstSnapshotWaitMs: 500, // 500ms
    evictionIntervalMs: 30_000, // 30 seconds
};

/**
 * Internal cache entry with metadata.
 */
interface CacheEntry {
    book: NormalizedBook;
    lastAccessedAt: number;
    subscribed: boolean; // Whether WS subscription is active
}

/**
 * Options for getFreshOrWait.
 */
export interface GetFreshOptions {
    /** Override freshness threshold (ms). */
    freshnessMs?: number;

    /** Override wait timeout (ms). */
    waitMs?: number;

    /** If true, don't wait - just return current state. */
    noWait?: boolean;
}

/**
 * In-memory order book cache with LRU eviction.
 *
 * Events:
 * - 'update': Emitted when a book is updated (tokenId, book)
 * - 'evict': Emitted when a book is evicted (tokenId)
 * - 'subscribe': Emitted when subscription is needed (tokenId)
 * - 'unsubscribe': Emitted when subscription should be dropped (tokenId)
 */
export class OrderBookCache extends EventEmitter {
    private cache: Map<string, CacheEntry> = new Map();
    private config: OrderBookCacheConfig;
    private evictionTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    // Waiters for fresh snapshots
    private waiters: Set<WaiterEntry> = new Set();

    constructor(config: Partial<OrderBookCacheConfig> = {}) {
        super();
        this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
        this.stopped = false;
    }

    /**
     * Start the eviction timer.
     */
    start(): void {
        if (this.evictionTimer) return;

        this.evictionTimer = setInterval(() => {
            this.evictExpired();
        }, this.config.evictionIntervalMs);

        // Don't block process exit
        this.evictionTimer.unref();

        logger.info({ config: this.config }, "OrderBookCache started");
    }

    /**
     * Stop the eviction timer and clear cache.
     */
    stop(): void {
        this.stopped = true;

        if (this.evictionTimer) {
            clearInterval(this.evictionTimer);
            this.evictionTimer = null;
        }

        // Emit unsubscribe for all subscribed tokens BEFORE clearing
        for (const [tokenId, entry] of this.cache.entries()) {
            if (entry.subscribed) {
                this.emit("unsubscribe", tokenId);
            }
        }

        // Resolve all pending waiters with current data (may be stale/null)
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timeout);
            const entry = this.cache.get(waiter.tokenId);
            waiter.resolve(entry?.book ?? null);
        }
        this.waiters.clear();

        this.cache.clear();
        logger.info("OrderBookCache stopped");
    }

    /**
     * Get current cache size.
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Get cache statistics.
     */
    getStats(): {
        size: number;
        maxSize: number;
        subscribedCount: number;
        freshCount: number;
    } {
        const now = Date.now();
        let subscribedCount = 0;
        let freshCount = 0;

        for (const entry of this.cache.values()) {
            if (entry.subscribed) subscribedCount++;
            if (now - entry.book.updatedAt < this.config.freshnessMs) freshCount++;
        }

        return {
            size: this.cache.size,
            maxSize: this.config.maxActiveBooks,
            subscribedCount,
            freshCount,
        };
    }

    /**
     * Touch a token to mark it as recently used.
     * Creates a placeholder entry if it doesn't exist.
     */
    touch(tokenId: string): void {
        const entry = this.cache.get(tokenId);
        if (entry) {
            entry.lastAccessedAt = Date.now();
        }
        // If no entry, we don't create one - use ensureSubscribed for that
    }

    /**
     * Get a book snapshot (may be stale).
     * Returns null if token is not in cache.
     */
    get(tokenId: string): NormalizedBook | null {
        const entry = this.cache.get(tokenId);
        if (!entry) return null;

        entry.lastAccessedAt = Date.now();
        return entry.book;
    }

    /**
     * Check if a book is fresh (updated within freshnessMs).
     */
    isFresh(tokenId: string, freshnessMs?: number): boolean {
        const entry = this.cache.get(tokenId);
        if (!entry) return false;

        const threshold = freshnessMs ?? this.config.freshnessMs;
        return Date.now() - entry.book.updatedAt < threshold;
    }

    /**
     * Get a fresh book or wait for one.
     *
     * If book is fresh, returns immediately.
     * If not fresh, ensures subscription and waits up to waitMs.
     * Returns null if timeout expires without fresh data.
     */
    async getFreshOrWait(
        tokenId: string,
        options: GetFreshOptions = {}
    ): Promise<NormalizedBook | null> {
        const freshnessMs = options.freshnessMs ?? this.config.freshnessMs;
        const waitMs = options.waitMs ?? this.config.firstSnapshotWaitMs;

        // Check if stopped
        if (this.stopped) {
            const entry = this.cache.get(tokenId);
            return entry?.book ?? null;
        }

        // Check if already fresh
        const entry = this.cache.get(tokenId);
        if (entry) {
            entry.lastAccessedAt = Date.now();
            if (Date.now() - entry.book.updatedAt < freshnessMs) {
                return entry.book;
            }
        }

        // If noWait, return current state (may be null or stale)
        if (options.noWait) {
            return entry?.book ?? null;
        }

        // Ensure subscription is requested
        this.ensureSubscribed(tokenId);

        // Wait for fresh update
        return new Promise<NormalizedBook | null>((resolve) => {
            const startTime = Date.now();
            let waiterEntry: WaiterEntry | null = null;

            const cleanup = () => {
                if (waiterEntry) {
                    this.waiters.delete(waiterEntry);
                    waiterEntry = null;
                }
            };

            const doResolve = (book: NormalizedBook | null) => {
                cleanup();
                resolve(book);
            };

            // Set up timeout
            const timeout = setTimeout(() => {
                // Return stale data or null
                const currentEntry = this.cache.get(tokenId);
                logger.debug(
                    { tokenId, waitedMs: Date.now() - startTime, hadData: !!currentEntry },
                    "getFreshOrWait timeout"
                );
                doResolve(currentEntry?.book ?? null);
            }, waitMs);

            // Create waiter entry
            waiterEntry = {
                tokenId,
                resolve: (book) => {
                    clearTimeout(timeout);
                    doResolve(book);
                },
                timeout,
                freshnessMs,
            };

            this.waiters.add(waiterEntry);
        });
    }

    /**
     * Ensure a token is marked for subscription.
     * Emits 'subscribe' event if not already subscribed.
     */
    ensureSubscribed(tokenId: string): void {
        let entry = this.cache.get(tokenId);

        if (!entry) {
            // Check if we need to evict before adding
            if (this.cache.size >= this.config.maxActiveBooks) {
                this.evictLRU();
            }

            // Create placeholder entry
            entry = {
                book: {
                    tokenId,
                    bids: [],
                    asks: [],
                    bestBidMicros: 0,
                    bestAskMicros: 1_000_000,
                    midPriceMicros: 500_000,
                    spreadMicros: 1_000_000,
                    updatedAt: 0, // Never updated
                    source: "REST",
                },
                lastAccessedAt: Date.now(),
                subscribed: false,
            };
            this.cache.set(tokenId, entry);
        }

        entry.lastAccessedAt = Date.now();

        if (!entry.subscribed) {
            entry.subscribed = true;
            this.emit("subscribe", tokenId);
            logger.debug({ tokenId }, "Subscription requested");
        }
    }

    /**
     * Mark a token as unsubscribed (e.g., after WS unsubscribe).
     */
    markUnsubscribed(tokenId: string): void {
        const entry = this.cache.get(tokenId);
        if (entry) {
            entry.subscribed = false;
        }
    }

    /**
     * Update the book for a token.
     * Called by WS client or REST fallback.
     */
    update(book: NormalizedBook): void {
        let entry = this.cache.get(book.tokenId);

        if (!entry) {
            // Check if we need to evict before adding
            if (this.cache.size >= this.config.maxActiveBooks) {
                this.evictLRU();
            }

            entry = {
                book,
                lastAccessedAt: Date.now(),
                subscribed: false,
            };
            this.cache.set(book.tokenId, entry);
        } else {
            entry.book = book;
            entry.lastAccessedAt = Date.now();
        }

        // Emit update event
        this.emit("update", book.tokenId, book);

        // Wake up any waiters for this token if the book is fresh enough
        const now = Date.now();
        for (const waiter of [...this.waiters]) {
            if (waiter.tokenId === book.tokenId) {
                // Check if this update makes the book fresh for this waiter
                if (now - book.updatedAt < waiter.freshnessMs) {
                    waiter.resolve(book);
                }
            }
        }

        logger.debug(
            {
                tokenId: book.tokenId,
                bestBid: book.bestBidMicros,
                bestAsk: book.bestAskMicros,
                spread: book.spreadMicros,
                source: book.source,
            },
            "Book updated"
        );
    }

    /**
     * Remove a token from cache.
     */
    remove(tokenId: string): void {
        const entry = this.cache.get(tokenId);
        if (!entry) return;

        if (entry.subscribed) {
            this.emit("unsubscribe", tokenId);
        }

        this.cache.delete(tokenId);
        this.emit("evict", tokenId);

        logger.debug({ tokenId }, "Book removed from cache");
    }

    /**
     * Evict entries that haven't been accessed within TTL.
     */
    evictExpired(): number {
        const now = Date.now();
        const toEvict: string[] = [];

        for (const [tokenId, entry] of this.cache.entries()) {
            if (now - entry.lastAccessedAt > this.config.bookTtlMs) {
                toEvict.push(tokenId);
            }
        }

        for (const tokenId of toEvict) {
            this.remove(tokenId);
        }

        if (toEvict.length > 0) {
            logger.info({ evicted: toEvict.length, remaining: this.cache.size }, "Evicted expired books");
        }

        return toEvict.length;
    }

    /**
     * Evict least recently used entry.
     */
    private evictLRU(): void {
        let oldest: { tokenId: string; accessedAt: number } | null = null;

        for (const [tokenId, entry] of this.cache.entries()) {
            if (!oldest || entry.lastAccessedAt < oldest.accessedAt) {
                oldest = { tokenId, accessedAt: entry.lastAccessedAt };
            }
        }

        if (oldest) {
            this.remove(oldest.tokenId);
            logger.debug({ tokenId: oldest.tokenId }, "Evicted LRU book");
        }
    }

    /**
     * Get all currently subscribed token IDs.
     * Used for re-subscription after WS reconnect.
     */
    getSubscribedTokenIds(): string[] {
        const tokenIds: string[] = [];
        for (const [tokenId, entry] of this.cache.entries()) {
            if (entry.subscribed) {
                tokenIds.push(tokenId);
            }
        }
        return tokenIds;
    }

    /**
     * Check if a token is subscribed.
     */
    isSubscribed(tokenId: string): boolean {
        const entry = this.cache.get(tokenId);
        return entry?.subscribed ?? false;
    }

    /**
     * Get all cached token IDs.
     */
    getAllTokenIds(): string[] {
        return Array.from(this.cache.keys());
    }
}

/**
 * Singleton instance (created lazily).
 */
let instance: OrderBookCache | null = null;

/**
 * Get the singleton OrderBookCache instance.
 */
export function getOrderBookCache(config?: Partial<OrderBookCacheConfig>): OrderBookCache {
    if (!instance) {
        instance = new OrderBookCache(config);
    }
    return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetOrderBookCache(): void {
    if (instance) {
        instance.stop();
        instance = null;
    }
}
