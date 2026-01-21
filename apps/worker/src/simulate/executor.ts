/**
 * Copy attempt executor.
 *
 * Orchestrates the full copy attempt flow:
 * 1. Apply timing delay (realism)
 * 2. Compute target notional
 * 3. Fetch order book
 * 4. Run guardrail checks
 * 5. Simulate fills
 * 6. Write CopyAttempt and ledger entries
 */

import { TradeSide, PortfolioScope, CopyDecision } from "@prisma/client";
import { ReasonCodes, type ReasonCode } from "@copybot/shared";
import { prisma } from "../db/prisma.js";
import { createChildLogger } from "../log/logger.js";
import { getSystemConfig } from "../config/system.js";
import { getGlobalConfig, getUserConfig } from "./config.js";
import { computeTargetNotional, computeTargetShares } from "./sizing.js";
import {
    simulateFromNormalizedBook,
    type SimulationResult,
} from "./book.js";
import { getBook } from "./bookService.js";
import type { NormalizedBook } from "./bookUtils.js";
import {
    checkSpreadFilter,
    checkMaxBuyCostPerShare,
    checkDepthRequirement,
    computePriceBounds,
    checkPriceProtection,
    checkCircuitBreakers,
    checkExposureCaps,
    isReducingExposure,
    type PortfolioState,
} from "./guardrails.js";
import type { TradeEventGroup, ActivityEventGroup, EventGroup } from "./types.js";

const logger = createChildLogger({ module: "executor" });

/**
 * Result of a copy attempt execution.
 */
export interface ExecutionResult {
    decision: CopyDecision;
    reasonCodes: ReasonCode[];
    copyAttemptId?: string;
    targetNotionalMicros: bigint;
    filledNotionalMicros: bigint;
    filledShareMicros: bigint;
    vwapPriceMicros: number;
    filledRatioBps: number;
}

/**
 * Sleep for timing realism.
 */
