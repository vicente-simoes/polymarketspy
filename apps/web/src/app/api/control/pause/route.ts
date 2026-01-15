import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { z } from "zod"

const PauseSchema = z.object({
    paused: z.boolean()
})

export async function POST(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const json = await request.json()
        const { paused } = PauseSchema.parse(json)

        await prisma.systemCheckpoint.upsert({
            where: { key: "system:copy_engine_enabled" },
            update: {
                valueJson: JSON.stringify(!paused), // paused=true -> enabled=false
                updatedAt: new Date()
            },
            create: {
                key: "system:copy_engine_enabled",
                valueJson: JSON.stringify(!paused),
                updatedAt: new Date()
            }
        })

        return NextResponse.json({ success: true, paused })
    } catch (error) {
        console.error("Failed to toggle pause:", error)
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: "Invalid input" }, { status: 400 })
        }
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
