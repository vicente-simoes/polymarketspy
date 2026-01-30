"use client"

import { Header } from "@/components/header"
import { Sidebar } from "@/components/sidebar"
import { fetcher } from "@/lib/fetcher"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"

interface GlobalPortfolioResponse {
    positions: {
        assetId: string | null
        marketId: string | null
        shares: number
        invested: number
        markPrice: number | null
        marketValue: number | null
        marketTitle: string
        outcome: string
    }[]
}

interface CopyAttemptRow {
    id: string
    groupKey: string
    followedUserId?: string | null
    followedUser?: { label?: string | null } | null
    decision: "EXECUTE" | "SKIP"
    reasonCodes: string[]
    sourceType: "IMMEDIATE" | "BUFFER" | "AGGREGATOR"
    bufferedTradeCount: number
    targetNotionalMicros: string | number
    filledNotionalMicros: string | number
    filledRatioBps: number
    createdAt: string
}

const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2
    }).format(value)

const formatSourceType = (
    sourceType: "IMMEDIATE" | "BUFFER" | "AGGREGATOR",
    bufferedTradeCount: number
) => {
    switch (sourceType) {
        case "IMMEDIATE":
            return "Immediate"
        case "BUFFER":
            return `Buffer (${bufferedTradeCount} trade${bufferedTradeCount !== 1 ? "s" : ""})`
        case "AGGREGATOR":
            return "Aggregator"
        default:
            return sourceType
    }
}

const getSourceTypeColor = (sourceType: "IMMEDIATE" | "BUFFER" | "AGGREGATOR") => {
    switch (sourceType) {
        case "IMMEDIATE":
            return "bg-[#1a2b10] text-[#a3e635]"
        case "BUFFER":
            return "bg-[#1a1a2b] text-[#a5b4fc]"
        case "AGGREGATOR":
            return "bg-[#1A1A1A] text-[#cfcfcf]"
        default:
            return "bg-[#1A1A1A] text-[#cfcfcf]"
    }
}

const getAttemptSide = (groupKey: string): "BUY" | "SELL" | null => {
    const parts = groupKey.split(":")
    if (parts.length < 3) return null
    const side = parts[2]
    return side === "BUY" || side === "SELL" ? side : null
}

