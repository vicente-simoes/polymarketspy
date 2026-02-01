import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export const dynamic = 'force-dynamic'

export async function GET() {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const users = await prisma.followedUser.findMany({
            include: {
                proxies: true,
                _count: {
                    select: { copyAttempts: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        })

        const userIds = users.map((u: { id: string }) => u.id)

        // Shadow portfolios are removed. Show current *attributed* (per-leader) equity using caches:
        // CurrentPositionByLeader + CurrentPrice.
        const leaderRows = userIds.length
            ? await prisma.currentPositionByLeader.findMany({
                  where: { followedUserId: { in: userIds } },
                  select: {
                      followedUserId: true,
                      assetId: true,
                      shareMicros: true,
                      netCashFlowMicros: true
                  }
              })
            : []

        const heldAssetIds = Array.from(
            new Set(
                leaderRows
                    .filter((row) => row.shareMicros !== BigInt(0))
                    .map((row) => row.assetId)
            )
        )

        const priceRows = heldAssetIds.length
            ? await prisma.currentPrice.findMany({
                  where: { assetId: { in: heldAssetIds } },
                  select: { assetId: true, midpointPriceMicros: true }
              })
            : []

        const priceByAsset = new Map(priceRows.map((row) => [row.assetId, row.midpointPriceMicros]))

        const MICROS_PER_UNIT = BigInt(1_000_000)
        const DEFAULT_MARK_PRICE_MICROS = 500_000 // $0.50

        const metricsByUser = new Map<
            string,
            { equityMicros: bigint; realizedMicros: bigint }
        >()

        for (const row of leaderRows) {
            const current = metricsByUser.get(row.followedUserId) ?? {
                equityMicros: BigInt(0),
                realizedMicros: BigInt(0)
            }

            let marketValueMicros = BigInt(0)
            if (row.shareMicros !== BigInt(0)) {
                const priceMicros = priceByAsset.get(row.assetId) ?? DEFAULT_MARK_PRICE_MICROS
                marketValueMicros = (row.shareMicros * BigInt(priceMicros)) / MICROS_PER_UNIT
            } else {
                // Fully closed position: netCashFlowMicros is realized PnL for that asset slice.
                current.realizedMicros += row.netCashFlowMicros
            }

            current.equityMicros += row.netCashFlowMicros + marketValueMicros
            metricsByUser.set(row.followedUserId, current)
        }

        const usersWithMetrics = users.map((user: any) => {
            const agg = metricsByUser.get(user.id)
            const equityMicros = agg?.equityMicros ?? BigInt(0)
            const realizedMicros = agg?.realizedMicros ?? BigInt(0)
            const unrealizedMicros = equityMicros - realizedMicros

            return {
                ...user,
                metrics: {
                    shadowEquity: 0,
                    execEquity: Number(equityMicros) / 1_000_000,
                    execRealizedPnl: Number(realizedMicros) / 1_000_000,
                    execUnrealizedPnl: Number(unrealizedMicros) / 1_000_000
                }
            }
        })

        return NextResponse.json(usersWithMetrics)
    } catch (error) {
        console.error("Failed to fetch users:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
