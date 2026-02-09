/**
 * Live trading module.
 *
 * This module provides components for live (real) order execution on Polymarket.
 * It includes:
 * - Trading params cache (tick/min/step constraints)
 * - Account state and reservations
 * - Authenticated CLOB client for order placement
 * - Live executor for real order submission
 * - User channel WebSocket handler
 * - Reconciliation for state safety
 */

export {
    // Trading params cache
    getTradingParams,
    prefetchTradingParams,
    refreshTradingParams,
    clearMemoryCache,

    // Types
    type TradingParams,
    type TradingParamsResult,
    type TradingParamsUnavailableReason,
} from "./tradingParams.js";

export {
    // Account state - initialization
    initializeFromReconciliation,
    updateFromReconciliation,

    // Account state - reservations
    reserveCashForBuy,
    reserveSharesForSell,
    releaseReservation,

    // Account state - updates
    applyFill,

    // Account state - queries
    getStateSnapshot,
    isStateHealthy,
    getAvailableCash,
    getAvailableShares,

    // Account state - submission serialization
    acquireSubmissionLock,
    areSubmissionsPaused,
    getPauseReason,
    pauseSubmissions,
    resumeSubmissions,

    // Account state - testing
    resetState,

    // Types
    type Reservation,
    type ReservationResult,
    type ReservationFailureReason,
    type AccountStateSnapshot,
} from "./accountState.js";

export {
    // CLOB client - initialization
    isLiveClientAvailable,
    isLiveClientInitialized,
    initializeLiveClient,
    getWalletAddress,
    getApiCredentials,

    // CLOB client - order placement
    placeOrderFAK,

    // CLOB client - order queries
    getOrder,
    listOpenOrders,
    listRecentTrades,

    // CLOB client - account state
    getBalance,
    getPositions,

    // CLOB client - utilities
    cancelAllOrders,
    cancelOrder,

    // Types
    type PlaceOrderParams,
    type PlaceOrderResult,
    type ClobOrderStatus,
    type ClobOrderError,
    type ClobOrder,
    type ClobTrade,
    type AccountBalance,
    type Position,
    type ApiKeyCreds,
} from "./clobClient.js";

export {
    // User channel WebSocket
    startUserChannel,
    stopUserChannel,
    isUserChannelConnected,
    getUserChannelMetrics,
} from "./userChannelWs.js";

export {
    // Reconciliation - lifecycle
    startLiveReconciliation,
    stopLiveReconciliation,

    // Reconciliation - health queries
    getReconciliationHealth,
    isReconciliationHealthy,
    hasReconciliationInitialized,

    // Types
    type ReconciliationHealth,
    type AuthoritativePosition,
    type AuthoritativeAccountState,
    type OrderReconcileResult,
} from "./reconciliation/index.js";

export {
    // Live executor
    executeLiveCopyAttempt,

    // Types
    type LiveExecutionResult,
    type LiveCopyAttemptOptions,
} from "./executor.js";
