/**
 * Order Reconciliation
 *
 * Periodically syncs open orders with the exchange to:
 * 1. Update order status and fill amounts
 * 2. Resolve SUBMISSION_UNKNOWN orders by matching against open orders
 * 3. Time out unresolved orders after 5 minutes
 * 4. Pause submissions when SUBMISSION_UNKNOWN orders exist
 *
 * Run every 45 seconds.
 */

import { LiveOrderStatus } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { createChildLogger } from "../../log/logger.js";
import { getOrder, listOpenOrders, listRecentTrades, type ClobOrder } from "../clobClient.js";
import { pauseSubmissions, resumeSubmissions, areSubmissionsPaused } from "../accountState.js";
import { recordOrderReconcileSuccess, recordOrderReconcileError } from "./metrics.js";
import type { OrderReconcileResult } from "./types.js";

const logger = createChildLogger({ module: "order-reconciler" });

// ─── Configuration ────────────────────────────────────────────────────────────

/** Time after which unresolved SUBMISSION_UNKNOWN orders are marked FAILED */
const SUBMISSION_UNKNOWN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Time window before order creation to search for matching orders */
const ORDER_MATCH_WINDOW_BEFORE_MS = 30 * 1000; // 30 seconds

/** Time window after order creation to search for matching orders */
const ORDER_MATCH_WINDOW_AFTER_MS = 60 * 1000; // 60 seconds

// ─── Status Mapping ───────────────────────────────────────────────────────────

/** Non-final statuses that need reconciliation */
const NON_FINAL_STATUSES: LiveOrderStatus[] = [
    "CREATED",
    "SUBMITTING",
    "OPEN",
    "PARTIAL",
    "SUBMISSION_UNKNOWN",
];

/** Final statuses that don't need reconciliation */
const FINAL_STATUSES: LiveOrderStatus[] = ["FILLED", "CANCELED", "REJECTED", "FAILED"];

/**
 * Map CLOB order status to our LiveOrderStatus.
 */
