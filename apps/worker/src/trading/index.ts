/**
 * Trading module exports.
 *
 * This module provides the shared decision engine and types used by
 * both paper and live executors.
 */

// Types
export type {
    CopyDecisionType,
    BookSnapshot,
    SizingMetadata,
    CopyIntent,
    ActivityIntent,
} from "./types.js";

// Decision engine
export {
    computeCopyIntent,
    generateIdempotencyKey,
    type DecisionEngineInput,
    type NoBookResult,
} from "./decisionEngine.js";
