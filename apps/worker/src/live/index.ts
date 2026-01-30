/**
 * Live trading module exports.
 *
 * This module provides the infrastructure for live order placement:
 * - Trading params cache (tick size, min order size)
 * - Account state management (cash/shares + reservations)
 * - CLOB client wrapper (authenticated order placement)
 * - Live executor (coming in Step 10)
 */

// Trading params cache
export {
    getTradingParams,
    refreshTradingParams,
    getOrRefreshTradingParams,
    prefetchTradingParams,
    clearMemoryCache as clearTradingParamsCache,
    getCacheStats as getTradingParamsCacheStats,
    type TradingParams,
    type TradingParamsResult,
    type TradingParamsUnavailableReason,
} from "./tradingParams.js";

// Account state + reservations
export {
    // Initialization
    initializeFromReconciliation,
    isStateInitialized,
    // Pre-trade checks
    canAffordBuy,
    canAffordSell,
    getMaxAffordableBuyShares,
    getMaxAffordableSellShares,
    // Reservation management
    reserveForBuy,
    reserveForSell,
    releaseReservation,
    adjustReservationForFill,
    // Fill application
    applyFill,
    // Reconciliation
    reconcile,
    // State accessors
    getState as getAccountState,
    getEffectiveCash,
    getEffectiveShares,
    getActiveReservations,
    // Submission mutex
    acquireSubmissionMutex,
    releaseSubmissionMutex,
    isSubmissionMutexLocked,
    getSubmissionMutexStatus,
    // Pause mechanism
    pauseSubmissions,
    resumeSubmissions,
    getSubmissionPauseStatus,
    areSubmissionsPaused,
    // Testing
    resetState as resetAccountState,
    // Types
    type LiveAccountStateSnapshot,
    type SubmissionPauseStatus,
} from "./accountState.js";

// CLOB client wrapper (authenticated order placement)
export {
    // Client lifecycle
    isLiveClientConfigured,
    resetClient,
    getWalletAddress,
    checkHealth as checkClobHealth,
    // Order placement
    createOrderFAK,
    createOrderFOK,
    // Order queries
    getOrder,
    listOpenOrders,
    cancelOrder,
    // Account state (from CLOB)
    getBalance,
    getPositions,
    getPositionForToken,
    // Trades
    getTrades,
    // Error codes
    ClobErrorCodes,
    // Types
    type ClobOrderType,
    type ClobSide,
    type ClobOrderStatus,
    type OrderPlacementResult,
    type ClobOrderInfo,
    type ClobBalance,
    type ClobPosition,
    type ClobTrade,
    type ClobErrorCode,
} from "./clobClient.js";

// User channel WebSocket (orders + fills)
export {
    startUserChannelWs,
    stopUserChannelWs,
    getUserChannelWsStatus,
    type UserChannelWsConfig,
    DEFAULT_USER_WS_CONFIG,
    UserChannelWsClient,
} from "./userChannelWs.js";

// Periodic reconciliation (safety net + real portfolio snapshots)
export {
    startLiveReconciliationLoops,
    stopLiveReconciliationLoops,
    getLiveReconcileStatus,
} from "./reconcile.js";
