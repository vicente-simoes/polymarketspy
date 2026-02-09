/**
 * Polymarket User Channel WebSocket Client
 *
 * Connects to wss://ws-subscriptions-clob.polymarket.com/ws/user
 * to receive real-time order and trade updates for authenticated user.
 *
 * Features:
 * - Order status updates (placement, partial fill, cancellation)
 * - Trade/fill updates (matched, mined, confirmed, failed)
 * - Orphan buffer for fills that arrive before order is stored
 * - Ledger entry writing on CONFIRMED fills
 * - Account state updates
 * - Automatic reconnection with exponential backoff
 */

import WebSocket from "ws";
import { LedgerEntryType, LiveOrderStatus, PortfolioScope, TradingMode } from "@prisma/client";
import { createChildLogger } from "../log/logger.js";
import { prisma } from "../db/prisma.js";
import { createLedgerEntryIfNotExistsAndUpdateCaches } from "../db/ledger.js";
import { getApiCredentials, type ApiKeyCreds } from "./clobClient.js";
import { applyFill } from "./accountState.js";

const logger = createChildLogger({ module: "user-channel-ws" });

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";

// Reconnection
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;

// Heartbeat
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 5_000;
const CONNECTION_TIMEOUT_MS = 30_000;

// Orphan buffer
const ORPHAN_TTL_MS = 30_000;
const ORPHAN_CLEANUP_INTERVAL_MS = 5_000;

// ─── Message Types ────────────────────────────────────────────────────────────

interface OrderMessage {
    event_type: "order";
    id: string; // clobOrderId
    type: "PLACEMENT" | "UPDATE" | "CANCELLATION";
    asset_id: string; // tokenId
    market: string; // conditionId
    side: "BUY" | "SELL";
    price: string;
    original_size: string;
    size_matched: string;
    status: string;
    associate_trades?: string[]; // linked trade IDs
    timestamp: string;
}

interface TradeMessage {
    event_type: "trade";
    id: string; // tradeId (unique)
    status: "MATCHED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED";
    asset_id: string; // tokenId
    side: "BUY" | "SELL";
    price: string;
    size: string;
    fee?: string;
    taker_order_id: string;
    maker_orders: Array<{
        order_id: string;
        matched_amount: string;
    }>;
    timestamp: string;
}

interface SubscribedMessage {
    type: "subscribed";
    channel: string;
}

type UserChannelMessage = OrderMessage | TradeMessage | SubscribedMessage;

// ─── Orphan Buffer Types ──────────────────────────────────────────────────────

interface OrphanTrade {
    trade: TradeMessage;
    receivedAt: number;
    retryCount: number;
}

// ─── Module State ─────────────────────────────────────────────────────────────

// Connection state
let ws: WebSocket | null = null;
let isConnected = false;
let isAuthenticated = false;
let isRunning = false;

// Reconnection
let reconnectTimeout: NodeJS.Timeout | null = null;
let currentBackoffMs = INITIAL_BACKOFF_MS;

// Heartbeat
let pingInterval: NodeJS.Timeout | null = null;
let pongTimeout: NodeJS.Timeout | null = null;
let awaitingPong = false;

// Orphan buffer (fills that arrive before order is stored)
const orphanTrades = new Map<string, OrphanTrade>(); // keyed by clobOrderId
let orphanCleanupInterval: NodeJS.Timeout | null = null;

// Metrics
const metrics = {
    connectCount: 0,
    disconnectCount: 0,
    messageCount: 0,
    orderUpdateCount: 0,
    tradeUpdateCount: 0,
    errorCount: 0,
    orphanBufferSize: 0,
    lastConnectedAt: null as number | null,
    lastMessageAt: null as number | null,
};

// ─── Unit Conversion ──────────────────────────────────────────────────────────

function decimalToPriceMicros(decimal: string): number {
    return Math.round(parseFloat(decimal) * 1_000_000);
}

