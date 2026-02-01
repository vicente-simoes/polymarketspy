import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { clearServerCache, getOrSetServerCache } from "@/lib/server-cache"
import { withPgStatementTimeout } from "@/lib/pg-guardrails"

class MarketNotFoundError extends Error {
    name = "MarketNotFoundError"
}

export async function GET(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get("limit") || "50")
    const marketId = searchParams.get("marketId")

    try {
        if (marketId) {
            const payload = await getOrSetServerCache(`markets:detail:${marketId}`, 30_000, async () => {
                return withPgStatementTimeout(4000, async (tx) => {
                    const guardrails = await tx.guardrailConfig.findFirst({
                        where: { scope: "GLOBAL", followedUserId: null },
                        orderBy: { updatedAt: "desc" }
                    })
                    const guardrailsConfig = (guardrails?.configJson || {}) as Record<string, any>
                    const blacklist = Array.isArray(guardrailsConfig.marketBlacklist)
                        ? guardrailsConfig.marketBlacklist
                        : []

                    const market = await tx.market.findUnique({
                        where: { id: marketId },
                        include: { assets: true }
                    })

                    if (!market) {
                        throw new MarketNotFoundError("Market not found")
                    }

                    const marketAssetIds = market.assets.map((asset) => asset.id)

                    const [positionRows, priceSnapshots] = await Promise.all([
                        tx.currentPosition.findMany({
                            where: {
                                marketId,
                                shareMicros: { not: BigInt(0) }
                            },
                            select: { assetId: true, shareMicros: true, netCashFlowMicros: true }
                        }),
                        marketAssetIds.length
                            ? tx.currentPrice.findMany({
                                  where: { assetId: { in: marketAssetIds } }
                              })
                            : Promise.resolve([])
                    ])

                    const priceMap = new Map(
                        priceSnapshots.map((snap) => [snap.assetId, snap.midpointPriceMicros])
                    )

                    const positions = positionRows.map((row) => {
                        const asset = market.assets.find((item) => item.id === row.assetId)
                        const shares = Number(row.shareMicros) / 1_000_000
                        const invested = -Number(row.netCashFlowMicros) / 1_000_000
                        const markMicros = priceMap.get(row.assetId) ?? null
                        const markPrice = markMicros !== null ? markMicros / 1_000_000 : null
                        const marketValue = markPrice !== null ? markPrice * shares : null

                        return {
                            assetId: row.assetId,
                            outcome: asset?.outcome || "Unknown",
                            shares,
                            invested,
                            markPrice,
                            marketValue
                        }
                    })

                    const exposure = positions.reduce((sum, pos) => {
                        const value = Math.abs(pos.marketValue ?? pos.invested)
                        return sum + value
                    }, 0)

                    const copyLedger = marketAssetIds.length
                        ? await tx.ledgerEntry.findMany({
                              where: {
                                  portfolioScope: "EXEC_GLOBAL",
                                  entryType: "TRADE_FILL",
                                  assetId: { in: marketAssetIds },
                                  refId: { startsWith: "copy:" }
                              },
                              select: { refId: true },
                              orderBy: { createdAt: "desc" },
                              take: 80
                          })
                        : []

                    const copyIds = copyLedger
                        .map((entry) => entry.refId.replace("copy:", ""))
                        .filter((id) => id.length > 0)

                    const copyAttempts = copyIds.length
                        ? await tx.copyAttempt.findMany({
                              where: { id: { in: copyIds } },
                              select: {
                                  id: true,
                                  vwapPriceMicros: true,
                                  theirReferencePriceMicros: true,
                                  createdAt: true
                              },
                              orderBy: { createdAt: "desc" },
                              take: 40
                          })
                        : []

                    const slippageHistory = copyAttempts
                        .filter((attempt) => attempt.vwapPriceMicros !== null)
                        .map((attempt) => ({
                            ts: attempt.createdAt.getTime(),
                            slippageCents:
                                ((attempt.vwapPriceMicros ?? 0) - attempt.theirReferencePriceMicros) /
                                10000
                        }))
                        .reverse()

                    const lastPrice =
                        market.assets.length > 0 ? priceMap.get(market.assets[0]!.id) ?? null : null

                    return {
                        market,
                        blacklisted: blacklist.includes(marketId),
                        exposure,
                        positions,
                        slippageHistory,
                        liquidity: {
                            spreadCents: null,
                            depthInBand: null,
                            lastPrice: lastPrice ? lastPrice / 1_000_000 : null
                        }
                    }
                })
            })

            return NextResponse.json(payload)
        }

        const payload = await getOrSetServerCache(`markets:list:limit=${limit}`, 30_000, async () => {
            return withPgStatementTimeout(4000, async (tx) => {
                const guardrails = await tx.guardrailConfig.findFirst({
                    where: { scope: "GLOBAL", followedUserId: null },
                    orderBy: { updatedAt: "desc" }
                })
                const guardrailsConfig = (guardrails?.configJson || {}) as Record<string, any>
                const blacklist = Array.isArray(guardrailsConfig.marketBlacklist)
                    ? guardrailsConfig.marketBlacklist
                    : []

                const openPositions = await tx.currentPosition.findMany({
                    where: {
                        shareMicros: { not: BigInt(0) },
                        marketId: { not: null }
                    },
                    select: {
                        assetId: true,
                        marketId: true,
                        shareMicros: true,
                        netCashFlowMicros: true
                    }
                })

                const openAssetIds = Array.from(new Set(openPositions.map((row) => row.assetId)))
                const priceRows = openAssetIds.length
                    ? await tx.currentPrice.findMany({
                          where: { assetId: { in: openAssetIds } },
                          select: { assetId: true, midpointPriceMicros: true }
                      })
                    : []
                const priceByAsset = new Map(
                    priceRows.map((row) => [row.assetId, row.midpointPriceMicros])
                )

                const exposureByMarket = new Map<string, { exposure: number; positions: number }>()

                for (const row of openPositions) {
                    if (!row.marketId) continue
                    const shares = Number(row.shareMicros) / 1_000_000
                    const invested = -Number(row.netCashFlowMicros) / 1_000_000
                    const markMicros = priceByAsset.get(row.assetId) ?? null
                    const markPrice = markMicros !== null ? markMicros / 1_000_000 : null
                    const marketValue = markPrice !== null ? markPrice * shares : null
                    const exposureValue = Math.abs(marketValue ?? invested)

                    const current = exposureByMarket.get(row.marketId)
                    if (current) {
                        current.exposure += exposureValue
                        current.positions += 1
                    } else {
                        exposureByMarket.set(row.marketId, {
                            exposure: exposureValue,
                            positions: 1
                        })
                    }
                }

                const markets = await tx.market.findMany({
                    take: limit,
                    include: {
                        _count: { select: { assets: true } }
                    },
                    orderBy: { closeTime: "desc" }
                })

                const marketSummaries = markets.map((market) => {
                    const exposure = exposureByMarket.get(market.id)
                    return {
                        id: market.id,
                        conditionId: market.conditionId,
                        active: market.active,
                        closeTime: market.closeTime,
                        outcomes: market._count.assets,
                        exposure: exposure?.exposure ?? 0,
                        positions: exposure?.positions ?? 0,
                        blacklisted: blacklist.includes(market.id)
                    }
                })

                return { markets: marketSummaries }
            })
        })

        return NextResponse.json(payload)
    } catch (error) {
        console.error("Failed to fetch markets:", error)
        if (error instanceof MarketNotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 })
        }
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

