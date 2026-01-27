import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"

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

export async function GET(request: NextRequest) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const range = parseRange(request.nextUrl.searchParams.get("range"))

        const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
            where: { portfolioScope: "EXEC_GLOBAL", followedUserId: null },
            orderBy: { bucketTime: "desc" }
        })

        if (!latestSnapshot) {
            return NextResponse.json({ range, pnlCurve: [] })
        }

        const endTime = latestSnapshot.bucketTime
        const startTime = new Date(endTime)

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
            case "1M":
            default:
                startTime.setDate(startTime.getDate() - 30)
                break
        }

        const snapshots = await prisma.portfolioSnapshot.findMany({
            where: {
                portfolioScope: "EXEC_GLOBAL",
                followedUserId: null,
                bucketTime: { gte: startTime, lte: endTime }
            },
            orderBy: { bucketTime: "asc" }
        })

        if (snapshots.length === 0) {
            return NextResponse.json({ range, pnlCurve: [] })
        }

        const baselinePnl =
            Number(snapshots[0].realizedPnlMicros + snapshots[0].unrealizedPnlMicros) /
            1_000_000

        const step = Math.max(1, Math.ceil(snapshots.length / MAX_POINTS))
        const sampled = step === 1 ? snapshots : snapshots.filter((_, idx) => idx % step === 0)
        const lastSnapshot = snapshots[snapshots.length - 1]

        if (sampled[sampled.length - 1]?.id !== lastSnapshot.id) {
            sampled.push(lastSnapshot)
        }

        const pnlCurve = sampled.map((s) => {
            const pnl =
                Number(s.realizedPnlMicros + s.unrealizedPnlMicros) / 1_000_000 - baselinePnl
            return {
                date: s.bucketTime.toISOString(),
                timestamp: s.bucketTime.getTime(),
                value: pnl
            }
        })

        return NextResponse.json({ range, pnlCurve })
    } catch (error) {
        console.error("Failed to fetch global pnl curve:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

