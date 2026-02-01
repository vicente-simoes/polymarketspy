/**
 * Snapshot module for prices and equity/portfolio snapshots.
 *
 * This module handles:
 * - CurrentPrice: periodic refresh for held assets
 * - EquityPoint: multi-resolution equity/PnL points
 * - PortfolioSnapshot: (legacy) minute-bucketed portfolio state snapshots
 */

// Price snapshots
export {
    startPriceRefreshLoop,
    stopPriceRefreshLoop,
    getLatestPrice,
    getLatestPrices,
} from "./prices.js";

// Portfolio snapshots
export {
    startPortfolioSnapshotLoop,
    stopPortfolioSnapshotLoop,
    getLatestSnapshot,
    triggerSnapshot,
} from "./portfolio.js";

// Equity points
export { startEquityPointLoop, stopEquityPointLoop } from "./equity.js";

import { createChildLogger } from "../log/logger.js";
import { startPriceRefreshLoop, stopPriceRefreshLoop } from "./prices.js";
import { startPortfolioSnapshotLoop, stopPortfolioSnapshotLoop } from "./portfolio.js";
import { startEquityPointLoop, stopEquityPointLoop } from "./equity.js";

const logger = createChildLogger({ module: "snapshot" });

/**
 * Start all snapshot loops.
 */
export function startSnapshotLoops(): void {
    logger.info("Starting snapshot loops");
    startPriceRefreshLoop();
    startEquityPointLoop();
    startPortfolioSnapshotLoop();
}

/**
 * Stop all snapshot loops.
 */
export function stopSnapshotLoops(): void {
    logger.info("Stopping snapshot loops");
    stopPriceRefreshLoop();
    stopEquityPointLoop();
    stopPortfolioSnapshotLoop();
}