function mapClobStatus(status: string): LiveOrderStatus {
    const mapping: Record<string, LiveOrderStatus> = {
        LIVE: "OPEN",
        OPEN: "OPEN",
        MATCHED: "PARTIAL",
        PARTIAL: "PARTIAL",
        FILLED: "FILLED",
        CANCELLED: "CANCELED",
        CANCELED: "CANCELED",
        REJECTED: "REJECTED",
    };
    return mapping[status.toUpperCase()] || "OPEN";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reconcile all open orders with the exchange.
 *
 * This function:
 * 1. Fetches all non-final LiveOrder rows from DB
 * 2. For orders with clobOrderId: syncs status via getOrder()
 * 3. For SUBMISSION_UNKNOWN without clobOrderId: tries to match via listOpenOrders()
 * 4. Times out SUBMISSION_UNKNOWN orders after 5 minutes
 * 5. Pauses/resumes submissions based on unresolved count
 *
 * @returns Results of reconciliation for each order
 */
export async function reconcileOpenOrders(): Promise<OrderReconcileResult[]> {
    const log = logger.child({});
    const results: OrderReconcileResult[] = [];

    try {
        // Fetch all non-final orders
        const openOrders = await prisma.liveOrder.findMany({
            where: { status: { in: NON_FINAL_STATUSES } },
            orderBy: { createdAt: "asc" },
        });

        if (openOrders.length === 0) {
            log.debug("No open orders to reconcile");
            recordOrderReconcileSuccess(0, []);

            // If we were paused and now have no issues, resume
            if (areSubmissionsPaused()) {
                resumeSubmissions();
            }
            return [];
        }

        log.debug({ count: openOrders.length }, "Reconciling open orders");

        // Fetch all open orders from exchange once (for SUBMISSION_UNKNOWN matching)
        const exchangeOrders = await listOpenOrders();
        const exchangeOrdersMap = new Map<string, ClobOrder>(
            exchangeOrders.map((o) => [o.clobOrderId, o])
        );

        // Track SUBMISSION_UNKNOWN orders for pause decision
        const unresolvedOrderIds: string[] = [];

        for (const order of openOrders) {
            try {
                const result = await reconcileOrder(order, exchangeOrdersMap);
                results.push(result);

                // Track unresolved SUBMISSION_UNKNOWN
                if (
                    result.newStatus === "SUBMISSION_UNKNOWN" &&
                    result.action !== "TIMED_OUT"
                ) {
                    unresolvedOrderIds.push(order.id);
                }
            } catch (err) {
                log.error({ err, orderId: order.id }, "Failed to reconcile order");
            }
        }

        // Update pause state based on unresolved count
        if (unresolvedOrderIds.length > 0) {
            if (!areSubmissionsPaused()) {
                pauseSubmissions(
                    `${unresolvedOrderIds.length} SUBMISSION_UNKNOWN order(s) unresolved`
                );
            }
        } else if (areSubmissionsPaused()) {
            resumeSubmissions();
        }

        recordOrderReconcileSuccess(unresolvedOrderIds.length, unresolvedOrderIds);

        log.info(
            {
                total: openOrders.length,
                updated: results.filter((r) => r.action === "UPDATED").length,
                matched: results.filter((r) => r.action === "MATCHED").length,
                timedOut: results.filter((r) => r.action === "TIMED_OUT").length,
                unchanged: results.filter((r) => r.action === "UNCHANGED").length,
                unresolved: unresolvedOrderIds.length,
            },
            "Order reconciliation complete"
        );

        return results;
    } catch (err) {
        log.error({ err }, "Order reconciliation failed");
        recordOrderReconcileError();
        throw err;
    }
}

// ─── Internal Functions ───────────────────────────────────────────────────────

interface LiveOrderRow {
    id: string;
    clobOrderId: string | null;
    status: LiveOrderStatus;
    tokenId: string;
    side: "BUY" | "SELL";
    limitPriceMicros: number;
    sizeShareMicros: bigint;
    filledShareMicros: bigint;
    createdAt: Date;
}

/**
 * Reconcile a single order.
 */
async function reconcileOrder(
    order: LiveOrderRow,
    exchangeOrders: Map<string, ClobOrder>
): Promise<OrderReconcileResult> {
    const log = logger.child({ orderId: order.id, status: order.status });

    // Case 1: Has clobOrderId - fetch directly
    if (order.clobOrderId) {
        return reconcileWithClobOrderId(order, order.clobOrderId, exchangeOrders);
    }

    // Case 2: SUBMISSION_UNKNOWN without clobOrderId - try to match
    if (order.status === "SUBMISSION_UNKNOWN") {
        return reconcileSubmissionUnknown(order, exchangeOrders);
    }

    // Case 3: CREATED or SUBMITTING without clobOrderId - check for timeout
    const ageMs = Date.now() - order.createdAt.getTime();
    if (ageMs > SUBMISSION_UNKNOWN_TIMEOUT_MS) {
        log.warn({ ageMs }, "Order timed out without clobOrderId");
        return markOrderFailed(order, "Order timed out without exchange ID");
    }

    // Still waiting for submission
    log.debug("Order still pending submission");
    return {
        orderId: order.id,
        clobOrderId: null,
        previousStatus: order.status,
        newStatus: order.status,
        filledShareMicros: order.filledShareMicros,
        action: "UNCHANGED",
    };
}

/**
 * Reconcile an order that has a clobOrderId.
 */
async function reconcileWithClobOrderId(
    order: LiveOrderRow,
    clobOrderId: string,
    exchangeOrders: Map<string, ClobOrder>
): Promise<OrderReconcileResult> {
    const log = logger.child({ orderId: order.id, clobOrderId });

    // First check our cached exchange orders
    let exchangeOrder = exchangeOrders.get(clobOrderId);

    // If not in open orders (maybe filled/canceled), fetch directly
    if (!exchangeOrder) {
        const fetched = await getOrder(clobOrderId);
        if (fetched) {
            exchangeOrder = fetched;
        }
    }

    if (!exchangeOrder) {
        // Order not found on exchange - might be expired or network issue
        log.warn("Order not found on exchange");
        return {
            orderId: order.id,
            clobOrderId,
            previousStatus: order.status,
            newStatus: order.status,
            filledShareMicros: order.filledShareMicros,
            action: "UNCHANGED",
        };
    }

    // Map and update status
    const newStatus = mapClobStatus(exchangeOrder.status);
    const filledShareMicros = decimalToShareMicros(exchangeOrder.filledSize);
    const originalShareMicros = decimalToShareMicros(exchangeOrder.originalSize);

    // Check if anything changed
    if (
        newStatus === order.status &&
        filledShareMicros === order.filledShareMicros
    ) {
        return {
            orderId: order.id,
            clobOrderId,
            previousStatus: order.status,
            newStatus,
            filledShareMicros,
            action: "UNCHANGED",
        };
    }

    // Update the order in DB
    const isFinal = FINAL_STATUSES.includes(newStatus);
    await prisma.liveOrder.update({
        where: { id: order.id },
        data: {
            status: newStatus,
            filledShareMicros,
            lastUpdateAt: new Date(),
            ...(isFinal ? { finalizedAt: new Date() } : {}),
        },
    });

    log.info(
        {
            previousStatus: order.status,
            newStatus,
            filledShareMicros: filledShareMicros.toString(),
        },
        "Order status updated from exchange"
    );

    return {
        orderId: order.id,
        clobOrderId,
        previousStatus: order.status,
        newStatus,
        filledShareMicros,
        action: "UPDATED",
    };
}

/**
 * Try to match a SUBMISSION_UNKNOWN order against open exchange orders.
 */
async function reconcileSubmissionUnknown(
    order: LiveOrderRow,
    exchangeOrders: Map<string, ClobOrder>
): Promise<OrderReconcileResult> {
    const log = logger.child({ orderId: order.id });
    const orderCreatedAt = order.createdAt.getTime();

    // Search for matching order on exchange
    for (const exchangeOrder of exchangeOrders.values()) {
        // Must match token, side, price, and size
        if (exchangeOrder.tokenId !== order.tokenId) continue;
        if (exchangeOrder.side !== order.side) continue;

        const exchangePriceMicros = decimalToPriceMicros(exchangeOrder.price);
        if (exchangePriceMicros !== order.limitPriceMicros) continue;

        const exchangeSizeMicros = decimalToShareMicros(exchangeOrder.originalSize);
        if (exchangeSizeMicros !== order.sizeShareMicros) continue;

        // Check time window
        const exchangeCreatedAt = exchangeOrder.createdAt * 1000; // Convert to ms
        const timeDiff = exchangeCreatedAt - orderCreatedAt;
        if (
            timeDiff < -ORDER_MATCH_WINDOW_BEFORE_MS ||
            timeDiff > ORDER_MATCH_WINDOW_AFTER_MS
        ) {
            continue;
        }

        // Match found!
        log.info(
            { clobOrderId: exchangeOrder.clobOrderId },
            "Matched SUBMISSION_UNKNOWN to exchange order"
        );

        const newStatus = mapClobStatus(exchangeOrder.status);
        const filledShareMicros = decimalToShareMicros(exchangeOrder.filledSize);
        const isFinal = FINAL_STATUSES.includes(newStatus);

        await prisma.liveOrder.update({
            where: { id: order.id },
            data: {
                clobOrderId: exchangeOrder.clobOrderId,
                status: newStatus,
                filledShareMicros,
                lastUpdateAt: new Date(),
                ...(isFinal ? { finalizedAt: new Date() } : {}),
            },
        });

        return {
            orderId: order.id,
            clobOrderId: exchangeOrder.clobOrderId,
            previousStatus: order.status,
            newStatus,
            filledShareMicros,
            action: "MATCHED",
        };
    }

    // No open-order match found; attempt matching via recent trades (filled quickly orders won't be open).
    const trades = await listRecentTrades({ asset_id: order.tokenId });
    const tradeCandidates = trades
        .filter((t) => t.tokenId === order.tokenId && t.side === order.side)
        .filter((t) => {
            if (t.matchTimeMs <= 0) return false;
            const timeDiff = t.matchTimeMs - orderCreatedAt;
            return (
                timeDiff >= -ORDER_MATCH_WINDOW_BEFORE_MS &&
                timeDiff <= ORDER_MATCH_WINDOW_AFTER_MS
            );
        })
        .sort((a, b) => Math.abs(a.matchTimeMs - orderCreatedAt) - Math.abs(b.matchTimeMs - orderCreatedAt));

    for (const trade of tradeCandidates) {
        const clobOrderId =
            trade.traderSide === "TAKER"
                ? trade.takerOrderId
                : trade.makerOrderIds[0] ?? trade.takerOrderId;

        if (!clobOrderId) continue;

        const tradeStatusUpper = trade.status.toUpperCase();
        const newStatus: LiveOrderStatus =
            tradeStatusUpper === "CONFIRMED" || tradeStatusUpper === "MINED" || tradeStatusUpper === "MATCHED"
                ? "PARTIAL"
                : "OPEN";

        log.info({ clobOrderId, tradeId: trade.tradeId, newStatus }, "Matched SUBMISSION_UNKNOWN via recent trades");

        await prisma.liveOrder.update({
            where: { id: order.id },
            data: {
                clobOrderId,
                status: newStatus,
                lastUpdateAt: new Date(),
            },
        });

        return {
            orderId: order.id,
            clobOrderId,
            previousStatus: order.status,
            newStatus,
            filledShareMicros: order.filledShareMicros,
            action: "MATCHED",
        };
    }

    // No match found - check for timeout
    const ageMs = Date.now() - orderCreatedAt;
    if (ageMs > SUBMISSION_UNKNOWN_TIMEOUT_MS) {
        log.warn({ ageMs }, "SUBMISSION_UNKNOWN timed out");
        return markOrderFailed(order, "SUBMISSION_UNKNOWN timed out after 5 minutes");
    }

    // Still searching
    log.debug({ ageMs }, "SUBMISSION_UNKNOWN still unresolved");
    return {
        orderId: order.id,
        clobOrderId: null,
        previousStatus: order.status,
        newStatus: "SUBMISSION_UNKNOWN",
        filledShareMicros: order.filledShareMicros,
        action: "UNCHANGED",
    };
}

/**
 * Mark an order as FAILED.
 */
async function markOrderFailed(
    order: LiveOrderRow,
    errorMessage: string
): Promise<OrderReconcileResult> {
    await prisma.liveOrder.update({
        where: { id: order.id },
        data: {
            status: "FAILED",
            lastErrorMessage: errorMessage,
            lastUpdateAt: new Date(),
            finalizedAt: new Date(),
        },
    });

    return {
        orderId: order.id,
        clobOrderId: order.clobOrderId,
        previousStatus: order.status,
        newStatus: "FAILED",
        filledShareMicros: order.filledShareMicros,
        action: "TIMED_OUT",
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function decimalToPriceMicros(decimal: string): number {
    return Math.round(parseFloat(decimal) * 1_000_000);
}

function decimalToShareMicros(decimal: string): bigint {
    return BigInt(Math.round(parseFloat(decimal) * 1_000_000));
}
