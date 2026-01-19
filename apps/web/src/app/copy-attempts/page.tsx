"use client"

import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { useMemo, useState } from "react"

interface CopyAttemptRow {
    id: string
    portfolioScope: "EXEC_USER" | "EXEC_GLOBAL"
    followedUserId?: string | null
    followedUser?: { label?: string | null }
    decision: "EXECUTE" | "SKIP"
    reasonCodes: string[]
    targetNotionalMicros: string | number
    filledNotionalMicros: string | number
    filledRatioBps: number
    vwapPriceMicros?: number | null
    theirReferencePriceMicros: number
    groupKey: string
    createdAt: string
    marketId?: string | null
    assetId?: string | null
    marketTitle?: string | null
    marketSlug?: string | null
    outcomeLabel?: string | null
}

export default function CopyAttemptsPage() {
    const [filters, setFilters] = useState({
        user: "",
        market: "",
        decision: "ALL",
        reason: ""
    })

    const [cursorHistory, setCursorHistory] = useState<string[]>([])
    const currentCursor = cursorHistory[cursorHistory.length - 1]
    const LIMIT = 50

    const {
        data,
        error,
        isLoading
    } = useSWR<{ items: CopyAttemptRow[], total: number }>(
        `/api/copy-attempts?limit=${LIMIT}${currentCursor ? `&cursor=${currentCursor}` : ""}`,
        fetcher,
        { refreshInterval: currentCursor ? 0 : 5000, keepPreviousData: true }
    )

    const attempts = data?.items
    const total = data?.total ?? 0

    const userQuery = filters.user.trim().toLowerCase()
    const marketQuery = filters.market.trim().toLowerCase()
    const reasonQuery = filters.reason.trim().toLowerCase()
    const decisionFilter = filters.decision

    const filteredAttempts = useMemo(() => {
        if (!attempts) return []
        return attempts.filter((attempt) => {
            const userField = `${attempt.followedUser?.label ?? ""} ${attempt.followedUserId ?? ""}`.toLowerCase()
            const marketField =
                `${attempt.marketId ?? ""} ${attempt.assetId ?? ""} ${attempt.marketTitle ?? ""} ${attempt.outcomeLabel ?? ""}`.toLowerCase()
            const reasonField = (attempt.reasonCodes ?? []).join(" ").toLowerCase()
            const matchesUser = !userQuery || userField.includes(userQuery)
            const matchesMarket = !marketQuery || marketField.includes(marketQuery)
            const matchesDecision =
                decisionFilter === "ALL" || attempt.decision === decisionFilter
            const matchesReason = !reasonQuery || reasonField.includes(reasonQuery)
            return matchesUser && matchesMarket && matchesDecision && matchesReason
        })
    }, [attempts, userQuery, marketQuery, decisionFilter, reasonQuery])

    const start = cursorHistory.length * LIMIT + 1
    const end = Math.min(start + (attempts?.length ?? 0) - 1, total)

    const formatCurrency = (value: number) =>
        new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: 2
        }).format(value)

    const formatLag = (ms: number | null) => {
        if (ms === null || Number.isNaN(ms)) return "--"
        if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
        const seconds = ms / 1000
        if (seconds < 60) return `${seconds.toFixed(1)}s`
        const minutes = seconds / 60
        return `${minutes.toFixed(1)}m`
    }

    const getAttemptMeta = (groupKey: string) => {
        const parts = groupKey.split(":")
        if (parts.length < 4) {
            return { side: null, windowStartMs: null }
        }
        const side = parts[2] === "BUY" || parts[2] === "SELL" ? parts[2] : null
        const windowStart = parts.slice(3).join(":")
        const windowStartMs = Date.parse(windowStart)
        return {
            side,
            windowStartMs: Number.isNaN(windowStartMs) ? null : windowStartMs
        }
    }

    return (
        <div className="relative h-screen w-full bg-black text-white overflow-hidden">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex gap-6 p-6 pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-6 min-w-0">
                        <div>
                            <p className="text-sm text-[#6f6f6f]">Copy Attempts</p>
                            <h1 className="text-3xl font-bold text-white">Execution Decisions</h1>
                        </div>

                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4">
                            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
                                <div className="flex flex-col gap-2">
                                    <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                        User
                                    </label>
                                    <input
                                        value={filters.user}
                                        onChange={(event) =>
                                            setFilters((prev) => ({
                                                ...prev,
                                                user: event.target.value
                                            }))
                                        }
                                        placeholder="Wallet or label"
                                        className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white placeholder:text-[#6f6f6f] focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                    />
                                </div>
                                <div className="flex flex-col gap-2">
                                    <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                        Market / Outcome
                                    </label>
                                    <input
                                        value={filters.market}
                                        onChange={(event) =>
                                            setFilters((prev) => ({
                                                ...prev,
                                                market: event.target.value
                                            }))
                                        }
                                        placeholder="Market, outcome, or id"
                                        className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white placeholder:text-[#6f6f6f] focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                    />
                                </div>
                                <div className="flex flex-col gap-2">
                                    <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                        Decision
                                    </label>
                                    <select
                                        value={filters.decision}
                                        onChange={(event) =>
                                            setFilters((prev) => ({
                                                ...prev,
                                                decision: event.target.value
                                            }))
                                        }
                                        className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                    >
                                        <option value="ALL">All</option>
                                        <option value="EXECUTE">Execute</option>
                                        <option value="SKIP">Skip</option>
                                    </select>
                                </div>
                                <div className="flex flex-col gap-2">
                                    <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                        Reason Code
                                    </label>
                                    <input
                                        value={filters.reason}
                                        onChange={(event) =>
                                            setFilters((prev) => ({
                                                ...prev,
                                                reason: event.target.value
                                            }))
                                        }
                                        placeholder="Search reason"
                                        className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white placeholder:text-[#6f6f6f] focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                    />
                                </div>
                            </div>
                        </div>

                        {isLoading ? (
                            <div className="text-gray-400">Loading copy attempts...</div>
                        ) : error ? (
                            <div className="text-red-500">Failed to load copy attempts</div>
                        ) : (
                            <div className="flex flex-col gap-4">
                                <div className="bg-[#0D0D0D] rounded-2xl p-6 overflow-x-auto border border-[#27272A]">
                                    <table className="w-full text-left">
                                        <thead>
                                            <tr className="text-[#6f6f6f] border-b border-[#27272A] text-sm">
                                                <th className="pb-3 px-3">Time</th>
                                                <th className="pb-3 px-3">User</th>
                                                <th className="pb-3 px-3">Scope</th>
                                                <th className="pb-3 px-3">Decision</th>
                                                <th className="pb-3 px-3">Market</th>
                                                <th className="pb-3 px-3 text-right">Target</th>
                                                <th className="pb-3 px-3 text-right">Filled</th>
                                                <th className="pb-3 px-3 text-right">Slippage</th>
                                                <th className="pb-3 px-3 text-right">Copy Lag</th>
                                                <th className="pb-3 px-3">Reasons</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredAttempts.length > 0 ? (
                                                filteredAttempts.map((attempt) => {
                                                    const fillRatio = attempt.filledRatioBps / 100
                                                    const { side, windowStartMs } = getAttemptMeta(
                                                        attempt.groupKey
                                                    )
                                                    const slippageMicros =
                                                        attempt.vwapPriceMicros !== null &&
                                                            attempt.vwapPriceMicros !== undefined
                                                            ? attempt.vwapPriceMicros -
                                                            attempt.theirReferencePriceMicros
                                                            : null
                                                    const slippageCents =
                                                        slippageMicros !== null ? slippageMicros / 10000 : null
                                                    const slippageLabel =
                                                        slippageCents === null
                                                            ? "--"
                                                            : `${slippageCents >= 0 ? "+" : ""}${slippageCents.toFixed(2)}c`
                                                    const slippageIsFavorable =
                                                        slippageMicros !== null && side
                                                            ? side === "BUY"
                                                                ? slippageMicros <= 0
                                                                : slippageMicros >= 0
                                                            : null
                                                    const copyLagMs =
                                                        windowStartMs !== null
                                                            ? new Date(attempt.createdAt).getTime() -
                                                            windowStartMs
                                                            : null
                                                    return (
                                                        <tr
                                                            key={attempt.id}
                                                            className="border-b border-[#1A1A1A] hover:bg-[#1A1A1A] transition-colors last:border-0"
                                                        >
                                                            <td className="py-4 px-3 text-sm text-[#6f6f6f]">
                                                                {new Date(attempt.createdAt).toLocaleString()}
                                                            </td>
                                                            <td className="py-4 px-3 text-sm text-white">
                                                                {attempt.followedUser?.label || "Global"}
                                                            </td>
                                                            <td className="py-4 px-3 text-sm text-white">
                                                                <span className="rounded-full bg-[#1A1A1A] px-2 py-1 text-xs text-[#cfcfcf]">
                                                                    {attempt.portfolioScope === "EXEC_GLOBAL"
                                                                        ? "GLOBAL"
                                                                        : "USER"}
                                                                </span>
                                                            </td>
                                                            <td className="py-4 px-3">
                                                                <span
                                                                    className={`rounded-full px-2 py-1 text-xs font-semibold ${attempt.decision === "EXECUTE"
                                                                        ? "bg-[#102b1a] text-[#86efac]"
                                                                        : "bg-[#2b1212] text-[#f87171]"
                                                                        }`}
                                                                >
                                                                    {attempt.decision}
                                                                </span>
                                                            </td>
                                                            <td className="py-4 px-3 text-sm text-white">
                                                                <div className="font-medium">
                                                                    {attempt.marketTitle ?? attempt.marketId ?? "Unknown"}
                                                                </div>
                                                                <div className="text-xs text-[#6f6f6f] font-mono">
                                                                    {attempt.outcomeLabel ?? attempt.assetId ?? "Asset N/A"}
                                                                </div>
                                                            </td>
                                                            <td className="py-4 px-3 text-right text-sm text-white font-mono">
                                                                {formatCurrency(
                                                                    Number(attempt.targetNotionalMicros) / 1_000_000
                                                                )}
                                                            </td>
                                                            <td className="py-4 px-3 text-right text-sm text-white font-mono">
                                                                {formatCurrency(
                                                                    Number(attempt.filledNotionalMicros) / 1_000_000
                                                                )}{" "}
                                                                <span className="text-xs text-[#6f6f6f]">
                                                                    ({fillRatio.toFixed(1)}%)
                                                                </span>
                                                            </td>
                                                            <td className="py-4 px-3 text-right text-sm font-mono">
                                                                <span
                                                                    className={
                                                                        slippageIsFavorable === null
                                                                            ? "text-white"
                                                                            : slippageIsFavorable
                                                                                ? "text-[#86efac]"
                                                                                : "text-red-400"
                                                                    }
                                                                >
                                                                    {slippageLabel}
                                                                </span>
                                                            </td>
                                                            <td className="py-4 px-3 text-right text-sm text-white font-mono">
                                                                {formatLag(copyLagMs)}
                                                            </td>
                                                            <td className="py-4 px-3 text-sm text-[#cfcfcf]">
                                                                {attempt.reasonCodes.length > 0 ? (
                                                                    <div className="flex flex-wrap gap-2">
                                                                        {attempt.reasonCodes.map((reason) => (
                                                                            <span
                                                                                key={reason}
                                                                                className="rounded-full bg-[#1A1A1A] px-2 py-1 text-[11px] text-[#cfcfcf]"
                                                                            >
                                                                                {reason}
                                                                            </span>
                                                                        ))}
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-[#6f6f6f]">--</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    )
                                                })
                                            ) : (
                                                <tr>
                                                    <td colSpan={10} className="py-8 text-center text-[#6f6f6f]">
                                                        No copy attempts match these filters
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>

                                <div className="flex justify-between items-center bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4">
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => setCursorHistory((prev) => prev.slice(0, -1))}
                                            disabled={cursorHistory.length === 0}
                                            className="px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed bg-[#1A1A1A] text-white hover:bg-[#27272A] transition-colors"
                                        >
                                            Previous
                                        </button>
                                        {cursorHistory.length > 0 && (
                                            <button
                                                onClick={() => setCursorHistory([])}
                                                className="px-4 py-2 text-sm font-medium rounded-lg bg-[#1A1A1A] text-white hover:bg-[#27272A] transition-colors"
                                            >
                                                First Page
                                            </button>
                                        )}
                                    </div>
                                    <span className="text-sm text-[#6f6f6f] font-mono">
                                        {total > 0 ? `${start}-${end} of ${total}` : '0 of 0'}
                                    </span>
                                    <button
                                        onClick={() => {
                                            if (attempts && attempts.length > 0) {
                                                const lastId = attempts[attempts.length - 1].id
                                                setCursorHistory(prev => [...prev, lastId])
                                            }
                                        }}
                                        disabled={!attempts || attempts.length < LIMIT || end >= total}
                                        className="px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed bg-[#1A1A1A] text-white hover:bg-[#27272A] transition-colors"
                                    >
                                        Next
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </main>
            </div>
        </div>
    )
}
