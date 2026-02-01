import { LedgerEntryType, PortfolioScope, Prisma, type LedgerEntry } from "@prisma/client";

export const EXEC_GLOBAL_STATE_ID = "EXEC_GLOBAL";

export interface LedgerEntryWriteInput {
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
    try {
        const created = await tx.ledgerEntry.create({
            data,
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

    const contributedDelta =
        entry.entryType === LedgerEntryType.DEPOSIT ? entry.cashDeltaMicros : BigInt(0);

    await tx.globalPortfolioState.upsert({
        where: { id: EXEC_GLOBAL_STATE_ID },
        create: {
            id: EXEC_GLOBAL_STATE_ID,
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
        where: { assetId: entry.assetId },
        create: {
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
            assetId_followedUserId: {
                assetId: entry.assetId,
                followedUserId: entry.followedUserId,
            },
        },
        create: {
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
