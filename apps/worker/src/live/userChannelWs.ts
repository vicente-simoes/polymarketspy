/**
 * Polymarket CLOB User Channel WebSocket client (orders + fills).
 *
 * Connects to the authenticated user channel and persists near-real-time updates:
 * - LiveOrder status transitions
 * - LiveFill upserts (dedup by tradeId)
 * - LIVE LedgerEntry upserts (dedup by tradeId)
 * - LiveAccountStateCache updates (fills + reservation release)
 *
 * This is Step 8 of live trading MVP.
 */

import WebSocket from "ws";
import {
    LedgerEntryType,
    LiveFillOrigin,
    LiveOrderStatus,
    PortfolioScope,
    TradeSide,
    TradingMode,
} from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import {
    adjustReservationForFill,
    applyFill,
    releaseReservation,
} from "./accountState.js";
import { createL2AuthHeaders, isLiveClientConfigured } from "./clobClient.js";

const logger = createChildLogger({ module: "user-channel-ws" });

/**
 * Polymarket user channel endpoint.
 *
 * NOTE: This is separate from the REST host (`POLYMARKET_CLOB_BASE_URL`).
 */
const DEFAULT_USER_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";

/**
 * Request path used for L2 header signing.
 */
const DEFAULT_REQUEST_PATH = "/ws/user";

export interface UserChannelWsConfig {
    wsUrl: string;
    requestPath: string;
    initialBackoffMs: number;
    maxBackoffMs: number;
    backoffMultiplier: number;
    pingIntervalMs: number;
    connectionTimeoutMs: number;
    pongTimeoutMs: number;
}

export const DEFAULT_USER_WS_CONFIG: UserChannelWsConfig = {
    wsUrl: DEFAULT_USER_WS_URL,
    requestPath: DEFAULT_REQUEST_PATH,
    initialBackoffMs: 1000,
    maxBackoffMs: 60_000,
    backoffMultiplier: 2,
    pingIntervalMs: 10_000,
    connectionTimeoutMs: 30_000,
    pongTimeoutMs: 5_000,
};

// -----------------------------------------------------------------------------
// Normalization helpers
// -----------------------------------------------------------------------------

function parseDecimalToPriceMicros(value: unknown): number | null {
    const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    const micros = Math.round(n * 1_000_000);
    return Number.isFinite(micros) ? micros : null;
}

function parseDecimalToShareMicros(value: unknown): bigint | null {
    const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return BigInt(Math.round(n * 1_000_000));
}

function parseFeeMicros(value: unknown): bigint | null {
    // Fee may arrive as decimal string/number in USDC.
    const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
    if (!Number.isFinite(n) || n < 0) return null;
    return BigInt(Math.round(n * 1_000_000));
}

function parseDate(value: unknown): Date | null {
    if (value instanceof Date) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        // Heuristic: seconds vs ms
        return value > 2_000_000_000 ? new Date(value) : new Date(value * 1000);
    }
    if (typeof value === "string") {
        const d = new Date(value);
        return Number.isFinite(d.getTime()) ? d : null;
    }
    return null;
}

function normalizeTradeSide(value: unknown): TradeSide | null {
    if (value === TradeSide.BUY || value === TradeSide.SELL) return value;
    const upper = typeof value === "string" ? value.toUpperCase() : "";
    if (upper === "BUY") return TradeSide.BUY;
    if (upper === "SELL") return TradeSide.SELL;
    return null;
}

function normalizeLiveOrderStatus(rawStatus: unknown): LiveOrderStatus | null {
    const upper = typeof rawStatus === "string" ? rawStatus.toUpperCase() : "";
    switch (upper) {
        case "LIVE":
        case "OPEN":
            return LiveOrderStatus.OPEN;
        case "MATCHED":
        case "PARTIAL":
            return LiveOrderStatus.PARTIAL;
        case "FILLED":
        case "CLOSED":
            return LiveOrderStatus.FILLED;
        case "CANCELED":
        case "CANCELLED":
        case "EXPIRED":
            return LiveOrderStatus.CANCELED;
        case "REJECTED":
            return LiveOrderStatus.REJECTED;
        default:
            return null;
    }
}

