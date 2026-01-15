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

        const snapshotRows = await prisma.portfolioSnapshot.findMany({
            where: {
                followedUserId: id,
                portfolioScope: { in: ["SHADOW_USER", "EXEC_USER"] }
            },
            orderBy: { bucketTime: "desc" },
            take: 180
        })

        const orderedSnapshots = [...snapshotRows].sort(
            (a, b) => a.bucketTime.getTime() - b.bucketTime.getTime()
        )

        const shadowByTime = new Map<number, number>()
        const execByTime = new Map<number, number>()

        let latestShadow = null as typeof snapshotRows[number] | null
        let latestExec = null as typeof snapshotRows[number] | null

        for (const snapshot of orderedSnapshots) {
            const ts = snapshot.bucketTime.getTime()
            if (snapshot.portfolioScope === "SHADOW_USER") {
                shadowByTime.set(ts, Number(snapshot.equityMicros) / 1_000_000)
                if (!latestShadow || snapshot.bucketTime > latestShadow.bucketTime) {
                    latestShadow = snapshot
                }
            } else if (snapshot.portfolioScope === "EXEC_USER") {
                execByTime.set(ts, Number(snapshot.equityMicros) / 1_000_000)
                if (!latestExec || snapshot.bucketTime > latestExec.bucketTime) {
                    latestExec = snapshot
                }
            }
        }

        const timeline = Array.from(
            new Set([...shadowByTime.keys(), ...execByTime.keys()])
        ).sort((a, b) => a - b)

        const equityCurve = timeline.map((ts) => {
            const shadow = shadowByTime.get(ts) ?? 0
            const exec = execByTime.get(ts) ?? 0
            return {
                ts,
                shadow,
                exec,
                gap: shadow - exec
            }
        })

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
            shadowPositionsRaw,
            execPositionsRaw
        ] = await Promise.all([
            prisma.copyAttempt.count({
                where: { followedUserId: id, portfolioScope: "EXEC_USER" }
            }),
            prisma.copyAttempt.count({
                where: {
                    followedUserId: id,
                    portfolioScope: "EXEC_USER",
                    decision: "EXECUTE"
                }
            }),
            prisma.copyAttempt.count({
                where: {
                    followedUserId: id,
                    portfolioScope: "EXEC_USER",
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
                    portfolioScope: "EXEC_USER",
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
                    portfolioScope: "EXEC_USER",
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
                where: { followedUserId: id, portfolioScope: "EXEC_USER" },
                orderBy: { createdAt: "desc" },
                take: 30
            }),
            prisma.ledgerEntry.groupBy({
                by: ["assetId"],
                where: { portfolioScope: "SHADOW_USER", followedUserId: id },
                _sum: {
                    shareDeltaMicros: true,
                    cashDeltaMicros: true
                },
                having: {
                    shareDeltaMicros: {
                        _sum: { not: { equals: 0 } }
                    }
                }
            }),
            prisma.ledgerEntry.groupBy({
                by: ["assetId"],
                where: { portfolioScope: "EXEC_USER", followedUserId: id },
                _sum: {
                    shareDeltaMicros: true,
                    cashDeltaMicros: true
                },
                having: {
                    shareDeltaMicros: {
                        _sum: { not: { equals: 0 } }
                    }
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

        const assetIds = [
            ...shadowPositionsRaw.map((row) => row.assetId),
            ...execPositionsRaw.map((row) => row.assetId)
        ].filter((assetId): assetId is string => Boolean(assetId))

        const assets = assetIds.length
            ? await prisma.outcomeAsset.findMany({
                  where: { id: { in: assetIds } },
                  include: { market: true }
              })
            : []

        const formatPositions = (rows: typeof shadowPositionsRaw) =>
            rows
                .filter((row) => row.assetId)
                .map((row) => {
                    const asset = assets.find((a) => a.id === row.assetId)
                    const shares = Number(row._sum.shareDeltaMicros ?? 0) / 1_000_000
                    const netCashFlow = Number(row._sum.cashDeltaMicros ?? 0) / 1_000_000

                    return {
                        assetId: row.assetId,
                        shares,
                        invested: -netCashFlow,
                        marketTitle: asset?.market.conditionId || "Unknown Market",
                        outcome: asset?.outcome || "Unknown"
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

        return NextResponse.json({
            ...user,
            metrics: {
                shadowEquity: latestShadow ? Number(latestShadow.equityMicros) / 1_000_000 : 0,
                execEquity: latestExec ? Number(latestExec.equityMicros) / 1_000_000 : 0,
                execRealizedPnl: latestExec
                    ? Number(latestExec.realizedPnlMicros) / 1_000_000
                    : 0,
                execUnrealizedPnl: latestExec
                    ? Number(latestExec.unrealizedPnlMicros) / 1_000_000
                    : 0,
                execExposure: latestExec ? Number(latestExec.exposureMicros) / 1_000_000 : 0,
                lastSnapshotTs: latestExec
                    ? latestExec.bucketTime.getTime()
                    : latestShadow
                      ? latestShadow.bucketTime.getTime()
                      : null
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
                shadow: formatPositions(shadowPositionsRaw),
                exec: formatPositions(execPositionsRaw)
            },
            recentTrades: recentTradesFormatted,
            recentAttempts: recentAttemptsFormatted
        })
    } catch (error) {
        console.error("Failed to fetch user details:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
