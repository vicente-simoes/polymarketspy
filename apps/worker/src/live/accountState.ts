/**
 * Live Account State Cache
 *
 * This module manages the in-memory state of the live trading wallet:
 * - Tracks available cash and reserved cash
 * - Tracks available shares and reserved shares per token
 * - Manages reservations to prevent oversubscription
 * - Provides submission serialization (concurrency=1 per wallet)
 * - Health gating based on state freshness
 *
 * The state is seeded from authoritative reconciliation and updated
 * optimistically on fills/cancels. Reconciliation corrects any drift.
 */

import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "account-state" });

// ─── Type Definitions ─────────────────────────────────────────────────────────

/** Reservation handle returned when reserving funds/shares */
export interface Reservation {
    id: string;
    type: "BUY" | "SELL";
    tokenId: string;
    amountMicros: bigint; // Cash for BUY, shares for SELL
    createdAt: number;
}

/** Result of attempting to reserve funds/shares */
export type ReservationResult =
    | { success: true; reservation: Reservation }
    | { success: false; reason: ReservationFailureReason; available: bigint; requested: bigint };

export type ReservationFailureReason =
    | "INSUFFICIENT_CASH"
    | "INSUFFICIENT_SHARES"
    | "STATE_NOT_INITIALIZED"
    | "STATE_STALE";

/** Current account state snapshot */
export interface AccountStateSnapshot {
    cashAvailableMicros: bigint;
    reservedCashMicros: bigint;
    positionsByTokenId: Map<string, bigint>; // tokenId -> shareMicros
    reservedSharesByTokenId: Map<string, bigint>;
    lastReconciledAt: Date | null;
    isHealthy: boolean;
    submissionsPaused: boolean;
    pauseReason: string | null;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
    /** Max age before state is considered stale (2 minutes) */
    MAX_STATE_AGE_MS: 2 * 60 * 1000,
};

// ─── Internal State ───────────────────────────────────────────────────────────

interface LiveAccountState {
    // Cash tracking
    cashAvailableMicros: bigint;
    reservedCashMicros: bigint;

    // Position tracking per token
    sharesAvailableMicrosByTokenId: Map<string, bigint>;
    reservedSharesMicrosByTokenId: Map<string, bigint>;

    // Active reservations (for release on fill/cancel)
    activeReservations: Map<string, Reservation>;

    // Health tracking
    lastReconciledAt: Date | null;
    isInitialized: boolean;
}

const state: LiveAccountState = {
    cashAvailableMicros: 0n,
    reservedCashMicros: 0n,
    sharesAvailableMicrosByTokenId: new Map(),
    reservedSharesMicrosByTokenId: new Map(),
    activeReservations: new Map(),
    lastReconciledAt: null,
    isInitialized: false,
};

// Submission serialization state
let submissionLockPromise: Promise<void> | null = null;
let submissionsPaused = false;
let pauseReason: string | null = null;

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize state from authoritative source (called by reconciliation).
 * This resets all reservations and sets the authoritative cash/positions.
 *
 * @param cashMicros - Available cash in micros
 * @param positions - Map of tokenId -> shareMicros
 */
export function initializeFromReconciliation(
    cashMicros: bigint,
    positions: Map<string, bigint>
): void {
    const log = logger.child({ cashMicros: cashMicros.toString(), positionCount: positions.size });

    // Reset all state
    state.cashAvailableMicros = cashMicros;
    state.reservedCashMicros = 0n;
    state.sharesAvailableMicrosByTokenId = new Map(positions);
    state.reservedSharesMicrosByTokenId = new Map();
    state.activeReservations = new Map();
    state.lastReconciledAt = new Date();
    state.isInitialized = true;

    log.info("Initialized live account state from reconciliation");
}

// ─── Reservation API ──────────────────────────────────────────────────────────

/**
 * Reserve cash for a BUY order (worst-case: limitPrice * size).
 *
 * @param tokenId - The token being bought (for tracking)
 * @param limitPriceMicros - The limit price in micros
 * @param sizeShareMicros - The order size in share micros
 * @param reservationId - Unique ID for this reservation (use idempotencyKey)
 * @returns ReservationResult indicating success or failure
 */
