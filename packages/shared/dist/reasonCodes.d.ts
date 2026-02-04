/**
 * Locked reason codes for copy attempt decisions.
 * These are used when a trade is SKIPPED.
 */
export declare const ReasonCodes: {
    /** Global risk cap exceeded (total exposure, per-market, etc.) */
    readonly RISK_CAP_GLOBAL: "RISK_CAP_GLOBAL";
    /** Per-user risk cap exceeded */
    readonly RISK_CAP_USER: "RISK_CAP_USER";
    /** BUY cost per share exceeds configured maximum */
    readonly BUY_COST_PER_SHARE_TOO_HIGH: "BUY_COST_PER_SHARE_TOO_HIGH";
    /** Order book spread exceeds max allowed ($0.02) */
    readonly SPREAD_TOO_WIDE: "SPREAD_TOO_WIDE";
    /** Not enough depth at acceptable price levels */
    readonly INSUFFICIENT_DEPTH: "INSUFFICIENT_DEPTH";
    /** Your fill price would be worse than their fill by more than $0.01 */
    readonly PRICE_WORSE_THAN_THEIR_FILL: "PRICE_WORSE_THAN_THEIR_FILL";
    /** Your fill price is too far over mid price ($0.015) */
    readonly PRICE_TOO_FAR_OVER_MID: "PRICE_TOO_FAR_OVER_MID";
    /** Zero liquidity available within acceptable price bounds */
    readonly NO_LIQUIDITY_WITHIN_BOUNDS: "NO_LIQUIDITY_WITHIN_BOUNDS";
    /** Market closes in < 30 minutes, no new opens allowed */
    readonly MARKET_TOO_CLOSE_TO_CLOSE: "MARKET_TOO_CLOSE_TO_CLOSE";
    /** Circuit breaker tripped (daily/weekly loss or max drawdown) */
    readonly CIRCUIT_BREAKER_TRIPPED: "CIRCUIT_BREAKER_TRIPPED";
    /** Trying to sell more shares than held */
    readonly NOT_ENOUGH_POSITION_TO_SELL: "NOT_ENOUGH_POSITION_TO_SELL";
    /** Merge/split cannot be applied to executable portfolio */
    readonly MERGE_SPLIT_NOT_APPLICABLE: "MERGE_SPLIT_NOT_APPLICABLE";
    /** Copy engine is paused globally */
    readonly ENGINE_PAUSED: "ENGINE_PAUSED";
    /** User is disabled */
    readonly USER_DISABLED: "USER_DISABLED";
    /** Market is blacklisted */
    readonly MARKET_BLACKLISTED: "MARKET_BLACKLISTED";
    /** Trade was buffered (not yet flushed) */
    readonly BUFFERED: "BUFFERED";
    /** Buffered notional below min exec threshold on flush */
    readonly BUFFER_FLUSH_BELOW_MIN_EXEC: "BUFFER_FLUSH_BELOW_MIN_EXEC";
    /** Leader trade notional is below configured minimum (filtered) */
    readonly LEADER_TRADE_BELOW_MIN_NOTIONAL: "LEADER_TRADE_BELOW_MIN_NOTIONAL";
    /** HARD budget enforcement: exposure would exceed budget allocation */
    readonly BUDGET_HARD_CAP_EXCEEDED: "BUDGET_HARD_CAP_EXCEEDED";
    /** Live trading is disabled globally */
    readonly LIVE_TRADING_DISABLED: "LIVE_TRADING_DISABLED";
    /** Live trading is disabled for this user (per-user override) */
    readonly LIVE_USER_DISABLED: "LIVE_USER_DISABLED";
    /** No fresh order book available for live execution */
    readonly LIVE_NO_FRESH_BOOK: "LIVE_NO_FRESH_BOOK";
    /** Order would not be marketable within price bounds */
    readonly LIVE_NOT_MARKETABLE_WITHIN_BOUNDS: "LIVE_NOT_MARKETABLE_WITHIN_BOUNDS";
    /** Order would not be marketable after tick rounding */
    readonly LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING: "LIVE_NOT_MARKETABLE_AFTER_TICK_ROUNDING";
    /** Rounded order size is below exchange minimum */
    readonly LIVE_BELOW_MIN_ORDER_SIZE: "LIVE_BELOW_MIN_ORDER_SIZE";
    /** Token trading params (tick/min size) unavailable or invalid */
    readonly LIVE_INVALID_TICK_OR_STEP: "LIVE_INVALID_TICK_OR_STEP";
    /** Insufficient cash to execute BUY order */
    readonly LIVE_INSUFFICIENT_CASH_TO_BUY: "LIVE_INSUFFICIENT_CASH_TO_BUY";
    /** Insufficient position to execute SELL order */
    readonly LIVE_INSUFFICIENT_POSITION_TO_SELL: "LIVE_INSUFFICIENT_POSITION_TO_SELL";
    /** Live account state is stale or unhealthy */
    readonly LIVE_ACCOUNT_STATE_UNHEALTHY: "LIVE_ACCOUNT_STATE_UNHEALTHY";
    /** Live account state has not been initialized by reconciliation */
    readonly LIVE_ACCOUNT_STATE_NOT_INITIALIZED: "LIVE_ACCOUNT_STATE_NOT_INITIALIZED";
    /** Live reconciliation is unhealthy (consecutive errors) */
    readonly LIVE_RECONCILIATION_UNHEALTHY: "LIVE_RECONCILIATION_UNHEALTHY";
    /** Order submission timed out (SUBMISSION_UNKNOWN) */
    readonly LIVE_SUBMISSION_TIMEOUT: "LIVE_SUBMISSION_TIMEOUT";
    /** Exchange rejected the order (auth error) */
    readonly LIVE_ORDER_REJECTED_AUTH: "LIVE_ORDER_REJECTED_AUTH";
    /** Exchange rejected the order (invalid tick size) */
    readonly LIVE_ORDER_REJECTED_TICK_SIZE: "LIVE_ORDER_REJECTED_TICK_SIZE";
    /** Exchange rejected the order (invalid min size) */
    readonly LIVE_ORDER_REJECTED_MIN_SIZE: "LIVE_ORDER_REJECTED_MIN_SIZE";
    /** Exchange rejected the order (insufficient balance) */
    readonly LIVE_ORDER_REJECTED_INSUFFICIENT_BALANCE: "LIVE_ORDER_REJECTED_INSUFFICIENT_BALANCE";
    /** Exchange rejected the order (market closed) */
    readonly LIVE_ORDER_REJECTED_MARKET_CLOSED: "LIVE_ORDER_REJECTED_MARKET_CLOSED";
    /** Exchange rejected the order (generic/unknown error) */
    readonly LIVE_ORDER_REJECTED_UNKNOWN: "LIVE_ORDER_REJECTED_UNKNOWN";
    /** Live submissions paused due to unresolved SUBMISSION_UNKNOWN */
    readonly LIVE_SUBMISSIONS_PAUSED: "LIVE_SUBMISSIONS_PAUSED";
};
export type ReasonCode = (typeof ReasonCodes)[keyof typeof ReasonCodes];
