
import { NextRequest, NextResponse } from "next/server"

export const dynamic = 'force-dynamic'
import { getServerSession } from "next-auth"
import * as z from "zod"

import prisma from "@/lib/prisma"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"

const toggleSchema = z.object({
    id: z.string().uuid(),
    enabled: z.boolean(),
})

export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions)

    if (!session) {
        return new NextResponse("Unauthorized", { status: 401 })
    }

    try {
        const json = await req.json()
        const body = toggleSchema.safeParse(json)

        if (!body.success) {
            return new NextResponse(body.error.message, { status: 422 })
        }

        const { id, enabled } = body.data

        const updatedUser = await prisma.followedUser.update({
            where: {
                id,
            },
            data: {
                enabled,
            },
        })

        return NextResponse.json(updatedUser)
    } catch (error) {
        console.error("[USER_TOGGLE]", error)
        return new NextResponse("Internal Error", { status: 500 })
    }
}
