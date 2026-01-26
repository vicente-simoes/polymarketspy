import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import prisma from "@/lib/prisma"
import net from "net"
import tls from "tls"

type WorkerHealth = {
    status: "ok" | "degraded" | "unhealthy"
    timestamp: string
    lastCanonicalEventTime: string | null
    alchemyWsConnected: boolean
    queueDepths: Record<string, number>
    dbConnected: boolean
}

type CheckpointValue = { timestamp?: string; blockNumber?: number }

const encodeCommand = (command: string, args: string[]) => {
    const parts = [command, ...args]
    const lines = [`*${parts.length}`]
    for (const part of parts) {
        const encoded = Buffer.from(part, "utf8")
        lines.push(`$${encoded.length}`)
        lines.push(encoded.toString())
    }
    return `${lines.join("\r\n")}\r\n`
}

const pingRedis = (url: string, timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
        try {
            const parsed = new URL(url)
            const host = parsed.hostname
            const port = parsed.port ? parseInt(parsed.port, 10) : 6379
            const password = parsed.password ? decodeURIComponent(parsed.password) : null
            const useTls = parsed.protocol === "rediss:"

            const socket = useTls
                ? tls.connect({ host, port })
                : net.connect({ host, port })

            let resolved = false
            let buffer = ""

            const finalize = (value: boolean) => {
                if (resolved) return
                resolved = true
                socket.destroy()
                resolve(value)
            }

            const timeout = setTimeout(() => finalize(false), timeoutMs)

            socket.on("error", () => finalize(false))
            socket.on("data", (data) => {
                buffer += data.toString()
                if (buffer.includes("+PONG")) {
                    clearTimeout(timeout)
                    finalize(true)
                }
                if (buffer.includes("-NOAUTH") || buffer.includes("-WRONGPASS")) {
                    clearTimeout(timeout)
                    finalize(false)
                }
            })

            socket.on("connect", () => {
                if (password) {
                    socket.write(encodeCommand("AUTH", [password]))
                }
                socket.write(encodeCommand("PING", []))
            })
        } catch {
            resolve(false)
        }
    })

const parseCheckpointTime = (value: CheckpointValue | null | undefined) => {
    if (!value?.timestamp) return null
    const parsed = new Date(value.timestamp).getTime()
    return Number.isNaN(parsed) ? null : parsed
}

