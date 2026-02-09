/**
 * Locked reason codes for copy attempt decisions.
 * These are used when a trade is SKIPPED.
 */
export const ReasonCodes = {
    /** Global risk cap exceeded (total exposure, per-market, etc.) */
    RISK_CAP_GLOBAL: "RISK_CAP_GLOBAL",
    /** Per-user risk cap exceeded */
    RISK_CAP_USER: "RISK_CAP_USER",
    /** BUY cost per share exceeds configured maximum */
    BUY_COST_PER_SHARE_TOO_HIGH: "BUY_COST_PER_SHARE_TOO_HIGH",
    /** Order book spread exceeds max allowed ($0.02) */
    SPREAD_TOO_WIDE: "SPREAD_TOO_WIDE",
    /** Not enough depth at acceptable price levels */
    INSUFFICIENT_DEPTH: "INSUFFICIENT_DEPTH",
    /** Your fill price would be worse than their fill by more than $0.01 */
    PRICE_WORSE_THAN_THEIR_FILL: "PRICE_WORSE_THAN_THEIR_FILL",
    /** Your fill price is too far over mid price ($0.015) */
    PRICE_TOO_FAR_OVER_MID: "PRICE_TOO_FAR_OVER_MID",
    /** Zero liquidity available within acceptable price bounds */
    NO_LIQUIDITY_WITHIN_BOUNDS: "NO_LIQUIDITY_WITHIN_BOUNDS",
    /** Market closes in < 30 minutes, no new opens allowed */
    MARKET_TOO_CLOSE_TO_CLOSE: "MARKET_TOO_CLOSE_TO_CLOSE",
    /** Trade signal is too old to execute safely */
    SIGNAL_TOO_OLD: "SIGNAL_TOO_OLD",
    /** Circuit breaker tripped (daily/weekly loss or max drawdown) */
    CIRCUIT_BREAKER_TRIPPED: "CIRCUIT_BREAKER_TRIPPED",
    /** Trying to sell more shares than held */
    NOT_ENOUGH_POSITION_TO_SELL: "NOT_ENOUGH_POSITION_TO_SELL",
    /** Merge/split cannot be applied to executable portfolio */
    MERGE_SPLIT_NOT_APPLICABLE: "MERGE_SPLIT_NOT_APPLICABLE",
    /** Copy engine is paused globally */
    ENGINE_PAUSED: "ENGINE_PAUSED",
    /** User is disabled */
    USER_DISABLED: "USER_DISABLED",
    /** Market is blacklisted */
    MARKET_BLACKLISTED: "MARKET_BLACKLISTED",

    // Small trade buffering reason codes
    /** Trade was buffered (not yet flushed) */
    BUFFERED: "BUFFERED",
    /** Buffered notional below min exec threshold on flush */
    BUFFER_FLUSH_BELOW_MIN_EXEC: "BUFFER_FLUSH_BELOW_MIN_EXEC",

    // Budgeted dynamic sizing reason codes
    /** Leader trade notional is below configured minimum (filtered) */
    LEADER_TRADE_BELOW_MIN_NOTIONAL: "LEADER_TRADE_BELOW_MIN_NOTIONAL",
    /** HARD budget enforcement: exposure would exceed budget allocation */
    BUDGET_HARD_CAP_EXCEEDED: "BUDGET_HARD_CAP_EXCEEDED",

    // ─── Live Trading Reason Codes ────────────────────────────────────────────
    /** Live trading is disabled globally */
    LIVE_TRADING_DISABLED: "LIVE_TRADING_DISABLED",
    /** Live trading is disabled for this user (per-user override) */
    LIVE_USER_DISABLED: "LIVE_USER_DISABLED",
    /** No fresh order book available for live execution */
    LIVE_NO_FRESH_BOOK: "LIVE_NO_FRESH_BOOK",
    /** Order would not be marketable within price bounds */
    LIVE_NOT_MARKETABLE_WITHIN_BOUNDS: "LIVE_NOT_MARKETABLE_WITHIN_BOUNDS",
    /** Order would not be marketable after tick rounding */
    LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING: "LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING",
    /** Rounded order size is below exchange minimum */
    LIVE_BELOW_MIN_ORDER_SIZE: "LIVE_BELOW_MIN_ORDER_SIZE",
    /** Token trading params (tick/min size) unavailable or invalid */
    LIVE_INVALID_TICK_OR_STEP: "LIVE_INVALID_TICK_OR_STEP",
    /** Insufficient cash to execute BUY order */
    LIVE_INSUFFICIENT_CASH_TO_BUY: "LIVE_INSUFFICIENT_CASH_TO_BUY",
    /** Insufficient position to execute SELL order */
    LIVE_INSUFFICIENT_POSITION_TO_SELL: "LIVE_INSUFFICIENT_POSITION_TO_SELL",
    /** Live account state is stale or unhealthy */
    LIVE_ACCOUNT_STATE_UNHEALTHY: "LIVE_ACCOUNT_STATE_UNHEALTHY",
    /** Live account state has not been initialized by reconciliation */
    LIVE_ACCOUNT_STATE_NOT_INITIALIZED: "LIVE_ACCOUNT_STATE_NOT_INITIALIZED",
    /** Live reconciliation is unhealthy (consecutive errors) */
    LIVE_RECONCILIATION_UNHEALTHY: "LIVE_RECONCILIATION_UNHEALTHY",
    /** Order submission timed out (SUBMISSION_UNKNOWN) */
    LIVE_SUBMISSION_TIMEOUT: "LIVE_SUBMISSION_TIMEOUT",
    /** Exchange rejected the order (auth error) */
    LIVE_ORDER_REJECTED_AUTH: "LIVE_ORDER_REJECTED_AUTH",
    /** Exchange rejected the order (invalid tick size) */
    LIVE_ORDER_REJECTED_TICK_SIZE: "LIVE_ORDER_REJECTED_TICK_SIZE",
    /** Exchange rejected the order (invalid min size) */
    LIVE_ORDER_REJECTED_MIN_SIZE: "LIVE_ORDER_REJECTED_MIN_SIZE",
    /** Exchange rejected the order (insufficient balance) */
    LIVE_ORDER_REJECTED_INSUFFICIENT_BALANCE: "LIVE_ORDER_REJECTED_INSUFFICIENT_BALANCE",
    /** Exchange rejected the order (market closed) */
    LIVE_ORDER_REJECTED_MARKET_CLOSED: "LIVE_ORDER_REJECTED_MARKET_CLOSED",
    /** Exchange rejected the order (generic/unknown error) */
    LIVE_ORDER_REJECTED_UNKNOWN: "LIVE_ORDER_REJECTED_UNKNOWN",
    /** Live submissions paused due to unresolved SUBMISSION_UNKNOWN */
    LIVE_SUBMISSIONS_PAUSED: "LIVE_SUBMISSIONS_PAUSED",
} as const;

export type ReasonCode = (typeof ReasonCodes)[keyof typeof ReasonCodes];
