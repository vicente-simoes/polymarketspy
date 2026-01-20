import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export async function GET(request: NextRequest) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const searchParams = request.nextUrl.searchParams
        const range = searchParams.get("range") || "1M"

        // Basic overview query
        // 1. Get latest global portfolio snapshot
        const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
            where: { portfolioScope: "EXEC_GLOBAL", followedUserId: null },
            orderBy: { bucketTime: 'desc' }
        })

        // 2. Get system status (checkpoints)
        const lastBlock = await prisma.systemCheckpoint.findUnique({ where: { key: "alchemy:lastBlock" } })
        const lastEvent = await prisma.tradeEvent.findFirst({ orderBy: { eventTime: 'desc' } })

        // 3. Count total trades today
        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)
        const totalTradesToday = await prisma.tradeEvent.count({
            where: { eventTime: { gte: startOfDay } }
        })

        // 4. Get equity curve based on range
        let startTime = new Date()
        switch (range) {
            case "1H":
                startTime.setTime(startTime.getTime() - 60 * 60 * 1000)
                break
            case "1D":
                startTime.setTime(startTime.getTime() - 24 * 60 * 60 * 1000)
                break
            case "1W":
                startTime.setDate(startTime.getDate() - 7)
                break
            case "ALL":
                startTime = new Date(0) // Beginning of time
                break
            case "1M":
            default:
                startTime.setDate(startTime.getDate() - 30)
                break
        }

        const equityCurveSnapshots = await prisma.portfolioSnapshot.findMany({
            where: {
                portfolioScope: "EXEC_GLOBAL",
                followedUserId: null,
                bucketTime: { gte: startTime }
            },
            orderBy: { bucketTime: 'asc' }
        })

        const equityCurve = equityCurveSnapshots.map((s: any) => ({
            date: s.bucketTime.toISOString(), // Full ISO string for frontend formatting
            timestamp: s.bucketTime.getTime(),
            value: Number(s.equityMicros) / 1_000_000
        }))

        // Calculate Max Drawdown from the curve
        let maxEquity = 0
        let maxDrawdown = 0
        for (const point of equityCurve) {
            if (point.value > maxEquity) {
                maxEquity = point.value
            }
            if (maxEquity > 0) {
                const drawdown = (maxEquity - point.value) / maxEquity
                if (drawdown > maxDrawdown) {
                    maxDrawdown = drawdown
                }
            }
        }

        // 5. Calculate Win Rate (Realized PnL > 0) from TradeEvents in last 30d (approx)
        // Note: TradeEvent doesn't store PnL directly, LedgerEntry does.
        // We need to look at CLOSED positions or Realized PnL entries in Ledger.
        // For simplicity in v0: Count "profitable trades" if we can, or just use aggregate stats if easier.
        // LedgerEntry scope=EXEC_GLOBAL and type=TRADE_CLOSE? System doesn't strictly have "TRADE_CLOSE".
        // Alternative: Look at aggregated performance.
        // 5. Win Rate - approximation difficult with current Ledger schema
        // We will default to 0 for now until we have a better way to track "closed trade PnL"
        const winRate = 0
        const totalClosed = 0

        // 6. Top Positions (Unrealized PnL)
        // a. Group by assetId to get open positions
        const positionsRaw = await prisma.ledgerEntry.groupBy({
            by: ["assetId"],
            where: { portfolioScope: "EXEC_GLOBAL" },
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

        const assetIds = positionsRaw
            .map((p) => p.assetId)
            .filter((id): id is string => id !== null)

        // b. Fetch prices and metadata
        const priceSnapshots = assetIds.length
            ? await prisma.marketPriceSnapshot.findMany({
                where: { assetId: { in: assetIds } },
                orderBy: { bucketTime: "desc" },
                distinct: ["assetId"]
            })
            : []
        const priceMap = new Map(
            priceSnapshots.map((snap) => [snap.assetId, snap.midpointPriceMicros])
        )

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
        const tokenMetadataMap = new Map(
            tokenMetadata.map((meta) => [meta.tokenId, meta])
        )

        // c. Calculate Unrealized PnL and sort
        const calculatedPositions = positionsRaw.map((p) => {
            const assetId = p.assetId
            if (!assetId) return null

            const shares = Number(p._sum.shareDeltaMicros) / 1_000_000
            const netCashFlow = Number(p._sum.cashDeltaMicros) / 1_000_000 // usually negative if buying
            const priceMicros = priceMap.get(assetId) || 0
            const price = priceMicros / 1_000_000

            // Unrealized PnL = (Shares * Price) + NetCashFlow
            // Example: Buy $100 shares. CashFlow = -100. Value = 110. PnL = 110 + (-100) = 10.
            const marketValue = shares * price
            const unrealizedPnl = marketValue + netCashFlow

            const meta = tokenMetadataMap.get(assetId)

            return {
                assetId,
                marketTitle: meta?.marketTitle || "Unknown Market",
                outcomeLabel: meta?.outcomeLabel || "Unknown",
                pnl: unrealizedPnl,
                marketValue
            }
        }).filter((p): p is NonNullable<typeof p> => p !== null)

        // Sort by Unrealized PnL descending
        const topMarkets = calculatedPositions
            .sort((a, b) => b.pnl - a.pnl)
            .slice(0, 5)

        // 7. Top Users (by Realized PnL)
        // Group LedgerEntry by followedUserId where scope=EXEC_USER
        const userPerformers = await prisma.ledgerEntry.groupBy({
            by: ['followedUserId'],
            where: {
                portfolioScope: "EXEC_USER",
                followedUserId: { not: null }
            },
            _sum: { cashDeltaMicros: true },
            orderBy: { _sum: { cashDeltaMicros: 'desc' } },
            take: 5
        })

        // Enhance with user labels and trade counts
        const topUsers = await Promise.all(userPerformers.map(async (u) => {
            if (!u.followedUserId) return null

            const user = await prisma.followedUser.findUnique({
                where: { id: u.followedUserId },
                select: { label: true }
            })

            const tradeCount = await prisma.copyAttempt.count({
                where: {
                    followedUserId: u.followedUserId,
                    decision: "EXECUTE"
                }
            })

            return {
                label: user?.label || "Unknown User",
                pnl: Number(u._sum.cashDeltaMicros) / 1_000_000,
                count: tradeCount
            }
        }))

        const validTopUsers = topUsers.filter(u => u !== null)

        return NextResponse.json({
            equity: latestSnapshot ? Number(latestSnapshot.equityMicros) / 1_000_000 : 0,
            pnl: latestSnapshot ? Number(latestSnapshot.realizedPnlMicros + latestSnapshot.unrealizedPnlMicros) / 1_000_000 : 0,
            exposure: latestSnapshot ? Number(latestSnapshot.exposureMicros) / 1_000_000 : 0,
            tradesToday: totalTradesToday,
            equityCurve,
            analytics: {
                winRate,
                totalClosedPositions: totalClosed,
                maxDrawdown: maxDrawdown * 100, // percentage
                topMarkets,
                topUsers: validTopUsers
            },
            system: {
                lastBlock: lastBlock?.valueJson,
                lastEventTime: lastEvent?.eventTime,
                status: "healthy"
            }
        })
    } catch (error) {
        console.error("Failed to fetch overview:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
