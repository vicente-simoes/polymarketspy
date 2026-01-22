/**
 * Simulation module for event aggregation and executable copy trading.
 *
 * This module handles:
 * - Event aggregation (grouping fills within short windows)
 * - Executable simulation (per-user and global)
 * - Copy attempt decision making with guardrails
 * - Ledger application for executable portfolios
 */

// Types
export * from "./types.js";

// Configuration
export { getGlobalConfig, getUserConfig, clearConfigCache, DEFAULT_GUARDRAILS, DEFAULT_SIZING } from "./config.js";

// Sizing
export { computeTargetNotional, computeTargetShares, computeNotional } from "./sizing.js";

// Order book simulation
export { simulateBookFills, computeAvailableDepth, type SimulationResult, type FillLevel } from "./book.js";

// Guardrails
export {
    checkPriceProtection,
    checkSpreadFilter,
    checkDepthRequirement,
    checkCircuitBreakers,
    checkExposureCaps,
    computePriceBounds,
    isReducingExposure,
    runAllGuardrailChecks,
    type GuardrailCheckResult,
    type PortfolioState,
} from "./guardrails.js";

// Aggregation
export { addTradeToAggregator, addActivityToAggregator, flushAllGroups, getAggregatorStats } from "./aggregator.js";

// Execution
export { executeCopyAttempt, executeTradeGroup, executeActivityGroup, type ExecutionResult, type CopyAttemptOptions } from "./executor.js";

// Workers
export { groupEventsWorker, startGroupEventsWorker } from "./processor.js";
export { copyAttemptGlobalWorker, startCopyAttemptWorkers } from "./workers.js";

// Flush loop (small trade buffer)
export { startFlushLoop, stopFlushLoop, stopFlushLoopGracefully } from "./flushLoop.js";

// Small trade buffer (for Redis client setup)
export { setBufferRedisClient, getBufferStats } from "./smallTradeBuffer.js";
