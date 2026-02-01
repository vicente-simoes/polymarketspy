import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const { id } = await params
        const user = await prisma.followedUser.findUnique({
            where: { id },
            include: {
                proxies: true,
                guardrails: true,
                sizing: true
            }
        })

        if (!user) {
            return NextResponse.json({ error: "User not found" }, { status: 404 })
        }

        const wallets = [user.profileWallet, ...user.proxies.map((proxy) => proxy.wallet)]
        // Shadow portfolios are removed and per-user snapshots are no longer written.
        // Keep the response shape stable but return an empty equity curve for now.
        const equityCurve: { ts: number; shadow: number; exec: number; gap: number }[] = []

        const [
            totalAttempts,
            executedAttempts,
            partialAttempts,
            tradeCount,
            slippageAttempts,
            lagTrades,
            skipAttempts,
            recentTrades,
            recentAttempts,
            leaderPositions
        ] = await Promise.all([
            prisma.copyAttempt.count({
                where: { followedUserId: id, portfolioScope: "EXEC_GLOBAL" }
            }),
            prisma.copyAttempt.count({
                where: {
                    followedUserId: id,
                    portfolioScope: "EXEC_GLOBAL",
                    decision: "EXECUTE"
                }
            }),
            prisma.copyAttempt.count({
                where: {
                    followedUserId: id,
                    portfolioScope: "EXEC_GLOBAL",
                    decision: "EXECUTE",
                    filledRatioBps: { gt: 0, lt: 10000 }
                }
            }),
            prisma.tradeEvent.count({
                where: {
                    OR: [
                        { profileWallet: { in: wallets } },
                        { proxyWallet: { in: wallets } }
                    ]
                }
            }),
            prisma.copyAttempt.findMany({
                where: {
                    followedUserId: id,
                    portfolioScope: "EXEC_GLOBAL",
                    decision: "EXECUTE",
                    vwapPriceMicros: { not: null }
                },
                select: {
                    vwapPriceMicros: true,
                    theirReferencePriceMicros: true
                },
                orderBy: { createdAt: "desc" },
                take: 200
            }),
            prisma.tradeEvent.findMany({
                where: {
                    OR: [
                        { profileWallet: { in: wallets } },
                        { proxyWallet: { in: wallets } }
                    ]
                },
                select: { eventTime: true, detectTime: true },
                orderBy: { eventTime: "desc" },
                take: 200
            }),
            prisma.copyAttempt.findMany({
                where: {
                    followedUserId: id,
                    portfolioScope: "EXEC_GLOBAL",
                    decision: "SKIP"
                },
                select: { reasonCodes: true },
                orderBy: { createdAt: "desc" },
                take: 200
            }),
            prisma.tradeEvent.findMany({
                where: {
                    OR: [
                        { profileWallet: { in: wallets } },
                        { proxyWallet: { in: wallets } }
                    ]
                },
                orderBy: { eventTime: "desc" },
                take: 30
            }),
            prisma.copyAttempt.findMany({
                where: { followedUserId: id, portfolioScope: "EXEC_GLOBAL" },
                orderBy: { createdAt: "desc" },
                take: 30
            }),
            prisma.currentPositionByLeader.findMany({
                where: { followedUserId: id },
                select: {
                    assetId: true,
                    shareMicros: true,
                    netCashFlowMicros: true
                }
            })
        ])

        const attemptRate = tradeCount > 0 ? (totalAttempts / tradeCount) * 100 : 0
        const fillRate = totalAttempts > 0 ? (executedAttempts / totalAttempts) * 100 : 0
        const partialRate = executedAttempts > 0 ? (partialAttempts / executedAttempts) * 100 : 0

        const slippageBuckets = [
            { label: "< -2.0c", min: Number.NEGATIVE_INFINITY, max: -20000 },
            { label: "-2.0 to -1.0c", min: -20000, max: -10000 },
            { label: "-1.0 to -0.5c", min: -10000, max: -5000 },
            { label: "-0.5 to 0c", min: -5000, max: 0 },
            { label: "0 to +0.5c", min: 0, max: 5000 },
            { label: "+0.5 to +1.0c", min: 5000, max: 10000 },
            { label: "+1.0 to +2.0c", min: 10000, max: 20000 },
            { label: "> +2.0c", min: 20000, max: Number.POSITIVE_INFINITY }
        ]

        const slippageHistogram = slippageBuckets.map((bucket) => ({
            bucket: bucket.label,
            count: 0
        }))

        for (const attempt of slippageAttempts) {
            const diff =
                (attempt.vwapPriceMicros ?? 0) - attempt.theirReferencePriceMicros
            const bucketIndex = slippageBuckets.findIndex(
                (bucket) => diff >= bucket.min && diff < bucket.max
            )
            if (bucketIndex >= 0) {
                slippageHistogram[bucketIndex].count += 1
            }
        }

        const lagBuckets = [
            { label: "<1s", min: 0, max: 1000 },
            { label: "1-3s", min: 1000, max: 3000 },
            { label: "3-5s", min: 3000, max: 5000 },
            { label: "5-10s", min: 5000, max: 10000 },
            { label: "10-20s", min: 10000, max: 20000 },
            { label: ">20s", min: 20000, max: Number.POSITIVE_INFINITY }
        ]

        const lagHistogram = lagBuckets.map((bucket) => ({
            bucket: bucket.label,
            count: 0
        }))

        for (const trade of lagTrades) {
            const lag = Math.max(0, trade.detectTime.getTime() - trade.eventTime.getTime())
            const bucketIndex = lagBuckets.findIndex(
                (bucket) => lag >= bucket.min && lag < bucket.max
            )
            if (bucketIndex >= 0) {
                lagHistogram[bucketIndex].count += 1
            }
        }

        const skipCounts = new Map<string, number>()
        for (const attempt of skipAttempts) {
            for (const reason of attempt.reasonCodes) {
                skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1)
            }
        }

        const skipReasonsSorted = Array.from(skipCounts.entries()).sort(
            (a, b) => b[1] - a[1]
        )

        const skipReasons = skipReasonsSorted.slice(0, 6).map(([reason, count]) => ({
            reason,
            count
        }))

        if (skipReasonsSorted.length > 6) {
            const remaining = skipReasonsSorted
                .slice(6)
                .reduce((sum, [, count]) => sum + count, 0)
            if (remaining > 0) {
                skipReasons.push({ reason: "OTHER", count: remaining })
            }
        }

        const openLeaderPositions = leaderPositions.filter(
            (row) => row.shareMicros !== BigInt(0)
        )
        const assetIds = openLeaderPositions.map((row) => row.assetId)

        const tokenMetadata = assetIds.length
            ? await prisma.tokenMetadataCache.findMany({
                  where: { tokenId: { in: assetIds } },
                  select: {
                      tokenId: true,
                      marketTitle: true,
                      outcomeLabel: true
                  }
              })
            : []
        const tokenMetadataMap = new Map(tokenMetadata.map((meta) => [meta.tokenId, meta]))

        const priceRows = assetIds.length
            ? await prisma.currentPrice.findMany({
                  where: { assetId: { in: assetIds } },
                  select: { assetId: true, midpointPriceMicros: true }
              })
            : []
        const priceByAsset = new Map(priceRows.map((row) => [row.assetId, row.midpointPriceMicros]))

        const MICROS_PER_UNIT = BigInt(1_000_000)
        const DEFAULT_MARK_PRICE_MICROS = 500_000 // $0.50

        let execEquityMicros = BigInt(0)
        let execRealizedPnlMicros = BigInt(0)
        let execExposureMicros = BigInt(0)

        for (const row of leaderPositions) {
            let marketValueMicros = BigInt(0)
            if (row.shareMicros !== BigInt(0)) {
                const priceMicros = priceByAsset.get(row.assetId) ?? DEFAULT_MARK_PRICE_MICROS
                marketValueMicros = (row.shareMicros * BigInt(priceMicros)) / MICROS_PER_UNIT
                const abs = marketValueMicros < BigInt(0) ? -marketValueMicros : marketValueMicros
                execExposureMicros += abs
            } else {
                execRealizedPnlMicros += row.netCashFlowMicros
            }
            execEquityMicros += row.netCashFlowMicros + marketValueMicros
        }

        const execUnrealizedPnlMicros = execEquityMicros - execRealizedPnlMicros

        const execPositions = openLeaderPositions.map((row) => {
            const meta = tokenMetadataMap.get(row.assetId)
            const shares = Number(row.shareMicros) / 1_000_000
            const netCashFlow = Number(row.netCashFlowMicros) / 1_000_000

            return {
                assetId: row.assetId,
                shares,
                invested: -netCashFlow,
                marketTitle: meta?.marketTitle || "Unknown Market",
                outcome: meta?.outcomeLabel || "Unknown"
            }
        })

        const recentTradesFormatted = recentTrades.map((trade) => ({
            id: trade.id,
            side: trade.side,
            marketId: trade.marketId,
            assetId: trade.assetId,
            price: Number(trade.priceMicros) / 1_000_000,
            shares: Number(trade.shareMicros) / 1_000_000,
            notional: Number(trade.notionalMicros) / 1_000_000,
            eventTime: trade.eventTime.getTime()
        }))

        const recentAttemptsFormatted = recentAttempts.map((attempt) => ({
            id: attempt.id,
            decision: attempt.decision,
            reasonCodes: attempt.reasonCodes,
            targetNotional: Number(attempt.targetNotionalMicros) / 1_000_000,
            filledNotional: Number(attempt.filledNotionalMicros) / 1_000_000,
            filledRatioBps: attempt.filledRatioBps,
            vwapPrice: attempt.vwapPriceMicros
                ? Number(attempt.vwapPriceMicros) / 1_000_000
                : null,
            theirReferencePrice: attempt.theirReferencePriceMicros / 1_000_000,
            createdAt: attempt.createdAt.getTime()
        }))

        const budgetedDynamic = {
            enabled: false,
            sizingMode: "fixedRate",
            budgetUsd: 0,
            leaderExposureUsd: 0,
            currentCopyExposureUsd: 0,
            effectiveRatePct: 0,
            headroomUsd: 0,
            budgetEnforcement: "hard",
            rMinPct: 0,
            rMaxPct: 0
        }

        return NextResponse.json({
            ...user,
            metrics: {
                shadowEquity: 0,
                execEquity: Number(execEquityMicros) / 1_000_000,
                execRealizedPnl: Number(execRealizedPnlMicros) / 1_000_000,
                execUnrealizedPnl: Number(execUnrealizedPnlMicros) / 1_000_000,
                execExposure: Number(execExposureMicros) / 1_000_000,
                lastSnapshotTs: null
            },
            equityCurve,
            attemptStats: {
                totalAttempts,
                executedAttempts,
                skippedAttempts: totalAttempts - executedAttempts,
                partialAttempts,
                attemptRate,
                fillRate,
                partialRate
            },
            slippageHistogram,
            lagHistogram,
            skipReasons,
            positions: {
                shadow: [],
                exec: execPositions
            },
            recentTrades: recentTradesFormatted,
            recentAttempts: recentAttemptsFormatted,
            budgetedDynamic
        })
    } catch (error) {
        console.error("Failed to fetch user details:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
