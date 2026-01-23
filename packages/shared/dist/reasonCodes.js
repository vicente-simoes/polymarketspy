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
};
