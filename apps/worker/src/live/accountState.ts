/**
 * Live Account State Cache + Reservations.
 *
 * Maintains an in-memory view of the live wallet's cash and positions,
 * with reservation tracking to prevent oversubscription during order placement.
 *
 * Key features:
 * - Tracks available vs reserved cash/shares
 * - Pre-trade affordability checks
 * - Reservation create/release lifecycle
 * - Submission mutex (concurrency=1 per wallet)
 * - Pause mechanism for SUBMISSION_UNKNOWN recovery
 *
 * Updated by:
 * - Reconciliation (authoritative reset)
 * - User Channel WS (optimistic fill updates)
 * - Live Executor (reservation management)
 */

import { TradeSide } from "@prisma/client";
import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "live-account-state" });

/**
 * Fee buffer in basis points to add to BUY reservations.
 * 0.1% = 10 bps - covers potential trading fees.
 */
const FEE_BUFFER_BPS = 10;

/**
 * Reservation for a pending order.
 */
interface Reservation {
    /** Order identifier (LiveOrder.id or idempotencyKey). */
    orderId: string;
    /** Trade side. */
    side: TradeSide;
    /** Token being traded. */
    tokenId: string;
    /** Cash reserved (for BUY orders). */
    cashMicros?: bigint;
    /** Shares reserved (for SELL orders). */
    shareMicros?: bigint;
    /** When the reservation was created. */
    createdAt: Date;
}

/**
 * Live account state snapshot.
 */
export interface LiveAccountStateSnapshot {
    /** Available cash from last reconciliation. */
    cashAvailableMicros: bigint;
    /** Cash currently reserved for pending BUYs. */
    reservedCashMicros: bigint;
    /** Effective cash (available - reserved). */
    effectiveCashMicros: bigint;
    /** Available shares by token. */
    sharesAvailableMicros: Map<string, bigint>;
    /** Reserved shares by token. */
    reservedSharesMicros: Map<string, bigint>;
    /** When last reconciled. */
    lastReconciledAt: Date | null;
    /** Whether state has been initialized. */
    isInitialized: boolean;
    /** Number of active reservations. */
    activeReservationCount: number;
}

/**
 * Submission pause status.
 */
export interface SubmissionPauseStatus {
    paused: boolean;
    reason: string | null;
    pausedAt: Date | null;
}

// ─── State ─────────────────────────────────────────────────────────────────

/** Available cash from last reconciliation. */
let cashAvailableMicros: bigint = BigInt(0);

/** Shares available by token from last reconciliation. */
const sharesAvailableMicros = new Map<string, bigint>();

/** Active reservations by order ID. */
const activeReservations = new Map<string, Reservation>();

/** When state was last reconciled. */
let lastReconciledAt: Date | null = null;

/** Whether state has been initialized. */
let isInitialized = false;

/** Whether submissions are paused. */
let submissionsPaused = false;

/** Reason for pause. */
let pauseReason: string | null = null;

/** When submissions were paused. */
let pausedAt: Date | null = null;

// ─── Computed Properties ───────────────────────────────────────────────────

/**
 * Get total reserved cash across all BUY reservations.
 */
function getReservedCashMicros(): bigint {
    let total = BigInt(0);
    for (const reservation of activeReservations.values()) {
        if (reservation.cashMicros) {
            total += reservation.cashMicros;
        }
    }
    return total;
}

/**
 * Get total reserved shares for a token across all SELL reservations.
 */
function getReservedSharesMicros(tokenId: string): bigint {
    let total = BigInt(0);
    for (const reservation of activeReservations.values()) {
        if (reservation.tokenId === tokenId && reservation.shareMicros) {
            total += reservation.shareMicros;
        }
    }
    return total;
}

/**
 * Get effective available cash (available - reserved).
 */
export function getEffectiveCash(): bigint {
    return cashAvailableMicros - getReservedCashMicros();
}

/**
 * Get effective available shares for a token (available - reserved).
 */
export function getEffectiveShares(tokenId: string): bigint {
    const available = sharesAvailableMicros.get(tokenId) ?? BigInt(0);
    const reserved = getReservedSharesMicros(tokenId);
    return available - reserved;
}

// ─── Initialization ────────────────────────────────────────────────────────

/**
 * Initialize account state from reconciliation data.
 *
 * Call this on startup after fetching authoritative state from the exchange.
 */
