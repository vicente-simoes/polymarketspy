import type { Prisma } from "@prisma/client"
import prisma from "@/lib/prisma"

function clampTimeoutMs(value: number): number {
    if (!Number.isFinite(value)) return 5000
    return Math.max(250, Math.min(30_000, Math.trunc(value)))
}

export async function withPgStatementTimeout<T>(
    timeoutMs: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
    const resolvedTimeoutMs = clampTimeoutMs(timeoutMs)
    const txTimeoutMs = Math.max(5_000, resolvedTimeoutMs + 1_000)

    return prisma.$transaction(
        async (tx) => {
            await tx.$executeRawUnsafe(
                `SET LOCAL statement_timeout = '${resolvedTimeoutMs}ms'`
            )
            return fn(tx)
        },
        { timeout: txTimeoutMs }
    )
}