export async function GET() {
    const session = await getServerSession(authOptions)
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const workerUrl =
            process.env.WORKER_HEALTH_URL ??
            (process.env.NODE_ENV === "development"
                ? "http://localhost:8081/health"
                : "http://worker:8081/health")
        let workerHealth: WorkerHealth | null = null
        const redisUrl = process.env.REDIS_URL ?? null
        let redisStatus: "ok" | "down" | "unknown" = redisUrl ? "down" : "unknown"

        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 1500)
            const response = await fetch(workerUrl, { signal: controller.signal })
            clearTimeout(timeout)
            if (response.ok) {
                workerHealth = (await response.json()) as WorkerHealth
            }
        } catch {
            workerHealth = null
        }

        if (redisUrl) {
            try {
                const pinged = await pingRedis(redisUrl, 700)
                redisStatus = pinged ? "ok" : "down"
            } catch {
                redisStatus = "down"
            }
        }

        let dbConnected = false
        try {
            await prisma.$queryRaw`SELECT 1`
            dbConnected = true
        } catch {
            dbConnected = false
        }

        let lastTradeEvent = null
        let lastActivityEvent = null
        let lastSnapshot = null
        let lastGlobalSnapshot = null
        let checkpoints: Awaited<ReturnType<typeof prisma.systemCheckpoint.findMany<{ select: { key: true; valueJson: true } }>>> = []
        let tradeCount = 0
        let activityCount = 0
        let copyAttemptCount = 0
        let ledgerCount = 0
        let snapshotCount = 0
        let dbSize: { size: bigint }[] | null = null

        if (dbConnected) {
            ;[
                lastTradeEvent,
                lastActivityEvent,
                lastSnapshot,
                lastGlobalSnapshot,
                checkpoints,
                tradeCount,
                activityCount,
                copyAttemptCount,
                ledgerCount,
                snapshotCount,
                dbSize
            ] = await Promise.all([
                prisma.tradeEvent.findFirst({ orderBy: { eventTime: "desc" } }),
                prisma.activityEvent.findFirst({ orderBy: { eventTime: "desc" } }),
                prisma.portfolioSnapshot.findFirst({ orderBy: { bucketTime: "desc" } }),
                prisma.portfolioSnapshot.findFirst({
                    where: { portfolioScope: "EXEC_GLOBAL", followedUserId: null },
                    orderBy: { bucketTime: "desc" }
                }),
                prisma.systemCheckpoint.findMany({
                    where: {
                        OR: [
                            { key: { startsWith: "api:lastTradeTime:" } },
                            { key: { startsWith: "api:lastActivityTime:" } },
                            { key: "alchemy:lastBlock" }
                        ]
                    },
                    select: { key: true, valueJson: true }
                }),
                prisma.tradeEvent.count(),
                prisma.activityEvent.count(),
                prisma.copyAttempt.count(),
                prisma.ledgerEntry.count(),
                prisma.portfolioSnapshot.count(),
                prisma
                    .$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`
                    .catch(() => null)
            ])
        }

        const checkpointMap = new Map(
            checkpoints.map((checkpoint) => [checkpoint.key, checkpoint.valueJson as CheckpointValue | null])
        )
        const alchemy = checkpointMap.get("alchemy:lastBlock") ?? null
        const tradeCheckpointTimes = checkpoints
            .filter((checkpoint) => checkpoint.key.startsWith("api:lastTradeTime:"))
            .map((checkpoint) => parseCheckpointTime(checkpoint.valueJson as CheckpointValue | null))
            .filter((value): value is number => value !== null)
        const activityCheckpointTimes = checkpoints
            .filter((checkpoint) => checkpoint.key.startsWith("api:lastActivityTime:"))
            .map((checkpoint) => parseCheckpointTime(checkpoint.valueJson as CheckpointValue | null))
            .filter((value): value is number => value !== null)

        const lastTradeCheckpoint =
            tradeCheckpointTimes.length > 0
                ? Math.max(...tradeCheckpointTimes)
                : null
        const lastActivityCheckpoint =
            activityCheckpointTimes.length > 0
                ? Math.max(...activityCheckpointTimes)
                : null

        const lastBackfill =
            lastTradeCheckpoint && lastActivityCheckpoint
                ? Math.max(lastTradeCheckpoint, lastActivityCheckpoint)
                : lastTradeCheckpoint ?? lastActivityCheckpoint ?? null

        const dbSizeBytes =
            Array.isArray(dbSize) && dbSize.length > 0 ? Number(dbSize[0].size) : null

        const queueDepths = workerHealth?.queueDepths ?? {}
        const queues = {
            ingest: queueDepths.ingestEvents ?? null,
            group: queueDepths.groupEvents ?? null,
            copyUser: queueDepths.copyAttemptUser ?? null,
            copyGlobal: queueDepths.copyAttemptGlobal ?? null,
            reconcile: queueDepths.reconcile ?? null,
            prices: queueDepths.prices ?? null,
            dlq: null
        }

        return NextResponse.json({
            health: { status: "ok" },
            services: {
                worker: workerHealth?.status ?? "down",
                database: dbConnected ? "ok" : "down",
                redis: redisStatus,
                websocket: workerHealth
                    ? workerHealth.alchemyWsConnected
                        ? "ok"
                        : "degraded"
                    : "down"
            },
            worker: {
                lastCanonicalEventTime: workerHealth?.lastCanonicalEventTime ?? null,
                wsConnected: workerHealth?.alchemyWsConnected ?? null,
                dbConnected: workerHealth?.dbConnected ?? null
            },
            ingestion: {
                lastTradeEventTime: lastTradeEvent?.eventTime?.getTime() ?? null,
                lastActivityEventTime: lastActivityEvent?.eventTime?.getTime() ?? null,
                lastBackfillTime: lastBackfill,
                lastBlock: alchemy?.blockNumber ?? null
            },
            snapshots: {
                lastSnapshotTime: lastSnapshot?.bucketTime?.getTime() ?? null,
                lastGlobalSnapshotTime: lastGlobalSnapshot?.bucketTime?.getTime() ?? null
            },
            queues,
            apiErrors: {
                polymarket: null,
                alchemy: null
            },
            database: {
                sizeBytes: dbSizeBytes,
                counts: {
                    trades: tradeCount,
                    activities: activityCount,
                    copyAttempts: copyAttemptCount,
                    ledgerEntries: ledgerCount,
                    snapshots: snapshotCount
                }
            }
        })
    } catch (error) {
        console.error("Failed to fetch system status:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