async function applyTimingDelay(decisionLatencyMs: number, jitterMsMax: number): Promise<void> {
    const jitter = Math.floor(Math.random() * jitterMsMax);
    const delay = decisionLatencyMs + jitter;
    await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Get current portfolio state for risk cap checks.
 */
async function getPortfolioState(
    scope: PortfolioScope,
    followedUserId: string | null
): Promise<PortfolioState> {
    // Get latest snapshot for equity
    const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
        where: {
            portfolioScope: scope,
            followedUserId: scope === PortfolioScope.EXEC_GLOBAL ? null : followedUserId,
        },
        orderBy: { bucketTime: "desc" },
    });

    const system = scope === PortfolioScope.EXEC_GLOBAL ? await getSystemConfig() : null;
    const defaultEquityMicros =
        scope === PortfolioScope.EXEC_GLOBAL && system
            ? BigInt(system.initialBankrollMicros)
            : BigInt(100_000_000_000); // Default 100k USDC
    const equityMicros = latestSnapshot?.equityMicros ?? defaultEquityMicros;
    const peakEquityMicros = equityMicros; // TODO: Track actual peak

    // Compute total exposure from positions
    const positions = await prisma.ledgerEntry.groupBy({
        by: ["assetId", "marketId"],
        where: {
            portfolioScope: scope,
            ...(scope === PortfolioScope.EXEC_GLOBAL ? {} : { followedUserId }),
            assetId: { not: null },
        },
        _sum: {
            shareDeltaMicros: true,
        },
    });

    let totalExposureMicros = BigInt(0);
    const exposureByMarket = new Map<string, bigint>();

    const assetIds = [
        ...new Set(
            positions
                .map((p) => p.assetId)
                .filter((id): id is string => Boolean(id))
        ),
    ];
    const priceSnapshots = assetIds.length
        ? await prisma.marketPriceSnapshot.findMany({
              where: { assetId: { in: assetIds } },
              orderBy: { bucketTime: "desc" },
              distinct: ["assetId"],
              select: { assetId: true, midpointPriceMicros: true },
          })
        : [];
    const priceByAsset = new Map<string, number>(
        priceSnapshots.map((snap) => [snap.assetId, snap.midpointPriceMicros])
    );

    for (const pos of positions) {
        if (!pos.assetId || !pos._sum.shareDeltaMicros) continue;

        const priceMicros = priceByAsset.get(pos.assetId) ?? 500_000; // Default 0.50
        const positionValue =
            (pos._sum.shareDeltaMicros * BigInt(priceMicros)) / BigInt(1_000_000);

        // Use absolute value for exposure
        const absExposure = positionValue < BigInt(0) ? -positionValue : positionValue;
        totalExposureMicros += absExposure;

        if (pos.marketId) {
            const current = exposureByMarket.get(pos.marketId) ?? BigInt(0);
            exposureByMarket.set(pos.marketId, current + absExposure);
        }
    }

    // Get per-user exposure (for global scope)
    const exposureByUser = new Map<string, bigint>();
    if (scope === PortfolioScope.EXEC_GLOBAL) {
        const perUserPositions = await prisma.ledgerEntry.groupBy({
            by: ["followedUserId", "assetId"],
            where: {
                portfolioScope: scope,
                followedUserId: { not: null },
                assetId: { not: null },
            },
            _sum: {
                shareDeltaMicros: true,
            },
        });

        for (const pos of perUserPositions) {
            if (!pos.followedUserId || !pos.assetId || !pos._sum.shareDeltaMicros) continue;

            const priceMicros = priceByAsset.get(pos.assetId) ?? 500_000;
            const positionValue =
                (pos._sum.shareDeltaMicros * BigInt(priceMicros)) / BigInt(1_000_000);
            const absExposure = positionValue < BigInt(0) ? -positionValue : positionValue;

            const current = exposureByUser.get(pos.followedUserId) ?? BigInt(0);
            exposureByUser.set(pos.followedUserId, current + absExposure);
        }
    }

    // TODO: Compute actual daily/weekly PnL from ledger
    const dailyPnlMicros = BigInt(0);
    const weeklyPnlMicros = BigInt(0);

    return {
        equityMicros,
        totalExposureMicros,
        exposureByMarket,
        exposureByUser,
        dailyPnlMicros,
        weeklyPnlMicros,
        peakEquityMicros,
    };
}

/**
 * Execute a copy attempt for a trade event group.
 */
