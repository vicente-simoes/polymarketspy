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
    const origin = searchParams.get("origin") // APP | EXTERNAL

    try {
        const where = {
            ...(origin ? { origin: origin as any } : {}),
        }

        const [total, fills] = await Promise.all([
            prisma.liveFill.count({ where }),
            prisma.liveFill.findMany({
                where,
                include: {
                    liveOrder: {
                        select: {
                            id: true,
                            status: true,
                            followedUserId: true,
                            followedUser: { select: { label: true } },
                        },
                    },
                },
                take: limit,
                skip: cursor ? 1 : 0,
                cursor: cursor ? { id: cursor } : undefined,
                orderBy: [{ matchedAt: "desc" }, { id: "desc" }],
            }),
        ])

        const tokenIds = Array.from(new Set(fills.map((f) => f.tokenId).filter(Boolean)))
        const metas = tokenIds.length
            ? await prisma.tokenMetadataCache.findMany({
                  where: { tokenId: { in: tokenIds } },
                  select: { tokenId: true, marketTitle: true, marketSlug: true, outcomeLabel: true },
              })
            : []
        const metaByToken = new Map(metas.map((m) => [m.tokenId, m]))

        const items = fills.map((fill) => {
            const meta = metaByToken.get(fill.tokenId)
            return {
                ...fill,
                marketTitle: meta?.marketTitle ?? null,
                marketSlug: meta?.marketSlug ?? null,
                outcomeLabel: meta?.outcomeLabel ?? null,
                shareMicros: fill.shareMicros.toString(),
                notionalMicros: fill.notionalMicros.toString(),
                feeMicros: fill.feeMicros?.toString() ?? null,
            }
        })

        return NextResponse.json({ items, total }, { headers: { "Cache-Control": "no-store" } })
    } catch (error) {
        console.error("Failed to fetch live fills:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

