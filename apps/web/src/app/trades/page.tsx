"use client"

import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { useMemo, useState } from "react"

interface TradeRow {
    id: string
    source: string
    profileWallet: string
    proxyWallet?: string | null
    userLabel?: string | null
    marketId?: string | null
    assetId?: string | null
    rawTokenId?: string | null
    enrichmentStatus?: "PENDING" | "ENRICHED" | "FAILED"
    side: "BUY" | "SELL"
    priceMicros: number
    shareMicros: string | number
    notionalMicros: string | number
    eventTime: string
    detectTime: string
}

/**
 * Format source display with enrichment status.
 * WS-first architecture: on-chain events show enrichment status.
 */
function formatSourceBadge(trade: TradeRow): { label: string; className: string } {
    const { source, enrichmentStatus } = trade

    if (source === "ONCHAIN_WS") {
        if (enrichmentStatus === "PENDING") {
            return {
                label: "On-chain ⏳",
                className: "bg-[#2b2612] text-[#fbbf24]" // Yellow/amber for pending
            }
        }
        if (enrichmentStatus === "FAILED") {
            return {
                label: "On-chain ⚠️",
                className: "bg-[#2b1212] text-[#f87171]" // Red for failed
            }
        }
        // ENRICHED or undefined (old records)
        return {
            label: "On-chain",
            className: "bg-[#102b1a] text-[#86efac]" // Green for on-chain
        }
    }

    if (source === "POLYMARKET_API") {
        return {
            label: "API",
            className: "bg-[#1A1A1A] text-[#cfcfcf]" // Gray for API
        }
    }

    // Fallback for any other source
    return {
        label: source,
        className: "bg-[#1A1A1A] text-[#cfcfcf]"
    }
}

/**
 * Format market/asset display with fallback for pending enrichment.
 */
function formatMarketDisplay(trade: TradeRow): { market: string; asset: string } {
    const { marketId, assetId, rawTokenId, enrichmentStatus } = trade

    // If we have market data, use it
    if (marketId) {
        return {
            market: marketId,
            asset: assetId ?? rawTokenId ?? "N/A"
        }
    }

    // WS-first trade without enrichment yet
    if (rawTokenId) {
        const truncatedToken = rawTokenId.length > 12
            ? `${rawTokenId.slice(0, 6)}...${rawTokenId.slice(-4)}`
            : rawTokenId

        if (enrichmentStatus === "PENDING") {
            return {
                market: "Enriching...",
                asset: `Token: ${truncatedToken}`
            }
        }
        if (enrichmentStatus === "FAILED") {
            return {
                market: "Unknown Market",
                asset: `Token: ${truncatedToken}`
            }
        }
    }

    return {
        market: "Unknown",
        asset: assetId ?? rawTokenId ?? "N/A"
    }
}

