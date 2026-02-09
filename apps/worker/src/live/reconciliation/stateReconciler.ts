/**
 * State Reconciliation
 *
 * Periodically fetches authoritative account state (cash + positions)
 * from the exchange and:
 * 1. Updates GlobalPortfolioState and CurrentPosition tables for LIVE mode
 * 2. Initializes or updates the in-memory LiveAccountStateCache
 * 3. Logs diffs between ledger-derived state and exchange state
 *
 * Run every 60 seconds.
 */

import { PortfolioScope, TradingMode } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { createChildLogger } from "../../log/logger.js";
import { getBalance, getPositions, getWalletAddress } from "../clobClient.js";
import {
    initializeFromReconciliation,
    updateFromReconciliation,
    getStateSnapshot,
} from "../accountState.js";
import { fetchPositionsFromDataApi } from "./dataApiClient.js";
import {
    markInitialized,
    recordStateReconcileSuccess,
    recordStateReconcileError,
    hasReconciliationInitialized,
} from "./metrics.js";
import type { AuthoritativeAccountState, AuthoritativePosition } from "./types.js";

const logger = createChildLogger({ module: "state-reconciler" });

const DEFAULT_MARK_PRICE_MICROS = 500_000; // $0.50
const MICROS_PER_UNIT = 1_000_000n;
const LIVE_BASELINE_TIME_KEY = "live:baselineTime";
const LIVE_BASELINE_EQUITY_KEY = "live:baselineEquityMicros";
const LIVE_BASELINE_POSITIONS_KEY = "live:baselinePositions";
const LIVE_LEDGER_DIFF_KEY = "live:ledgerVsExchangeDiff";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reconcile account state with the exchange.
 *
 * This function:
 * 1. Fetches cash balance from CLOB client
 * 2. Fetches positions from CLOB client, falling back to Data API
 * 3. Writes authoritative state to GlobalPortfolioState and CurrentPosition tables
 * 4. Updates the in-memory LiveAccountStateCache
 * 5. Logs any diffs between ledger-derived and exchange state
 *
 * @returns The authoritative state fetched, or null on error
 */
export async function reconcileAccountState(): Promise<AuthoritativeAccountState | null> {
    const log = logger.child({});

    try {
        // Fetch authoritative state
        const authState = await fetchAuthoritativeState();
        if (!authState) {
            log.error("Failed to fetch authoritative state");
            recordStateReconcileError();
            return null;
        }

        log.debug(
            {
                cashMicros: authState.cashMicros.toString(),
                positionCount: authState.positions.length,
                source: authState.source,
            },
            "Fetched authoritative state"
        );

        // Write to database
        await writeStateToDatabase(authState);

        // Update in-memory cache
        updateInMemoryState(authState);

        // Best-effort: persist baseline + ledger-vs-exchange diffs for UI/debug.
        await ensureBaselineAndLedgerDiffs(authState);

        // Log diffs (for monitoring, not corrective action)
        await logStateDiffs(authState);

        recordStateReconcileSuccess();
        markInitialized();

        log.info(
            {
                cashMicros: authState.cashMicros.toString(),
                positionCount: authState.positions.length,
                source: authState.source,
            },
            "State reconciliation complete"
        );

        return authState;
    } catch (err) {
        log.error({ err }, "State reconciliation failed");
        recordStateReconcileError();
        return null;
    }
}

