/**
 * Shared trading types for decision engine and executors.
 *
 * These types are used by both paper and live execution paths.
 */

import { TradeSide } from "@prisma/client";
import type { ReasonCode } from "@copybot/shared";
import type { SimulationResult } from "../simulate/book.js";

/**
 * Copy decision outcome.
 */
export type CopyDecisionType = "EXECUTE" | "SKIP";

/**
 * Book snapshot at decision time.
 * Captures the state used to make the copy decision.
 */
export interface BookSnapshot {
    /** Best bid price in micros. */
    bestBidMicros: number;
    /** Best ask price in micros. */
    bestAskMicros: number;
    /** Mid price in micros. */
    midPriceMicros: number;
    /** Spread in micros (bestAsk - bestBid). */
    spreadMicros: number;
    /** Source of the book data. */
    source: "WS" | "REST";
    /** Whether the book was considered stale. */
    stale: boolean;
    /** Age of the book in milliseconds (if known). */
    ageMs?: number;
}

/**
 * Sizing metadata for observability.
 * Captures the sizing computation details for debugging/audit.
 */
export interface SizingMetadata {
    /** Effective copy rate in bps (for budgeted dynamic mode). */
    effectiveRateBps?: number;
    /** Whether target was clamped to minimum. */
    clampedToMin: boolean;
    /** Whether target was clamped to maximum. */
    clampedToMax: boolean;
    /** Whether target was clamped by bankroll limit. */
    clampedByBankroll: boolean;
    /** Whether rate was clamped to rMin (budgeted dynamic). */
    clampedToRMin?: boolean;
    /** Whether rate was clamped to rMax (budgeted dynamic). */
    clampedToRMax?: boolean;
    /** Whether target was capped by budget headroom (HARD enforcement). */
    budgetCapped?: boolean;
    /** Remaining budget headroom in micros (HARD enforcement). */
    budgetHeadroomMicros?: bigint;
    /** Leader exposure used for budgeted dynamic computation. */
    leaderExposureMicros?: bigint;
}

/**
 * Copy intent - the output of the decision engine.
 *
 * Contains all information needed to execute a copy trade in either
 * paper or live mode. The decision is mode-agnostic; executors handle
 * mode-specific persistence and order placement.
 */
export interface CopyIntent {
    // ─── Identity ───────────────────────────────────────────────────────────

    /** Followed user who triggered this copy. */
    followedUserId: string;
    /** Token ID (outcome token / asset_id). */
    tokenId: string;
    /** Trade side (BUY or SELL). */
    side: TradeSide;
    /** Source type of this copy attempt. */
    sourceType: "IMMEDIATE" | "BUFFER" | "AGGREGATOR";
    /** Stable aggregation key for deduplication. */
    groupKey: string;
    /**
     * Idempotency key for order placement deduplication.
     * Format: v1_<sha256-hash>
     * Deterministic from (followedUserId, tokenId, side, groupKey).
     */
    idempotencyKey: string;

    // ─── Sizing ─────────────────────────────────────────────────────────────

    /** Target notional in micros (after all clamps). */
    targetNotionalMicros: bigint;
    /** Target shares in micros (derived from notional and price). */
    targetShareMicros: bigint;
    /** Raw target notional before clamps (for observability). */
    rawTargetMicros: bigint;
    /** Sizing computation metadata. */
    sizingMetadata: SizingMetadata;

    // ─── Price Bounds ───────────────────────────────────────────────────────

    /** Maximum acceptable price for BUY (in micros). */
    maxBuyPriceMicros?: number;
    /** Minimum acceptable price for SELL (in micros). */
    minSellPriceMicros?: number;
    /** Their reference price (leader VWAP) in micros. */
    theirReferencePriceMicros: number;
    /** Mid price at decision time in micros. */
    midPriceMicrosAtDecision: number;

    // ─── Book State ─────────────────────────────────────────────────────────

    /** Book snapshot at decision time. */
    bookSnapshot: BookSnapshot;

    // ─── Simulation Results ─────────────────────────────────────────────────

    /**
     * Simulation results from book walk.
     * Used by paper executor for fills; used by live for observability.
     */
    simulation: SimulationResult;

    // ─── Decision ───────────────────────────────────────────────────────────

    /** Decision outcome: EXECUTE or SKIP. */
    decision: CopyDecisionType;
    /** Reason codes explaining the decision (empty if EXECUTE). */
    reasonCodes: ReasonCode[];

    // ─── Metadata ───────────────────────────────────────────────────────────

    /** Trade event IDs in this group. */
    tradeEventIds: string[];
    /** Number of buffered trades (for BUFFER source type). */
    bufferedTradeCount: number;
    /** Market ID if available. */
    marketId: string | null;
}

/**
 * Subset of CopyIntent for activity events (MERGE/SPLIT).
 * Activity events don't have the same sizing/book semantics as trades.
 */
export interface ActivityIntent {
    followedUserId: string;
    activityType: string;
    assetIds: string[];
    groupKey: string;
    idempotencyKey: string;
    decision: CopyDecisionType;
    reasonCodes: ReasonCode[];
    activityEventIds: string[];
}
