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
    const decision = searchParams.get("decision") // EXECUTE or SKIP
    const cursor = searchParams.get("cursor")

    try {
        const where = {
            ...(decision && { decision: decision as any }),
        }

        const [total, attempts] = await Promise.all([
            prisma.copyAttempt.count({ where }),
            prisma.copyAttempt.findMany({
                where,
                include: {
                    followedUser: {
                        select: { label: true }
                    },
                    fills: true
                },
                take: limit,
                skip: cursor ? 1 : 0,
                cursor: cursor ? { id: cursor } : undefined,
                orderBy: [
                    { createdAt: 'desc' },
                    { id: 'desc' }
                ]
            })
        ])

        const refIds = attempts.map((attempt) => `copy:${attempt.id}`)
        const ledgerEntries = await prisma.ledgerEntry.findMany({
            where: {
                refId: { in: refIds },
                entryType: "TRADE_FILL"
            },
            select: {
                refId: true,
                marketId: true,
                assetId: true
            }
        })

        const ledgerMap = new Map(ledgerEntries.map((entry) => [entry.refId, entry]))

        const enrichedAttempts = attempts.map((attempt) => {
            const ledger = ledgerMap.get(`copy:${attempt.id}`)
            return {
                ...attempt,
                marketId: ledger?.marketId ?? null,
                assetId: ledger?.assetId ?? null
            }
        })

        const serializedAttempts = enrichedAttempts.map((attempt) => ({
            ...attempt,
            targetNotionalMicros: attempt.targetNotionalMicros.toString(),
            filledNotionalMicros: attempt.filledNotionalMicros.toString(),
            fills: attempt.fills.map((fill) => ({
                ...fill,
                filledShareMicros: fill.filledShareMicros.toString(),
                fillNotionalMicros: fill.fillNotionalMicros.toString()
            }))
        }))

        return NextResponse.json({
            items: serializedAttempts,
            total
        })
    } catch (error) {
        console.error("Failed to fetch copy attempts:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