async function ensureBaselineAndLedgerDiffs(state: AuthoritativeAccountState): Promise<void> {
    const log = logger.child({ operation: "baseline" });

    try {
        const baselineTimeRow = await prisma.systemCheckpoint.findUnique({
            where: { key: LIVE_BASELINE_TIME_KEY },
            select: { valueJson: true },
        });

        if (!baselineTimeRow) {
            const tokenIds = state.positions.map((p) => p.tokenId);
            const prices = tokenIds.length
                ? await prisma.currentPrice.findMany({
                      where: { assetId: { in: tokenIds } },
                      select: { assetId: true, midpointPriceMicros: true },
                  })
                : [];
            const priceByToken = new Map<string, number>(
                prices.map((row) => [row.assetId, row.midpointPriceMicros])
            );

            let totalPositionValueMicros = 0n;
            for (const pos of state.positions) {
                const priceMicros = priceByToken.get(pos.tokenId) ?? DEFAULT_MARK_PRICE_MICROS;
                totalPositionValueMicros += (pos.shareMicros * BigInt(priceMicros)) / MICROS_PER_UNIT;
            }

            const baselineEquityMicros = state.cashMicros + totalPositionValueMicros;

            await prisma.$transaction(async (tx) => {
                const existing = await tx.systemCheckpoint.findUnique({
                    where: { key: LIVE_BASELINE_TIME_KEY },
                    select: { id: true },
                });
                if (existing) return;

                await tx.systemCheckpoint.create({
                    data: {
                        key: LIVE_BASELINE_TIME_KEY,
                        valueJson: { timestamp: state.fetchedAt.toISOString() },
                    },
                });
                await tx.systemCheckpoint.create({
                    data: {
                        key: LIVE_BASELINE_EQUITY_KEY,
                        valueJson: { equityMicros: baselineEquityMicros.toString() },
                    },
                });
                await tx.systemCheckpoint.create({
                    data: {
                        key: LIVE_BASELINE_POSITIONS_KEY,
                        valueJson: {
                            positions: state.positions.map((p) => ({
                                tokenId: p.tokenId,
                                shareMicros: p.shareMicros.toString(),
                            })),
                        },
                    },
                });
            });

            log.info(
                {
                    baselineEquityMicros: baselineEquityMicros.toString(),
                    positionCount: state.positions.length,
                },
                "Initialized live baseline"
            );
        }

        const [ledgerCashAgg, ledgerPositionAgg] = await Promise.all([
            prisma.ledgerEntry.aggregate({
                where: {
                    tradingMode: TradingMode.LIVE,
                    portfolioScope: PortfolioScope.EXEC_GLOBAL,
                },
                _sum: { cashDeltaMicros: true },
            }),
            prisma.ledgerEntry.groupBy({
                by: ["assetId"],
                where: {
                    tradingMode: TradingMode.LIVE,
                    portfolioScope: PortfolioScope.EXEC_GLOBAL,
                    assetId: { not: null },
                },
                _sum: { shareDeltaMicros: true },
            }),
        ]);

        const ledgerCashMicros = ledgerCashAgg._sum.cashDeltaMicros ?? 0n;
        const ledgerSharesByToken = new Map<string, bigint>();
        for (const row of ledgerPositionAgg) {
            const assetId = row.assetId;
            const sumShares = row._sum.shareDeltaMicros;
            if (!assetId || !sumShares) continue;
            ledgerSharesByToken.set(assetId, sumShares);
        }

        const exchangeSharesByToken = new Map<string, bigint>(
            state.positions.map((p) => [p.tokenId, p.shareMicros])
        );
        const allTokenIds = new Set<string>([
            ...ledgerSharesByToken.keys(),
            ...exchangeSharesByToken.keys(),
        ]);

        let positionDiffCount = 0;
        let maxAbsPositionDiffMicros = 0n;
        for (const tokenId of allTokenIds) {
            const ledgerShares = ledgerSharesByToken.get(tokenId) ?? 0n;
            const exchangeShares = exchangeSharesByToken.get(tokenId) ?? 0n;
            const diff = exchangeShares - ledgerShares;
            if (diff !== 0n) {
                positionDiffCount += 1;
                const abs = diff < 0n ? -diff : diff;
                if (abs > maxAbsPositionDiffMicros) maxAbsPositionDiffMicros = abs;
            }
        }

        const cashDiffMicros = state.cashMicros - ledgerCashMicros;

        await prisma.systemCheckpoint.upsert({
            where: { key: LIVE_LEDGER_DIFF_KEY },
            create: {
                key: LIVE_LEDGER_DIFF_KEY,
                valueJson: {
                    asOf: state.fetchedAt.toISOString(),
                    cashDiffMicros: cashDiffMicros.toString(),
                    positionDiffCount,
                    maxAbsPositionDiffMicros: maxAbsPositionDiffMicros.toString(),
                },
            },
            update: {
                valueJson: {
                    asOf: state.fetchedAt.toISOString(),
                    cashDiffMicros: cashDiffMicros.toString(),
                    positionDiffCount,
                    maxAbsPositionDiffMicros: maxAbsPositionDiffMicros.toString(),
                },
            },
        });
    } catch (err) {
        log.warn({ err }, "Failed to persist live baseline/diff metadata");
    }
}

// ─── Internal Functions ───────────────────────────────────────────────────────

/**
 * Fetch authoritative state from CLOB client / Data API.
 */
async function fetchAuthoritativeState(): Promise<AuthoritativeAccountState | null> {
    // Fetch cash balance
    const balance = await getBalance();
    if (!balance) {
        logger.error("Failed to fetch balance from CLOB client");
        return null;
    }

    // Try CLOB client for positions first
    let positions = await getPositions();
    let source: AuthoritativeAccountState["source"] = "CLOB_CLIENT";

    // Fallback to Data API if CLOB client returns null
    if (!positions) {
        const walletAddress = getWalletAddress();
        if (!walletAddress) {
            logger.error("No wallet address available for position fetch");
            return null;
        }

        const dataApiPositions = await fetchPositionsFromDataApi(walletAddress);
        if (dataApiPositions) {
            positions = dataApiPositions.map((p) => ({
                tokenId: p.tokenId,
                shareMicros: p.shareMicros,
            }));
            source = "DATA_API";
        } else {
            // Fail closed: without authoritative positions we must not proceed.
            logger.error("Both CLOB and Data API position fetches failed; refusing to reconcile");
            return null;
        }
    }

    return {
        cashMicros: balance.cashMicros,
        positions: positions.map((p) => ({
            tokenId: p.tokenId,
            shareMicros: p.shareMicros,
        })),
        fetchedAt: new Date(),
        source,
    };
}