export default function PositionDetailPage() {
    const params = useParams()
    const assetIdParam = params?.assetId
    const assetId = Array.isArray(assetIdParam) ? assetIdParam[0] : assetIdParam

    const LIMIT = 50
    const [cursorHistory, setCursorHistory] = useState<string[]>([])
    const currentCursor = cursorHistory[cursorHistory.length - 1]

    useEffect(() => {
        setCursorHistory([])
    }, [assetId])

    const {
        data: portfolio,
        error: portfolioError,
        isLoading: portfolioLoading
    } = useSWR<GlobalPortfolioResponse>("/api/portfolio/global", fetcher, {
        refreshInterval: 10000
    })

    const position = useMemo(() => {
        if (!assetId || !portfolio?.positions) return null
        return portfolio.positions.find((p) => p.assetId === assetId) ?? null
    }, [assetId, portfolio?.positions])

    const attemptsUrl = useMemo(() => {
        if (!assetId) return null
        const searchParams = new URLSearchParams({
            limit: String(LIMIT),
            assetId
        })
        if (currentCursor) searchParams.set("cursor", currentCursor)
        return `/api/copy-attempts?${searchParams.toString()}`
    }, [LIMIT, assetId, currentCursor])

    const {
        data: attemptsData,
        error: attemptsError,
        isLoading: attemptsLoading
    } = useSWR<{ items: CopyAttemptRow[]; total: number }>(attemptsUrl, fetcher, {
        refreshInterval: currentCursor ? 0 : 5000,
        keepPreviousData: true
    })

    const attempts = attemptsData?.items ?? []
    const total = attemptsData?.total ?? 0
    const start = cursorHistory.length * LIMIT + 1
    const end = Math.min(start + attempts.length - 1, total)

    return (
        <div className="relative w-full bg-black text-white overflow-hidden min-h-dvh md:h-screen">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex flex-col md:flex-row gap-4 md:gap-6 p-4 md:p-6 pt-20 md:pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-4 md:gap-6 min-w-0">
                        <div className="flex flex-col gap-2">
                            <Link
                                href="/portfolio"
                                className="text-sm text-[#86efac] hover:text-[#4ade80] transition-colors w-fit"
                            >
                                ← Back to Portfolio
                            </Link>
                            <div>
                                <p className="text-sm text-[#6f6f6f]">Position</p>
                                <h1 className="text-2xl md:text-3xl font-bold text-white">Detail</h1>
                            </div>
                        </div>

                        {!assetId ? (
                            <div className="text-red-500">Missing asset id</div>
                        ) : portfolioLoading ? (
                            <div className="text-gray-400">Loading position...</div>
                        ) : portfolioError ? (
                            <div className="text-red-500">Failed to load position</div>
                        ) : (
                            <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                                <div className="flex flex-col gap-1">
                                    <div className="text-lg font-semibold text-white">
                                        {position?.marketTitle ?? "Unknown Market"}
                                    </div>
                                    <div className="text-sm text-[#6f6f6f]">
                                        {position?.outcome ?? "Unknown outcome"}
                                    </div>
                                </div>

                                <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                                    <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Asset Id
                                        </div>
                                        <div className="mt-2 font-mono text-white break-all">
                                            {assetId}
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Market Id
                                        </div>
                                        <div className="mt-2 font-mono text-white break-all">
                                            {position?.marketId ?? "--"}
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Shares
                                        </div>
                                        <div className="mt-2 font-mono text-white">
                                            {position ? position.shares.toFixed(2) : "--"}
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Mark
                                        </div>
                                        <div className="mt-2 font-mono text-white">
                                            {position?.markPrice !== null && position?.markPrice !== undefined
                                                ? position.markPrice.toFixed(3)
                                                : "--"}
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Value
                                        </div>
                                        <div className="mt-2 font-mono text-white">
                                            {position
                                                ? formatCurrency(position.marketValue ?? position.invested)
                                                : "--"}
                                        </div>
                                    </div>
                                    <div className="rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Invested
                                        </div>
                                        <div className="mt-2 font-mono text-white">
                                            {position ? formatCurrency(position.invested) : "--"}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                            <div className="text-sm text-[#6f6f6f]">Copy Attempts</div>
                            <div className="mt-1 text-xs text-[#6f6f6f]">
                                Newest first. Shows both executed and skipped attempts for this position.
                            </div>

                            {attemptsLoading ? (
                                <div className="mt-4 text-gray-400">Loading copy attempts...</div>
                            ) : attemptsError ? (
                                <div className="mt-4 text-red-500">Failed to load copy attempts</div>
                            ) : (
                                <div className="mt-4 flex flex-col gap-4">
                                    <div className="md:hidden flex flex-col gap-3">
                                        {attempts.length > 0 ? (
                                            attempts.map((attempt) => {
                                                const fillRatio = attempt.filledRatioBps / 100
                                                const side = getAttemptSide(attempt.groupKey)
                                                return (
                                                    <div
                                                        key={attempt.id}
                                                        className="rounded-2xl border border-[#27272A] bg-[#111111] p-4"
                                                    >
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="min-w-0">
                                                                <div className="text-sm font-medium text-white truncate">
                                                                    {attempt.followedUser?.label ||
                                                                        attempt.followedUserId ||
                                                                        "Unknown"}
                                                                </div>
                                                                <div className="mt-0.5 text-xs text-[#6f6f6f]">
                                                                    {new Date(attempt.createdAt).toLocaleString()}
                                                                </div>
                                                            </div>
                                                            <span
                                                                className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${
                                                                    attempt.decision === "EXECUTE"
                                                                        ? "bg-[#102b1a] text-[#86efac]"
                                                                        : "bg-[#2b1212] text-[#f87171]"
                                                                }`}
                                                            >
                                                                {attempt.decision}
                                                            </span>
                                                        </div>

                                                        <div className="mt-3 flex items-center justify-between gap-3">
                                                            <span className="text-xs text-[#cfcfcf]">
                                                                Side:{" "}
                                                                <span className="font-mono text-white">
                                                                    {side ?? "--"}
                                                                </span>
                                                            </span>
                                                            <span
                                                                className={`rounded-full px-2 py-1 text-xs font-medium ${getSourceTypeColor(
                                                                    attempt.sourceType
                                                                )}`}
                                                            >
                                                                {formatSourceType(
                                                                    attempt.sourceType,
                                                                    attempt.bufferedTradeCount
                                                                )}
                                                            </span>
                                                        </div>

                                                        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                                                            <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                                                <div className="text-[#6f6f6f] uppercase tracking-wider">
                                                                    Target
                                                                </div>
                                                                <div className="mt-1 text-white font-mono">
                                                                    {formatCurrency(
                                                                        Number(attempt.targetNotionalMicros) /
                                                                            1_000_000
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                                                <div className="text-[#6f6f6f] uppercase tracking-wider">
                                                                    Filled
                                                                </div>
                                                                <div className="mt-1 text-white font-mono">
                                                                    {formatCurrency(
                                                                        Number(attempt.filledNotionalMicros) /
                                                                            1_000_000
                                                                    )}{" "}
                                                                    <span className="text-[#6f6f6f]">
                                                                        ({fillRatio.toFixed(1)}%)
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {attempt.reasonCodes.length > 0 ? (
                                                            <div className="mt-3 flex flex-wrap gap-2">
                                                                {attempt.reasonCodes.slice(0, 6).map((reason) => (
                                                                    <span
                                                                        key={reason}
                                                                        className="rounded-full bg-[#1A1A1A] px-2 py-1 text-[11px] text-[#cfcfcf]"
                                                                    >
                                                                        {reason}
                                                                    </span>
                                                                ))}
                                                                {attempt.reasonCodes.length > 6 ? (
                                                                    <span className="rounded-full bg-[#1A1A1A] px-2 py-1 text-[11px] text-[#6f6f6f]">
                                                                        +{attempt.reasonCodes.length - 6} more
                                                                    </span>
                                                                ) : null}
                                                            </div>
                                                        ) : (
                                                            <div className="mt-3 text-xs text-[#6f6f6f]">
                                                                No reasons
                                                            </div>
                                                        )}
                                                    </div>
                                                )
                                            })
                                        ) : (
                                            <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-6 text-center text-[#6f6f6f]">
                                                No attempts yet
                                            </div>
                                        )}
                                    </div>

                                    <div className="hidden md:block overflow-x-auto">
                                        <table className="w-full text-left text-sm">
                                            <thead>
                                                <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                    <th className="pb-3 px-3">Time</th>
                                                    <th className="pb-3 px-3">Side</th>
                                                    <th className="pb-3 px-3">User</th>
                                                    <th className="pb-3 px-3">Decision</th>
                                                    <th className="pb-3 px-3">Source</th>
                                                    <th className="pb-3 px-3 text-right">Target</th>
                                                    <th className="pb-3 px-3 text-right">Filled</th>
                                                    <th className="pb-3 px-3">Reasons</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {attempts.length > 0 ? (
                                                    attempts.map((attempt) => {
                                                        const fillRatio = attempt.filledRatioBps / 100
                                                        const side = getAttemptSide(attempt.groupKey)
                                                        return (
                                                            <tr
                                                                key={attempt.id}
                                                                className="border-b border-[#1A1A1A] last:border-0"
                                                            >
                                                                <td className="py-4 px-3 text-[#6f6f6f] font-mono">
                                                                    {new Date(attempt.createdAt).toLocaleString()}
                                                                </td>
                                                                <td className="py-4 px-3 text-white font-mono">
                                                                    {side ?? "--"}
                                                                </td>
                                                                <td className="py-4 px-3 text-white">
                                                                    {attempt.followedUser?.label ||
                                                                        attempt.followedUserId ||
                                                                        "Unknown"}
                                                                </td>
                                                                <td className="py-4 px-3">
                                                                    <span
                                                                        className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                                                            attempt.decision === "EXECUTE"
                                                                                ? "bg-[#102b1a] text-[#86efac]"
                                                                                : "bg-[#2b1212] text-[#f87171]"
                                                                        }`}
                                                                    >
                                                                        {attempt.decision}
                                                                    </span>
                                                                </td>
                                                                <td className="py-4 px-3">
                                                                    <span
                                                                        className={`rounded-full px-2 py-1 text-xs font-medium ${getSourceTypeColor(
                                                                            attempt.sourceType
                                                                        )}`}
                                                                    >
                                                                        {formatSourceType(
                                                                            attempt.sourceType,
                                                                            attempt.bufferedTradeCount
                                                                        )}
                                                                    </span>
                                                                </td>
                                                                <td className="py-4 px-3 text-right text-white font-mono">
                                                                    {formatCurrency(
                                                                        Number(attempt.targetNotionalMicros) /
                                                                            1_000_000
                                                                    )}
                                                                </td>
                                                                <td className="py-4 px-3 text-right text-white font-mono">
                                                                    {formatCurrency(
                                                                        Number(attempt.filledNotionalMicros) /
                                                                            1_000_000
                                                                    )}{" "}
                                                                    <span className="text-xs text-[#6f6f6f]">
                                                                        ({fillRatio.toFixed(1)}%)
                                                                    </span>
                                                                </td>
                                                                <td className="py-4 px-3 text-[#cfcfcf]">
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
                                                        <td
                                                            colSpan={8}
                                                            className="py-6 text-center text-[#6f6f6f]"
                                                        >
                                                            No copy attempts yet
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>

                                    <div className="flex justify-between items-center rounded-xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() =>
                                                    setCursorHistory((prev) => prev.slice(0, -1))
                                                }
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
                                            {total > 0 ? `${start}-${end} of ${total}` : "0 of 0"}
                                        </span>
                                        <button
                                            onClick={() => {
                                                if (attempts.length > 0) {
                                                    const lastId = attempts[attempts.length - 1].id
                                                    setCursorHistory((prev) => [...prev, lastId])
                                                }
                                            }}
                                            disabled={attempts.length < LIMIT || end >= total}
                                            className="px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed bg-[#1A1A1A] text-white hover:bg-[#27272A] transition-colors"
                                        >
                                            Next
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </main>
            </div>
        </div>
    )
}