export default function TradesPage() {
    const [filters, setFilters] = useState({
        user: "",
        market: ""
    })

    const [cursorHistory, setCursorHistory] = useState<string[]>([])
    const currentCursor = cursorHistory[cursorHistory.length - 1]
    const LIMIT = 50

    const {
        data,
        error: tradesError,
        isLoading: tradesLoading
    } = useSWR<{ items: TradeRow[], total: number }>(
        `/api/trades?limit=${LIMIT}${currentCursor ? `&cursor=${currentCursor}` : ""}`,
        fetcher,
        { refreshInterval: currentCursor ? 0 : 5000 }
    )

    const trades = data?.items
    const total = data?.total ?? 0

    const userQuery = filters.user.trim().toLowerCase()
    const marketQuery = filters.market.trim().toLowerCase()

    const filteredTrades = useMemo(() => {
        if (!trades || !Array.isArray(trades)) return []
        return trades.filter((trade) => {
            const userField = `${trade.userLabel ?? ""} ${trade.profileWallet ?? ""} ${trade.proxyWallet ?? ""}`.toLowerCase()
            // Include rawTokenId in market search for WS-first trades
            const marketField = `${trade.marketId ?? ""} ${trade.assetId ?? ""} ${trade.rawTokenId ?? ""}`.toLowerCase()
            const matchesUser = !userQuery || userField.includes(userQuery)
            const matchesMarket = !marketQuery || marketField.includes(marketQuery)
            return matchesUser && matchesMarket
        })
    }, [trades, userQuery, marketQuery])

    const start = cursorHistory.length * LIMIT + 1
    const end = Math.min(start + (trades?.length ?? 0) - 1, total)

    const formatCurrency = (value: number) =>
        new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: 2
        }).format(value)

    const formatWallet = (wallet: string) =>
        `${wallet.substring(0, 6)}...${wallet.substring(wallet.length - 4)}`

    const formatLag = (ms: number | null) => {
        if (ms === null || Number.isNaN(ms)) return "--"
        if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
        const seconds = ms / 1000
        if (seconds < 60) return `${seconds.toFixed(1)}s`
        const minutes = seconds / 60
        return `${minutes.toFixed(1)}m`
    }

    return (
        <div className="relative h-screen w-full bg-black text-white overflow-hidden">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex gap-6 p-6 pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-6 min-w-0">
                        <div>
                            <p className="text-sm text-[#6f6f6f]">Trades</p>
                            <h1 className="text-3xl font-bold text-white">Detected Trades</h1>
                        </div>

                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4">
                            <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
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
                                        Market / Asset
                                    </label>
                                    <input
                                        value={filters.market}
                                        onChange={(event) =>
                                            setFilters((prev) => ({
                                                ...prev,
                                                market: event.target.value
                                            }))
                                        }
                                        placeholder="Market or asset id"
                                        className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white placeholder:text-[#6f6f6f] focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                    />
                                </div>
                            </div>
                        </div>

                        {tradesLoading ? (
                            <div className="text-gray-400">Loading trades...</div>
                        ) : tradesError ? (
                            <div className="text-red-500">Failed to load trades</div>
                        ) : (
                            <div className="flex flex-col gap-4">
                                <div className="bg-[#0D0D0D] rounded-2xl p-6 overflow-x-auto border border-[#27272A]">
                                    <table className="w-full text-left">
                                        <thead>
                                            <tr className="text-[#6f6f6f] border-b border-[#27272A] text-sm">
                                                <th className="pb-3 px-3">Time</th>
                                                <th className="pb-3 px-3">Detect Lag</th>
                                                <th className="pb-3 px-3">User</th>
                                                <th className="pb-3 px-3">Market</th>
                                                <th className="pb-3 px-3">Side</th>
                                                <th className="pb-3 px-3 text-right">Shares</th>
                                                <th className="pb-3 px-3 text-right">Price</th>
                                                <th className="pb-3 px-3 text-right">Notional</th>
                                                <th className="pb-3 px-3 text-right">Source</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredTrades.length > 0 ? (
                                                filteredTrades.map((trade) => (
                                                    <tr
                                                        key={trade.id}
                                                        className="border-b border-[#1A1A1A] hover:bg-[#1A1A1A] transition-colors last:border-0"
                                                    >
                                                        <td className="py-4 px-3 text-sm text-[#6f6f6f]">
                                                            {new Date(trade.eventTime).toLocaleString()}
                                                        </td>
                                                        <td className="py-4 px-3 text-sm text-[#cfcfcf]">
                                                            {formatLag(
                                                                new Date(trade.detectTime).getTime() -
                                                                new Date(trade.eventTime).getTime()
                                                            )}
                                                        </td>
                                                        <td className="py-4 px-3 text-sm font-mono text-white">
                                                            {trade.userLabel ?? formatWallet(trade.profileWallet)}
                                                        </td>
                                                        <td className="py-4 px-3 text-sm text-white">
                                                            {(() => {
                                                                const { market, asset } = formatMarketDisplay(trade)
                                                                const isPending = trade.enrichmentStatus === "PENDING"
                                                                return (
                                                                    <>
                                                                        <div className={`font-medium ${isPending ? "text-[#6f6f6f] italic" : ""}`}>
                                                                            {market}
                                                                        </div>
                                                                        <div className="text-xs text-[#6f6f6f] font-mono">
                                                                            {asset}
                                                                        </div>
                                                                    </>
                                                                )
                                                            })()}
                                                        </td>
                                                        <td className="py-4 px-3">
                                                            <span
                                                                className={`rounded-full px-2 py-1 text-xs font-semibold ${trade.side === "BUY"
                                                                    ? "bg-[#102b1a] text-[#86efac]"
                                                                    : "bg-[#2b1212] text-[#f87171]"
                                                                    }`}
                                                            >
                                                                {trade.side}
                                                            </span>
                                                        </td>
                                                        <td className="py-4 px-3 text-right text-sm text-white font-mono">
                                                            {(Number(trade.shareMicros) / 1_000_000).toFixed(2)}
                                                        </td>
                                                        <td className="py-4 px-3 text-right text-sm text-white font-mono">
                                                            {(trade.priceMicros / 1_000_000).toFixed(3)}
                                                        </td>
                                                        <td className="py-4 px-3 text-right text-sm text-white font-mono">
                                                            {formatCurrency(
                                                                Number(trade.notionalMicros) / 1_000_000
                                                            )}
                                                        </td>
                                                        <td className="py-4 px-3 text-right text-sm text-white">
                                                            {(() => {
                                                                const { label, className } = formatSourceBadge(trade)
                                                                return (
                                                                    <span className={`rounded-full px-2 py-1 text-xs ${className}`}>
                                                                        {label}
                                                                    </span>
                                                                )
                                                            })()}
                                                        </td>
                                                    </tr>
                                                ))
                                            ) : (
                                                <tr>
                                                    <td colSpan={9} className="py-8 text-center text-[#6f6f6f]">
                                                        No trades match these filters
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>

                                <div className="flex justify-between items-center bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4">
                                    <button
                                        onClick={() => setCursorHistory(prev => prev.slice(0, -1))}
                                        disabled={cursorHistory.length === 0}
                                        className="px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed bg-[#1A1A1A] text-white hover:bg-[#27272A] transition-colors"
                                    >
                                        Previous
                                    </button>
                                    <span className="text-sm text-[#6f6f6f] font-mono">
                                        {total > 0 ? `${start}-${end} of ${total}` : '0 of 0'}
                                    </span>
                                    <button
                                        onClick={() => {
                                            if (trades && trades.length > 0) {
                                                const lastId = trades[trades.length - 1].id
                                                setCursorHistory(prev => [...prev, lastId])
                                            }
                                        }}
                                        disabled={!trades || trades.length < LIMIT || end >= total}
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
