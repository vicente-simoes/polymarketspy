/**
 * Polymarket CLOB WebSocket client for real-time order book updates.
 *
 * Connects to wss://ws-subscriptions-clob.polymarket.com/ws/market
 * and subscribes to order book updates for tokens requested by OrderBookCache.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Ping/pong heartbeat to keep connection alive
 * - Delta-based book updates (set price->size, size=0 removes level)
 * - Integration with OrderBookCache for snapshot storage
 */

import WebSocket from "ws";
import { createChildLogger } from "../log/logger.js";
import { OrderBookCache } from "./OrderBookCache.js";
import {
    normalizeOrderBook,
    priceToMicros,
    sharesToMicros,
    type NormalizedBook,
    type NormalizedLevel,
} from "../simulate/bookUtils.js";

const logger = createChildLogger({ module: "clob-book-ws" });

/**
 * WebSocket endpoint for Polymarket CLOB market channel.
 */
const WS_ENDPOINT = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/**
 * Client configuration.
 */
export interface ClobBookWsConfig {
    /** WebSocket endpoint URL. Default: Polymarket production */
    wsUrl: string;

    /** Initial reconnect backoff (ms). Default: 1000 */
    initialBackoffMs: number;

    /** Maximum reconnect backoff (ms). Default: 60000 */
    maxBackoffMs: number;

    /** Backoff multiplier. Default: 2 */
    backoffMultiplier: number;

    /** Ping interval (ms). Default: 10000 */
    pingIntervalMs: number;

    /** Connection timeout (ms). Default: 30000 */
    connectionTimeoutMs: number;

    /** Pong timeout - disconnect if no pong received (ms). Default: 5000 */
    pongTimeoutMs: number;
}

/**
 * Default client configuration.
 */
export const DEFAULT_WS_CONFIG: ClobBookWsConfig = {
    wsUrl: WS_ENDPOINT,
    initialBackoffMs: 1000,
    maxBackoffMs: 60_000,
    backoffMultiplier: 2,
    pingIntervalMs: 10_000,
    connectionTimeoutMs: 30_000,
    pongTimeoutMs: 5_000,
};

/**
 * In-memory book state for delta application.
 * Uses Map<price, size> to efficiently apply deltas.
 */
interface BookState {
    tokenId: string;
    bids: Map<number, bigint>; // priceMicros -> sizeMicros
    asks: Map<number, bigint>; // priceMicros -> sizeMicros
    lastUpdateAt: number;
}

/**
 * Message types from the WebSocket.
 */
interface WsBookMessage {
    event_type?: string;
    asset_id?: string;
    market?: string;
    hash?: string;
    timestamp?: string;
    bids?: Array<{ price: string; size: string }> | Record<string, string | number>;
    asks?: Array<{ price: string; size: string }> | Record<string, string | number>;
}

/**
 * CLOB Book WebSocket client.
 */
export class ClobBookWsClient {
    private config: ClobBookWsConfig;
    private cache: OrderBookCache;
    private ws: WebSocket | null = null;
    private isRunning = false;
    private currentBackoffMs: number;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private pongTimeout: NodeJS.Timeout | null = null;
    private awaitingPong = false;

    // In-memory book state for delta application
    private bookStates: Map<string, BookState> = new Map();

    // Pending subscriptions (requested while disconnected)
    private pendingSubscriptions: Set<string> = new Set();

    // Active subscriptions (confirmed subscribed)
    private activeSubscriptions: Set<string> = new Set();

    // Metrics
    private metrics = {
        connectCount: 0,
        disconnectCount: 0,
        messageCount: 0,
        bookUpdateCount: 0,
        errorCount: 0,
        lastConnectedAt: null as number | null,
        lastDisconnectedAt: null as number | null,
        lastMessageAt: null as number | null,
    };

    constructor(cache: OrderBookCache, config: Partial<ClobBookWsConfig> = {}) {
        this.config = { ...DEFAULT_WS_CONFIG, ...config };
        this.cache = cache;
        this.currentBackoffMs = this.config.initialBackoffMs;

        // Listen for subscription requests from cache
        this.cache.on("subscribe", (tokenId: string) => {
            this.subscribe(tokenId);
        });

        this.cache.on("unsubscribe", (tokenId: string) => {
            this.unsubscribe(tokenId);
        });
    }

