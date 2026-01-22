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
};
export type ReasonCode = (typeof ReasonCodes)[keyof typeof ReasonCodes];
