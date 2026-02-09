/**
 * Live Trading Reconciliation Module
 *
 * Provides periodic reconciliation between our local state and the exchange:
 * - Order reconciliation (every 45s): Sync open orders, resolve SUBMISSION_UNKNOWN
 * - State reconciliation (every 60s): Sync cash and positions with exchange
 *
 * This module is the safety net for live trading, ensuring:
 * - Orders don't get stuck in unknown states
 * - Account state stays in sync with reality
 * - Executor is gated on reconciliation health
 */

import { createChildLogger } from "../../log/logger.js";
import { isLiveClientInitialized } from "../clobClient.js";
import { reconcileOpenOrders } from "./orderReconciler.js";
import { reconcileAccountState } from "./stateReconciler.js";
import {
    getReconciliationHealth,
    isReconciliationHealthy,
    hasReconciliationInitialized,
    resetMetrics,
} from "./metrics.js";

// Re-export types and functions
export {
    getReconciliationHealth,
    isReconciliationHealthy,
    hasReconciliationInitialized,
} from "./metrics.js";

export type {
    ReconciliationHealth,
    AuthoritativePosition,
    AuthoritativeAccountState,
    OrderReconcileResult,
} from "./types.js";

const logger = createChildLogger({ module: "live-reconciliation" });

// ─── Configuration ────────────────────────────────────────────────────────────

/** Order reconciliation interval (45 seconds) */
const ORDER_RECONCILE_INTERVAL_MS = 45 * 1000;

/** State reconciliation interval (60 seconds) */
const STATE_RECONCILE_INTERVAL_MS = 60 * 1000;

/** Initial delay before starting reconciliation (5 seconds) */
const INITIAL_DELAY_MS = 5 * 1000;

// ─── Module State ─────────────────────────────────────────────────────────────

let orderReconcileInterval: ReturnType<typeof setInterval> | null = null;
let stateReconcileInterval: ReturnType<typeof setInterval> | null = null;
let initialDelayTimeout: ReturnType<typeof setTimeout> | null = null;

let orderReconcileInFlight = false;
let stateReconcileInFlight = false;

let isRunning = false;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Start the live reconciliation loops.
 *
 * Should be called after CLOB client initialization.
 * Runs an initial state reconciliation immediately (after short delay),
 * then starts periodic reconciliation loops.
 */
export async function startLiveReconciliation(): Promise<void> {
    if (isRunning) {
        logger.warn("Live reconciliation already running");
        return;
    }

    if (!isLiveClientInitialized()) {
        logger.warn("Cannot start live reconciliation: CLOB client not initialized");
        return;
    }

    isRunning = true;
    logger.info(
        {
            orderIntervalMs: ORDER_RECONCILE_INTERVAL_MS,
            stateIntervalMs: STATE_RECONCILE_INTERVAL_MS,
            initialDelayMs: INITIAL_DELAY_MS,
        },
        "Starting live reconciliation"
    );

    // Initial delay to let other systems stabilize
    initialDelayTimeout = setTimeout(async () => {
        initialDelayTimeout = null;

        if (!isRunning) return;

        // Run initial state reconciliation to seed account state
        logger.info("Running initial state reconciliation");
        await runStateReconcile();

        // Run initial order reconciliation
        logger.info("Running initial order reconciliation");
        await runOrderReconcile();

        // Start periodic loops
        startLoops();
    }, INITIAL_DELAY_MS);
}

/**
 * Stop the live reconciliation loops.
 */
export function stopLiveReconciliation(): void {
    if (!isRunning) {
        return;
    }

    isRunning = false;

    if (initialDelayTimeout) {
        clearTimeout(initialDelayTimeout);
        initialDelayTimeout = null;
    }

    if (orderReconcileInterval) {
        clearInterval(orderReconcileInterval);
        orderReconcileInterval = null;
    }

    if (stateReconcileInterval) {
        clearInterval(stateReconcileInterval);
        stateReconcileInterval = null;
    }

    // Reset metrics on stop
    resetMetrics();

    logger.info("Live reconciliation stopped");
}

// ─── Internal Functions ───────────────────────────────────────────────────────

/**
 * Start the periodic reconciliation loops.
 */
function startLoops(): void {
    // Order reconciliation loop (every 45s)
    orderReconcileInterval = setInterval(() => {
        runOrderReconcile().catch((err) => {
            logger.error({ err }, "Order reconciliation loop error");
        });
    }, ORDER_RECONCILE_INTERVAL_MS);

    // State reconciliation loop (every 60s)
    stateReconcileInterval = setInterval(() => {
        runStateReconcile().catch((err) => {
            logger.error({ err }, "State reconciliation loop error");
        });
    }, STATE_RECONCILE_INTERVAL_MS);

    // Don't block process exit
    orderReconcileInterval.unref?.();
    stateReconcileInterval.unref?.();

    logger.info("Live reconciliation loops started");
}

/**
 * Run order reconciliation with in-flight guard.
 */
async function runOrderReconcile(): Promise<void> {
    if (orderReconcileInFlight) {
        logger.warn("Order reconciliation already in flight, skipping");
        return;
    }

    if (!isRunning) {
        return;
    }

    orderReconcileInFlight = true;
    try {
        await reconcileOpenOrders();
    } finally {
        orderReconcileInFlight = false;
    }
}

/**
 * Run state reconciliation with in-flight guard.
 */
async function runStateReconcile(): Promise<void> {
    if (stateReconcileInFlight) {
        logger.warn("State reconciliation already in flight, skipping");
        return;
    }

    if (!isRunning) {
        return;
    }

    stateReconcileInFlight = true;
    try {
        await reconcileAccountState();
    } finally {
        stateReconcileInFlight = false;
    }
}
