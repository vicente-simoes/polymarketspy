/**
 * Alchemy WebSocket module for low-latency fill event detection.
 *
 * This module provides non-canonical event detection from on-chain data.
 * It serves as a trigger for fast reconciliation - the Polymarket Data API
 * remains the canonical source of truth.
 */

export { startAlchemySubscription, stopAlchemySubscription, setAlchemyRedisClient } from "./subscription.js";
export { getLastBlock, setLastBlock } from "./checkpoint.js";
export type { RawLogEvent, ParsedFillEvent, ReconcileJobData } from "./types.js";
export { CTF_EXCHANGE_ADDRESSES, ORDER_FILLED_TOPIC } from "./types.js";