/**
 * Write authoritative state to database.
 */
async function writeStateToDatabase(state: AuthoritativeAccountState): Promise<void> {
    await prisma.$transaction(async (tx) => {
        // Upsert GlobalPortfolioState for LIVE mode
        await tx.globalPortfolioState.upsert({
            where: {
                tradingMode_portfolioScope: {
                    tradingMode: TradingMode.LIVE,
                    portfolioScope: PortfolioScope.EXEC_GLOBAL,
                },
            },
            create: {
                tradingMode: TradingMode.LIVE,
                portfolioScope: PortfolioScope.EXEC_GLOBAL,
                cashMicros: state.cashMicros,
                contributedCapitalMicros: 0n, // Not tracked via reconciliation
            },
            update: {
                cashMicros: state.cashMicros,
            },
        });

        // Get existing positions to detect which ones need to be zeroed
        const existingPositions = await tx.currentPosition.findMany({
            where: {
                tradingMode: TradingMode.LIVE,
                shareMicros: { not: 0n },
            },
            select: { assetId: true, shareMicros: true },
        });

        const existingByToken = new Map<string, bigint>(
            existingPositions.map((p) => [p.assetId, p.shareMicros])
        );

        const exchangeTokenIds = new Set<string>();

        // Upsert each position from exchange
        for (const pos of state.positions) {
            exchangeTokenIds.add(pos.tokenId);

            await tx.currentPosition.upsert({
                where: {
                    tradingMode_assetId: {
                        tradingMode: TradingMode.LIVE,
                        assetId: pos.tokenId,
                    },
                },
                create: {
                    tradingMode: TradingMode.LIVE,
                    assetId: pos.tokenId,
                    marketId: null,
                    shareMicros: pos.shareMicros,
                    netCashFlowMicros: 0n, // Not tracked via reconciliation
                },
                update: {
                    shareMicros: pos.shareMicros,
                },
            });
        }

        // Zero out positions that exist in DB but not on exchange
        for (const [tokenId, shareMicros] of existingByToken) {
            if (!exchangeTokenIds.has(tokenId) && shareMicros !== 0n) {
                logger.debug(
                    { tokenId, previousShareMicros: shareMicros.toString() },
                    "Zeroing position not found on exchange"
                );

                await tx.currentPosition.update({
                    where: {
                        tradingMode_assetId: {
                            tradingMode: TradingMode.LIVE,
                            assetId: tokenId,
                        },
                    },
                    data: { shareMicros: 0n },
                });
            }
        }
    });
}

/**
 * Update in-memory account state cache.
 */
function updateInMemoryState(state: AuthoritativeAccountState): void {
    const positionsMap = new Map<string, bigint>(
        state.positions.map((p) => [p.tokenId, p.shareMicros])
    );

    if (!hasReconciliationInitialized()) {
        // First run - initialize
        initializeFromReconciliation(state.cashMicros, positionsMap);
    } else {
        // Subsequent runs - update
        updateFromReconciliation(state.cashMicros, positionsMap);
    }
}

/**
 * Log diffs between ledger-derived state and exchange state.
 * This is for monitoring only - we don't automatically correct.
 */
async function logStateDiffs(exchangeState: AuthoritativeAccountState): Promise<void> {
    const log = logger.child({ operation: "diff" });

    // Get current in-memory state (after update)
    const memState = getStateSnapshot();

    // Compare cash
    const cashDiff = exchangeState.cashMicros - memState.cashAvailableMicros;
    if (cashDiff !== 0n) {
        log.warn(
            {
                exchangeCash: exchangeState.cashMicros.toString(),
                memoryCash: memState.cashAvailableMicros.toString(),
                diff: cashDiff.toString(),
            },
            "Cash mismatch between exchange and memory (post-reconcile)"
        );
    }

    // Compare positions
    const exchangePositions = new Map<string, bigint>(
        exchangeState.positions.map((p) => [p.tokenId, p.shareMicros])
    );

    const allTokenIds = new Set([
        ...exchangePositions.keys(),
        ...memState.positionsByTokenId.keys(),
    ]);

    for (const tokenId of allTokenIds) {
        const exchangeShares = exchangePositions.get(tokenId) ?? 0n;
        const memoryShares = memState.positionsByTokenId.get(tokenId) ?? 0n;
        const diff = exchangeShares - memoryShares;

        if (diff !== 0n) {
            log.warn(
                {
                    tokenId,
                    exchangeShares: exchangeShares.toString(),
                    memoryShares: memoryShares.toString(),
                    diff: diff.toString(),
                },
                "Position mismatch between exchange and memory (post-reconcile)"
            );
        }
    }
}
