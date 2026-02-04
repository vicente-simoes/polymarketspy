/**
 * Reconciliation Types
 *
 * Shared types for order and state reconciliation modules.
 */

import type { LiveOrderStatus } from "@prisma/client";

/** Health status for reconciliation module */
export interface ReconciliationHealth {
    isHealthy: boolean;
    isInitialized: boolean;
    lastOrderReconcileAt: Date | null;
    lastStateReconcileAt: Date | null;
    orderReconcileErrorCount: number;
    stateReconcileErrorCount: number;
    consecutiveOrderErrors: number;
    consecutiveStateErrors: number;
    submissionUnknownCount: number;
    unresolvedOrderIds: string[];
}

/** Authoritative position from exchange or Data API */
export interface AuthoritativePosition {
    tokenId: string;
    shareMicros: bigint;
}

/** Full authoritative account state fetched from exchange */
export interface AuthoritativeAccountState {
    cashMicros: bigint;
    positions: AuthoritativePosition[];
    fetchedAt: Date;
    source: "CLOB_CLIENT" | "DATA_API" | "HYBRID";
}

/** Result of reconciling a single order */
export interface OrderReconcileResult {
    orderId: string;
    clobOrderId: string | null;
    previousStatus: LiveOrderStatus;
    newStatus: LiveOrderStatus;
    filledShareMicros: bigint;
    action: "UPDATED" | "MATCHED" | "TIMED_OUT" | "UNCHANGED";
}