export function initializeFromReconciliation(
    cashMicros: bigint,
    positions: Map<string, bigint>
): void {
    logger.info(
        {
            cashMicros: cashMicros.toString(),
            positionCount: positions.size,
        },
        "Initializing live account state from reconciliation"
    );

    // Clear existing state
    cashAvailableMicros = cashMicros;
    sharesAvailableMicros.clear();
    activeReservations.clear();

    // Set positions
    for (const [tokenId, shareMicros] of positions) {
        if (shareMicros > BigInt(0)) {
            sharesAvailableMicros.set(tokenId, shareMicros);
        }
    }

    lastReconciledAt = new Date();
    isInitialized = true;

    logger.info(
        {
            effectiveCash: getEffectiveCash().toString(),
            positionCount: sharesAvailableMicros.size,
        },
        "Live account state initialized"
    );
}

/**
 * Check if account state is initialized.
 */
export function isStateInitialized(): boolean {
    return isInitialized;
}

// ─── Pre-trade Checks ──────────────────────────────────────────────────────

/**
 * Check if we can afford a BUY order.
 *
 * @param notionalMicros - Total cost of the order (price * shares / 1M)
 * @returns true if effective cash >= notional
 */
export function canAffordBuy(notionalMicros: bigint): boolean {
    if (!isInitialized) {
        logger.warn("canAffordBuy called before initialization");
        return false;
    }

    const effectiveCash = getEffectiveCash();
    const canAfford = effectiveCash >= notionalMicros;

    logger.debug(
        {
            notionalMicros: notionalMicros.toString(),
            effectiveCash: effectiveCash.toString(),
            canAfford,
        },
        "BUY affordability check"
    );

    return canAfford;
}

/**
 * Check if we can afford a SELL order.
 *
 * @param tokenId - Token to sell
 * @param shareMicros - Shares to sell
 * @returns true if effective shares >= shareMicros
 */
export function canAffordSell(tokenId: string, shareMicros: bigint): boolean {
    if (!isInitialized) {
        logger.warn("canAffordSell called before initialization");
        return false;
    }

    const effectiveShares = getEffectiveShares(tokenId);
    const canAfford = effectiveShares >= shareMicros;

    logger.debug(
        {
            tokenId,
            shareMicros: shareMicros.toString(),
            effectiveShares: effectiveShares.toString(),
            canAfford,
        },
        "SELL affordability check"
    );

    return canAfford;
}

/**
 * Get the maximum BUY size we can afford given current state.
 *
 * @param priceMicros - Price per share in micros
 * @returns Maximum shares we can buy (in share-micros)
 */
export function getMaxAffordableBuyShares(priceMicros: number): bigint {
    if (!isInitialized || priceMicros <= 0) {
        return BigInt(0);
    }

    const effectiveCash = getEffectiveCash();
    // notional = price * shares / 1M → shares = notional * 1M / price
    // With fee buffer: effectiveCash / (1 + fee) = usable cash
    const feeMultiplier = 10_000 + FEE_BUFFER_BPS;
    const usableCash = (effectiveCash * BigInt(10_000)) / BigInt(feeMultiplier);
    const maxShares = (usableCash * BigInt(1_000_000)) / BigInt(priceMicros);

    return maxShares > BigInt(0) ? maxShares : BigInt(0);
}

/**
 * Get the maximum SELL size for a token given current state.
 *
 * @param tokenId - Token to sell
 * @returns Maximum shares we can sell (in share-micros)
 */
export function getMaxAffordableSellShares(tokenId: string): bigint {
    if (!isInitialized) {
        return BigInt(0);
    }

    const effectiveShares = getEffectiveShares(tokenId);
    return effectiveShares > BigInt(0) ? effectiveShares : BigInt(0);
}

// ─── Reservation Management ────────────────────────────────────────────────

/**
 * Reserve cash for a BUY order.
 *
 * Call this BEFORE submitting the order to the exchange.
 *
 * @param orderId - Unique order identifier
 * @param tokenId - Token being bought
 * @param notionalMicros - Cost of the order
 */