    /**
     * Start the WebSocket client.
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn("CLOB Book WS client already running");
            return;
        }

        this.isRunning = true;
        logger.info({ wsUrl: this.config.wsUrl }, "Starting CLOB Book WebSocket client");

        await this.connect();
    }

    /**
     * Stop the WebSocket client.
     */
    stop(): void {
        this.isRunning = false;

        this.clearTimers();

        if (this.ws) {
            try {
                this.ws.close(1000, "Client stopping");
            } catch {
                // Ignore close errors
            }
            this.ws = null;
        }

        this.activeSubscriptions.clear();
        this.pendingSubscriptions.clear();
        this.bookStates.clear();

        logger.info("CLOB Book WebSocket client stopped");
    }

    /**
     * Check if connected.
     */
    get isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    /**
     * Get connection status and metrics for health checks.
     */
    getStatus(): {
        connected: boolean;
        activeSubscriptions: number;
        pendingSubscriptions: number;
        bookStates: number;
        metrics: {
            connectCount: number;
            disconnectCount: number;
            messageCount: number;
            bookUpdateCount: number;
            errorCount: number;
            lastConnectedAt: number | null;
            lastDisconnectedAt: number | null;
            lastMessageAt: number | null;
        };
    } {
        return {
            connected: this.isConnected,
            activeSubscriptions: this.activeSubscriptions.size,
            pendingSubscriptions: this.pendingSubscriptions.size,
            bookStates: this.bookStates.size,
            metrics: { ...this.metrics },
        };
    }

    /**
     * Subscribe to a token's order book.
     */
    subscribe(tokenId: string): void {
        if (this.activeSubscriptions.has(tokenId)) {
            return; // Already subscribed
        }

        if (!this.isConnected) {
            // Queue for when we reconnect
            this.pendingSubscriptions.add(tokenId);
            logger.debug({ tokenId }, "Queued subscription (not connected)");
            return;
        }

        this.sendSubscribe([tokenId]);
        this.activeSubscriptions.add(tokenId);
        this.pendingSubscriptions.delete(tokenId);
    }

    /**
     * Unsubscribe from a token's order book.
     */
    unsubscribe(tokenId: string): void {
        this.pendingSubscriptions.delete(tokenId);

        if (!this.activeSubscriptions.has(tokenId)) {
            return; // Not subscribed
        }

        this.activeSubscriptions.delete(tokenId);
        this.bookStates.delete(tokenId);

        if (this.isConnected) {
            this.sendUnsubscribe([tokenId]);
        }
    }

    /**
     * Connect to the WebSocket.
     */
    private async connect(): Promise<void> {
        logger.info("Connecting to CLOB Book WebSocket...");

        try {
            await this.createConnection();

            // Reset backoff on successful connection
            this.currentBackoffMs = this.config.initialBackoffMs;

            // Update metrics
            this.metrics.connectCount++;
            this.metrics.lastConnectedAt = Date.now();

            // Send initial subscription for tokens from cache
            const tokensToSubscribe = [
                ...this.cache.getSubscribedTokenIds(),
                ...this.pendingSubscriptions,
            ];

            if (tokensToSubscribe.length > 0) {
                this.sendInitialSubscription(tokensToSubscribe);
                for (const tokenId of tokensToSubscribe) {
                    this.activeSubscriptions.add(tokenId);
                }
                this.pendingSubscriptions.clear();
            }

            // Start ping interval
            this.startPingInterval();

            logger.info(
                { subscriptions: this.activeSubscriptions.size },
                "CLOB Book WebSocket connected"
            );
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error({ err: errorMessage }, "Failed to connect to CLOB Book WebSocket");

            if (this.isRunning) {
                this.scheduleReconnect();
            }
        }
    }

    /**
     * Create the WebSocket connection.
     */
    private createConnection(): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeout: NodeJS.Timeout | null = null;