function decimalToShareMicros(decimal: string): bigint {
    return BigInt(Math.round(parseFloat(decimal) * 1_000_000));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the user channel WebSocket (call after CLOB client init).
 */
export async function startUserChannel(): Promise<boolean> {
    if (isRunning) {
        logger.warn("User channel already running");
        return true;
    }

    const creds = getApiCredentials();
    if (!creds) {
        logger.warn("Cannot start user channel: CLOB client not initialized");
        return false;
    }

    isRunning = true;
    logger.info("Starting user channel WebSocket");

    // Start orphan cleanup interval
    startOrphanCleanup();

    try {
        await connect(creds);
        return true;
    } catch (err) {
        logger.error({ err }, "Failed to start user channel");
        scheduleReconnect();
        return false;
    }
}

/**
 * Stop the user channel WebSocket.
 */
export function stopUserChannel(): void {
    isRunning = false;
    clearTimers();

    if (ws) {
        try {
            ws.close(1000, "Client stopping");
        } catch {
            // Ignore close errors
        }
        ws = null;
    }

    isConnected = false;
    isAuthenticated = false;
    orphanTrades.clear();

    logger.info("User channel WebSocket stopped");
}

/**
 * Check if connected and authenticated.
 */
export function isUserChannelConnected(): boolean {
    return isConnected && isAuthenticated;
}

/**
 * Get metrics for health endpoint.
 */
export function getUserChannelMetrics(): typeof metrics {
    return { ...metrics, orphanBufferSize: orphanTrades.size };
}

// ─── Connection Management ────────────────────────────────────────────────────

async function connect(creds: ApiKeyCreds): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let connectionTimeout: NodeJS.Timeout | null = null;

        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            if (connectionTimeout) {
                clearTimeout(connectionTimeout);
                connectionTimeout = null;
            }
            fn();
        };

        logger.info("Connecting to user channel WebSocket...");
        ws = new WebSocket(WS_URL);

        ws.on("open", () => {
            isConnected = true;
            metrics.connectCount++;
            metrics.lastConnectedAt = Date.now();
            logger.info("User channel connected, sending auth");

            sendAuth(creds);
            startPingLoop();
            settle(() => resolve());
        });

        ws.on("message", (data) => {
            handleMessage(data);
        });

        ws.on("close", (code, reason) => {
            if (!settled) {
                settle(() => reject(new Error(`WebSocket closed: ${code} ${reason}`)));
                return;
            }
            handleClose(code, reason);
        });

        ws.on("error", (err) => {
            if (!settled) {
                settle(() => reject(err));
                return;
            }
            logger.error({ err: err.message }, "WebSocket error");
            metrics.errorCount++;
        });

        ws.on("pong", () => {
            awaitingPong = false;
            if (pongTimeout) {
                clearTimeout(pongTimeout);
                pongTimeout = null;
            }
        });

        // Connection timeout
        connectionTimeout = setTimeout(() => {
            settle(() => {
                try {
                    ws?.close();
                } catch {
                    // Ignore
                }
                reject(new Error("Connection timeout"));
            });
        }, CONNECTION_TIMEOUT_MS);
    });
}

function sendAuth(creds: ApiKeyCreds): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const authPayload = {
        type: "subscribe",
        channel: "user",
        auth: {
            apiKey: creds.key,
            secret: creds.secret,
            passphrase: creds.passphrase,
        },
    };

    try {
        ws.send(JSON.stringify(authPayload));
        logger.debug("Sent auth payload");
    } catch (err) {
        logger.error({ err }, "Failed to send auth");
    }
}

function handleClose(code: number, reason: Buffer): void {
    isConnected = false;
    isAuthenticated = false;
    metrics.disconnectCount++;

    clearTimers();

    logger.info({ code, reason: reason.toString() }, "User channel disconnected");

    if (isRunning) {
        scheduleReconnect();
    }
}

