/**
 * CLOB WebSocket module for order book subscriptions.
 *
 * This module provides:
 * - OrderBookCache: In-memory cache with TTL/LRU eviction
 * - ClobBookWsClient: WebSocket client for real-time book updates
 */

export {
    OrderBookCache,
    getOrderBookCache,
    resetOrderBookCache,
    DEFAULT_CACHE_CONFIG,
    type OrderBookCacheConfig,
    type GetFreshOptions,
} from "./OrderBookCache.js";

export {
    ClobBookWsClient,
    getClobBookWsClient,
    resetClobBookWsClient,
    DEFAULT_WS_CONFIG,
    type ClobBookWsConfig,
} from "./ClobBookWsClient.js";
