/**
 * Trading module for copy trading decision and execution.
 *
 * This module provides:
 * - Shared decision engine for paper and live trading
 * - Idempotency key generation
 * - CopyIntent types and utilities
 */

export {
    // Core decision function
    makeDecision,

    // Live-specific utilities
    isBookFreshEnoughForLive,
    computeLiveSlippageBounds,

    // Types
    type CopyIntent,
    type CopyDecisionType,
    type BookSnapshot,
    type DecisionInputs,
} from "./decisionEngine.js";

export { generateIdempotencyKey } from "./idempotency.js";