export function reserveCashForBuy(
    tokenId: string,
    limitPriceMicros: number,
    sizeShareMicros: bigint,
    reservationId: string
): ReservationResult {
    const log = logger.child({ tokenId, reservationId });

    // Check state health
    if (!state.isInitialized) {
        log.warn("Cannot reserve: state not initialized");
        return { success: false, reason: "STATE_NOT_INITIALIZED", available: 0n, requested: 0n };
    }

    if (!isStateFresh()) {
        log.warn("Cannot reserve: state is stale");
        const available = state.cashAvailableMicros - state.reservedCashMicros;
        return { success: false, reason: "STATE_STALE", available, requested: 0n };
    }

    // Check for existing reservation with same ID (idempotent)
    const existing = state.activeReservations.get(reservationId);
    if (existing) {
        log.debug("Reservation already exists, returning existing");
        return { success: true, reservation: existing };
    }

    // Calculate required cash (worst-case)
    const requiredCash = (BigInt(limitPriceMicros) * sizeShareMicros) / BigInt(1_000_000);
    const available = state.cashAvailableMicros - state.reservedCashMicros;

    if (requiredCash > available) {
        log.debug({
            requiredCash: requiredCash.toString(),
            available: available.toString(),
        }, "Insufficient cash for BUY reservation");
        return { success: false, reason: "INSUFFICIENT_CASH", available, requested: requiredCash };
    }

    // Create reservation
    state.reservedCashMicros += requiredCash;
    const reservation: Reservation = {
        id: reservationId,
        type: "BUY",
        tokenId,
        amountMicros: requiredCash,
        createdAt: Date.now(),
    };
    state.activeReservations.set(reservationId, reservation);

    log.debug({
        reservedCash: requiredCash.toString(),
        totalReservedCash: state.reservedCashMicros.toString(),
    }, "Reserved cash for BUY");

    return { success: true, reservation };
}

/**
 * Reserve shares for a SELL order.
 *
 * @param tokenId - The token being sold
 * @param sizeShareMicros - The order size in share micros
 * @param reservationId - Unique ID for this reservation (use idempotencyKey)
 * @returns ReservationResult indicating success or failure
 */
export function reserveSharesForSell(
    tokenId: string,
    sizeShareMicros: bigint,
    reservationId: string
): ReservationResult {
    const log = logger.child({ tokenId, reservationId });

    // Check state health
    if (!state.isInitialized) {
        log.warn("Cannot reserve: state not initialized");
        return { success: false, reason: "STATE_NOT_INITIALIZED", available: 0n, requested: 0n };
    }

    if (!isStateFresh()) {
        log.warn("Cannot reserve: state is stale");
        const totalShares = state.sharesAvailableMicrosByTokenId.get(tokenId) ?? 0n;
        const reserved = state.reservedSharesMicrosByTokenId.get(tokenId) ?? 0n;
        return { success: false, reason: "STATE_STALE", available: totalShares - reserved, requested: sizeShareMicros };
    }

    // Check for existing reservation with same ID (idempotent)
    const existing = state.activeReservations.get(reservationId);
    if (existing) {
        log.debug("Reservation already exists, returning existing");
        return { success: true, reservation: existing };
    }

    // Calculate available shares
    const totalShares = state.sharesAvailableMicrosByTokenId.get(tokenId) ?? 0n;
    const reservedShares = state.reservedSharesMicrosByTokenId.get(tokenId) ?? 0n;
    const available = totalShares - reservedShares;

    if (sizeShareMicros > available) {
        log.debug({
            requested: sizeShareMicros.toString(),
            available: available.toString(),
        }, "Insufficient shares for SELL reservation");
        return { success: false, reason: "INSUFFICIENT_SHARES", available, requested: sizeShareMicros };
    }

    // Create reservation
    state.reservedSharesMicrosByTokenId.set(tokenId, reservedShares + sizeShareMicros);
    const reservation: Reservation = {
        id: reservationId,
        type: "SELL",
        tokenId,
        amountMicros: sizeShareMicros,
        createdAt: Date.now(),
    };
    state.activeReservations.set(reservationId, reservation);

    log.debug({
        reservedShares: sizeShareMicros.toString(),
        totalReservedShares: (reservedShares + sizeShareMicros).toString(),
    }, "Reserved shares for SELL");

    return { success: true, reservation };
}