const STATUS_PRECEDENCE: Record<LiveOrderStatus, number> = {
    [LiveOrderStatus.CREATED]: 0,
    [LiveOrderStatus.SUBMITTING]: 1,
    [LiveOrderStatus.SUBMISSION_UNKNOWN]: 2,
    [LiveOrderStatus.OPEN]: 3,
    [LiveOrderStatus.PARTIAL]: 4,
    [LiveOrderStatus.CANCELED]: 5,
    [LiveOrderStatus.FILLED]: 6,
    [LiveOrderStatus.REJECTED]: 7,
    [LiveOrderStatus.FAILED]: 8,
};

function isFinalStatus(status: LiveOrderStatus): boolean {
    return (
        status === LiveOrderStatus.FILLED ||
        status === LiveOrderStatus.CANCELED ||
        status === LiveOrderStatus.REJECTED ||
        status === LiveOrderStatus.FAILED
    );
}

function chooseMonotonicStatus(current: LiveOrderStatus, next: LiveOrderStatus): LiveOrderStatus {
    const cur = STATUS_PRECEDENCE[current] ?? 0;
    const nxt = STATUS_PRECEDENCE[next] ?? 0;
    return nxt >= cur ? next : current;
}

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

type ProcessingTask = () => Promise<void>;

interface UserChannelWsMetrics {
    connectCount: number;
    disconnectCount: number;
    messageCount: number;
    errorCount: number;
    orderUpdateCount: number;
    fillUpdateCount: number;
    lastConnectedAt: number | null;
    lastDisconnectedAt: number | null;
    lastMessageAt: number | null;
}

export class UserChannelWsClient {
    private config: UserChannelWsConfig;
    private ws: WebSocket | null = null;
    private isRunning = false;
    private currentBackoffMs: number;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private pongTimeout: NodeJS.Timeout | null = null;
    private awaitingPong = false;
    private processingChain: Promise<void> = Promise.resolve();

    private metrics: UserChannelWsMetrics = {
        connectCount: 0,
        disconnectCount: 0,
        messageCount: 0,
        errorCount: 0,
        orderUpdateCount: 0,
        fillUpdateCount: 0,
        lastConnectedAt: null as number | null,
        lastDisconnectedAt: null as number | null,
        lastMessageAt: null as number | null,
    };

    constructor(config: Partial<UserChannelWsConfig> = {}) {
        this.config = { ...DEFAULT_USER_WS_CONFIG, ...config };
        this.currentBackoffMs = this.config.initialBackoffMs;
    }

    get isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    getStatus(): {
        running: boolean;
        connected: boolean;
        metrics: UserChannelWsMetrics;
    } {
        return {
            running: this.isRunning,
            connected: this.isConnected,
            metrics: { ...this.metrics },
        };
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn("User channel WS client already running");
            return;
        }

        if (!isLiveClientConfigured()) {
            logger.info("User channel WS not started (POLYMARKET_LIVE_PRIVATE_KEY not set)");
            return;
        }

