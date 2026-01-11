import { createChildLogger } from "../log/logger.js";
import { ingestAllUserTrades, discoverProxyWallets } from "./trades.js";
import { ingestAllUserActivity } from "./activity.js";

const logger = createChildLogger({ module: "polling" });

// Polling interval in milliseconds (30 seconds per planning.md)
const POLL_INTERVAL_MS = 30_000;

// Backfill window on startup (15 minutes per planning.md)
const BACKFILL_MINUTES = 15;

// Reconcile interval (60 seconds per planning.md)
const RECONCILE_INTERVAL_MS = 60_000;

// Reconcile backfill window (2 minutes per planning.md)
const RECONCILE_BACKFILL_MINUTES = 2;

let pollInterval: NodeJS.Timeout | null = null;
let reconcileInterval: NodeJS.Timeout | null = null;

/**
 * Run one polling cycle.
 * Fetches both trades and activity events for all followed users.
 */
async function pollCycle(isReconcile = false): Promise<void> {
    const backfillMinutes = isReconcile
        ? RECONCILE_BACKFILL_MINUTES
        : undefined;

    try {
        // Ingest trades (BUY/SELL)
        await ingestAllUserTrades({ backfillMinutes });

        // Ingest activity events (MERGE/SPLIT/REDEEM)
        await ingestAllUserActivity({ backfillMinutes });

        // Discover any new proxy wallets
        await discoverProxyWallets();
    } catch (err) {
        logger.error({ err, isReconcile }, "Polling cycle failed");
    }
}

/**
 * Start the polling loop.
 */
export async function startPolling(): Promise<void> {
    logger.info("Starting polling loop");

    // Initial backfill on startup
    logger.info({ backfillMinutes: BACKFILL_MINUTES }, "Running initial backfill");
    await ingestAllUserTrades({ backfillMinutes: BACKFILL_MINUTES });
    await ingestAllUserActivity({ backfillMinutes: BACKFILL_MINUTES });
    await discoverProxyWallets();

    // Start regular polling
    pollInterval = setInterval(() => {
        pollCycle().catch((err) => {
            logger.error({ err }, "Poll cycle error");
        });
    }, POLL_INTERVAL_MS);

    // Start reconciliation loop (safety net)
    reconcileInterval = setInterval(() => {
        logger.debug("Running reconcile cycle");
        pollCycle(true).catch((err) => {
            logger.error({ err }, "Reconcile cycle error");
        });
    }, RECONCILE_INTERVAL_MS);

    logger.info(
        { pollIntervalMs: POLL_INTERVAL_MS, reconcileIntervalMs: RECONCILE_INTERVAL_MS },
        "Polling started"
    );
}

/**
 * Stop the polling loop.
 */
export function stopPolling(): void {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    if (reconcileInterval) {
        clearInterval(reconcileInterval);
        reconcileInterval = null;
    }
    logger.info("Polling stopped");
}
