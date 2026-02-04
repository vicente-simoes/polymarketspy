import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import * as z from "zod"

import prisma from "@/lib/prisma"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import { LiveOverride } from "@prisma/client"

export const dynamic = "force-dynamic"

const schema = z.object({
    id: z.string().uuid(),
    liveOverride: z.nativeEnum(LiveOverride),
})

export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return new NextResponse("Unauthorized", { status: 401 })
    }

    try {
        const json = await req.json()
        const body = schema.safeParse(json)

        if (!body.success) {
            return new NextResponse(body.error.message, { status: 422 })
        }

        const { id, liveOverride } = body.data

        const updatedUser = await prisma.followedUser.update({
            where: { id },
            data: { liveOverride },
            select: {
                id: true,
                enabled: true,
                liveOverride: true,
            },
        })

        return NextResponse.json(updatedUser)
    } catch (error) {
        console.error("[USER_LIVE_OVERRIDE]", error)
        return new NextResponse("Internal Error", { status: 500 })
    }
}

