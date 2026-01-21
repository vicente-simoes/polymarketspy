import { LedgerEntryType, PortfolioScope } from "@prisma/client";
import { prisma } from "./db/prisma.js";
import { createChildLogger } from "./log/logger.js";
import { fetchResolvedTokenPayouts } from "./enrichment/gamma.js";

const logger = createChildLogger({ module: "settlement-loop" });

const SETTLEMENT_INTERVAL_MS = 120_000;
const MICROS_PER_UNIT = BigInt(1_000_000);

let settlementTimer: ReturnType<typeof setInterval> | null = null;
let settlementInFlight = false;

interface OpenPosition {
    followedUserId: string | null;
    assetId: string;
    marketId: string | null;
    shareMicros: bigint;
}

function buildSettlementRefBase(position: OpenPosition): string {
    const followedUserPart = position.followedUserId ?? "null";
    const marketPart = position.marketId ?? "null";
    return `settle:${position.assetId}:${followedUserPart}:${marketPart}`;
}

async function getOpenExecGlobalPositions(): Promise<OpenPosition[]> {
    const grouped = await prisma.ledgerEntry.groupBy({
        by: ["followedUserId", "assetId", "marketId"],
        where: {
            portfolioScope: PortfolioScope.EXEC_GLOBAL,
            assetId: { not: null },
        },
        _sum: {
            shareDeltaMicros: true,
        },
    });

    const open: OpenPosition[] = [];
    for (const row of grouped) {
        if (!row.assetId) continue;
        const shareMicros = row._sum.shareDeltaMicros ?? BigInt(0);
        if (shareMicros === BigInt(0)) continue;

        open.push({
            followedUserId: row.followedUserId ?? null,
            assetId: row.assetId,
            marketId: row.marketId ?? null,
            shareMicros,
        });
    }

    return open;
}

async function settleResolvedPositionsOnce(): Promise<void> {
    if (settlementInFlight) {
        logger.warn("Settlement run already in flight, skipping");
        return;
    }

    settlementInFlight = true;
    const log = logger.child({ operation: "settle-once" });

    try {
        const openPositions = await getOpenExecGlobalPositions();
        if (openPositions.length === 0) {
            log.debug("No open EXEC_GLOBAL positions to check");
            return;
        }

        const tokenIds = Array.from(
            new Set(openPositions.map((p) => p.assetId).filter((id) => /^\d+$/.test(id)))
        );
        if (tokenIds.length === 0) {
            log.debug({ openPositions: openPositions.length }, "No numeric token IDs to check");
            return;
        }

        const payouts = await fetchResolvedTokenPayouts(tokenIds);
        if (payouts.size === 0) {
            log.debug({ tokenCount: tokenIds.length }, "No resolved tokens found");
            return;
        }

        let settledPositions = 0;

        for (const position of openPositions) {
            const payoutPerShareMicros = payouts.get(position.assetId);
            if (payoutPerShareMicros === undefined) continue;

            const refBase = buildSettlementRefBase(position);
            const sharesRefId = `${refBase}:shares`;
            const cashRefId = `${refBase}:cash`;

            // 1) Burn shares to close the position.
            await prisma.ledgerEntry.upsert({
                where: {
                    portfolioScope_refId_entryType: {
                        portfolioScope: PortfolioScope.EXEC_GLOBAL,
                        refId: sharesRefId,
                        entryType: LedgerEntryType.SETTLEMENT,
                    },
                },
                create: {
                    portfolioScope: PortfolioScope.EXEC_GLOBAL,
                    followedUserId: position.followedUserId,
                    marketId: position.marketId,
                    assetId: position.assetId,
                    entryType: LedgerEntryType.SETTLEMENT,
                    shareDeltaMicros: -position.shareMicros,
                    cashDeltaMicros: BigInt(0),
                    priceMicros: null,
                    refId: sharesRefId,
                },
                update: {},
            });

            // 2) Credit cash payout (if any). Winning token pays 1 USDC/share; losing pays 0.
            const cashDeltaMicros =
                (position.shareMicros * BigInt(payoutPerShareMicros)) / MICROS_PER_UNIT;
            if (cashDeltaMicros !== BigInt(0)) {
                await prisma.ledgerEntry.upsert({
                    where: {
                        portfolioScope_refId_entryType: {
                            portfolioScope: PortfolioScope.EXEC_GLOBAL,
                            refId: cashRefId,
                            entryType: LedgerEntryType.SETTLEMENT,
                        },
                    },
                    create: {
                        portfolioScope: PortfolioScope.EXEC_GLOBAL,
                        followedUserId: position.followedUserId,
                        marketId: position.marketId,
                        assetId: null,
                        entryType: LedgerEntryType.SETTLEMENT,
                        shareDeltaMicros: BigInt(0),
                        cashDeltaMicros,
                        priceMicros: null,
                        refId: cashRefId,
                    },
                    update: {},
                });
            }

            settledPositions++;

            log.info(
                {
                    assetId: position.assetId,
                    marketId: position.marketId,
                    followedUserId: position.followedUserId,
                    shareMicros: position.shareMicros.toString(),
                    payoutPerShareMicros,
                    cashDeltaMicros: cashDeltaMicros.toString(),
                },
                "Settled resolved position"
            );
        }

        log.info(
            {
                openPositions: openPositions.length,
                tokenCount: tokenIds.length,
                resolvedTokens: payouts.size,
                settledPositions,
            },
            "Settlement run complete"
        );
    } catch (err) {
        log.error({ err }, "Settlement run failed");
    } finally {
        settlementInFlight = false;
    }
}

export function startSettlementLoop(): void {
    if (settlementTimer) {
        logger.warn("Settlement loop already running");
        return;
    }

    logger.info({ intervalMs: SETTLEMENT_INTERVAL_MS }, "Starting settlement loop");

    settleResolvedPositionsOnce().catch((err) => {
        logger.error({ err }, "Initial settlement run failed");
    });

    settlementTimer = setInterval(() => {
        settleResolvedPositionsOnce().catch((err) => {
            logger.error({ err }, "Scheduled settlement run failed");
        });
    }, SETTLEMENT_INTERVAL_MS);
}

export function stopSettlementLoop(): void {
    if (settlementTimer) {
        clearInterval(settlementTimer);
        settlementTimer = null;
        logger.info("Settlement loop stopped");
    }
}

