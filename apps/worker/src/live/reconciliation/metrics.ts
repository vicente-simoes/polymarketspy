/**
 * Reconciliation Health Metrics
 *
 * Tracks health status and error counts for the reconciliation module.
 * Used to gate live order submissions when reconciliation is unhealthy.
 */

import { createChildLogger } from "../../log/logger.js";
import type { ReconciliationHealth } from "./types.js";

const logger = createChildLogger({ module: "reconciliation-metrics" });

// ─── Configuration ────────────────────────────────────────────────────────────

/** Mark unhealthy after this many consecutive errors */
const MAX_CONSECUTIVE_ERRORS = 3;

// ─── Internal State ───────────────────────────────────────────────────────────

const state = {
    isInitialized: false,
    lastOrderReconcileAt: null as Date | null,
    lastStateReconcileAt: null as Date | null,
    orderReconcileErrorCount: 0,
    stateReconcileErrorCount: 0,
    consecutiveOrderErrors: 0,
    consecutiveStateErrors: 0,
    submissionUnknownCount: 0,
    unresolvedOrderIds: [] as string[],
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get current reconciliation health status.
 */
export function getReconciliationHealth(): ReconciliationHealth {
    return {
        isHealthy: isReconciliationHealthy(),
        isInitialized: state.isInitialized,
        lastOrderReconcileAt: state.lastOrderReconcileAt,
        lastStateReconcileAt: state.lastStateReconcileAt,
        orderReconcileErrorCount: state.orderReconcileErrorCount,
        stateReconcileErrorCount: state.stateReconcileErrorCount,
        consecutiveOrderErrors: state.consecutiveOrderErrors,
        consecutiveStateErrors: state.consecutiveStateErrors,
        submissionUnknownCount: state.submissionUnknownCount,
        unresolvedOrderIds: [...state.unresolvedOrderIds],
    };
}

/**
 * Check if reconciliation is healthy enough to allow submissions.
 */
export function isReconciliationHealthy(): boolean {
    // Must be initialized
    if (!state.isInitialized) {
        return false;
    }

    // Too many consecutive order errors
    if (state.consecutiveOrderErrors >= MAX_CONSECUTIVE_ERRORS) {
        return false;
    }

    // Too many consecutive state errors
    if (state.consecutiveStateErrors >= MAX_CONSECUTIVE_ERRORS) {
        return false;
    }

    return true;
}

/**
 * Check if initial reconciliation has completed.
 */
export function hasReconciliationInitialized(): boolean {
    return state.isInitialized;
}

// ─── Update Functions ─────────────────────────────────────────────────────────

/**
 * Mark state reconciliation as initialized (first successful run).
 */
export function markInitialized(): void {
    if (!state.isInitialized) {
        state.isInitialized = true;
        logger.info("Reconciliation marked as initialized");
    }
}

/**
 * Record successful order reconciliation.
 */
export function recordOrderReconcileSuccess(
    submissionUnknownCount: number,
    unresolvedOrderIds: string[]
): void {
    state.lastOrderReconcileAt = new Date();
    state.consecutiveOrderErrors = 0;
    state.submissionUnknownCount = submissionUnknownCount;
    state.unresolvedOrderIds = unresolvedOrderIds;
}

/**
 * Record failed order reconciliation.
 */
export function recordOrderReconcileError(): void {
    state.orderReconcileErrorCount++;
    state.consecutiveOrderErrors++;

    if (state.consecutiveOrderErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.warn(
            { consecutiveErrors: state.consecutiveOrderErrors },
            "Order reconciliation unhealthy due to consecutive errors"
        );
    }
}

/**
 * Record successful state reconciliation.
 */
export function recordStateReconcileSuccess(): void {
    state.lastStateReconcileAt = new Date();
    state.consecutiveStateErrors = 0;
}

/**
 * Record failed state reconciliation.
 */
export function recordStateReconcileError(): void {
    state.stateReconcileErrorCount++;
    state.consecutiveStateErrors++;

    if (state.consecutiveStateErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.warn(
            { consecutiveErrors: state.consecutiveStateErrors },
            "State reconciliation unhealthy due to consecutive errors"
        );
    }
}

/**
 * Reset all metrics (for testing).
 */
export function resetMetrics(): void {
    state.isInitialized = false;
    state.lastOrderReconcileAt = null;
    state.lastStateReconcileAt = null;
    state.orderReconcileErrorCount = 0;
    state.stateReconcileErrorCount = 0;
    state.consecutiveOrderErrors = 0;
    state.consecutiveStateErrors = 0;
    state.submissionUnknownCount = 0;
    state.unresolvedOrderIds = [];
}
