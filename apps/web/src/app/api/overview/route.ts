import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { getOrSetServerCache } from "@/lib/server-cache"
import { withPgStatementTimeout } from "@/lib/pg-guardrails"

type RangeKey = "1H" | "1D" | "1W" | "1M" | "ALL"

const MICROS_PER_UNIT = BigInt(1_000_000)
const DEFAULT_MARK_PRICE_MICROS = 500_000 // $0.50

function parseRange(raw: string | null): RangeKey {
    switch (raw) {
        case "1H":
        case "1D":
        case "1W":
        case "1M":
        case "ALL":
            return raw
        default:
            return "1M"
    }
}

function getRangeStart(range: RangeKey): Date {
    const startTime = new Date()
    switch (range) {
        case "1H":
            startTime.setTime(startTime.getTime() - 60 * 60 * 1000)
            return startTime
        case "1D":
            startTime.setTime(startTime.getTime() - 24 * 60 * 60 * 1000)
            return startTime
        case "1W":
            startTime.setDate(startTime.getDate() - 7)
            return startTime
        case "ALL":
            return new Date(0)
        case "1M":
        default:
            startTime.setDate(startTime.getDate() - 30)
            return startTime
    }
}

function getGranularityForRange(range: RangeKey) {
    switch (range) {
        case "1H":
            return "M1" as const
        case "1D":
            return "M20" as const
        case "1W":
            return "H2" as const
        case "1M":
            return "H12" as const
        case "ALL":
        default:
            return "D1" as const
    }
}

function parseInitialBankrollMicros(valueJson: unknown): bigint {
    const raw = (valueJson as any)?.initialBankrollMicros
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return BigInt(Math.trunc(raw))
    }
    if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
        try {
            return BigInt(raw)
        } catch {
            return BigInt(0)
        }
    }
    return BigInt(0)
}

