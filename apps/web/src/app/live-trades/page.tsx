"use client"

import { Header } from "@/components/header"
import { Sidebar } from "@/components/sidebar"
import { fetcher } from "@/lib/fetcher"
import useSWR from "swr"
import { useMemo, useState } from "react"
import { Activity, Database, Shield, TriangleAlert, Wifi } from "lucide-react"

type LiveStatusResponse = {
    system: {
        copyEngineEnabled: boolean
        liveTradingEnabled: boolean
        liveTradingReadOnlyEnabled: boolean
        updatedAt: number | null
    }
    followedUsers: {
        overrides: {
            INHERIT: number
            FORCE_ON: number
            FORCE_OFF: number
            disabled: number
        }
    }
    worker: {
        userChannel: {
            enabled: boolean
            connected: boolean
            lastConnectedAt: string | null
            lastMessageAt: string | null
            errorCount: number
            orphanBufferSize: number
        } | null
        liveReconciliation: {
            enabled: boolean
            isHealthy: boolean
            isInitialized: boolean
            lastOrderReconcileAt: string | null
            lastStateReconcileAt: string | null
            submissionUnknownCount: number
        } | null
        clobBookWsConnected: boolean | null
    }
    liveOrders: {
        openOrdersCount: number
        submissionUnknownCount: number
        lastError: {
            liveOrderId: string
            status: string
            code: string | null
            message: string | null
            at: number
        } | null
    }
    liveFills: { lastMatchedAt: number | null }
    liveAttempts: { lastAttemptAt: number | null }
}

type LiveOrderRow = {
    id: string
    createdAt: string
    status: string
    tokenId: string
    side: "BUY" | "SELL"
    orderType: string
    limitPriceMicros: number
    sizeShareMicros: string
    filledShareMicros: string
    filledNotionalMicros: string
    avgFillPriceMicros: number | null
    clobOrderId: string | null
    lastErrorCode: string | null
    lastErrorMessage: string | null
    followedUserId: string | null
    followedUser: { label: string } | null
    bookSource: "WS" | "REST" | null
    bookAgeMs: number | null
    copyAttempt: {
        id: string
        decision: "EXECUTE" | "SKIP"
        reasonCodes: string[]
        bookSource: "WS" | "REST" | null
        usedRestFallback: boolean
        groupKey: string
        createdAt: string
    } | null
    marketTitle: string | null
    outcomeLabel: string | null
}

type LiveFillRow = {
    id: string
    tradeId: string
    origin: "APP" | "EXTERNAL"
    tokenId: string
    side: "BUY" | "SELL"
    matchedAt: string
    priceMicros: number
    shareMicros: string
    notionalMicros: string
    feeMicros: string | null
    clobOrderId: string | null
    liveOrder: {
        id: string
        status: string
        followedUserId: string | null
        followedUser: { label: string } | null
    } | null
    marketTitle: string | null
    outcomeLabel: string | null
}

type LiveAttemptRow = {
    id: string
    createdAt: string
    groupKey: string
    decision: "EXECUTE" | "SKIP"
    reasonCodes: string[]
    bookSource: "WS" | "REST" | null
    usedRestFallback: boolean
    targetNotionalMicros: string
    filledNotionalMicros: string
    followedUserId: string | null
    followedUser: { label: string | null } | null
    liveOrder: {
        id: string
        status: string
        clobOrderId: string | null
        lastErrorCode: string | null
        lastErrorMessage: string | null
    } | null
    marketTitle: string | null
    outcomeLabel: string | null
}

const formatTime = (value: number | null) => (value ? new Date(value).toLocaleString() : "--")

const formatAgo = (value: number | null) => {
    if (!value) return "--"
    const diffMs = Date.now() - value
    const seconds = Math.max(0, Math.floor(diffMs / 1000))
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}

const formatCurrencyFromMicros = (micros: string) => {
    const value = Number(micros) / 1_000_000
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
    }).format(value)
}

const formatSharesFromMicros = (micros: string) => (Number(micros) / 1_000_000).toFixed(2)

function StatusPill({ value }: { value: "ok" | "warn" | "bad" }) {
    const tone =
        value === "ok"
            ? "bg-[#102b1a] text-[#86efac]"
            : value === "warn"
              ? "bg-[#2b2312] text-amber-400"
              : "bg-[#2b1212] text-[#f87171]"
    return <span className={`rounded-full px-2 py-1 text-xs font-semibold ${tone}`}>{value}</span>
}

function SummaryTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="rounded-2xl border border-[#27272A] bg-[#0D0D0D] p-4">
            <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">{label}</div>
            <div className="mt-2 text-lg font-semibold text-white">{value}</div>
            {hint ? <div className="mt-1 text-xs text-[#6f6f6f]">{hint}</div> : null}
        </div>
    )
}

function statusFromBool(value: boolean | null | undefined): "ok" | "bad" {
    return value ? "ok" : "bad"
}

export default function LiveTradesPage() {
    const LIMIT = 25

    const [ordersCursorHistory, setOrdersCursorHistory] = useState<string[]>([])
    const [fillsCursorHistory, setFillsCursorHistory] = useState<string[]>([])
    const [attemptsCursorHistory, setAttemptsCursorHistory] = useState<string[]>([])

    const ordersCursor = ordersCursorHistory[ordersCursorHistory.length - 1]
    const fillsCursor = fillsCursorHistory[fillsCursorHistory.length - 1]
    const attemptsCursor = attemptsCursorHistory[attemptsCursorHistory.length - 1]

    const { data: status } = useSWR<LiveStatusResponse>("/api/live/status", fetcher, {
        refreshInterval: 5000,
    })

    const ordersUrl = useMemo(
        () => `/api/live/orders?limit=${LIMIT}${ordersCursor ? `&cursor=${ordersCursor}` : ""}`,
        [LIMIT, ordersCursor]
    )
    const fillsUrl = useMemo(
        () => `/api/live/fills?limit=${LIMIT}${fillsCursor ? `&cursor=${fillsCursor}` : ""}`,
        [LIMIT, fillsCursor]
    )
    const attemptsUrl = useMemo(
        () =>
            `/api/live/attempts?decision=SKIP&limit=${LIMIT}${attemptsCursor ? `&cursor=${attemptsCursor}` : ""}`,
        [LIMIT, attemptsCursor]
    )

    const { data: ordersData, isLoading: ordersLoading } = useSWR<{ items: LiveOrderRow[]; total: number }>(
        ordersUrl,
        fetcher,
        { refreshInterval: ordersCursor ? 0 : 5000, keepPreviousData: true }
    )

    const { data: fillsData, isLoading: fillsLoading } = useSWR<{ items: LiveFillRow[]; total: number }>(
        fillsUrl,
        fetcher,
        { refreshInterval: fillsCursor ? 0 : 5000, keepPreviousData: true }
    )

    const { data: attemptsData, isLoading: attemptsLoading } = useSWR<{ items: LiveAttemptRow[]; total: number }>(
        attemptsUrl,
        fetcher,
        { refreshInterval: attemptsCursor ? 0 : 5000, keepPreviousData: true }
    )

    const orders = ordersData?.items ?? []
    const fills = fillsData?.items ?? []
    const attempts = attemptsData?.items ?? []

    const userChannelLastMessageAtMs = status?.worker.userChannel?.lastMessageAt
        ? new Date(status.worker.userChannel.lastMessageAt).getTime()
        : null
    const reconcileLastAtMs = status?.worker.liveReconciliation?.lastStateReconcileAt
        ? new Date(status.worker.liveReconciliation.lastStateReconcileAt).getTime()
        : null

    return (
        <div className="relative w-full bg-black text-white overflow-hidden min-h-dvh md:h-screen">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex flex-col md:flex-row gap-4 md:gap-6 p-4 md:p-6 pt-20 md:pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-4 md:gap-6 min-w-0">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <p className="text-sm text-[#6f6f6f]">Live Trades</p>
                                <h1 className="text-2xl md:text-3xl font-bold text-white">Operational Dashboard</h1>
                            </div>
                            <div className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#111111] px-4 py-2 text-sm text-[#cfcfcf]">
                                <Activity className="h-4 w-4 text-[#86efac]" />
                                LIVE
                            </div>
                        </div>

                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                            <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                <Shield className="h-4 w-4 text-[#86efac]" />
                                Live Status
                            </div>

                            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                                <SummaryTile
                                    label="Copy Engine"
                                    value={status?.system.copyEngineEnabled ? "ON" : "OFF"}
                                    hint={status?.system.updatedAt ? formatTime(status.system.updatedAt) : undefined}
                                />
                                <SummaryTile
                                    label="Live Trading"
                                    value={status?.system.liveTradingEnabled ? "ON" : "OFF"}
                                />
                                <SummaryTile
                                    label="Live Read-Only"
                                    value={status?.system.liveTradingReadOnlyEnabled ? "ON" : "OFF"}
                                />
                                <SummaryTile
                                    label="Per-User Overrides"
                                    value={`${status?.followedUsers.overrides.FORCE_ON ?? 0} on / ${status?.followedUsers.overrides.FORCE_OFF ?? 0} off`}
                                    hint={`${status?.followedUsers.overrides.INHERIT ?? 0} inherit, ${status?.followedUsers.overrides.disabled ?? 0} disabled`}
                                />
                            </div>

                            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                                <div className="rounded-2xl border border-[#27272A] bg-[#0D0D0D] p-4">
                                    <div className="flex items-center justify-between">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            CLOB Auth
                                        </div>
                                        <StatusPill value={statusFromBool(status?.worker.liveReconciliation?.enabled)} />
                                    </div>
                                    <div className="mt-2 text-xs text-[#6f6f6f]">
                                        {status?.worker.liveReconciliation?.enabled
                                            ? "initialized"
                                            : "not initialized"}
                                    </div>
                                </div>

                                <div className="rounded-2xl border border-[#27272A] bg-[#0D0D0D] p-4">
                                    <div className="flex items-center justify-between">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            User Channel WS
                                        </div>
                                        <StatusPill value={statusFromBool(status?.worker.userChannel?.connected)} />
                                    </div>
                                    <div className="mt-2 text-xs text-[#6f6f6f]">
                                        last msg: {formatAgo(userChannelLastMessageAtMs)}
                                    </div>
                                </div>

                                <div className="rounded-2xl border border-[#27272A] bg-[#0D0D0D] p-4">
                                    <div className="flex items-center justify-between">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Reconciliation
                                        </div>
                                        <StatusPill
                                            value={
                                                status?.worker.liveReconciliation?.enabled
                                                    ? status?.worker.liveReconciliation?.isHealthy
                                                        ? "ok"
                                                        : "warn"
                                                    : "warn"
                                            }
                                        />
                                    </div>
                                    <div className="mt-2 text-xs text-[#6f6f6f]">
                                        last state: {formatAgo(reconcileLastAtMs)}
                                    </div>
                                </div>

                                <div className="rounded-2xl border border-[#27272A] bg-[#0D0D0D] p-4">
                                    <div className="flex items-center justify-between">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Orders
                                        </div>
                                        <Wifi className="h-4 w-4 text-[#86efac]" />
                                    </div>
                                    <div className="mt-2 text-sm text-white">
                                        open: {status?.liveOrders.openOrdersCount ?? 0}
                                    </div>
                                    <div className="mt-1 text-xs text-[#6f6f6f]">
                                        SUBMISSION_UNKNOWN: {status?.liveOrders.submissionUnknownCount ?? 0}
                                    </div>
                                </div>
                            </div>

                            {status?.liveOrders.lastError ? (
                                <div className="mt-4 rounded-2xl border border-[#27272A] bg-[#111111] p-4">
                                    <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                        <TriangleAlert className="h-4 w-4 text-amber-400" />
                                        Last Error
                                    </div>
                                    <div className="mt-2 text-sm text-white">
                                        {status.liveOrders.lastError.message ?? "Unknown error"}
                                    </div>
                                    <div className="mt-1 text-xs text-[#6f6f6f]">
                                        {formatTime(status.liveOrders.lastError.at)} · {status.liveOrders.lastError.code ?? "NO_CODE"} · order{" "}
                                        <span className="font-mono">{status.liveOrders.lastError.liveOrderId}</span>
                                    </div>
                                </div>
                            ) : null}
                        </div>

                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <div className="text-sm text-[#6f6f6f]">Live Orders</div>
                                    <div className="mt-1 text-xs text-[#6f6f6f]">Newest first</div>
                                </div>
                                <div className="text-xs text-[#6f6f6f]">
                                    {ordersData ? `${orders.length} / ${ordersData.total}` : "--"}
                                </div>
                            </div>

                            {ordersLoading ? (
                                <div className="mt-4 text-gray-400">Loading live orders...</div>
                            ) : (
                                <div className="mt-4 overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                <th className="pb-3 text-left">Time</th>
                                                <th className="pb-3 text-left">User</th>
                                                <th className="pb-3 text-left">Market</th>
                                                <th className="pb-3 text-left">Side</th>
                                                <th className="pb-3 text-right">Price</th>
                                                <th className="pb-3 text-right">Size</th>
                                                <th className="pb-3 text-left">Book</th>
                                                <th className="pb-3 text-left">Status</th>
                                                <th className="pb-3 text-left">Order Id</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {orders.length > 0 ? (
                                                orders.map((order) => (
                                                    <tr
                                                        key={order.id}
                                                        className="border-b border-[#1A1A1A] last:border-0"
                                                    >
                                                        <td className="py-3 text-[#cfcfcf] whitespace-nowrap">
                                                            {new Date(order.createdAt).toLocaleString()}
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            {order.followedUser?.label ?? order.followedUserId ?? "--"}
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            <div className="font-medium">
                                                                {order.marketTitle ?? order.tokenId}
                                                            </div>
                                                            <div className="text-xs text-[#6f6f6f]">
                                                                {order.outcomeLabel ?? ""}
                                                            </div>
                                                        </td>
                                                        <td className="py-3 text-white">{order.side}</td>
                                                        <td className="py-3 text-right text-white font-mono">
                                                            {(order.limitPriceMicros / 1_000_000).toFixed(3)}
                                                        </td>
                                                        <td className="py-3 text-right text-white font-mono">
                                                            {formatSharesFromMicros(order.sizeShareMicros)}
                                                        </td>
                                                        <td className="py-3 text-[#cfcfcf]">
                                                            <div className="flex items-center gap-2">
                                                                <span className="rounded-full px-2 py-1 text-xs font-semibold bg-[#1A1A1A] text-[#cfcfcf]">
                                                                    {order.copyAttempt?.bookSource ?? order.bookSource ?? "--"}
                                                                </span>
                                                                {order.copyAttempt?.usedRestFallback ? (
                                                                    <span className="rounded-full px-2 py-1 text-xs font-semibold bg-[#2b2312] text-amber-400">
                                                                        REST fallback
                                                                    </span>
                                                                ) : null}
                                                            </div>
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            <span className="font-mono">{order.status}</span>
                                                            {order.lastErrorMessage ? (
                                                                <div className="text-xs text-[#f87171] mt-1 max-w-[420px] truncate">
                                                                    {order.lastErrorMessage}
                                                                </div>
                                                            ) : null}
                                                        </td>
                                                        <td className="py-3 text-[#cfcfcf] font-mono">
                                                            {order.clobOrderId ?? order.id}
                                                        </td>
                                                    </tr>
                                                ))
                                            ) : (
                                                <tr>
                                                    <td colSpan={9} className="py-6 text-center text-[#6f6f6f]">
                                                        No live orders yet
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className="mt-4 flex items-center justify-between gap-2">
                                <button
                                    className="rounded-lg border border-[#27272A] bg-[#111111] px-3 py-2 text-sm text-white disabled:opacity-50"
                                    disabled={ordersCursorHistory.length === 0}
                                    onClick={() =>
                                        setOrdersCursorHistory((prev) => prev.slice(0, prev.length - 1))
                                    }
                                >
                                    Prev
                                </button>
                                <button
                                    className="rounded-lg border border-[#27272A] bg-[#111111] px-3 py-2 text-sm text-white disabled:opacity-50"
                                    disabled={!ordersData || orders.length < LIMIT}
                                    onClick={() => {
                                        const last = orders[orders.length - 1]
                                        if (!last) return
                                        setOrdersCursorHistory((prev) => [...prev, last.id])
                                    }}
                                >
                                    Next
                                </button>
                            </div>
                        </div>

                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <div className="text-sm text-[#6f6f6f]">Live Fills</div>
                                    <div className="mt-1 text-xs text-[#6f6f6f]">Includes EXTERNAL fills</div>
                                </div>
                                <div className="text-xs text-[#6f6f6f]">
                                    {fillsData ? `${fills.length} / ${fillsData.total}` : "--"}
                                </div>
                            </div>

                            {fillsLoading ? (
                                <div className="mt-4 text-gray-400">Loading live fills...</div>
                            ) : (
                                <div className="mt-4 overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                <th className="pb-3 text-left">Matched</th>
                                                <th className="pb-3 text-left">Origin</th>
                                                <th className="pb-3 text-left">User</th>
                                                <th className="pb-3 text-left">Market</th>
                                                <th className="pb-3 text-left">Side</th>
                                                <th className="pb-3 text-right">Price</th>
                                                <th className="pb-3 text-right">Shares</th>
                                                <th className="pb-3 text-right">Notional</th>
                                                <th className="pb-3 text-right">Fee</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {fills.length > 0 ? (
                                                fills.map((fill) => (
                                                    <tr key={fill.id} className="border-b border-[#1A1A1A] last:border-0">
                                                        <td className="py-3 text-[#cfcfcf] whitespace-nowrap">
                                                            {new Date(fill.matchedAt).toLocaleString()}
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            <span className="rounded-full px-2 py-1 text-xs font-semibold bg-[#1A1A1A] text-[#cfcfcf]">
                                                                {fill.origin}
                                                            </span>
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            {fill.liveOrder?.followedUser?.label ??
                                                                fill.liveOrder?.followedUserId ??
                                                                "--"}
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            <div className="font-medium">
                                                                {fill.marketTitle ?? fill.tokenId}
                                                            </div>
                                                            <div className="text-xs text-[#6f6f6f]">
                                                                {fill.outcomeLabel ?? ""}
                                                            </div>
                                                        </td>
                                                        <td className="py-3 text-white">{fill.side}</td>
                                                        <td className="py-3 text-right text-white font-mono">
                                                            {(fill.priceMicros / 1_000_000).toFixed(3)}
                                                        </td>
                                                        <td className="py-3 text-right text-white font-mono">
                                                            {formatSharesFromMicros(fill.shareMicros)}
                                                        </td>
                                                        <td className="py-3 text-right text-white font-mono">
                                                            {formatCurrencyFromMicros(fill.notionalMicros)}
                                                        </td>
                                                        <td className="py-3 text-right text-white font-mono">
                                                            {fill.feeMicros ? formatCurrencyFromMicros(fill.feeMicros) : "--"}
                                                        </td>
                                                    </tr>
                                                ))
                                            ) : (
                                                <tr>
                                                    <td colSpan={9} className="py-6 text-center text-[#6f6f6f]">
                                                        No live fills yet
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className="mt-4 flex items-center justify-between gap-2">
                                <button
                                    className="rounded-lg border border-[#27272A] bg-[#111111] px-3 py-2 text-sm text-white disabled:opacity-50"
                                    disabled={fillsCursorHistory.length === 0}
                                    onClick={() =>
                                        setFillsCursorHistory((prev) => prev.slice(0, prev.length - 1))
                                    }
                                >
                                    Prev
                                </button>
                                <button
                                    className="rounded-lg border border-[#27272A] bg-[#111111] px-3 py-2 text-sm text-white disabled:opacity-50"
                                    disabled={!fillsData || fills.length < LIMIT}
                                    onClick={() => {
                                        const last = fills[fills.length - 1]
                                        if (!last) return
                                        setFillsCursorHistory((prev) => [...prev, last.id])
                                    }}
                                >
                                    Next
                                </button>
                            </div>
                        </div>

                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <div className="text-sm text-[#6f6f6f]">Skipped / Rejected</div>
                                    <div className="mt-1 text-xs text-[#6f6f6f]">Live-mode copy attempts that did not place</div>
                                </div>
                                <div className="text-xs text-[#6f6f6f]">
                                    {attemptsData ? `${attempts.length} / ${attemptsData.total}` : "--"}
                                </div>
                            </div>

                            {attemptsLoading ? (
                                <div className="mt-4 text-gray-400">Loading skipped attempts...</div>
                            ) : (
                                <div className="mt-4 overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                <th className="pb-3 text-left">Time</th>
                                                <th className="pb-3 text-left">User</th>
                                                <th className="pb-3 text-left">Market</th>
                                                <th className="pb-3 text-right">Target</th>
                                                <th className="pb-3 text-left">Book</th>
                                                <th className="pb-3 text-left">Reasons</th>
                                                <th className="pb-3 text-left">Order Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {attempts.length > 0 ? (
                                                attempts.map((attempt) => (
                                                    <tr
                                                        key={attempt.id}
                                                        className="border-b border-[#1A1A1A] last:border-0"
                                                    >
                                                        <td className="py-3 text-[#cfcfcf] whitespace-nowrap">
                                                            {new Date(attempt.createdAt).toLocaleString()}
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            {attempt.followedUser?.label ??
                                                                attempt.followedUserId ??
                                                                "--"}
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            <div className="font-medium">
                                                                {attempt.marketTitle ?? "--"}
                                                            </div>
                                                            <div className="text-xs text-[#6f6f6f]">
                                                                {attempt.outcomeLabel ?? ""}
                                                            </div>
                                                        </td>
                                                        <td className="py-3 text-right text-white font-mono">
                                                            {formatCurrencyFromMicros(attempt.targetNotionalMicros)}
                                                        </td>
                                                        <td className="py-3 text-[#cfcfcf]">
                                                            <div className="flex items-center gap-2">
                                                                <span className="rounded-full px-2 py-1 text-xs font-semibold bg-[#1A1A1A] text-[#cfcfcf]">
                                                                    {attempt.bookSource ?? "--"}
                                                                </span>
                                                                {attempt.usedRestFallback ? (
                                                                    <span className="rounded-full px-2 py-1 text-xs font-semibold bg-[#2b2312] text-amber-400">
                                                                        REST fallback
                                                                    </span>
                                                                ) : null}
                                                            </div>
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            <div className="flex flex-wrap gap-1 max-w-[520px]">
                                                                {attempt.reasonCodes?.length ? (
                                                                    attempt.reasonCodes.map((code) => (
                                                                        <span
                                                                            key={code}
                                                                            className="rounded-full px-2 py-1 text-xs font-semibold bg-[#1A1A1A] text-[#cfcfcf]"
                                                                        >
                                                                            {code}
                                                                        </span>
                                                                    ))
                                                                ) : (
                                                                    <span className="text-[#6f6f6f]">--</span>
                                                                )}
                                                            </div>
                                                        </td>
                                                        <td className="py-3 text-white">
                                                            {attempt.liveOrder ? (
                                                                <div>
                                                                    <div className="font-mono">{attempt.liveOrder.status}</div>
                                                                    {attempt.liveOrder.lastErrorMessage ? (
                                                                        <div className="text-xs text-[#f87171] mt-1 max-w-[420px] truncate">
                                                                            {attempt.liveOrder.lastErrorMessage}
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                            ) : (
                                                                <span className="text-[#6f6f6f]">--</span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))
                                            ) : (
                                                <tr>
                                                    <td colSpan={7} className="py-6 text-center text-[#6f6f6f]">
                                                        No skipped attempts yet
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className="mt-4 flex items-center justify-between gap-2">
                                <button
                                    className="rounded-lg border border-[#27272A] bg-[#111111] px-3 py-2 text-sm text-white disabled:opacity-50"
                                    disabled={attemptsCursorHistory.length === 0}
                                    onClick={() =>
                                        setAttemptsCursorHistory((prev) => prev.slice(0, prev.length - 1))
                                    }
                                >
                                    Prev
                                </button>
                                <button
                                    className="rounded-lg border border-[#27272A] bg-[#111111] px-3 py-2 text-sm text-white disabled:opacity-50"
                                    disabled={!attemptsData || attempts.length < LIMIT}
                                    onClick={() => {
                                        const last = attempts[attempts.length - 1]
                                        if (!last) return
                                        setAttemptsCursorHistory((prev) => [...prev, last.id])
                                    }}
                                >
                                    Next
                                </button>
                            </div>
                        </div>

                        <div className="rounded-2xl border border-[#27272A] bg-[#0D0D0D] p-4">
                            <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                <Database className="h-4 w-4 text-[#86efac]" />
                                Pointers
                            </div>
                            <div className="mt-2 text-xs text-[#6f6f6f]">
                                last fill: {formatAgo(status?.liveFills.lastMatchedAt ?? null)} · last attempt:{" "}
                                {formatAgo(status?.liveAttempts.lastAttemptAt ?? null)}
                            </div>
                        </div>
                    </div>
                </main>
            </div>
        </div>
    )
}

