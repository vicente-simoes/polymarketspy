import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

export async function GET(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get("limit") || "50")
    const marketId = searchParams.get("marketId")

    try {
        const guardrails = await prisma.guardrailConfig.findFirst({
            where: { scope: "GLOBAL", followedUserId: null },
            orderBy: { updatedAt: "desc" }
        })
        const guardrailsConfig = (guardrails?.configJson || {}) as Record<string, any>
        const blacklist = Array.isArray(guardrailsConfig.marketBlacklist)
            ? guardrailsConfig.marketBlacklist
            : []

        if (marketId) {
            const market = await prisma.market.findUnique({
                where: { id: marketId },
                include: { assets: true }
            })

            if (!market) {
                return NextResponse.json({ error: "Market not found" }, { status: 404 })
            }

            const positionsRaw = await prisma.ledgerEntry.groupBy({
                by: ["assetId"],
                where: {
                    portfolioScope: "EXEC_GLOBAL",
                    marketId
                },
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
                .map((row) => row.assetId)
                .filter((id): id is string => Boolean(id))
            const assets = assetIds.length
                ? await prisma.outcomeAsset.findMany({
                      where: { id: { in: assetIds } }
                  })
                : []
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

            const positions = positionsRaw.map((row) => {
                const asset = assets.find((item) => item.id === row.assetId)
                const shares = Number(row._sum.shareDeltaMicros ?? 0) / 1_000_000
                const netCashFlow = Number(row._sum.cashDeltaMicros ?? 0) / 1_000_000
                const markMicros = row.assetId ? priceMap.get(row.assetId) : null
                const markPrice = markMicros ? markMicros / 1_000_000 : null
                const marketValue = markPrice !== null ? markPrice * shares : null

                return {
                    assetId: row.assetId,
                    outcome: asset?.outcome || "Unknown",
                    shares,
                    invested: -netCashFlow,
                    markPrice,
                    marketValue
                }
            })

            const exposure = positions.reduce((sum, pos) => {
                const value = Math.abs(pos.marketValue ?? pos.invested)
                return sum + value
            }, 0)

            const copyLedger = await prisma.ledgerEntry.findMany({
                where: {
                    portfolioScope: "EXEC_GLOBAL",
                    marketId,
                    entryType: "TRADE_FILL",
                    refId: { startsWith: "copy:" }
                },
                select: { refId: true }
            })

            const copyIds = copyLedger
                .map((entry) => entry.refId.replace("copy:", ""))
                .filter((id) => id.length > 0)

            const copyAttempts = copyIds.length
                ? await prisma.copyAttempt.findMany({
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
                        ((attempt.vwapPriceMicros ?? 0) -
                            attempt.theirReferencePriceMicros) /
                        10000
                }))
                .reverse()

            const lastPrice =
                market.assets.length > 0
                    ? priceMap.get(market.assets[0]!.id) ?? null
                    : null

            return NextResponse.json({
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
            })
        }

        const positionsRaw = await prisma.ledgerEntry.groupBy({
            by: ["marketId", "assetId"],
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

        const exposureByMarket = new Map<
            string,
            { exposure: number; positions: number }
        >()

        for (const row of positionsRaw) {
            if (!row.marketId) continue
            const netCashFlow = Number(row._sum.cashDeltaMicros ?? 0) / 1_000_000
            const exposureValue = Math.abs(-netCashFlow)
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

        const markets = await prisma.market.findMany({
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

        return NextResponse.json({ markets: marketSummaries })
    } catch (error) {
        console.error("Failed to fetch markets:", error)
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

        return NextResponse.json({ marketId, blacklisted })
    } catch (error) {
        console.error("Failed to update market blacklist:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
