/**
 * Book service - unified interface for order book data.
 *
 * Provides cache-first book fetching:
 * 1. If WS is enabled, try cache.getFreshOrWait() first
 * 2. If cache returns fresh data, use it (source = WS)
 * 3. Otherwise, fall back to REST API and normalize
 *
 * This service abstracts away the choice between WS-streaming and REST-polling
 * from the simulation/executor code.
 */

import { env } from "../config/env.js";
import { createChildLogger } from "../log/logger.js";
import { fetchOrderBook } from "../poly/index.js";
import {
    getOrderBookCache,
    getClobBookWsClient,
    type OrderBookCache,
    type ClobBookWsClient,
} from "../clob-ws/index.js";
import { normalizeOrderBook, type NormalizedBook } from "./bookUtils.js";

const logger = createChildLogger({ module: "book-service" });

/**
 * Result of a book fetch with source information.
 */
export interface BookFetchResult {
    book: NormalizedBook | null;
    source: "WS" | "REST" | null;
    stale: boolean;
}

/**
 * Options for getBook.
 */
export interface GetBookOptions {
    /** How long to wait for fresh WS data (ms). Default: 500ms */
    waitMs?: number;

    /** Freshness threshold (ms). Default: 2000ms */
    freshnessMs?: number;

    /** If true, don't wait for fresh data. Default: false */
    noWait?: boolean;
}

// Lazy-initialized singleton instances
let cache: OrderBookCache | null = null;
let wsClient: ClobBookWsClient | null = null;
let wsInitialized = false;
let wsInitPromise: Promise<void> | null = null;

/**
 * Initialize the WS client (once).
 */
async function ensureWsInitialized(): Promise<void> {
    if (!env.CLOB_BOOK_WS_ENABLED) {
        return;
    }

    if (wsInitialized) {
        return;
    }

    if (wsInitPromise) {
        return wsInitPromise;
    }

    wsInitPromise = (async () => {
        try {
            cache = getOrderBookCache();
            wsClient = getClobBookWsClient(cache);

            // Start the cache eviction timer
            cache.start();

            // Start the WS client
            await wsClient.start();

            wsInitialized = true;
            logger.info("Book service WS initialized");
        } catch (err) {
            logger.error({ err }, "Failed to initialize book service WS");
            // Don't throw - we'll fall back to REST
        }
    })();

    return wsInitPromise;
}

/**
 * Get a NormalizedBook for a token.
 *
 * Tries WS cache first if enabled, falls back to REST.
 *
 * @param tokenId - The token ID to get the book for
 * @param options - Fetch options
 */
export async function getBook(
    tokenId: string,
    options: GetBookOptions = {}
): Promise<BookFetchResult> {
    const { waitMs = 500, freshnessMs = 2000, noWait = false } = options;
    const log = logger.child({ tokenId });

    // Try WS cache first if enabled
    if (env.CLOB_BOOK_WS_ENABLED) {
        await ensureWsInitialized();

        if (cache) {
            try {
                const book = await cache.getFreshOrWait(tokenId, {
                    waitMs,
                    freshnessMs,
                    noWait,
                });

                if (book && book.updatedAt > 0) {
                    const age = Date.now() - book.updatedAt;
                    const stale = age > freshnessMs;

                    log.debug(
                        { source: book.source, age, stale },
                        "Got book from cache"
                    );

                    return {
                        book,
                        source: book.source,
                        stale,
                    };
                }

                // Placeholder or no data - fall through to REST
                log.debug("Cache returned placeholder, falling back to REST");
            } catch (err) {
                log.warn({ err }, "Cache fetch failed, falling back to REST");
            }
        }
    }

    // Fall back to REST
    try {
        const rawBook = await fetchOrderBook(tokenId);

        if (!rawBook) {
            log.warn("REST returned null (market may be resolved)");
            return { book: null, source: null, stale: false };
        }

        const book = normalizeOrderBook(rawBook, "REST");

        log.debug({ source: "REST" }, "Got book from REST");

        // Update cache if we have one (opportunistic)
        if (cache && env.CLOB_BOOK_WS_ENABLED) {
            cache.update(book);
        }

        return { book, source: "REST", stale: false };
    } catch (err) {
        log.error({ err }, "REST fetch failed");
        return { book: null, source: null, stale: false };
    }
}

/**
 * Ensure a token is subscribed for WS updates.
 *
 * Call this when you know you'll need fresh data for a token soon.
 * This pre-warms the cache so subsequent getBook() calls are faster.
 */
export async function ensureSubscribed(tokenId: string): Promise<void> {
    if (!env.CLOB_BOOK_WS_ENABLED) {
        return;
    }

    await ensureWsInitialized();

    if (cache) {
        cache.ensureSubscribed(tokenId);
    }
}

/**
 * Detailed book service statistics for diagnostics.
 */
export interface BookServiceStats {
    wsEnabled: boolean;
    wsConnected: boolean;
    cacheSize: number;
    subscribedCount: number;
    freshCount: number;
    wsMetrics?: {
        connectCount: number;
        disconnectCount: number;
        messageCount: number;
        bookUpdateCount: number;
        errorCount: number;
        lastConnectedAt: number | null;
        lastDisconnectedAt: number | null;
        lastMessageAt: number | null;
    };
}

/**
 * Get cache statistics (for diagnostics).
 */
export function getBookServiceStats(): BookServiceStats {
    if (!cache) {
        return {
            wsEnabled: env.CLOB_BOOK_WS_ENABLED,
            wsConnected: false,
            cacheSize: 0,
            subscribedCount: 0,
            freshCount: 0,
        };
    }

    const cacheStats = cache.getStats();
    const wsStatus = wsClient?.getStatus();

    return {
        wsEnabled: env.CLOB_BOOK_WS_ENABLED,
        wsConnected: wsClient?.isConnected ?? false,
        cacheSize: cacheStats.size,
        subscribedCount: cacheStats.subscribedCount,
        freshCount: cacheStats.freshCount,
        wsMetrics: wsStatus?.metrics,
    };
}

/**
 * Stop the book service (for graceful shutdown).
 */
export async function stopBookService(): Promise<void> {
    if (wsClient) {
        wsClient.stop();
        wsClient = null;
    }

    if (cache) {
        cache.stop();
        cache = null;
    }

    wsInitialized = false;
    wsInitPromise = null;

    logger.info("Book service stopped");
}