export async function executeTradeGroup(
    group: TradeEventGroup,
    portfolioScope: PortfolioScope,
    followedUserId: string | null
): Promise<ExecutionResult> {
    // Use rawTokenId (on-chain) if available, otherwise assetId (API)
    const effectiveTokenId = group.rawTokenId ?? group.assetId;

    const log = logger.child({
        groupKey: group.groupKey,
        scope: portfolioScope,
        followedUserId,
        side: group.side,
        tokenId: effectiveTokenId,
    });

    const reasonCodes: ReasonCode[] = [];

    // Get config
    const config = followedUserId
        ? await getUserConfig(followedUserId)
        : await getGlobalConfig();
    const { guardrails, sizing } = config;

    // 1. Apply timing delay
    log.debug("Applying timing delay");
    await applyTimingDelay(guardrails.decisionLatencyMs, guardrails.jitterMsMax);

    // 2. Get portfolio state
    const portfolioState = await getPortfolioState(portfolioScope, followedUserId);

    // 3. Compute target notional
    const targetResult = computeTargetNotional(
        group.totalNotionalMicros,
        portfolioState.equityMicros,
        sizing
    );

    // 4. Check if we have a token ID
    if (!effectiveTokenId) {
        log.error("No token ID available for book simulation");
        return {
            decision: CopyDecision.SKIP,
            reasonCodes: [ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS],
            targetNotionalMicros: targetResult.targetNotionalMicros,
            filledNotionalMicros: BigInt(0),
            filledShareMicros: BigInt(0),
            vwapPriceMicros: 0,
            filledRatioBps: 0,
        };
    }

    // 5. Fetch order book FIRST (before computing price bounds)
    // Uses cache-first approach: WS cache if available, REST fallback
    log.debug("Fetching order book (cache-first)");
    const bookResult = await getBook(effectiveTokenId, {
        waitMs: 500,
        freshnessMs: 2000,
    });

    if (!bookResult.book) {
        log.warn("Order book not available (market may be resolved)");
        return {
            decision: CopyDecision.SKIP,
            reasonCodes: [ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS],
            targetNotionalMicros: targetResult.targetNotionalMicros,
            filledNotionalMicros: BigInt(0),
            filledShareMicros: BigInt(0),
            vwapPriceMicros: 0,
            filledRatioBps: 0,
        };
    }

    const book: NormalizedBook = bookResult.book;

    // 6. Extract metrics from the normalized book
    const { midPriceMicros, bestBidMicros, bestAskMicros, spreadMicros } = book;

    // 7. Now compute price bounds using the REAL mid price
    const priceBounds = computePriceBounds(
        group.side,
        group.vwapPriceMicros,
        midPriceMicros, // Use real mid from book
        guardrails
    );

    // 8. Simulate fills against the normalized book
    const targetShareMicros = computeTargetShares(targetResult.targetNotionalMicros, group.vwapPriceMicros);
    const simulation = simulateFromNormalizedBook(
        book,
        group.side,
        targetShareMicros,
        priceBounds.maxPriceMicros,
        priceBounds.minPriceMicros
    );

    // Log decision inputs for observability (helps debug "always skip" issues)
    log.info(
        {
            side: group.side,
            theirRefPriceMicros: group.vwapPriceMicros,
            bestBidMicros,
            bestAskMicros,
            midPriceMicros,
            spreadMicros,
            maxPriceMicros: priceBounds.maxPriceMicros,
            minPriceMicros: priceBounds.minPriceMicros,
            targetNotionalMicros: targetResult.targetNotionalMicros.toString(),
            targetShareMicros: targetShareMicros.toString(),
            availableNotionalMicros: simulation.availableNotionalMicros.toString(),
            filledNotionalMicros: simulation.filledNotionalMicros.toString(),
            filledShareMicros: simulation.filledShareMicros.toString(),
            filledRatioBps: simulation.filledRatioBps,
            simulationSuccess: simulation.success,
            bookSource: bookResult.source,
            bookStale: bookResult.stale,
        },
        "Copy attempt decision inputs"
    );

    if (!simulation.success) {
        log.warn({ error: simulation.error }, "Book simulation failed");
        reasonCodes.push(ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS);
    }

    // 9. Run guardrail checks
    if (simulation.success) {
        // Optional guardrail: max buy cost per share (GLOBAL only)
        if (portfolioScope === PortfolioScope.EXEC_GLOBAL) {
            const maxBuyCostCheck = checkMaxBuyCostPerShare(
                group.side,
                simulation.vwapPriceMicros,
                guardrails
            );
            if (!maxBuyCostCheck.passed) {
                reasonCodes.push(...maxBuyCostCheck.reasonCodes);
            }
        }

        // Spread filter
        const spreadCheck = checkSpreadFilter(simulation.spreadMicros, guardrails);
        if (!spreadCheck.passed) {
            reasonCodes.push(...spreadCheck.reasonCodes);
        }

        // Depth requirement
        const depthCheck = checkDepthRequirement(
            simulation.availableNotionalMicros,
            targetResult.targetNotionalMicros,
            guardrails
        );
        if (!depthCheck.passed) {
            reasonCodes.push(...depthCheck.reasonCodes);
        }

        // Price protection
        if (simulation.filledShareMicros > BigInt(0)) {
            const priceCheck = checkPriceProtection(
                group.side,
                simulation.vwapPriceMicros,
                group.vwapPriceMicros, // Their reference price
                simulation.midPriceMicros,
                guardrails
            );
            if (!priceCheck.passed) {
                reasonCodes.push(...priceCheck.reasonCodes);
            }
        }

        // Check if reducing exposure (allows bypassing some caps)
        const isReducing = await isReducingExposure(
            portfolioScope,
            followedUserId,
            effectiveTokenId,
            group.side
        );

        // Circuit breakers (skip if reducing)
        if (!isReducing) {
            const circuitCheck = checkCircuitBreakers(portfolioState, guardrails);
            if (circuitCheck.tripped) {
                reasonCodes.push(...circuitCheck.reasonCodes);
            }
        }

        // Exposure caps (skip if reducing)
        if (!isReducing) {
            const exposureCheck = checkExposureCaps(
                portfolioState,
                simulation.filledNotionalMicros,
                group.marketId,
                followedUserId,
                guardrails,
                portfolioScope === PortfolioScope.EXEC_GLOBAL ? "GLOBAL" : "USER"
            );
            if (!exposureCheck.passed) {
                reasonCodes.push(...exposureCheck.reasonCodes);
            }
        }
    }

    // Check for zero fill
    if (simulation.success && simulation.filledShareMicros === BigInt(0)) {
        reasonCodes.push(ReasonCodes.NO_LIQUIDITY_WITHIN_BOUNDS);
    }

    // 10. Determine decision
    const uniqueReasons = [...new Set(reasonCodes)];
    const decision = uniqueReasons.length === 0 ? CopyDecision.EXECUTE : CopyDecision.SKIP;

    log.info(
        {
            decision,
            reasonCodes: uniqueReasons,
            targetNotional: targetResult.targetNotionalMicros.toString(),
            filledNotional: simulation.filledNotionalMicros.toString(),
            filledRatio: simulation.filledRatioBps,
        },
        "Copy attempt decision"
    );

    // 11. Write CopyAttempt to database
    // Handle the upsert differently based on whether followedUserId is null
    // Prisma compound unique with nullable field requires special handling
    const copyAttemptData = {
        portfolioScope,
        followedUserId,
        groupKey: group.groupKey,
        decision,
        reasonCodes: uniqueReasons,
        targetNotionalMicros: targetResult.targetNotionalMicros,
        filledNotionalMicros: decision === CopyDecision.EXECUTE ? simulation.filledNotionalMicros : BigInt(0),
        vwapPriceMicros: decision === CopyDecision.EXECUTE ? simulation.vwapPriceMicros : null,
        filledRatioBps: decision === CopyDecision.EXECUTE ? simulation.filledRatioBps : 0,
        theirReferencePriceMicros: group.vwapPriceMicros,
        midPriceMicrosAtDecision: simulation.midPriceMicros,
    };

    let copyAttempt;
    if (followedUserId !== null) {
        // User scope: use compound unique key
        copyAttempt = await prisma.copyAttempt.upsert({
            where: {
                portfolioScope_followedUserId_groupKey: {
                    portfolioScope,
                    followedUserId,
                    groupKey: group.groupKey,
                },
            },
            create: copyAttemptData,
            update: {
                decision,
                reasonCodes: uniqueReasons,
                filledNotionalMicros: decision === CopyDecision.EXECUTE ? simulation.filledNotionalMicros : BigInt(0),
                vwapPriceMicros: decision === CopyDecision.EXECUTE ? simulation.vwapPriceMicros : null,
                filledRatioBps: decision === CopyDecision.EXECUTE ? simulation.filledRatioBps : 0,
            },
        });
    } else {
        // Global scope: use findFirst + upsert pattern for null followedUserId
        const existing = await prisma.copyAttempt.findFirst({
            where: {
                portfolioScope,
                followedUserId: null,
                groupKey: group.groupKey,
            },
        });

        if (existing) {
            copyAttempt = await prisma.copyAttempt.update({
                where: { id: existing.id },
                data: {
                    decision,
                    reasonCodes: uniqueReasons,
                    filledNotionalMicros: decision === CopyDecision.EXECUTE ? simulation.filledNotionalMicros : BigInt(0),
                    vwapPriceMicros: decision === CopyDecision.EXECUTE ? simulation.vwapPriceMicros : null,
                    filledRatioBps: decision === CopyDecision.EXECUTE ? simulation.filledRatioBps : 0,
                },
            });
        } else {
            copyAttempt = await prisma.copyAttempt.create({
                data: copyAttemptData,
            });
        }
    }

    // 12. Write ExecutableFill rows and ledger entries if EXECUTE
    if (decision === CopyDecision.EXECUTE && simulation.fills.length > 0) {
        // Write fill rows
        for (const fill of simulation.fills) {
            await prisma.executableFill.create({
                data: {
                    copyAttemptId: copyAttempt.id,
                    filledShareMicros: fill.shareMicros,
                    fillPriceMicros: fill.priceMicros,
                    fillNotionalMicros: fill.notionalMicros,
                },
            });
        }

        // Write ledger entry
        const isBuy = group.side === TradeSide.BUY;
        const shareDeltaMicros = isBuy
            ? simulation.filledShareMicros
            : -simulation.filledShareMicros;
        const cashDeltaMicros = isBuy
            ? -simulation.filledNotionalMicros
            : simulation.filledNotionalMicros;

        await prisma.ledgerEntry.upsert({
            where: {
                portfolioScope_refId_entryType: {
                    portfolioScope,
                    refId: `copy:${copyAttempt.id}`,
                    entryType: "TRADE_FILL",
                },
            },
            create: {
                portfolioScope,
                followedUserId,
                marketId: group.marketId,
                assetId: effectiveTokenId, // Use rawTokenId for WS-first trades
                entryType: "TRADE_FILL",
                shareDeltaMicros,
                cashDeltaMicros,
                priceMicros: simulation.vwapPriceMicros,
                refId: `copy:${copyAttempt.id}`,
            },
            update: {},
        });

        log.debug("Wrote ExecutableFill and LedgerEntry rows");
    }

    return {
        decision,
        reasonCodes: uniqueReasons,
        copyAttemptId: copyAttempt.id,
        targetNotionalMicros: targetResult.targetNotionalMicros,
        filledNotionalMicros: simulation.filledNotionalMicros,
        filledShareMicros: simulation.filledShareMicros,
        vwapPriceMicros: simulation.vwapPriceMicros,
        filledRatioBps: simulation.filledRatioBps,
    };
}

