/**
 * Snapshot module for price and portfolio snapshots.
 *
 * This module handles:
 * - MarketPriceSnapshot: 30-second price refresh for held assets
 * - PortfolioSnapshot: Minute-bucketed portfolio state snapshots
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

import { createChildLogger } from "../log/logger.js";
import { startPriceRefreshLoop, stopPriceRefreshLoop } from "./prices.js";
import { startPortfolioSnapshotLoop, stopPortfolioSnapshotLoop } from "./portfolio.js";

const logger = createChildLogger({ module: "snapshot" });

/**
 * Start all snapshot loops.
 */
export function startSnapshotLoops(): void {
    logger.info("Starting snapshot loops");
    startPriceRefreshLoop();
    startPortfolioSnapshotLoop();
}

/**
 * Stop all snapshot loops.
 */
export function stopSnapshotLoops(): void {
    logger.info("Stopping snapshot loops");
    stopPriceRefreshLoop();
    stopPortfolioSnapshotLoop();
}