/**
 * Release a reservation (on fill, cancel, or failure).
 *
 * @param reservationId - The ID of the reservation to release
 * @returns true if reservation was found and released, false otherwise
 */
export function releaseReservation(reservationId: string): boolean {
    const log = logger.child({ reservationId });

    const reservation = state.activeReservations.get(reservationId);
    if (!reservation) {
        log.debug("Reservation not found, nothing to release");
        return false;
    }

    // Release based on type
    if (reservation.type === "BUY") {
        state.reservedCashMicros -= reservation.amountMicros;
        // Ensure we don't go negative due to rounding
        if (state.reservedCashMicros < 0n) {
            state.reservedCashMicros = 0n;
        }
    } else {
        const currentReserved = state.reservedSharesMicrosByTokenId.get(reservation.tokenId) ?? 0n;
        const newReserved = currentReserved - reservation.amountMicros;
        if (newReserved <= 0n) {
            state.reservedSharesMicrosByTokenId.delete(reservation.tokenId);
        } else {
            state.reservedSharesMicrosByTokenId.set(reservation.tokenId, newReserved);
        }
    }

    state.activeReservations.delete(reservationId);
    log.debug({ type: reservation.type, amount: reservation.amountMicros.toString() }, "Released reservation");

    return true;
}

// ─── State Updates ────────────────────────────────────────────────────────────

/**
 * Update state after a fill (BUY decreases cash + increases shares, SELL opposite).
 * Also releases the associated reservation if provided.
 *
 * @param tokenId - The token involved
 * @param side - BUY or SELL
 * @param shareMicros - Shares filled
 * @param notionalMicros - Cash amount (price * shares)
 * @param reservationId - Optional reservation to release
 */
export function applyFill(
    tokenId: string,
    side: "BUY" | "SELL",
    shareMicros: bigint,
    notionalMicros: bigint,
    feeMicros?: bigint | null,
    reservationId?: string
): void {
    const log = logger.child({ tokenId, side, shareMicros: shareMicros.toString(), notionalMicros: notionalMicros.toString() });

    const fee = feeMicros ?? 0n;
    const totalNotional = notionalMicros + fee;

    if (side === "BUY") {
        // BUY: decrease cash, increase shares (fees reduce cash as well)
        state.cashAvailableMicros -= totalNotional;
        if (state.cashAvailableMicros < 0n) {
            log.warn({ cashAvailable: state.cashAvailableMicros.toString() }, "Cash went negative after BUY fill");
            state.cashAvailableMicros = 0n;
        }

        const currentShares = state.sharesAvailableMicrosByTokenId.get(tokenId) ?? 0n;
        state.sharesAvailableMicrosByTokenId.set(tokenId, currentShares + shareMicros);
    } else {
        // SELL: increase cash, decrease shares (fees reduce proceeds)
        state.cashAvailableMicros += notionalMicros - fee;

        const currentShares = state.sharesAvailableMicrosByTokenId.get(tokenId) ?? 0n;
        const newShares = currentShares - shareMicros;
        if (newShares <= 0n) {
            state.sharesAvailableMicrosByTokenId.delete(tokenId);
        } else {
            state.sharesAvailableMicrosByTokenId.set(tokenId, newShares);
        }
    }

    // Release reservation if provided
    if (reservationId) {
        releaseReservation(reservationId);
    }

    log.debug("Applied fill to account state");
}

/**
 * Update state from authoritative reconciliation.
 * Preserves active reservations but corrects the base state.
 *
 * @param cashMicros - Authoritative cash balance
 * @param positions - Authoritative positions map
 */
