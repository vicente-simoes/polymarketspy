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
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200)
    const cursor = searchParams.get("cursor")
    const status = searchParams.get("status") // optional exact match

    try {
        const where = {
            ...(status ? { status: status as any } : {}),
        }

        const [total, orders] = await Promise.all([
            prisma.liveOrder.count({ where }),
            prisma.liveOrder.findMany({
                where,
                include: {
                    followedUser: { select: { label: true } },
                    copyAttempt: {
                        select: {
                            id: true,
                            decision: true,
                            reasonCodes: true,
                            bookSource: true,
                            usedRestFallback: true,
                            groupKey: true,
                            createdAt: true,
                        },
                    },
                },
                take: limit,
                skip: cursor ? 1 : 0,
                cursor: cursor ? { id: cursor } : undefined,
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            }),
        ])

        const tokenIds = Array.from(new Set(orders.map((o) => o.tokenId).filter(Boolean)))
        const metas = tokenIds.length
            ? await prisma.tokenMetadataCache.findMany({
                  where: { tokenId: { in: tokenIds } },
                  select: { tokenId: true, marketTitle: true, marketSlug: true, outcomeLabel: true },
              })
            : []
        const metaByToken = new Map(metas.map((m) => [m.tokenId, m]))

        const items = orders.map((order) => {
            const meta = metaByToken.get(order.tokenId)
            return {
                ...order,
                marketTitle: meta?.marketTitle ?? null,
                marketSlug: meta?.marketSlug ?? null,
                outcomeLabel: meta?.outcomeLabel ?? null,
                sizeShareMicros: order.sizeShareMicros.toString(),
                filledShareMicros: order.filledShareMicros.toString(),
                filledNotionalMicros: order.filledNotionalMicros.toString(),
            }
        })

        return NextResponse.json({ items, total }, { headers: { "Cache-Control": "no-store" } })
    } catch (error) {
        console.error("Failed to fetch live orders:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