export function reserveForBuy(
    orderId: string,
    tokenId: string,
    notionalMicros: bigint
): void {
    if (activeReservations.has(orderId)) {
        logger.warn({ orderId }, "Reservation already exists for order");
        return;
    }

    // Add fee buffer
    const feeBuffer = (notionalMicros * BigInt(FEE_BUFFER_BPS)) / BigInt(10_000);
    const totalReservation = notionalMicros + feeBuffer;

    const reservation: Reservation = {
        orderId,
        side: TradeSide.BUY,
        tokenId,
        cashMicros: totalReservation,
        createdAt: new Date(),
    };

    activeReservations.set(orderId, reservation);

    logger.info(
        {
            orderId,
            tokenId,
            notionalMicros: notionalMicros.toString(),
            reservedCash: totalReservation.toString(),
            newEffectiveCash: getEffectiveCash().toString(),
        },
        "Reserved cash for BUY order"
    );
}

/**
 * Reserve shares for a SELL order.
 *
 * Call this BEFORE submitting the order to the exchange.
 *
 * @param orderId - Unique order identifier
 * @param tokenId - Token being sold
 * @param shareMicros - Shares to sell
 */
export function reserveForSell(
    orderId: string,
    tokenId: string,
    shareMicros: bigint
): void {
    if (activeReservations.has(orderId)) {
        logger.warn({ orderId }, "Reservation already exists for order");
        return;
    }

    const reservation: Reservation = {
        orderId,
        side: TradeSide.SELL,
        tokenId,
        shareMicros,
        createdAt: new Date(),
    };

    activeReservations.set(orderId, reservation);

    logger.info(
        {
            orderId,
            tokenId,
            shareMicros: shareMicros.toString(),
            newEffectiveShares: getEffectiveShares(tokenId).toString(),
        },
        "Reserved shares for SELL order"
    );
}

/**
 * Release a reservation.
 *
 * Call this when an order is:
 * - Fully filled (after applying fills)
 * - Canceled
 * - Rejected
 * - Failed
 *
 * @param orderId - Order identifier to release
 */
export function releaseReservation(orderId: string): void {
    const reservation = activeReservations.get(orderId);
    if (!reservation) {
        logger.debug({ orderId }, "No reservation to release");
        return;
    }

    activeReservations.delete(orderId);

    logger.info(
        {
            orderId,
            side: reservation.side,
            tokenId: reservation.tokenId,
            releasedCash: reservation.cashMicros?.toString(),
            releasedShares: reservation.shareMicros?.toString(),
        },
        "Released reservation"
    );
}

/**
 * Adjust a reservation after a partial fill.
 *
 * Reduces the reservation by the filled amount.
 *
 * @param orderId - Order identifier
 * @param filledNotionalMicros - For BUY: cash used
 * @param filledShareMicros - For SELL: shares sold
 */
export function adjustReservationForFill(
    orderId: string,
    filledNotionalMicros: bigint,
    filledShareMicros: bigint
): void {
    const reservation = activeReservations.get(orderId);
    if (!reservation) {
        logger.debug({ orderId }, "No reservation to adjust");
        return;
    }

    if (reservation.side === TradeSide.BUY && reservation.cashMicros) {
        // Add fee buffer to filled amount for accurate reduction
        const feeBuffer = (filledNotionalMicros * BigInt(FEE_BUFFER_BPS)) / BigInt(10_000);
        const reduction = filledNotionalMicros + feeBuffer;
        reservation.cashMicros = reservation.cashMicros > reduction
            ? reservation.cashMicros - reduction
            : BigInt(0);

        logger.debug(
            {
                orderId,
                filledNotional: filledNotionalMicros.toString(),
                remainingReservation: reservation.cashMicros.toString(),
            },
            "Adjusted BUY reservation for partial fill"
        );
    } else if (reservation.side === TradeSide.SELL && reservation.shareMicros) {
        reservation.shareMicros = reservation.shareMicros > filledShareMicros
            ? reservation.shareMicros - filledShareMicros
            : BigInt(0);

        logger.debug(
            {
                orderId,
                filledShares: filledShareMicros.toString(),
                remainingReservation: reservation.shareMicros.toString(),
            },
            "Adjusted SELL reservation for partial fill"
        );
    }

    // If reservation is now zero, remove it
    if (
        (reservation.cashMicros === undefined || reservation.cashMicros === BigInt(0)) &&
        (reservation.shareMicros === undefined || reservation.shareMicros === BigInt(0))
    ) {
        activeReservations.delete(orderId);
        logger.debug({ orderId }, "Reservation fully consumed, removed");
    }
}

