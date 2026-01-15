import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export async function GET() {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        // Basic overview query
        // 1. Get latest global portfolio snapshot
        const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
            where: { portfolioScope: "EXEC_GLOBAL" },
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

        // 4. Get equity curve (last 30 days) and calculate Drawdown
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        const equityCurveSnapshots = await prisma.portfolioSnapshot.findMany({
            where: {
                portfolioScope: "EXEC_GLOBAL",
                bucketTime: { gte: thirtyDaysAgo }
            },
            orderBy: { bucketTime: 'asc' }
        })

        const equityCurve = equityCurveSnapshots.map((s: any) => ({
            date: s.bucketTime.toISOString().split('T')[0], // YYYY-MM-DD
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

        // 6. Top Performers (Markets & Users)
        // Top Markets by Net Cash Flow (PROXY for PnL if we assume mostly flat)
        const marketPerformers = await prisma.ledgerEntry.groupBy({
            by: ['assetId'],
            where: { portfolioScope: "EXEC_GLOBAL" },
            _sum: { cashDeltaMicros: true },
            orderBy: { _sum: { cashDeltaMicros: 'desc' } }, // positive cash flow = profit (usually)
            take: 5
        })

        const topMarkets = marketPerformers.map((m: any) => ({
            assetId: m.assetId,
            pnl: Number(m._sum.cashDeltaMicros) / 1_000_000
        }))

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
                topMarkets
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
