import { createChildLogger } from "../log/logger.js";
import { ingestAllUserTrades, discoverProxyWallets } from "./trades.js";
import { ingestAllUserActivity } from "./activity.js";

const logger = createChildLogger({ module: "polling" });

// Polling interval in milliseconds (30 seconds per planning.md)
const POLL_INTERVAL_MS = 30_000;

// Backfill window on startup (15 minutes per planning.md)
const BACKFILL_MINUTES = 15;

let pollInterval: NodeJS.Timeout | null = null;

/**
 * Run one polling cycle.
 * Fetches both trades and activity events for all followed users.
 * Uses checkpoint-based incremental fetch (no backfill window).
 */
async function pollCycle(): Promise<void> {
    try {
        // Ingest trades (BUY/SELL)
        await ingestAllUserTrades();

        // Ingest activity events (MERGE/SPLIT/REDEEM)
        await ingestAllUserActivity();

        // Discover any new proxy wallets
        await discoverProxyWallets();
    } catch (err) {
        logger.error({ err }, "Polling cycle failed");
    }
}

/**
 * Start the polling loop.
 *
 * Note: Reconciliation/backfill is handled separately by:
 * - reconcile processor (Alchemy-triggered fast fetches)
 * - alchemy_reconnect events (5-minute backfill on WS reconnect)
 */
export async function startPolling(): Promise<void> {
    logger.info("Starting polling loop");

    // Initial backfill on startup
    logger.info({ backfillMinutes: BACKFILL_MINUTES }, "Running initial backfill");
    await ingestAllUserTrades({ backfillMinutes: BACKFILL_MINUTES });
    await ingestAllUserActivity({ backfillMinutes: BACKFILL_MINUTES });
    await discoverProxyWallets();

    // Start regular polling (checkpoint-based incremental fetch)
    pollInterval = setInterval(() => {
        pollCycle().catch((err) => {
            logger.error({ err }, "Poll cycle error");
        });
    }, POLL_INTERVAL_MS);

    logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, "Polling started");
}

/**
 * Stop the polling loop.
 */
export function stopPolling(): void {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    logger.info("Polling stopped");
}