// ─── Fill Application ──────────────────────────────────────────────────────

/**
 * Apply a fill to the account state.
 *
 * Call this when receiving fill events from user channel or reconciliation.
 * This updates the available balances (optimistic update).
 *
 * @param side - Trade side
 * @param tokenId - Token traded
 * @param shareMicros - Shares filled
 * @param notionalMicros - Cash exchanged
 */
export function applyFill(
    side: TradeSide,
    tokenId: string,
    shareMicros: bigint,
    notionalMicros: bigint
): void {
    if (!isInitialized) {
        logger.warn("applyFill called before initialization");
        return;
    }

    if (side === TradeSide.BUY) {
        // BUY: cash decreases, shares increase
        cashAvailableMicros -= notionalMicros;
        const currentShares = sharesAvailableMicros.get(tokenId) ?? BigInt(0);
        sharesAvailableMicros.set(tokenId, currentShares + shareMicros);

        logger.debug(
            {
                side,
                tokenId,
                shareMicros: shareMicros.toString(),
                notionalMicros: notionalMicros.toString(),
                newCash: cashAvailableMicros.toString(),
                newShares: sharesAvailableMicros.get(tokenId)?.toString(),
            },
            "Applied BUY fill"
        );
    } else {
        // SELL: shares decrease, cash increases
        const currentShares = sharesAvailableMicros.get(tokenId) ?? BigInt(0);
        const newShares = currentShares - shareMicros;
        if (newShares > BigInt(0)) {
            sharesAvailableMicros.set(tokenId, newShares);
        } else {
            sharesAvailableMicros.delete(tokenId);
        }
        cashAvailableMicros += notionalMicros;

        logger.debug(
            {
                side,
                tokenId,
                shareMicros: shareMicros.toString(),
                notionalMicros: notionalMicros.toString(),
                newCash: cashAvailableMicros.toString(),
                newShares: newShares.toString(),
            },
            "Applied SELL fill"
        );
    }
}

// ─── Reconciliation ────────────────────────────────────────────────────────

/**
 * Reconcile account state with authoritative exchange data.
 *
 * This is the safety net - resets all state to match exchange reality.
 * Clears all reservations as they should match open orders from exchange.
 *
 * @param cashMicros - Authoritative cash balance
 * @param positions - Authoritative positions
 */
export function reconcile(
    cashMicros: bigint,
    positions: Map<string, bigint>
): void {
    const priorCash = cashAvailableMicros;
    const priorReservations = activeReservations.size;

    // Reset state
    cashAvailableMicros = cashMicros;
    sharesAvailableMicros.clear();
    activeReservations.clear();

    for (const [tokenId, shareMicros] of positions) {
        if (shareMicros > BigInt(0)) {
            sharesAvailableMicros.set(tokenId, shareMicros);
        }
    }

    lastReconciledAt = new Date();
    isInitialized = true;

    logger.info(
        {
            priorCash: priorCash.toString(),
            newCash: cashMicros.toString(),
            priorReservations,
            positionCount: sharesAvailableMicros.size,
        },
        "Reconciled live account state"
    );
}

// ─── State Accessors ───────────────────────────────────────────────────────

/**
 * Get current account state snapshot.
 */
export function getState(): LiveAccountStateSnapshot {
    const reservedSharesMap = new Map<string, bigint>();
    for (const reservation of activeReservations.values()) {
        if (reservation.shareMicros) {
            const current = reservedSharesMap.get(reservation.tokenId) ?? BigInt(0);
            reservedSharesMap.set(reservation.tokenId, current + reservation.shareMicros);
        }
    }

    return {
        cashAvailableMicros,
        reservedCashMicros: getReservedCashMicros(),
        effectiveCashMicros: getEffectiveCash(),
        sharesAvailableMicros: new Map(sharesAvailableMicros),
        reservedSharesMicros: reservedSharesMap,
        lastReconciledAt,
        isInitialized,
        activeReservationCount: activeReservations.size,
    };
}

/**
 * Get list of active reservations (for diagnostics).
 */
export function getActiveReservations(): Reservation[] {
    return [...activeReservations.values()];
}

// ─── Submission Mutex ──────────────────────────────────────────────────────

