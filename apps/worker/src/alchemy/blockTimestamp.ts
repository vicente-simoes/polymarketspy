/**
 * Block timestamp fetching with caching.
 *
 * Fetches block timestamps from the RPC provider and caches them
 * to minimize RPC calls. Used to set accurate eventTime for WS trades.
 */

import { JsonRpcProvider } from "ethers";
import { env } from "../config/env.js";
import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "block-timestamp" });

// Cache: blockNumber -> timestamp (as Date)
// Bounded to prevent unbounded memory growth
const CACHE_MAX_SIZE = 1000;
const cache = new Map<number, Date>();

// Derive HTTP URL from WebSocket URL
// wss://polygon-mainnet.g.alchemy.com/v2/KEY -> https://polygon-mainnet.g.alchemy.com/v2/KEY
function deriveHttpUrl(wsUrl: string): string {
    return wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

// Lazy-initialized provider (created on first use)
let httpProvider: JsonRpcProvider | null = null;

function getProvider(): JsonRpcProvider {
    if (!httpProvider) {
        const httpUrl = deriveHttpUrl(env.ALCHEMY_WS_URL);
        httpProvider = new JsonRpcProvider(httpUrl, 137, { staticNetwork: true });
        logger.debug("Initialized HTTP provider for block timestamp lookups");
    }
    return httpProvider;
}

/**
 * Prune oldest entries if cache exceeds max size.
 * Simple FIFO eviction (Map maintains insertion order).
 */
function pruneCache(): void {
    if (cache.size <= CACHE_MAX_SIZE) return;

    const toDelete = cache.size - CACHE_MAX_SIZE;
    const keys = cache.keys();
    for (let i = 0; i < toDelete; i++) {
        const key = keys.next().value;
        if (key !== undefined) {
            cache.delete(key);
        }
    }
}

/**
 * Get block timestamp with caching.
 *
 * @param blockNumber - The block number to get timestamp for
 * @returns The block timestamp as a Date, or null on failure
 */
export async function getBlockTimestamp(blockNumber: number): Promise<Date | null> {
    // Check cache first
    const cached = cache.get(blockNumber);
    if (cached) {
        return cached;
    }

    try {
        const provider = getProvider();
        const block = await provider.getBlock(blockNumber);

        if (!block) {
            logger.warn({ blockNumber }, "Block not found");
            return null;
        }

        // block.timestamp is in seconds (Unix epoch)
        const timestamp = new Date(block.timestamp * 1000);

        // Store in cache
        cache.set(blockNumber, timestamp);
        pruneCache();

        logger.debug({ blockNumber, timestamp: timestamp.toISOString() }, "Fetched block timestamp");
        return timestamp;
    } catch (err) {
        logger.error({ err, blockNumber }, "Failed to fetch block timestamp");
        return null;
    }
}

/**
 * Get block timestamp with fallback to detectTime.
 *
 * @param blockNumber - The block number to get timestamp for
 * @param fallback - Fallback date to use if fetch fails
 * @returns The block timestamp or fallback
 */
export async function getBlockTimestampOrFallback(
    blockNumber: number,
    fallback: Date
): Promise<Date> {
    const timestamp = await getBlockTimestamp(blockNumber);
    if (timestamp) {
        return timestamp;
    }
    logger.warn({ blockNumber }, "Using fallback detectTime for eventTime");
    return fallback;
}

/**
 * Clear the cache (for testing).
 */
export function clearBlockTimestampCache(): void {
    cache.clear();
}

/**
 * Get cache stats (for monitoring).
 */
export function getBlockTimestampCacheStats(): { size: number; maxSize: number } {
    return { size: cache.size, maxSize: CACHE_MAX_SIZE };
}