export function updateFromReconciliation(
    cashMicros: bigint,
    positions: Map<string, bigint>
): void {
    const log = logger.child({ cashMicros: cashMicros.toString(), positionCount: positions.size });

    // Update base state (authoritative)
    state.cashAvailableMicros = cashMicros;
    state.sharesAvailableMicrosByTokenId = new Map(positions);
    state.lastReconciledAt = new Date();

    // Note: We preserve reservations - they will be released when orders complete
    // If reconciliation shows we have less than we thought, active reservations
    // may prevent new orders until they complete/release

    log.debug({ activeReservations: state.activeReservations.size }, "Updated account state from reconciliation");
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get current state snapshot for diagnostics/UI.
 */
export function getStateSnapshot(): AccountStateSnapshot {
    return {
        cashAvailableMicros: state.cashAvailableMicros,
        reservedCashMicros: state.reservedCashMicros,
        positionsByTokenId: new Map(state.sharesAvailableMicrosByTokenId),
        reservedSharesByTokenId: new Map(state.reservedSharesMicrosByTokenId),
        lastReconciledAt: state.lastReconciledAt,
        isHealthy: isStateHealthy(),
        submissionsPaused,
        pauseReason,
    };
}

/**
 * Check if state is healthy (initialized, not stale, not paused).
 */
export function isStateHealthy(): boolean {
    if (!state.isInitialized) return false;
    if (submissionsPaused) return false;
    if (!isStateFresh()) return false;
    return true;
}

/**
 * Check if state is fresh (within TTL).
 */
function isStateFresh(): boolean {
    if (!state.lastReconciledAt) return false;
    const ageMs = Date.now() - state.lastReconciledAt.getTime();
    return ageMs < CONFIG.MAX_STATE_AGE_MS;
}

/**
 * Get available cash after reservations.
 */
export function getAvailableCash(): bigint {
    return state.cashAvailableMicros - state.reservedCashMicros;
}

/**
 * Get available shares for a token after reservations.
 */
export function getAvailableShares(tokenId: string): bigint {
    const total = state.sharesAvailableMicrosByTokenId.get(tokenId) ?? 0n;
    const reserved = state.reservedSharesMicrosByTokenId.get(tokenId) ?? 0n;
    return total - reserved;
}

// ─── Submission Serialization ─────────────────────────────────────────────────

/**
 * Acquire the submission mutex (concurrency=1).
 * Returns a release function that must be called when done.
 *
 * @returns A function to release the lock
 */
export async function acquireSubmissionLock(): Promise<() => void> {
    const log = logger.child({});

    // Wait for any existing lock
    while (submissionLockPromise) {
        log.debug("Waiting for submission lock");
        await submissionLockPromise;
    }

    // Create new lock
    let releaseFunc!: () => void;
    submissionLockPromise = new Promise<void>((resolve) => {
        releaseFunc = resolve;
    });

    log.debug("Acquired submission lock");

    // Return release function
    return () => {
        submissionLockPromise = null;
        releaseFunc();
        log.debug("Released submission lock");
    };
}

/**
 * Check if submissions are paused (e.g., due to SUBMISSION_UNKNOWN).
 */
export function areSubmissionsPaused(): boolean {
    return submissionsPaused;
}

/**
 * Get the reason why submissions are paused.
 */
export function getPauseReason(): string | null {
    return pauseReason;
}

/**
 * Pause submissions (call when SUBMISSION_UNKNOWN occurs).
 *
 * @param reason - Human-readable reason for pausing
 */
export function pauseSubmissions(reason: string): void {
    submissionsPaused = true;
    pauseReason = reason;
    logger.warn({ reason }, "Live submissions paused");
}

/**
 * Resume submissions (after manual clearance or reconciliation).
 */
export function resumeSubmissions(): void {
    const wasReason = pauseReason;
    submissionsPaused = false;
    pauseReason = null;
    logger.info({ previousReason: wasReason }, "Live submissions resumed");
}

// ─── Testing/Debug ────────────────────────────────────────────────────────────

/**
 * Reset all state (for testing only).
 */
export function resetState(): void {
    state.cashAvailableMicros = 0n;
    state.reservedCashMicros = 0n;
    state.sharesAvailableMicrosByTokenId.clear();
    state.reservedSharesMicrosByTokenId.clear();
    state.activeReservations.clear();
    state.lastReconciledAt = null;
    state.isInitialized = false;
    submissionLockPromise = null;
    submissionsPaused = false;
    pauseReason = null;
    logger.debug("Reset account state");
}