/**
 * Execute a copy attempt for an activity event group (MERGE/SPLIT).
 * TODO: Implement activity copy logic when applicable.
 */
export async function executeActivityGroup(
    group: ActivityEventGroup,
    portfolioScope: PortfolioScope,
    followedUserId: string | null
): Promise<ExecutionResult> {
    const log = logger.child({
        groupKey: group.groupKey,
        scope: portfolioScope,
        followedUserId,
        activityType: group.activityType,
    });

    // For now, skip MERGE/SPLIT copy attempts with reason code
    // In v0, we track them but don't execute
    log.info("Activity copy not applicable in v0");

    return {
        decision: CopyDecision.SKIP,
        reasonCodes: [ReasonCodes.MERGE_SPLIT_NOT_APPLICABLE],
        targetNotionalMicros: BigInt(0),
        filledNotionalMicros: BigInt(0),
        filledShareMicros: BigInt(0),
        vwapPriceMicros: 0,
        filledRatioBps: 0,
    };
}

/**
 * Execute a copy attempt for any event group.
 */
export async function executeCopyAttempt(
    group: EventGroup,
    portfolioScope: PortfolioScope
): Promise<ExecutionResult> {
    // Single global execution portfolio, but we still attribute every attempt
    // to the followed user that triggered it (for overrides + reporting).
    const followedUserId = group.followedUserId;

    if (group.type === "trade") {
        return executeTradeGroup(group, portfolioScope, followedUserId);
    } else {
        return executeActivityGroup(group, portfolioScope, followedUserId);
    }
}
