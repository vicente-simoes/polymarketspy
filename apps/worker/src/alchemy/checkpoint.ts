/**
 * Checkpoint management for Alchemy WebSocket subscription.
 *
 * Maintains the last processed block number to enable recovery after
 * disconnections or restarts.
 */

import { getCheckpoint, setCheckpoint } from "../ingest/checkpoint.js";
import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "alchemy-checkpoint" });

const ALCHEMY_LAST_BLOCK_KEY = "alchemy:lastBlock";

interface LastBlockCheckpoint {
    blockNumber: number;
    timestamp: string;
}

/**
 * Get the last processed block number.
 * Returns null if no checkpoint exists (first run).
 */
export async function getLastBlock(): Promise<number | null> {
    const checkpoint = await getCheckpoint<LastBlockCheckpoint>(ALCHEMY_LAST_BLOCK_KEY);
    if (!checkpoint) {
        logger.debug("No last block checkpoint found");
        return null;
    }
    logger.debug({ blockNumber: checkpoint.blockNumber }, "Retrieved last block checkpoint");
    return checkpoint.blockNumber;
}

/**
 * Set the last processed block number.
 */
export async function setLastBlock(blockNumber: number): Promise<void> {
    await setCheckpoint<LastBlockCheckpoint>(ALCHEMY_LAST_BLOCK_KEY, {
        blockNumber,
        timestamp: new Date().toISOString(),
    });
    logger.debug({ blockNumber }, "Saved last block checkpoint");
}
