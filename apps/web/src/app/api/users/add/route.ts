import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import { z } from "zod"

const AddUserSchema = z.object({
    label: z.string().min(1, "Label is required"),
    profileWallet: z.string().length(42, "Invalid wallet address length").startsWith("0x", "Must start with 0x"),
})

export async function POST(req: Request) {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const body = await req.json()
        const result = AddUserSchema.safeParse(body)

        if (!result.success) {
            return NextResponse.json({ error: result.error.errors[0].message }, { status: 400 })
        }

        const { label, profileWallet } = result.data

        const existingUser = await prisma.followedUser.findUnique({
            where: { profileWallet }
        })

        if (existingUser) {
            return NextResponse.json({ error: "User with this wallet already exists" }, { status: 409 })
        }

        const newUser = await prisma.followedUser.create({
            data: {
                label,
                profileWallet,
                enabled: true
            }
        })

        return NextResponse.json(newUser)
    } catch (error) {
        console.error("Failed to add user:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
