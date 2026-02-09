import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { z } from "zod"

export const dynamic = "force-dynamic"

const SYSTEM_CONFIG_KEY = "system:config"

const PauseSchema = z.union([
    z.object({
        paused: z.boolean()
    }),
    z.object({
        action: z.enum(["PAUSE", "RESUME"])
    })
])

export async function POST(request: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const json = await request.json()
        const parsed = PauseSchema.parse(json)

        const copyEngineEnabled = "paused" in parsed ? !parsed.paused : parsed.action === "RESUME"

        const existing = await prisma.systemCheckpoint.findUnique({
            where: { key: SYSTEM_CONFIG_KEY },
            select: { valueJson: true },
        })
        const existingJson = (existing?.valueJson || {}) as Record<string, any>
        const nextJson = {
            ...existingJson,
            copyEngineEnabled,
        }

        await prisma.systemCheckpoint.upsert({
            where: { key: SYSTEM_CONFIG_KEY },
            update: { valueJson: nextJson },
            create: { key: SYSTEM_CONFIG_KEY, valueJson: nextJson },
        })

        return NextResponse.json({ success: true, copyEngineEnabled })
    } catch (error) {
        console.error("Failed to toggle pause:", error)
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: "Invalid input" }, { status: 400 })
        }
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