/**
 * Submission mutex for serializing live order placement.
 *
 * Ensures only one order is being submitted at a time to prevent
 * race conditions in reservation management.
 */
class SubmissionMutex {
    private locked = false;
    private queue: Array<{
        resolve: () => void;
        reject: (err: Error) => void;
    }> = [];

    /**
     * Acquire the mutex. Waits if already locked.
     */
    async acquire(): Promise<void> {
        if (!this.locked) {
            this.locked = true;
            logger.debug("Submission mutex acquired");
            return;
        }

        // Wait in queue
        return new Promise((resolve, reject) => {
            this.queue.push({ resolve, reject });
            logger.debug({ queueLength: this.queue.length }, "Waiting for submission mutex");
        });
    }

    /**
     * Release the mutex. Processes next waiter if any.
     */
    release(): void {
        const next = this.queue.shift();
        if (next) {
            logger.debug({ remainingQueue: this.queue.length }, "Passing mutex to next waiter");
            next.resolve();
        } else {
            this.locked = false;
            logger.debug("Submission mutex released");
        }
    }

    /**
     * Check if mutex is currently locked.
     */
    isLocked(): boolean {
        return this.locked;
    }

    /**
     * Get queue length.
     */
    getQueueLength(): number {
        return this.queue.length;
    }

    /**
     * Reject all waiters (e.g., on shutdown).
     */
    rejectAll(reason: string): void {
        const waiters = this.queue.splice(0, this.queue.length);
        for (const waiter of waiters) {
            waiter.reject(new Error(reason));
        }
        this.locked = false;
    }
}

/** Singleton submission mutex. */
const submissionMutex = new SubmissionMutex();

/**
 * Acquire the submission mutex.
 *
 * Use with try/finally to ensure release:
 * ```
 * await acquireSubmissionMutex();
 * try {
 *     // ... submit order ...
 * } finally {
 *     releaseSubmissionMutex();
 * }
 * ```
 */
export async function acquireSubmissionMutex(): Promise<void> {
    // Check if paused first
    if (submissionsPaused) {
        throw new Error(`Submissions paused: ${pauseReason}`);
    }
    await submissionMutex.acquire();
}

/**
 * Release the submission mutex.
 */
export function releaseSubmissionMutex(): void {
    submissionMutex.release();
}

/**
 * Check if submission mutex is locked.
 */
export function isSubmissionMutexLocked(): boolean {
    return submissionMutex.isLocked();
}

/**
 * Get submission mutex status.
 */
export function getSubmissionMutexStatus(): {
    locked: boolean;
    queueLength: number;
} {
    return {
        locked: submissionMutex.isLocked(),
        queueLength: submissionMutex.getQueueLength(),
    };
}

// ─── Pause Mechanism ───────────────────────────────────────────────────────

/**
 * Pause live submissions.
 *
 * Use this when encountering SUBMISSION_UNKNOWN or other conditions
 * that require manual intervention before continuing.
 */
export function pauseSubmissions(reason: string): void {
    submissionsPaused = true;
    pauseReason = reason;
    pausedAt = new Date();

    logger.warn({ reason }, "Live submissions PAUSED");
}

/**
 * Resume live submissions.
 */
export function resumeSubmissions(): void {
    const wasPaused = submissionsPaused;
    const priorReason = pauseReason;

    submissionsPaused = false;
    pauseReason = null;
    pausedAt = null;

    if (wasPaused) {
        logger.info({ priorReason }, "Live submissions RESUMED");
    }
}

/**
 * Get submission pause status.
 */
export function getSubmissionPauseStatus(): SubmissionPauseStatus {
    return {
        paused: submissionsPaused,
        reason: pauseReason,
        pausedAt,
    };
}

/**
 * Check if submissions are paused.
 */
export function areSubmissionsPaused(): boolean {
    return submissionsPaused;
}

// ─── Reset (for testing) ───────────────────────────────────────────────────

/**
 * Reset all state (for testing only).
 */
export function resetState(): void {
    cashAvailableMicros = BigInt(0);
    sharesAvailableMicros.clear();
    activeReservations.clear();
    lastReconciledAt = null;
    isInitialized = false;
    submissionsPaused = false;
    pauseReason = null;
    pausedAt = null;
    submissionMutex.rejectAll("State reset");

    logger.debug("Live account state reset");
}