export async function GET(request: NextRequest) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const searchParams = request.nextUrl.searchParams
        const range = parseRange(searchParams.get("range"))

        const payload = await getOrSetServerCache(`overview:${range}`, 15_000, async () => {
            return withPgStatementTimeout(4000, async (tx) => {
                const [systemConfigRow, globalState, positions, lastBlock] = await Promise.all([
                    tx.systemCheckpoint.findUnique({
                        where: { key: "system:config" },
                        select: { valueJson: true }
                    }),
                    tx.globalPortfolioState.findUnique({
                        where: { id: "EXEC_GLOBAL" },
                        select: { cashMicros: true, contributedCapitalMicros: true }
                    }),
                    tx.currentPosition.findMany({
                        where: { shareMicros: { not: BigInt(0) } },
                        select: { assetId: true, shareMicros: true, netCashFlowMicros: true }
                    }),
                    tx.systemCheckpoint.findUnique({
                        where: { key: "alchemy:lastBlock" },
                        select: { valueJson: true }
                    })
                ])

                const initialBankrollMicros = parseInitialBankrollMicros(systemConfigRow?.valueJson)
                const cashMicros = initialBankrollMicros + (globalState?.cashMicros ?? BigInt(0))
                const contributedCapitalMicros =
                    initialBankrollMicros + (globalState?.contributedCapitalMicros ?? BigInt(0))

                const assetIds = positions.map((pos) => pos.assetId)
                const [priceRows, tokenMetadata] = assetIds.length
                    ? await Promise.all([
                          tx.currentPrice.findMany({
                              where: { assetId: { in: assetIds } },
                              select: { assetId: true, midpointPriceMicros: true }
                          }),
                          tx.tokenMetadataCache.findMany({
                              where: { tokenId: { in: assetIds } },
                              select: { tokenId: true, marketTitle: true, outcomeLabel: true }
                          })
                      ])
                    : [[], []]

                const priceByAsset = new Map(
                    priceRows.map((row) => [row.assetId, row.midpointPriceMicros])
                )
                const tokenMetadataMap = new Map(tokenMetadata.map((meta) => [meta.tokenId, meta]))

                let totalPositionValueMicros = BigInt(0)
                let totalExposureMicros = BigInt(0)

                const positionsWithMarks = positions.map((pos) => {
                    const priceMicros = priceByAsset.get(pos.assetId) ?? DEFAULT_MARK_PRICE_MICROS
                    const marketValueMicros =
                        (pos.shareMicros * BigInt(priceMicros)) / MICROS_PER_UNIT
                    const pnlMicros = marketValueMicros + pos.netCashFlowMicros
                    const absValue =
                        marketValueMicros < BigInt(0) ? -marketValueMicros : marketValueMicros

                    totalPositionValueMicros += marketValueMicros
                    totalExposureMicros += absValue

                    return {
                        assetId: pos.assetId,
                        marketValueMicros,
                        pnlMicros
                    }
                })

                const equityMicros = cashMicros + totalPositionValueMicros
                const pnlMicros = equityMicros - contributedCapitalMicros

                const startTime = getRangeStart(range)
                const granularity = getGranularityForRange(range)
                const MAX_POINTS = 800
                const points = await tx.equityPoint.findMany({
                    where: {
                        granularity,
                        bucketTime: { gte: startTime }
                    },
                    orderBy: { bucketTime: "asc" }
                })

                const step = Math.max(1, Math.ceil(points.length / MAX_POINTS))
                const sampledPoints =
                    step === 1 ? points : points.filter((_, idx) => idx % step === 0)
                const lastPoint = points.length > 0 ? points[points.length - 1] : null
                if (
                    lastPoint &&
                    sampledPoints.length > 0 &&
                    sampledPoints[sampledPoints.length - 1]?.bucketTime.getTime() !==
                        lastPoint.bucketTime.getTime()
                ) {
                    sampledPoints.push(lastPoint)
                }

                const equityCurve = sampledPoints.map((p) => ({
                    date: p.bucketTime.toISOString(),
                    timestamp: p.bucketTime.getTime(),
                    value: Number(p.equityMicros) / 1_000_000
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

                // Win rate/closed positions tracking not implemented yet.
                const winRate = 0
                const totalClosed = 0

                // 6. Top Positions (Unrealized PnL)
                const calculatedPositions = positionsWithMarks.map((p) => {
                    const meta = tokenMetadataMap.get(p.assetId)
                    return {
                        assetId: p.assetId,
                        marketTitle: meta?.marketTitle || "Unknown Market",
                        outcomeLabel: meta?.outcomeLabel || "Unknown",
                        pnl: Number(p.pnlMicros) / 1_000_000,
                        marketValue: Number(p.marketValueMicros) / 1_000_000
                    }
                })

                // Sort by Unrealized PnL descending
                const topMarkets = calculatedPositions
                    .sort((a, b) => b.pnl - a.pnl)
                    .slice(0, 5)

                // 7. Top Users (attributed open PnL)
                const leaderRows = await tx.currentPositionByLeader.findMany({
                    where: { shareMicros: { not: BigInt(0) } },
                    select: {
                        followedUserId: true,
                        assetId: true,
                        shareMicros: true,
                        netCashFlowMicros: true
                    }
                })

                const leaderAssetIds = Array.from(new Set(leaderRows.map((row) => row.assetId)))
                const leaderPrices = leaderAssetIds.length
                    ? await tx.currentPrice.findMany({
                          where: { assetId: { in: leaderAssetIds } },
                          select: { assetId: true, midpointPriceMicros: true }
                      })
                    : []
                const leaderPriceByAsset = new Map(
                    leaderPrices.map((row) => [row.assetId, row.midpointPriceMicros])
                )

                const pnlMicrosByUser = new Map<string, bigint>()
                const positionsByUser = new Map<string, number>()
                for (const row of leaderRows) {
                    const priceMicros =
                        leaderPriceByAsset.get(row.assetId) ?? DEFAULT_MARK_PRICE_MICROS
                    const valueMicros =
                        (row.shareMicros * BigInt(priceMicros)) / MICROS_PER_UNIT
                    const pnlMicros = valueMicros + row.netCashFlowMicros

                    pnlMicrosByUser.set(
                        row.followedUserId,
                        (pnlMicrosByUser.get(row.followedUserId) ?? BigInt(0)) + pnlMicros
                    )
                    positionsByUser.set(
                        row.followedUserId,
                        (positionsByUser.get(row.followedUserId) ?? 0) + 1
                    )
                }

                const leaderIds = Array.from(pnlMicrosByUser.keys())
                const leaders = leaderIds.length
                    ? await tx.followedUser.findMany({
                          where: { id: { in: leaderIds } },
                          select: { id: true, label: true }
                      })
                    : []
                const labelById = new Map(leaders.map((u) => [u.id, u.label]))

                const validTopUsers = Array.from(pnlMicrosByUser.entries())
                    .map(([userId, pnlMicros]) => ({
                        label: labelById.get(userId) || "Unknown User",
                        pnl: Number(pnlMicros) / 1_000_000,
                        count: positionsByUser.get(userId) ?? 0
                    }))
                    .sort((a, b) => b.pnl - a.pnl)
                    .slice(0, 5)

                return {
                    equity: Number(equityMicros) / 1_000_000,
                    pnl: Number(pnlMicros) / 1_000_000,
                    exposure: Number(totalExposureMicros) / 1_000_000,
                    tradesToday: 0,
                    equityCurve,
                    analytics: {
                        winRate,
                        totalClosedPositions: totalClosed,
                        maxDrawdown: maxDrawdown * 100, // percentage
                        topMarkets,
                        topUsers: validTopUsers
                    },
                    system: {
                        lastBlock: lastBlock?.valueJson ?? null,
                        lastEventTime: null,
                        status: "healthy"
                    }
                }
            })
        })

        return NextResponse.json(payload)
    } catch (error) {
        console.error("Failed to fetch overview:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