        this.isRunning = true;
        logger.info({ wsUrl: this.config.wsUrl }, "Starting user channel WebSocket client");
        await this.connect();
    }

    stop(): void {
        this.isRunning = false;
        this.clearTimers();

        if (this.ws) {
            try {
                this.ws.close(1000, "Client stopping");
            } catch {
                // ignore
            }
            this.ws = null;
        }

        logger.info("User channel WebSocket client stopped");
    }

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
        this.awaitingPong = false;
    }

    private enqueue(task: ProcessingTask): void {
        this.processingChain = this.processingChain
            .then(task)
            .catch((err) => {
                logger.error({ err }, "User channel WS message handler failed");
            });
    }

    private async connect(): Promise<void> {
        if (!this.isRunning) return;

        this.clearTimers();

        let headers: Record<string, string> | undefined;
        try {
            headers = await createL2AuthHeaders({
                method: "GET",
                requestPath: this.config.requestPath,
            });
        } catch (err) {
            this.metrics.errorCount++;
            logger.error({ err }, "Failed to create L2 auth headers for user WS");
            this.scheduleReconnect();
            return;
        }

        logger.info({ wsUrl: this.config.wsUrl }, "Connecting to user channel WebSocket");

        const ws = new WebSocket(this.config.wsUrl, {
            headers,
            handshakeTimeout: this.config.connectionTimeoutMs,
        });

        this.ws = ws;

        ws.on("open", () => {
            this.metrics.connectCount++;
            this.metrics.lastConnectedAt = Date.now();
            this.currentBackoffMs = this.config.initialBackoffMs;

            logger.info("User channel WebSocket connected");
            this.startHeartbeat();

            // Some servers require an initial "type" message.
            try {
                ws.send(JSON.stringify({ type: "user" }));
            } catch {
                // ignore
            }
        });

        ws.on("message", (data) => {
            this.metrics.messageCount++;
            this.metrics.lastMessageAt = Date.now();

            const text = typeof data === "string" ? data : data.toString("utf8");
            if (text === "PONG") {
                this.handlePong();
                return;
            }
            if (text === "PING") {
                // Reply to server ping
                try {
                    ws.send("PONG");
                } catch {
                    // ignore
                }
                return;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                logger.debug({ text: text.slice(0, 200) }, "Ignoring non-JSON WS message");
                return;
            }

            this.enqueue(async () => {
                await this.handleEvent(parsed);
            });
        });

        ws.on("error", (err) => {
            this.metrics.errorCount++;
            logger.warn({ err }, "User channel WebSocket error");
        });

        ws.on("close", (code, reason) => {
            this.metrics.disconnectCount++;
            this.metrics.lastDisconnectedAt = Date.now();

            logger.warn(
                { code, reason: reason.toString() },
                "User channel WebSocket disconnected"
            );

            if (this.ws === ws) {
                this.ws = null;
            }

            this.clearTimers();
            this.scheduleReconnect();
        });
    }

    private startHeartbeat(): void {
        if (!this.ws) return;

        // Send periodic ping to keep connection alive.
        this.pingInterval = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

            if (this.awaitingPong) {
                logger.warn("No pong received, terminating user WS connection");
                try {
                    this.ws.terminate();
                } catch {
                    // ignore
                }
                return;
            }

            this.awaitingPong = true;
            try {
                this.ws.send("PING");
            } catch {
                // ignore
            }

            // Pong timeout
            if (this.pongTimeout) clearTimeout(this.pongTimeout);
            this.pongTimeout = setTimeout(() => {
                if (this.awaitingPong) {
                    logger.warn("Pong timeout, terminating user WS connection");
                    try {
                        this.ws?.terminate();
                    } catch {
                        // ignore
                    }
                }
            }, this.config.pongTimeoutMs);
        }, this.config.pingIntervalMs);
    }

    private handlePong(): void {
        this.awaitingPong = false;
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    private scheduleReconnect(): void {
        if (!this.isRunning) return;
        if (this.reconnectTimeout) return;

        const backoff = this.currentBackoffMs;
        this.currentBackoffMs = Math.min(
            this.config.maxBackoffMs,
            Math.floor(this.currentBackoffMs * this.config.backoffMultiplier)
        );

        logger.info({ backoffMs: backoff }, "Scheduling user WS reconnect");
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect().catch((err) => {
                logger.error({ err }, "User WS reconnect failed");
                this.scheduleReconnect();
            });
        }, backoff);
    }

    private async handleEvent(payload: unknown): Promise<void> {
        if (!payload || typeof payload !== "object") return;

        const msg = payload as Record<string, any>;
        const eventTypeRaw =
            msg.event_type ?? msg.type ?? msg.eventType ?? msg.event ?? msg.channel ?? null;
        const eventType =
            typeof eventTypeRaw === "string" ? eventTypeRaw.toLowerCase() : null;
        const data = typeof msg.data === "object" && msg.data !== null ? msg.data : msg;

        // Heuristic routing
        if (eventType?.includes("order") || (data && typeof data.status === "string" && (data.order_id || data.orderID || data.id))) {
            this.metrics.orderUpdateCount++;
            await this.handleOrderUpdate(data);
            return;
        }
        if (eventType?.includes("trade") || eventType?.includes("fill") || data.trade_id || data.tradeId) {
            this.metrics.fillUpdateCount++;
            await this.handleTradeOrFill(data);
            return;
        }

        // Unknown message type; ignore.
        logger.debug({ eventType }, "Ignoring user WS message (unknown type)");
    }

    private async handleOrderUpdate(data: Record<string, any>): Promise<void> {
        const clobOrderId: string | null =
            data.order_id ?? data.orderID ?? data.orderId ?? data.id ?? null;
        const mappedStatus = normalizeLiveOrderStatus(data.status);

        if (!clobOrderId || !mappedStatus) {
            return;
        }

        const filledShareMicros = parseDecimalToShareMicros(
            data.size_matched ?? data.filled_size ?? data.filledSize ?? null
        );

        const now = new Date();

        await prisma.$transaction(async (tx) => {
            const existing = await tx.liveOrder.findUnique({
                where: { clobOrderId },
                select: {
                    id: true,
                    status: true,
                    submittedAt: true,
                    finalizedAt: true,
                    filledShareMicros: true,
                },
            });

            if (!existing) {
                logger.debug({ clobOrderId }, "Order update for unknown clobOrderId; ignoring");
                return;
            }

            const nextStatus = chooseMonotonicStatus(existing.status, mappedStatus);
            const shouldSetSubmittedAt =
                existing.submittedAt === null &&
                (nextStatus === LiveOrderStatus.OPEN ||
                    nextStatus === LiveOrderStatus.PARTIAL ||
                    nextStatus === LiveOrderStatus.CANCELED ||
                    nextStatus === LiveOrderStatus.FILLED);
            const shouldSetFinalizedAt = existing.finalizedAt === null && isFinalStatus(nextStatus);

            const dataToUpdate: Record<string, any> = {
                status: nextStatus,
                lastUpdateAt: now,
                ...(shouldSetSubmittedAt ? { submittedAt: now } : {}),
                ...(shouldSetFinalizedAt ? { finalizedAt: now } : {}),
            };

            if (filledShareMicros !== null) {
                dataToUpdate.filledShareMicros =
                    filledShareMicros > existing.filledShareMicros
                        ? filledShareMicros
                        : existing.filledShareMicros;
            }

            await tx.liveOrder.update({
                where: { id: existing.id },
                data: dataToUpdate,
            });

            // Reservation release is in-memory; do after DB state is updated.
            if (isFinalStatus(nextStatus)) {
                releaseReservation(existing.id);
            }
        });
    }

    private async handleTradeOrFill(data: Record<string, any>): Promise<void> {
        const tradeId: string | null =
            data.trade_id ?? data.tradeId ?? data.id ?? null;
        if (!tradeId) return;

        const clobOrderId: string | null =
            data.order_id ??
            data.orderID ??
            data.orderId ??
            data.taker_order_id ??
            data.takerOrderId ??
            null;

        const tokenId: string | null =
            data.asset_id ?? data.token_id ?? data.tokenId ?? data.tokenID ?? null;

        const side = normalizeTradeSide(data.side);
        const shareMicros = parseDecimalToShareMicros(data.size ?? data.share_size ?? data.amount ?? null);
        const priceMicros = parseDecimalToPriceMicros(data.price ?? null);

        if (!tokenId || !side || shareMicros === null || priceMicros === null) {
            return;
        }

        const matchedAt =
            parseDate(data.match_time ?? data.matched_at ?? data.matchedAt ?? data.timestamp ?? null) ??
            new Date();

        // notionalMicros = shares * price / 1e6
        const notionalMicros =
            (shareMicros * BigInt(priceMicros)) / BigInt(1_000_000);

        // Fee handling:
        // Prefer explicit fee fields; otherwise approximate from fee_rate_bps if present.
        let feeMicros: bigint | null = parseFeeMicros(
            data.fee ?? data.fee_amount ?? data.feeUsd ?? null
        );
        if (feeMicros === null && data.fee_rate_bps != null) {
            const feeRateBps = typeof data.fee_rate_bps === "string"
                ? Number.parseFloat(data.fee_rate_bps)
                : typeof data.fee_rate_bps === "number"
                  ? data.fee_rate_bps
                  : NaN;
            if (Number.isFinite(feeRateBps) && feeRateBps >= 0) {
                feeMicros =
                    (notionalMicros * BigInt(Math.round(feeRateBps))) / BigInt(10_000);
            }
        }

        const status = typeof data.status === "string" ? data.status : "MATCHED";

        // Persist + dedupe in a transaction.
        const result = await prisma.$transaction(async (tx) => {
            const existingFill = await tx.liveFill.findUnique({
                where: { tradeId },
                select: { id: true },
            });
            if (existingFill) {
                return { created: false, origin: null as LiveFillOrigin | null, orderId: null as string | null };
            }

            const liveOrder = clobOrderId
                ? await tx.liveOrder.findUnique({
                      where: { clobOrderId },
                      select: {
                          id: true,
                          followedUserId: true,
                          sizeShareMicros: true,
                          filledShareMicros: true,
                          filledNotionalMicros: true,
                          status: true,
                      },
                  })
                : null;

            const origin = liveOrder ? LiveFillOrigin.APP : LiveFillOrigin.EXTERNAL;

            await tx.liveFill.create({
                data: {
                    tradeId,
                    clobOrderId,
                    tokenId,
                    side,
                    priceMicros,
                    shareMicros,
                    notionalMicros,
                    feeMicros,
                    origin,
                    matchedAt,
                    status,
                    liveOrderId: liveOrder?.id ?? null,
                },
            });

            const tokenMeta = await tx.tokenMetadataCache.findUnique({
                where: { tokenId },
                select: { marketId: true },
            });

            const fee = feeMicros ?? BigInt(0);
            const shareDeltaMicros = side === TradeSide.BUY ? shareMicros : -shareMicros;
            const cashDeltaMicros =
                side === TradeSide.BUY
                    ? -(notionalMicros + fee)
                    : notionalMicros - fee;

            await tx.ledgerEntry.upsert({
                where: {
                    tradingMode_portfolioScope_refId_entryType: {
                        tradingMode: TradingMode.LIVE,
                        portfolioScope: PortfolioScope.EXEC_GLOBAL,
                        refId: tradeId,
                        entryType: LedgerEntryType.TRADE_FILL,
                    },
                },
                create: {
                    tradingMode: TradingMode.LIVE,
                    portfolioScope: PortfolioScope.EXEC_GLOBAL,
                    followedUserId: liveOrder?.followedUserId ?? null,
                    marketId: tokenMeta?.marketId ?? null,
                    assetId: tokenId,
                    entryType: LedgerEntryType.TRADE_FILL,
                    shareDeltaMicros,
                    cashDeltaMicros,
                    priceMicros,
                    refId: tradeId,
                },
                update: {},
            });

            if (liveOrder) {
                const newFilledShareMicros = liveOrder.filledShareMicros + shareMicros;
                const newFilledNotionalMicros = liveOrder.filledNotionalMicros + notionalMicros;
                const avgFillPriceMicros =
                    newFilledShareMicros > BigInt(0)
                        ? Number(
                              (newFilledNotionalMicros * BigInt(1_000_000)) / newFilledShareMicros
                          )
                        : null;

                // If we see fills, at minimum the order is PARTIAL unless already final.
                const fillImpliedStatus =
                    newFilledShareMicros >= liveOrder.sizeShareMicros
                        ? LiveOrderStatus.FILLED
                        : LiveOrderStatus.PARTIAL;
                const nextStatus = isFinalStatus(liveOrder.status)
                    ? liveOrder.status
                    : chooseMonotonicStatus(liveOrder.status, fillImpliedStatus);

                await tx.liveOrder.update({
                    where: { id: liveOrder.id },
                    data: {
                        filledShareMicros: newFilledShareMicros,
                        filledNotionalMicros: newFilledNotionalMicros,
                        avgFillPriceMicros: avgFillPriceMicros ?? undefined,
                        status: nextStatus,
                        lastUpdateAt: matchedAt,
                        ...(nextStatus === LiveOrderStatus.FILLED ? { finalizedAt: matchedAt } : {}),
                    },
                });
            }

            return {
                created: true,
                origin,
                orderId: liveOrder?.id ?? null,
            };
        });

        if (!result.created) {
            return;
        }

        // Update in-memory account state (best-effort).
        // Apply net cash changes including fees.
        const fee = feeMicros ?? BigInt(0);
        const cashForState =
            side === TradeSide.BUY
                ? notionalMicros + fee
                : notionalMicros - fee;

        if (result.orderId) {
            // Reservations were made against notional (fee handled via buffer).
            adjustReservationForFill(result.orderId, notionalMicros, shareMicros);
        }

        applyFill(side, tokenId, shareMicros, cashForState);
    }
}

// -----------------------------------------------------------------------------
// Singleton wiring
// -----------------------------------------------------------------------------

let singleton: UserChannelWsClient | null = null;

export async function startUserChannelWs(): Promise<void> {
    if (!singleton) {
        singleton = new UserChannelWsClient();
    }
    await singleton.start();
}

export function stopUserChannelWs(): void {
    singleton?.stop();
}

export function getUserChannelWsStatus(): ReturnType<UserChannelWsClient["getStatus"]> | null {
    return singleton?.getStatus() ?? null;
}
