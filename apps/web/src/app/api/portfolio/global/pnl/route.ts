import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { getOrSetServerCache } from "@/lib/server-cache"
import { withPgStatementTimeout } from "@/lib/pg-guardrails"
import { TradingMode } from "@prisma/client"

type PnlRange = "1H" | "1D" | "1W" | "1M"

const MAX_POINTS = 600

const parseRange = (raw: string | null): PnlRange => {
    switch (raw) {
        case "1H":
        case "1D":
        case "1W":
        case "1M":
            return raw
        default:
            return "1D"
    }
}

const granularityForRange = (range: PnlRange) => {
    switch (range) {
        case "1H":
            return "M1" as const
        case "1D":
            return "M20" as const
        case "1W":
            return "H2" as const
        case "1M":
        default:
            return "H12" as const
    }
}

const rangeMs = (range: PnlRange) => {
    switch (range) {
        case "1H":
            return 60 * 60 * 1000
        case "1D":
            return 24 * 60 * 60 * 1000
        case "1W":
            return 7 * 24 * 60 * 60 * 1000
        case "1M":
        default:
            return 30 * 24 * 60 * 60 * 1000
    }
}

export async function GET(request: NextRequest) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const range = parseRange(request.nextUrl.searchParams.get("range"))
        const payload = await getOrSetServerCache(`portfolio:global:pnl:${range}`, 30_000, async () => {
            return withPgStatementTimeout(4000, async (tx) => {
                const granularity = granularityForRange(range)
                const nowMs = Date.now()
                const startTime = new Date(nowMs - rangeMs(range))

                const points = await tx.equityPoint.findMany({
                    where: {
                        tradingMode: TradingMode.PAPER,
                        granularity,
                        bucketTime: { gte: startTime, lte: new Date(nowMs) }
                    },
                    orderBy: { bucketTime: "asc" }
                })

                if (points.length === 0) {
                    return {
                        range,
                        pnlCurve: [] as Array<{ date: string; timestamp: number; value: number }>
                    }
                }

                const baselinePnl = Number(points[0].pnlMicros) / 1_000_000

                const step = Math.max(1, Math.ceil(points.length / MAX_POINTS))
                const sampled = step === 1 ? points : points.filter((_, idx) => idx % step === 0)
                const lastPoint = points[points.length - 1]

                if (
                    sampled[sampled.length - 1]?.bucketTime.getTime() !==
                    lastPoint.bucketTime.getTime()
                ) {
                    sampled.push(lastPoint)
                }

                const pnlCurve = sampled.map((p) => ({
                    date: p.bucketTime.toISOString(),
                    timestamp: p.bucketTime.getTime(),
                    value: Number(p.pnlMicros) / 1_000_000 - baselinePnl
                }))

                return { range, pnlCurve }
            })
        })

        return NextResponse.json(payload)
    } catch (error) {
        console.error("Failed to fetch global pnl curve:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