export async function POST(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const body = await request.json()
        const marketId = body?.marketId
        const blacklisted = body?.blacklisted

        if (!marketId || typeof blacklisted !== "boolean") {
            return NextResponse.json({ error: "Invalid payload" }, { status: 422 })
        }

        const existing = await prisma.guardrailConfig.findFirst({
            where: { scope: "GLOBAL", followedUserId: null },
            orderBy: { updatedAt: "desc" }
        })

        const configJson = (existing?.configJson || {}) as Record<string, any>
        const currentBlacklist = Array.isArray(configJson.marketBlacklist)
            ? configJson.marketBlacklist
            : []
        const blacklistSet = new Set<string>(currentBlacklist)

        if (blacklisted) {
            blacklistSet.add(marketId)
        } else {
            blacklistSet.delete(marketId)
        }

        const updatedConfig = {
            ...configJson,
            marketBlacklist: Array.from(blacklistSet)
        }

        const result = await prisma.guardrailConfig.updateMany({
            where: { scope: "GLOBAL", followedUserId: null },
            data: { configJson: updatedConfig }
        })

        if (result.count === 0) {
            await prisma.guardrailConfig.create({
                data: {
                    scope: "GLOBAL",
                    followedUserId: null,
                    configJson: updatedConfig
                }
            })
        }

        clearServerCache("markets:")

        return NextResponse.json({ marketId, blacklisted })
    } catch (error) {
        console.error("Failed to update market blacklist:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
