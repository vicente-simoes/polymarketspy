/**
 * Batching logic for Alchemy-triggered reconcile events.
 *
 * When multiple events arrive for the same wallet in quick succession,
 * we batch them together to make a single API call.
 *
 * Strategy:
 * - Buffer events by wallet address
 * - Debounce: 500ms after last event for that wallet
 * - Max wait: 1000ms force flush
 * - Output: callback with wallet address and event metadata
 */

import { createChildLogger } from "../log/logger.js";

const logger = createChildLogger({ module: "reconcile-batcher" });

export interface BatchedEvent {
    txHash: string;
    walletAddress: string;
    alchemyDetectTime: Date;
}

interface WalletBatch {
    walletAddress: string;
    events: BatchedEvent[];
    firstEventTime: number;
    lastEventTime: number;
    debounceTimer: NodeJS.Timeout | null;
}

// Batching parameters
const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 1000;

// Active batches by wallet address
const batches = new Map<string, WalletBatch>();

// Callback for when a batch is ready
type BatchCallback = (walletAddress: string, events: BatchedEvent[]) => void;
let onBatchReady: BatchCallback | null = null;

/**
 * Set the callback for when a batch is ready to be processed.
 */
export function setBatchCallback(callback: BatchCallback): void {
    onBatchReady = callback;
}

/**
 * Add an event to the batch for its wallet.
 */
export function addToBatch(event: BatchedEvent): void {
    const { walletAddress } = event;
    const normalizedWallet = walletAddress.toLowerCase();
    const now = Date.now();

    let batch = batches.get(normalizedWallet);

    if (!batch) {
        // Create new batch
        batch = {
            walletAddress: event.walletAddress, // Keep original casing
            events: [],
            firstEventTime: now,
            lastEventTime: now,
            debounceTimer: null,
        };
        batches.set(normalizedWallet, batch);
        logger.debug({ wallet: walletAddress }, "Created new batch");
    }

    // Add event to batch
    batch.events.push(event);
    batch.lastEventTime = now;

    // Clear existing debounce timer
    if (batch.debounceTimer) {
        clearTimeout(batch.debounceTimer);
    }

    // Check if max wait exceeded
    const elapsed = now - batch.firstEventTime;
    if (elapsed >= MAX_WAIT_MS) {
        logger.debug(
            { wallet: walletAddress, eventCount: batch.events.length, elapsed },
            "Max wait exceeded, flushing batch"
        );
        flushBatch(normalizedWallet);
        return;
    }

    // Set new debounce timer
    const timeUntilMaxWait = MAX_WAIT_MS - elapsed;
    const debounceTime = Math.min(DEBOUNCE_MS, timeUntilMaxWait);

    batch.debounceTimer = setTimeout(() => {
        logger.debug(
            { wallet: walletAddress, eventCount: batch!.events.length },
            "Debounce timer fired, flushing batch"
        );
        flushBatch(normalizedWallet);
    }, debounceTime);
}

/**
 * Flush a batch for a specific wallet.
 */
function flushBatch(normalizedWallet: string): void {
    const batch = batches.get(normalizedWallet);
    if (!batch) return;

    // Clear timer
    if (batch.debounceTimer) {
        clearTimeout(batch.debounceTimer);
    }

    // Remove from active batches
    batches.delete(normalizedWallet);

    // Invoke callback
    if (onBatchReady && batch.events.length > 0) {
        logger.debug(
            { wallet: batch.walletAddress, eventCount: batch.events.length },
            "Batch ready"
        );
        onBatchReady(batch.walletAddress, batch.events);
    }
}

/**
 * Flush all pending batches immediately.
 * Called during shutdown.
 */
export function flushAllBatches(): void {
    const wallets = Array.from(batches.keys());
    for (const wallet of wallets) {
        flushBatch(wallet);
    }
    logger.debug({ flushedCount: wallets.length }, "Flushed all batches");
}

/**
 * Get count of pending batches (for health check).
 */
export function getPendingBatchCount(): number {
    return batches.size;
}

/**
 * Get total events across all pending batches.
 */
export function getPendingEventCount(): number {
    let count = 0;
    for (const batch of batches.values()) {
        count += batch.events.length;
    }
    return count;
}