function scheduleReconnect(): void {
    if (reconnectTimeout) return;

    const jitter = currentBackoffMs * 0.1 * (Math.random() - 0.5);
    const delay = Math.floor(currentBackoffMs + jitter);

    logger.info({ delayMs: delay }, "Scheduling reconnect");

    reconnectTimeout = setTimeout(async () => {
        reconnectTimeout = null;
        currentBackoffMs = Math.min(currentBackoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);

        const creds = getApiCredentials();
        if (creds && isRunning) {
            try {
                await connect(creds);
            } catch {
                scheduleReconnect();
            }
        }
    }, delay);
}

function clearTimers(): void {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
    }
    if (orphanCleanupInterval) {
        clearInterval(orphanCleanupInterval);
        orphanCleanupInterval = null;
    }
    awaitingPong = false;
}

function startPingLoop(): void {
    if (pingInterval) {
        clearInterval(pingInterval);
    }

    pingInterval = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        if (awaitingPong) {
            logger.warn("Pong timeout, disconnecting");
            ws.close();
            return;
        }

        awaitingPong = true;
        ws.ping();

        pongTimeout = setTimeout(() => {
            if (awaitingPong) {
                logger.warn("Pong not received in time");
                ws?.close();
            }
        }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    // Don't block process exit
    pingInterval.unref();
}

// ─── Message Handling ─────────────────────────────────────────────────────────

function handleMessage(data: WebSocket.RawData): void {
    metrics.messageCount++;
    metrics.lastMessageAt = Date.now();

    try {
        const messageStr = data.toString();

        // Handle text PONG
        if (messageStr === "PONG" || messageStr === "pong") {
            awaitingPong = false;
            if (pongTimeout) {
                clearTimeout(pongTimeout);
                pongTimeout = null;
            }
            return;
        }

        const msg = JSON.parse(messageStr) as UserChannelMessage;

        // Check for auth confirmation
        if ("type" in msg && msg.type === "subscribed") {
            isAuthenticated = true;
            currentBackoffMs = INITIAL_BACKOFF_MS; // Reset backoff on success
            logger.info({ channel: msg.channel }, "User channel authenticated");
            return;
        }

        if ("event_type" in msg) {
            if (msg.event_type === "order") {
                handleOrderUpdate(msg).catch((err) => {
                    logger.error({ err }, "Error handling order update");
                    metrics.errorCount++;
                });
            } else if (msg.event_type === "trade") {
                handleTradeUpdate(msg).catch((err) => {
                    logger.error({ err }, "Error handling trade update");
                    metrics.errorCount++;
                });
            }
        }
    } catch (err) {
        logger.error({ err, data: data.toString().slice(0, 200) }, "Failed to parse message");
        metrics.errorCount++;
    }
}

// ─── Order Update Handler ─────────────────────────────────────────────────────

async function handleOrderUpdate(msg: OrderMessage): Promise<void> {
    metrics.orderUpdateCount++;
    const log = logger.child({ clobOrderId: msg.id, type: msg.type });

    try {
        const status = mapOrderStatus(msg.status);
        const filledShareMicros = decimalToShareMicros(msg.size_matched);

        const existing = await prisma.liveOrder.findUnique({
            where: { clobOrderId: msg.id },
            select: { id: true },
        });

        if (existing) {
            await prisma.liveOrder.update({
                where: { id: existing.id },
                data: {
                    status,
                    filledShareMicros,
                    lastUpdateAt: new Date(),
                    ...(isFinalStatus(status) ? { finalizedAt: new Date() } : {}),
                },
            });

            log.debug({ status, filledShareMicros: filledShareMicros.toString() }, "Order updated");

            // Opportunistic relink: if we persisted trades before we had the order,
            // attach them now using clobOrderId.
            await prisma.liveFill.updateMany({
                where: {
                    clobOrderId: msg.id,
                    liveOrderId: null,
                },
                data: {
                    liveOrderId: existing.id,
                    origin: "APP",
                },
            });

            // Process any orphaned trades for this order
            await processOrphanTrades(msg.id);
        } else {
            log.debug("Order not found in DB (may be external or not yet stored)");
        }
    } catch (err) {
        log.error({ err }, "Failed to handle order update");
        metrics.errorCount++;
    }
}

function mapOrderStatus(status: string): LiveOrderStatus {
    const mapping: Record<string, LiveOrderStatus> = {
        LIVE: "OPEN",
        OPEN: "OPEN",
        MATCHED: "PARTIAL",
        FILLED: "FILLED",
        CANCELLED: "CANCELED",
        CANCELED: "CANCELED",
        REJECTED: "REJECTED",
    };
    return mapping[status.toUpperCase()] || "OPEN";
}

function isFinalStatus(status: LiveOrderStatus): boolean {
    return ["FILLED", "CANCELED", "REJECTED", "FAILED"].includes(status);
}

// ─── Trade/Fill Handler ───────────────────────────────────────────────────────

async function handleTradeUpdate(msg: TradeMessage): Promise<void> {
    metrics.tradeUpdateCount++;
    const log = logger.child({ tradeId: msg.id, status: msg.status });

    try {
        // Find which of our orders this fill belongs to
        const matchResult = await findMatchingOrder(msg);

        if (!matchResult) {
            // Persist immediately as EXTERNAL (or pre-link), then buffer for later linking.
            const primaryOrderId =
                msg.taker_order_id || msg.maker_orders[0]?.order_id || null;
            await processFill(msg, primaryOrderId, null, { unmatchedAtReceipt: true });
            bufferOrphanTrade(msg);
            log.debug("Trade persisted as EXTERNAL and buffered for later linking");
            return;
        }

        await processFill(msg, matchResult.clobOrderId, matchResult.liveOrderId);
    } catch (err) {
        log.error({ err }, "Failed to handle trade update");
        metrics.errorCount++;
    }
}

async function findMatchingOrder(
    msg: TradeMessage
): Promise<{ clobOrderId: string; liveOrderId: string } | null> {
    // Check if we're the taker
    const takerOrder = await prisma.liveOrder.findUnique({
        where: { clobOrderId: msg.taker_order_id },
        select: { id: true, clobOrderId: true },
    });
    if (takerOrder && takerOrder.clobOrderId) {
        return { clobOrderId: takerOrder.clobOrderId, liveOrderId: takerOrder.id };
    }

    // Check if we're a maker
    for (const maker of msg.maker_orders) {
        const makerOrder = await prisma.liveOrder.findUnique({
            where: { clobOrderId: maker.order_id },
            select: { id: true, clobOrderId: true },
        });
        if (makerOrder && makerOrder.clobOrderId) {
            return { clobOrderId: makerOrder.clobOrderId, liveOrderId: makerOrder.id };
        }
    }

    return null;
}

async function processFill(
    msg: TradeMessage,
    clobOrderId: string | null,
    liveOrderId: string | null,
    extraContext?: Record<string, unknown>
): Promise<void> {
    const log = logger.child({ tradeId: msg.id, status: msg.status, ...extraContext });
    const priceMicros = decimalToPriceMicros(msg.price);
    const shareMicros = decimalToShareMicros(msg.size);
    const notionalMicros = (shareMicros * BigInt(priceMicros)) / 1_000_000n;
    const feeMicros = msg.fee ? decimalToShareMicros(msg.fee) : null;

    // Determine origin (APP if linked to our order, EXTERNAL otherwise)
    const origin = liveOrderId ? "APP" : "EXTERNAL";

    // Get LiveOrder details for ledger entry
    const liveOrder = liveOrderId
        ? await prisma.liveOrder.findUnique({
              where: { id: liveOrderId },
              select: {
                  id: true,
                  followedUserId: true,
                  tokenId: true,
                  side: true,
                  idempotencyKey: true,
                  sizeShareMicros: true,
                  status: true,
                  filledShareMicros: true,
                  filledNotionalMicros: true,
              },
          })
        : null;

    // Upsert LiveFill (idempotent by tradeId)
    const fill = await prisma.liveFill.upsert({
        where: { tradeId: msg.id },
        create: {
            tradeId: msg.id,
            liveOrderId: liveOrder?.id ?? null,
            origin,
            clobOrderId,
            tokenId: msg.asset_id,
            side: msg.side,
            matchedAt: new Date(msg.timestamp),
            priceMicros,
            shareMicros,
            notionalMicros,
            feeMicros,
            status: msg.status,
        },
        update: {
            status: msg.status,
            ...(liveOrder?.id
                ? {
                      liveOrderId: liveOrder.id,
                      origin: "APP",
                  }
                : {}),
            ...(clobOrderId ? { clobOrderId } : {}),
        },
    });

    log.debug({ fillId: fill.id, status: msg.status, origin }, "Fill upserted");

    // Write ledger entry ONLY on CONFIRMED
    if (msg.status === "CONFIRMED") {
        await writeLedgerEntry(fill, liveOrder, msg);
        await updateLiveOrderAggregatesOnConfirmedFill(liveOrder);
        await updateAccountState(msg, liveOrder);
        log.info({ fillId: fill.id }, "Fill confirmed, ledger written");
    }

    // If FAILED, mark fill and don't ledger
    if (msg.status === "FAILED") {
        await prisma.liveFill.update({
            where: { id: fill.id },
            data: { status: "FAILED" },
        });
        log.warn({ fillId: fill.id }, "Fill failed");
    }
}

async function updateLiveOrderAggregatesOnConfirmedFill(
    liveOrder: (OrderData & { sizeShareMicros: bigint; status: LiveOrderStatus; filledShareMicros: bigint }) | null
): Promise<void> {
    if (!liveOrder) return;

    // Compute confirmed fill aggregates from the DB (idempotent, avoids double-counting).
    const aggregates = await prisma.liveFill.aggregate({
        where: {
            liveOrderId: liveOrder.id,
            status: "CONFIRMED",
        },
        _sum: {
            shareMicros: true,
            notionalMicros: true,
        },
    });

    const confirmedShareMicros = aggregates._sum.shareMicros ?? 0n;
    const confirmedNotionalMicros = aggregates._sum.notionalMicros ?? 0n;
    const avgFillPriceMicros =
        confirmedShareMicros > 0n
            ? Number((confirmedNotionalMicros * 1_000_000n) / confirmedShareMicros)
            : null;

    // Do not override final statuses based solely on fills.
    const isFinal = ["FILLED", "CANCELED", "REJECTED", "FAILED"].includes(liveOrder.status);
    const shouldMarkFilled =
        !isFinal && liveOrder.filledShareMicros >= liveOrder.sizeShareMicros;

    await prisma.liveOrder.update({
        where: { id: liveOrder.id },
        data: {
            filledNotionalMicros: confirmedNotionalMicros,
            avgFillPriceMicros: avgFillPriceMicros,
            ...(shouldMarkFilled ? { status: "FILLED", finalizedAt: new Date() } : {}),
            lastUpdateAt: new Date(),
        },
    });
}

// ─── Ledger Entry Writing ─────────────────────────────────────────────────────

interface FillData {
    id: string;
    tradeId: string;
    tokenId: string;
    priceMicros: number;
    shareMicros: bigint;
    notionalMicros: bigint;
    feeMicros: bigint | null;
}

interface OrderData {
    id: string;
    followedUserId: string | null;
    tokenId: string;
    side: "BUY" | "SELL";
    idempotencyKey: string;
}

async function writeLedgerEntry(
    fill: FillData,
    liveOrder: OrderData | null,
    msg: TradeMessage
): Promise<void> {
    const isBuy = msg.side === "BUY";
    const shareDelta = isBuy ? fill.shareMicros : -fill.shareMicros;
    const cashDelta = isBuy
        ? -(fill.notionalMicros + (fill.feeMicros ?? 0n))
        : fill.notionalMicros - (fill.feeMicros ?? 0n);

    await prisma.$transaction(async (tx) => {
        await createLedgerEntryIfNotExistsAndUpdateCaches(tx, {
            tradingMode: TradingMode.LIVE,
            portfolioScope: PortfolioScope.EXEC_GLOBAL,
            followedUserId: liveOrder?.followedUserId ?? null,
            marketId: null, // Could enrich from token metadata if needed
            assetId: fill.tokenId,
            entryType: LedgerEntryType.TRADE_FILL,
            refId: fill.tradeId,
            shareDeltaMicros: shareDelta,
            cashDeltaMicros: cashDelta,
            priceMicros: fill.priceMicros,
        });
    });
}

// ─── Account State Updates ────────────────────────────────────────────────────

async function updateAccountState(
    msg: TradeMessage,
    liveOrder: OrderData | null
): Promise<void> {
    const shareMicros = decimalToShareMicros(msg.size);
    const priceMicros = decimalToPriceMicros(msg.price);
    const notionalMicros = (shareMicros * BigInt(priceMicros)) / 1_000_000n;
    const feeMicros = msg.fee ? decimalToShareMicros(msg.fee) : null;

    // Apply fill to account state (notionalMicros is always positive; side determines sign)
    // If this was our order, use idempotencyKey to release the reservation.
    applyFill(
        msg.asset_id,
        msg.side,
        shareMicros,
        notionalMicros,
        feeMicros,
        liveOrder?.idempotencyKey
    );
}

// ─── Orphan Trade Buffer ──────────────────────────────────────────────────────

function bufferOrphanTrade(msg: TradeMessage): void {
    const orphan: OrphanTrade = {
        trade: msg,
        receivedAt: Date.now(),
        retryCount: 0,
    };

    // Buffer by taker order ID
    orphanTrades.set(msg.taker_order_id, orphan);

    // Also buffer by maker order IDs
    for (const maker of msg.maker_orders) {
        orphanTrades.set(maker.order_id, orphan);
    }

    logger.debug(
        { tradeId: msg.id, takerOrderId: msg.taker_order_id, makerCount: msg.maker_orders.length },
        "Buffered orphan trade"
    );
}

async function processOrphanTrades(clobOrderId: string): Promise<void> {
    const orphan = orphanTrades.get(clobOrderId);
    if (!orphan) return;

    // Clean up all entries for this trade
    orphanTrades.delete(orphan.trade.taker_order_id);
    for (const maker of orphan.trade.maker_orders) {
        orphanTrades.delete(maker.order_id);
    }

    // Find the order again (it should exist now)
    const matchResult = await findMatchingOrder(orphan.trade);
    if (!matchResult) {
        logger.warn({ tradeId: orphan.trade.id }, "Orphan trade still has no matching order");
        return;
    }

    // Reprocess the trade
    await processFill(orphan.trade, matchResult.clobOrderId, matchResult.liveOrderId, { wasOrphan: true });
}

function startOrphanCleanup(): void {
    if (orphanCleanupInterval) {
        clearInterval(orphanCleanupInterval);
    }

    orphanCleanupInterval = setInterval(() => {
        const now = Date.now();
        const expiredTradeIds = new Set<string>();

        for (const [key, orphan] of orphanTrades.entries()) {
            if (now - orphan.receivedAt > ORPHAN_TTL_MS) {
                expiredTradeIds.add(orphan.trade.id);
                orphanTrades.delete(key);
            }
        }

        if (expiredTradeIds.size > 0) {
            logger.warn(
                { count: expiredTradeIds.size, tradeIds: Array.from(expiredTradeIds) },
                "Orphan trades expired without matching order"
            );
        }
    }, ORPHAN_CLEANUP_INTERVAL_MS);

    // Don't block process exit
    orphanCleanupInterval.unref();
}
