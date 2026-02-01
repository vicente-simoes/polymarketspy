import { LedgerEntryType, PortfolioScope, Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EXEC_GLOBAL_STATE_ID = "EXEC_GLOBAL";
const SYSTEM_CONFIG_KEY = "system:config";

function parseInitialBankrollMicros(valueJson: unknown): number {
    if (!valueJson || typeof valueJson !== "object") return 0;
    const raw = (valueJson as { initialBankrollMicros?: unknown }).initialBankrollMicros;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
    return Math.max(0, Math.floor(raw));
}

async function main(): Promise<void> {
    const reset = process.argv.includes("--reset");
    if (!reset) {
        throw new Error("Refusing to run without --reset (this rebuilds derived cache tables).");
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
        await tx.currentPositionByLeader.deleteMany();
        await tx.currentPosition.deleteMany();
        await tx.currentPrice.deleteMany();
        await tx.globalPortfolioState.deleteMany();
    });

    const systemRow = await prisma.systemCheckpoint.findUnique({
        where: { key: SYSTEM_CONFIG_KEY },
        select: { valueJson: true },
    });
    const initialBankrollMicros = parseInitialBankrollMicros(systemRow?.valueJson);

    const cashAgg = await prisma.ledgerEntry.aggregate({
        where: { portfolioScope: PortfolioScope.EXEC_GLOBAL },
        _sum: { cashDeltaMicros: true },
    });
    const depositAgg = await prisma.ledgerEntry.aggregate({
        where: {
            portfolioScope: PortfolioScope.EXEC_GLOBAL,
            entryType: LedgerEntryType.DEPOSIT,
        },
        _sum: { cashDeltaMicros: true },
    });

    // GlobalPortfolioState stores ledger-derived values only (no initial bankroll).
    // The initial bankroll is read from system config at runtime when computing equity/PnL.
    const cashMicros = cashAgg._sum.cashDeltaMicros ?? BigInt(0);
    const contributedCapitalMicros = depositAgg._sum.cashDeltaMicros ?? BigInt(0);

    await prisma.globalPortfolioState.upsert({
        where: { id: EXEC_GLOBAL_STATE_ID },
        create: {
            id: EXEC_GLOBAL_STATE_ID,
            cashMicros,
            contributedCapitalMicros,
        },
        update: {
            cashMicros,
            contributedCapitalMicros,
        },
    });

    const groupedPositions = await prisma.ledgerEntry.groupBy({
        by: ["assetId"],
        where: {
            portfolioScope: PortfolioScope.EXEC_GLOBAL,
            assetId: { not: null },
        },
        _sum: {
            shareDeltaMicros: true,
            cashDeltaMicros: true,
        },
    });

    const allAssetIds = groupedPositions
        .map((row) => row.assetId)
        .filter((id): id is string => Boolean(id));

    const tokenMetadata = allAssetIds.length
        ? await prisma.tokenMetadataCache.findMany({
              where: { tokenId: { in: allAssetIds } },
              select: { tokenId: true, marketId: true },
          })
        : [];
    const marketIdByAsset = new Map<string, string | null>(
        tokenMetadata.map((meta) => [meta.tokenId, meta.marketId ?? null])
    );

    const positionRows = groupedPositions
        .map((row) => {
            if (!row.assetId) return null;
            const shareMicros = row._sum.shareDeltaMicros ?? BigInt(0);
            if (shareMicros === BigInt(0)) return null;
            const netCashFlowMicros = row._sum.cashDeltaMicros ?? BigInt(0);
            return {
                assetId: row.assetId,
                marketId: marketIdByAsset.get(row.assetId) ?? null,
                shareMicros,
                netCashFlowMicros,
                updatedAt: now,
            };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

    if (positionRows.length > 0) {
        await prisma.currentPosition.createMany({
            data: positionRows,
            skipDuplicates: true,
        });
    }

    const groupedByLeader = await prisma.ledgerEntry.groupBy({
        by: ["assetId", "followedUserId"],
        where: {
            portfolioScope: PortfolioScope.EXEC_GLOBAL,
            assetId: { not: null },
            followedUserId: { not: null },
        },
        _sum: {
            shareDeltaMicros: true,
            cashDeltaMicros: true,
        },
    });

    const byLeaderRows = groupedByLeader
        .map((row) => {
            if (!row.assetId || !row.followedUserId) return null;
            const shareMicros = row._sum.shareDeltaMicros ?? BigInt(0);
            if (shareMicros === BigInt(0)) return null;
            const netCashFlowMicros = row._sum.cashDeltaMicros ?? BigInt(0);
            return {
                assetId: row.assetId,
                followedUserId: row.followedUserId,
                marketId: marketIdByAsset.get(row.assetId) ?? null,
                shareMicros,
                netCashFlowMicros,
                updatedAt: now,
            };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

    if (byLeaderRows.length > 0) {
        await prisma.currentPositionByLeader.createMany({
            data: byLeaderRows,
            skipDuplicates: true,
        });
    }

    // Seed CurrentPrice from the latest MarketPriceSnapshot per asset (if available).
    if (positionRows.length > 0) {
        const heldAssetIds = positionRows.map((row) => row.assetId);

        const latestPrices = await prisma.$queryRaw<
            { assetId: string; midpointPriceMicros: number }[]
        >(Prisma.sql`
            SELECT DISTINCT ON ("assetId")
                "assetId",
                "midpointPriceMicros"
            FROM "MarketPriceSnapshot"
            WHERE "assetId" IN (${Prisma.join(heldAssetIds)})
            ORDER BY "assetId", "bucketTime" DESC
        `);

        if (latestPrices.length > 0) {
            await prisma.currentPrice.createMany({
                data: latestPrices.map((row) => ({
                    assetId: row.assetId,
                    midpointPriceMicros: row.midpointPriceMicros,
                    updatedAt: now,
                })),
                skipDuplicates: true,
            });
        }
    }

    console.log("CPU caches backfill complete", {
        initialBankrollMicros,
        cashMicros: cashMicros.toString(),
        contributedCapitalMicros: contributedCapitalMicros.toString(),
        currentPositions: positionRows.length,
        positionsByLeader: byLeaderRows.length,
    });
}

main()
    .then(async () => {
        await prisma.$disconnect();
    })
    .catch(async (err) => {
        console.error(err);
        await prisma.$disconnect();
        process.exit(1);
    });