            const ws = new WebSocket(this.config.wsUrl);
            this.ws = ws;

            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                fn();
            };

            ws.on("open", () => {
                settle(() => resolve());
            });

            ws.on("error", (err) => {
                if (!settled) {
                    settle(() => reject(err));
                    return;
                }
                logger.error({ err: err.message }, "WebSocket error");
                this.handleDisconnect();
            });

            ws.on("close", (code, reason) => {
                if (!settled) {
                    settle(() => reject(new Error(`WebSocket closed: ${code} ${reason}`)));
                    return;
                }
                logger.warn({ code, reason: reason.toString() }, "WebSocket closed");
                this.handleDisconnect();
            });

            ws.on("message", (data) => {
                this.handleMessage(data);
            });

            ws.on("pong", () => {
                this.handlePong();
            });

            // Connection timeout
            timeout = setTimeout(() => {
                settle(() => {
                    try {
                        ws.close();
                    } catch {
                        // Ignore
                    }
                    reject(new Error("Connection timeout"));
                });
            }, this.config.connectionTimeoutMs);
        });
    }

    /**
     * Handle disconnection.
     */
    private handleDisconnect(): void {
        this.clearTimers();

        // Update metrics
        this.metrics.disconnectCount++;
        this.metrics.lastDisconnectedAt = Date.now();

        // Move active subscriptions to pending for resubscription
        for (const tokenId of this.activeSubscriptions) {
            this.pendingSubscriptions.add(tokenId);
        }
        this.activeSubscriptions.clear();

        this.ws = null;

        if (this.isRunning) {
            this.scheduleReconnect();
        }
    }

    /**
     * Schedule a reconnection attempt.
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        // Add jitter
        const jitter = this.currentBackoffMs * 0.1 * (Math.random() - 0.5);
        const actualBackoff = Math.floor(this.currentBackoffMs + jitter);

        logger.info({ backoffMs: actualBackoff }, "Scheduling reconnect");

        this.reconnectTimeout = setTimeout(async () => {
            this.reconnectTimeout = null;
            await this.connect();
        }, actualBackoff);

        // Increase backoff for next attempt
        this.currentBackoffMs = Math.min(
            this.currentBackoffMs * this.config.backoffMultiplier,
            this.config.maxBackoffMs
        );
    }

    /**
     * Clear all timers.
     */
    private clearTimers(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    /**
     * Start the ping interval.
     */
    private startPingInterval(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }

        this.pingInterval = setInterval(() => {
            this.sendPing();
        }, this.config.pingIntervalMs);

        // Don't block process exit
        this.pingInterval.unref();
    }

    /**
     * Send a ping.
     */
    private sendPing(): void {
        if (!this.isConnected || this.awaitingPong) {
            return;
        }

        try {
            this.ws!.send("PING");
            this.awaitingPong = true;

            // Set pong timeout
            this.pongTimeout = setTimeout(() => {
                logger.warn("Pong timeout - reconnecting");
                this.awaitingPong = false;
                this.handleDisconnect();
            }, this.config.pongTimeoutMs);
        } catch (err) {
            logger.error({ err }, "Failed to send ping");
        }
    }

    /**
     * Handle pong response.
     */
    private handlePong(): void {
        this.awaitingPong = false;
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    /**
     * Send initial subscription message.
     */
    private sendInitialSubscription(tokenIds: string[]): void {
        if (!this.isConnected || tokenIds.length === 0) return;

        const message = {
            assets_ids: tokenIds,
            type: "market",
        };

        try {
            this.ws!.send(JSON.stringify(message));
            logger.debug({ count: tokenIds.length }, "Sent initial subscription");
        } catch (err) {
            logger.error({ err }, "Failed to send initial subscription");
        }
    }

    /**
     * Send subscribe message for additional tokens.
     */
    private sendSubscribe(tokenIds: string[]): void {
        if (!this.isConnected || tokenIds.length === 0) return;

        const message = {
            assets_ids: tokenIds,
            operation: "subscribe",
        };

        try {
            this.ws!.send(JSON.stringify(message));
            logger.debug({ count: tokenIds.length }, "Sent subscribe");
        } catch (err) {
            logger.error({ err }, "Failed to send subscribe");
        }
    }

    /**
     * Send unsubscribe message.
     */
    private sendUnsubscribe(tokenIds: string[]): void {
        if (!this.isConnected || tokenIds.length === 0) return;

        const message = {
            assets_ids: tokenIds,
            operation: "unsubscribe",
        };

        try {
            this.ws!.send(JSON.stringify(message));
            logger.debug({ count: tokenIds.length }, "Sent unsubscribe");
        } catch (err) {
            logger.error({ err }, "Failed to send unsubscribe");
        }
    }

    /**
     * Handle incoming WebSocket message.
     */
    private handleMessage(data: WebSocket.RawData): void {
        this.metrics.messageCount++;
        this.metrics.lastMessageAt = Date.now();

        try {
            const messageStr = data.toString();

            // Handle PONG response (some servers send text PONG)
            if (messageStr === "PONG" || messageStr === "pong") {
                this.handlePong();
                return;
            }

            const message = JSON.parse(messageStr) as WsBookMessage;
            this.processBookMessage(message);
        } catch (err) {
            this.metrics.errorCount++;
            logger.error({ err, data: data.toString().slice(0, 200) }, "Failed to parse WS message");
        }
    }

    /**
     * Process a book update message.
     */
    private processBookMessage(message: WsBookMessage): void {
        // Get token ID from message
        const tokenId = message.asset_id ?? message.market;
        if (!tokenId) {
            logger.debug({ message }, "Message without token ID");
            return;
        }

        // Get or create book state
        let state = this.bookStates.get(tokenId);
        const isFirstMessage = !state;
        if (!state) {
            state = {
                tokenId,
                bids: new Map(),
                asks: new Map(),
                lastUpdateAt: 0,
            };
            this.bookStates.set(tokenId, state);

            // Log first message for debugging (helps verify message format)
            logger.info(
                {
                    tokenId,
                    eventType: message.event_type,
                    bidCount: message.bids ? (Array.isArray(message.bids) ? message.bids.length : Object.keys(message.bids).length) : 0,
                    askCount: message.asks ? (Array.isArray(message.asks) ? message.asks.length : Object.keys(message.asks).length) : 0,
                    hasTimestamp: !!message.timestamp,
                    hasHash: !!message.hash,
                },
                "First book message received for token"
            );
        }

        // Apply bid updates
        if (message.bids) {
            this.applyLevelUpdates(state.bids, message.bids);
        }

        // Apply ask updates
        if (message.asks) {
            this.applyLevelUpdates(state.asks, message.asks);
        }

        state.lastUpdateAt = Date.now();

        // Update metrics
        this.metrics.bookUpdateCount++;

        // Convert to NormalizedBook and update cache
        const normalizedBook = this.stateToNormalizedBook(state);
        this.cache.update(normalizedBook);

        // Log periodically or on first meaningful update
        if (isFirstMessage || this.metrics.bookUpdateCount % 100 === 0) {
            logger.debug(
                {
                    tokenId,
                    bidLevels: normalizedBook.bids.length,
                    askLevels: normalizedBook.asks.length,
                    bestBid: normalizedBook.bestBidMicros / 1_000_000,
                    bestAsk: normalizedBook.bestAskMicros / 1_000_000,
                    spread: normalizedBook.spreadMicros / 1_000_000,
                    updateCount: this.metrics.bookUpdateCount,
                },
                "Book state updated"
            );
        }
    }

    /**
     * Apply level updates to a bid or ask map.
     * Handles both array format and object format.
     */
    private applyLevelUpdates(
        levels: Map<number, bigint>,
        updates: Array<{ price: string; size: string }> | Record<string, string | number>
    ): void {
        if (Array.isArray(updates)) {
            // Array format: [{price: "0.5", size: "100"}, ...]
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
            // Object format: {"0.5": 100, "0.6": 200, ...}
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

    /**
     * Convert internal book state to NormalizedBook.
     */
    private stateToNormalizedBook(state: BookState): NormalizedBook {
        // Convert maps to sorted arrays
        const bids: NormalizedLevel[] = [];
        const asks: NormalizedLevel[] = [];

        for (const [priceMicros, sizeMicros] of state.bids.entries()) {
            if (sizeMicros > BigInt(0) && priceMicros > 0 && priceMicros < 1_000_000) {
                bids.push({ priceMicros, sizeMicros });
            }
        }

        for (const [priceMicros, sizeMicros] of state.asks.entries()) {
            if (sizeMicros > BigInt(0) && priceMicros > 0 && priceMicros < 1_000_000) {
                asks.push({ priceMicros, sizeMicros });
            }
        }

        // Sort: bids descending, asks ascending
        bids.sort((a, b) => b.priceMicros - a.priceMicros);
        asks.sort((a, b) => a.priceMicros - b.priceMicros);

        // Compute best bid/ask
        const bestBidMicros = bids.length > 0 ? bids[0]!.priceMicros : 0;
        const bestAskMicros = asks.length > 0 ? asks[0]!.priceMicros : 1_000_000;
        const midPriceMicros = Math.round((bestBidMicros + bestAskMicros) / 2);
        const spreadMicros = bestAskMicros - bestBidMicros;

        return {
            tokenId: state.tokenId,
            bids,
            asks,
            bestBidMicros,
            bestAskMicros,
            midPriceMicros,
            spreadMicros,
            updatedAt: state.lastUpdateAt,
            source: "WS",
        };
    }
}

/**
 * Singleton instance.
 */
let instance: ClobBookWsClient | null = null;

/**
 * Get the singleton ClobBookWsClient.
 */
export function getClobBookWsClient(
    cache: OrderBookCache,
    config?: Partial<ClobBookWsConfig>
): ClobBookWsClient {
    if (!instance) {
        instance = new ClobBookWsClient(cache, config);
    }
    return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetClobBookWsClient(): void {
    if (instance) {
        instance.stop();
        instance = null;
    }
}
