import { LedgerEntryType, PortfolioScope, Prisma, TradingMode, type LedgerEntry } from "@prisma/client";

export const EXEC_GLOBAL_STATE_ID = "EXEC_GLOBAL";

export interface LedgerEntryWriteInput {
    tradingMode?: TradingMode;
    portfolioScope: PortfolioScope;
    followedUserId: string | null;
    marketId: string | null;
    assetId: string | null;
    entryType: LedgerEntryType;
    shareDeltaMicros: bigint;
    cashDeltaMicros: bigint;
    priceMicros: number | null;
    refId: string;
}

export async function createLedgerEntryIfNotExistsAndUpdateCaches(
    tx: Prisma.TransactionClient,
    data: LedgerEntryWriteInput
): Promise<{ inserted: boolean }> {
    const tradingMode = data.tradingMode ?? TradingMode.PAPER;
    try {
        const created = await tx.ledgerEntry.create({
            data: {
                ...data,
                tradingMode,
            },
        });
        await applyLedgerEntryToCaches(tx, created);
        return { inserted: true };
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            return { inserted: false };
        }
        throw err;
    }
}

async function applyLedgerEntryToCaches(
    tx: Prisma.TransactionClient,
    entry: LedgerEntry
): Promise<void> {
    if (entry.portfolioScope !== PortfolioScope.EXEC_GLOBAL) return;

    const tradingMode = entry.tradingMode;
    const contributedDelta =
        entry.entryType === LedgerEntryType.DEPOSIT ? entry.cashDeltaMicros : BigInt(0);

    await tx.globalPortfolioState.upsert({
        where: {
            tradingMode_portfolioScope: {
                tradingMode,
                portfolioScope: entry.portfolioScope,
            },
        },
        create: {
            tradingMode,
            portfolioScope: entry.portfolioScope,
            cashMicros: entry.cashDeltaMicros,
            contributedCapitalMicros: contributedDelta,
        },
        update: {
            cashMicros: { increment: entry.cashDeltaMicros },
            ...(contributedDelta !== BigInt(0)
                ? { contributedCapitalMicros: { increment: contributedDelta } }
                : {}),
        },
    });

    if (!entry.assetId) return;

    await tx.currentPosition.upsert({
        where: {
            tradingMode_assetId: {
                tradingMode,
                assetId: entry.assetId,
            },
        },
        create: {
            tradingMode,
            assetId: entry.assetId,
            marketId: entry.marketId,
            shareMicros: entry.shareDeltaMicros,
            netCashFlowMicros: entry.cashDeltaMicros,
        },
        update: {
            shareMicros: { increment: entry.shareDeltaMicros },
            netCashFlowMicros: { increment: entry.cashDeltaMicros },
            ...(entry.marketId ? { marketId: entry.marketId } : {}),
        },
    });

    if (!entry.followedUserId) return;

    await tx.currentPositionByLeader.upsert({
        where: {
            tradingMode_assetId_followedUserId: {
                tradingMode,
                assetId: entry.assetId,
                followedUserId: entry.followedUserId,
            },
        },
        create: {
            tradingMode,
            assetId: entry.assetId,
            followedUserId: entry.followedUserId,
            marketId: entry.marketId,
            shareMicros: entry.shareDeltaMicros,
            netCashFlowMicros: entry.cashDeltaMicros,
        },
        update: {
            shareMicros: { increment: entry.shareDeltaMicros },
            netCashFlowMicros: { increment: entry.cashDeltaMicros },
            ...(entry.marketId ? { marketId: entry.marketId } : {}),
        },
    });
}
