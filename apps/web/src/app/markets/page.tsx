"use client"

import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import useSWR, { useSWRConfig } from "swr"
import { fetcher } from "@/lib/fetcher"
import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import {
    Bar,
    BarChart,
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from "recharts"
import { AlertTriangle, Droplet, Layers, ShieldCheck } from "lucide-react"

interface MarketSummary {
    id: string
    conditionId: string
    active: boolean
    closeTime: string | null
    outcomes: number
    exposure: number
    positions: number
    blacklisted: boolean
}

interface MarketListResponse {
    markets: MarketSummary[]
}

interface MarketDetailResponse {
    market: {
        id: string
        conditionId: string
        active: boolean
        closeTime: string | null
        assets: { id: string; outcome: string }[]
    }
    blacklisted: boolean
    exposure: number
    positions: {
        assetId: string | null
        outcome: string
        shares: number
        invested: number
        markPrice: number | null
        marketValue: number | null
    }[]
    slippageHistory: { ts: number; slippageCents: number }[]
    liquidity: {
        spreadCents: number | null
        depthInBand: number | null
        lastPrice: number | null
    }
}

const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2
    }).format(value)

const formatShortId = (value: string, size = 8) =>
    `${value.slice(0, size)}...${value.slice(-size)}`

const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleDateString() : "--"

export default function MarketsPage() {
    const { mutate } = useSWRConfig()
    const [search, setSearch] = useState("")
    const [statusFilter, setStatusFilter] = useState("ALL")
    const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null)

    const {
        data: listData,
        error,
        isLoading
    } = useSWR<MarketListResponse>("/api/markets?limit=100", fetcher, {
        refreshInterval: 30000
    })

    const detailKey = selectedMarketId ? `/api/markets?marketId=${selectedMarketId}` : null
    const { data: detailData } = useSWR<MarketDetailResponse>(detailKey, fetcher, {
        refreshInterval: 30000
    })

    useEffect(() => {
        if (!selectedMarketId && listData?.markets?.length) {
            setSelectedMarketId(listData.markets[0].id)
        }
    }, [listData, selectedMarketId])

    const filteredMarkets = useMemo(() => {
        if (!listData?.markets) return []
        const query = search.trim().toLowerCase()
        return listData.markets.filter((market) => {
            const matchesQuery =
                !query ||
                market.id.toLowerCase().includes(query) ||
                market.conditionId.toLowerCase().includes(query)
            const matchesStatus =
                statusFilter === "ALL" ||
                (statusFilter === "ACTIVE" && market.active) ||
                (statusFilter === "CLOSED" && !market.active) ||
                (statusFilter === "BLACKLISTED" && market.blacklisted)
            return matchesQuery && matchesStatus
        })
    }, [listData, search, statusFilter])

    const handleBlacklistToggle = async () => {
        if (!detailData) return
        const nextValue = !detailData.blacklisted
        try {
            await fetch("/api/markets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    marketId: detailData.market.id,
                    blacklisted: nextValue
                })
            })
            mutate("/api/markets?limit=100")
            mutate(`/api/markets?marketId=${detailData.market.id}`)
        } catch (toggleError) {
            console.error("Failed to update blacklist:", toggleError)
        }
    }

    return (
        <div className="relative w-full bg-black text-white overflow-hidden min-h-dvh md:h-screen">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex flex-col md:flex-row gap-4 md:gap-6 p-4 md:p-6 pt-20 md:pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-4 md:gap-6 min-w-0">
                        <div>
                            <p className="text-sm text-[#6f6f6f]">Markets</p>
                            <h1 className="text-2xl md:text-3xl font-bold text-white">Liquidity & Exposure</h1>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[1.35fr_1fr] gap-6">
                            <div className="flex flex-col gap-4">
                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div className="flex flex-col gap-2">
                                            <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Search
                                            </label>
                                            <input
                                                value={search}
                                                onChange={(event) => setSearch(event.target.value)}
                                                placeholder="Market id or condition id"
                                                className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white placeholder:text-[#6f6f6f] focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-2">
                                            <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Status
                                            </label>
                                            <select
                                                value={statusFilter}
                                                onChange={(event) => setStatusFilter(event.target.value)}
                                                className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                            >
                                                <option value="ALL">All</option>
                                                <option value="ACTIVE">Active</option>
                                                <option value="CLOSED">Closed</option>
                                                <option value="BLACKLISTED">Blacklisted</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>

                                {isLoading ? (
                                    <div className="text-gray-400">Loading markets...</div>
                                ) : error ? (
                                    <div className="text-red-500">Failed to load markets</div>
                                ) : (
                                    <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-4 md:p-6">
                                        <div className="md:hidden flex flex-col gap-3">
                                            {filteredMarkets.length > 0 ? (
                                                filteredMarkets.map((market) => {
                                                    const isActive = market.id === selectedMarketId
                                                    const statusLabel = market.blacklisted
                                                        ? "Blacklisted"
                                                        : market.active
                                                            ? "Active"
                                                            : "Closed"
                                                    const statusTone = market.blacklisted
                                                        ? "bg-[#2b1212] text-[#f87171]"
                                                        : market.active
                                                            ? "bg-[#102b1a] text-[#86efac]"
                                                            : "bg-[#2a2a2a] text-[#9b9b9b]"

                                                    return (
                                                        <button
                                                            type="button"
                                                            key={market.id}
                                                            onClick={() => setSelectedMarketId(market.id)}
                                                            className={[
                                                                "w-full text-left rounded-2xl border p-4 transition-colors",
                                                                isActive
                                                                    ? "border-[#86efac]/40 bg-[#111111]"
                                                                    : "border-[#27272A] bg-[#111111] hover:bg-[#1A1A1A]",
                                                            ].join(" ")}
                                                        >
                                                            <div className="flex items-start justify-between gap-3">
                                                                <div className="min-w-0">
                                                                    <div className="text-sm font-medium text-white truncate">
                                                                        {market.conditionId || "Market"}
                                                                    </div>
                                                                    <div className="mt-0.5 text-xs text-[#6f6f6f] font-mono truncate">
                                                                        {formatShortId(market.id)}
                                                                    </div>
                                                                </div>
                                                                <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${statusTone}`}>
                                                                    {statusLabel}
                                                                </span>
                                                            </div>

                                                            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                                                                <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                                                    <div className="text-[#6f6f6f] uppercase tracking-wider">
                                                                        Exposure
                                                                    </div>
                                                                    <div className="mt-1 text-white font-mono">
                                                                        {formatCurrency(market.exposure)}
                                                                    </div>
                                                                </div>
                                                                <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3">
                                                                    <div className="text-[#6f6f6f] uppercase tracking-wider">
                                                                        Positions
                                                                    </div>
                                                                    <div className="mt-1 text-white font-mono">
                                                                        {market.positions}
                                                                    </div>
                                                                </div>
                                                                <div className="rounded-xl border border-[#1F1F1F] bg-[#0D0D0D] p-3 col-span-2">
                                                                    <div className="text-[#6f6f6f] uppercase tracking-wider">
                                                                        Close
                                                                    </div>
                                                                    <div className="mt-1 text-[#cfcfcf]">
                                                                        {formatDate(market.closeTime)}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </button>
                                                    )
                                                })
                                            ) : (
                                                <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-6 text-center text-[#6f6f6f]">
                                                    No markets match these filters
                                                </div>
                                            )}
                                        </div>

                                        <div className="hidden md:block overflow-x-auto">
                                            <table className="w-full text-left">
                                                <thead>
                                                    <tr className="text-[#6f6f6f] border-b border-[#27272A] text-sm">
                                                        <th className="pb-3 px-3">Market</th>
                                                        <th className="pb-3 px-3">Status</th>
                                                        <th className="pb-3 px-3 text-right">Exposure</th>
                                                        <th className="pb-3 px-3 text-right">Positions</th>
                                                        <th className="pb-3 px-3 text-right">Close</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredMarkets.length > 0 ? (
                                                        filteredMarkets.map((market) => {
                                                            const isActive = market.id === selectedMarketId
                                                            return (
                                                                <tr
                                                                    key={market.id}
                                                                    onClick={() => setSelectedMarketId(market.id)}
                                                                    className={`border-b border-[#1A1A1A] transition-colors last:border-0 cursor-pointer ${
                                                                        isActive
                                                                            ? "bg-[#1A1A1A]"
                                                                            : "hover:bg-[#1A1A1A]"
                                                                    }`}
                                                                >
                                                                    <td className="py-4 px-3 text-sm text-white">
                                                                        <div className="font-medium">
                                                                            {market.conditionId || "Market"}
                                                                        </div>
                                                                        <div className="text-xs text-[#6f6f6f] font-mono">
                                                                            {formatShortId(market.id)}
                                                                        </div>
                                                                    </td>
                                                                    <td className="py-4 px-3">
                                                                        <span
                                                                            className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                                                                market.blacklisted
                                                                                    ? "bg-[#2b1212] text-[#f87171]"
                                                                                    : market.active
                                                                                      ? "bg-[#102b1a] text-[#86efac]"
                                                                                      : "bg-[#2a2a2a] text-[#9b9b9b]"
                                                                            }`}
                                                                        >
                                                                            {market.blacklisted
                                                                                ? "Blacklisted"
                                                                                : market.active
                                                                                  ? "Active"
                                                                                  : "Closed"}
                                                                        </span>
                                                                    </td>
                                                                    <td className="py-4 px-3 text-right text-sm text-white font-mono">
                                                                        {formatCurrency(market.exposure)}
                                                                    </td>
                                                                    <td className="py-4 px-3 text-right text-sm text-white font-mono">
                                                                        {market.positions}
                                                                    </td>
                                                                    <td className="py-4 px-3 text-right text-sm text-[#6f6f6f]">
                                                                        {formatDate(market.closeTime)}
                                                                    </td>
                                                                </tr>
                                                            )
                                                        })
                                                    ) : (
                                                        <tr>
                                                            <td colSpan={5} className="py-8 text-center text-[#6f6f6f]">
                                                                No markets match these filters
                                                            </td>
                                                        </tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="flex flex-col gap-4">
                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                    {detailData ? (
                                        <div className="flex flex-col gap-4">
                                            <div className="flex flex-wrap items-start justify-between gap-4">
                                                <div>
                                                    <div className="text-sm text-[#6f6f6f]">
                                                        Market Detail
                                                    </div>
                                                    <div className="text-xl font-semibold text-white">
                                                        {detailData.market.conditionId}
                                                    </div>
                                                    <div className="text-xs text-[#6f6f6f] font-mono">
                                                        {detailData.market.id}
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={handleBlacklistToggle}
                                                        className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                                                            detailData.blacklisted
                                                                ? "bg-[#2b1212] text-[#f87171] hover:bg-[#3b1717]"
                                                                : "bg-[#102b1a] text-[#86efac] hover:bg-[#1f2e1d]"
                                                        }`}
                                                    >
                                                        {detailData.blacklisted ? "Remove Blacklist" : "Blacklist Market"}
                                                    </button>
                                                    <Link
                                                        href={`https://polymarket.com/market/${detailData.market.id}`}
                                                        target="_blank"
                                                        className="rounded-full border border-[#27272A] bg-[#111111] px-3 py-1 text-xs text-[#cfcfcf] hover:text-white"
                                                    >
                                                        View Market
                                                    </Link>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-2 gap-4">
                                                <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-4">
                                                    <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                        Exposure
                                                    </div>
                                                    <div className="mt-2 text-2xl font-semibold text-white">
                                                        {formatCurrency(detailData.exposure)}
                                                    </div>
                                                </div>
                                                <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-4">
                                                    <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                        Close Date
                                                    </div>
                                                    <div className="mt-2 text-lg font-semibold text-white">
                                                        {formatDate(detailData.market.closeTime)}
                                                    </div>
                                                </div>
                                                <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-4">
                                                    <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                        Spread
                                                    </div>
                                                    <div className="mt-2 text-lg font-semibold text-white">
                                                        {detailData.liquidity.spreadCents !== null
                                                            ? `${detailData.liquidity.spreadCents.toFixed(2)}c`
                                                            : "--"}
                                                    </div>
                                                </div>
                                                <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-4">
                                                    <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                        Depth in Band
                                                    </div>
                                                    <div className="mt-2 text-lg font-semibold text-white">
                                                        {detailData.liquidity.depthInBand !== null
                                                            ? formatCurrency(detailData.liquidity.depthInBand)
                                                            : "--"}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3 text-xs text-[#6f6f6f]">
                                                <AlertTriangle className="h-4 w-4 text-amber-400" />
                                                Liquidity stats appear when order book snapshots are available.
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="text-sm text-[#6f6f6f]">
                                            Select a market to view details.
                                        </div>
                                    )}
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                    <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                        <Droplet className="h-4 w-4 text-[#86efac]" />
                                        Slippage History
                                    </div>
                                    <div className="mt-4 h-[200px]">
                                        {detailData && detailData.slippageHistory.length > 0 ? (
                                            <ResponsiveContainer width="100%" height="100%">
                                                <LineChart data={detailData.slippageHistory}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" />
                                                    <XAxis
                                                        dataKey="ts"
                                                        tick={{ fill: "#6f6f6f", fontSize: 10 }}
                                                        axisLine={false}
                                                        tickLine={false}
                                                        tickFormatter={(value) =>
                                                            new Date(value as number).toLocaleTimeString(
                                                                "en-US",
                                                                {
                                                                    hour: "2-digit",
                                                                    minute: "2-digit"
                                                                }
                                                            )
                                                        }
                                                    />
                                                    <YAxis
                                                        tick={{ fill: "#6f6f6f" }}
                                                        axisLine={false}
                                                        tickLine={false}
                                                        tickFormatter={(value) => `${value}c`}
                                                    />
                                                    <Tooltip
                                                        content={({ active, payload }) => {
                                                            if (active && payload && payload.length) {
                                                                return (
                                                                    <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                        <div className="text-[#6f6f6f]">
                                                                            {new Date(
                                                                                payload[0].payload.ts
                                                                            ).toLocaleString()}
                                                                        </div>
                                                                        <div className="mt-1 text-[#86efac]">
                                                                            {payload[0].value}c
                                                                        </div>
                                                                    </div>
                                                                )
                                                            }
                                                            return null
                                                        }}
                                                    />
                                                    <Line
                                                        type="monotone"
                                                        dataKey="slippageCents"
                                                        stroke="#86efac"
                                                        strokeWidth={2}
                                                        dot={false}
                                                    />
                                                </LineChart>
                                            </ResponsiveContainer>
                                        ) : (
                                            <div className="h-full flex items-center justify-center text-[#6f6f6f]">
                                                No slippage data yet
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[1.3fr_1fr] gap-6">
                            <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                    <Layers className="h-4 w-4 text-[#86efac]" />
                                    Open Positions
                                </div>
                                <div className="mt-4 overflow-x-auto">
                                    <table className="w-full text-left text-sm">
                                        <thead>
                                            <tr className="text-[#6f6f6f] border-b border-[#27272A]">
                                                <th className="pb-3 px-3">Outcome</th>
                                                <th className="pb-3 px-3 text-right">Shares</th>
                                                <th className="pb-3 px-3 text-right">Mark</th>
                                                <th className="pb-3 px-3 text-right">Value</th>
                                                <th className="pb-3 px-3 text-right">Invested</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {detailData?.positions?.length ? (
                                                detailData.positions.map((position) => (
                                                    <tr
                                                        key={position.assetId ?? position.outcome}
                                                        className="border-b border-[#1A1A1A] last:border-0"
                                                    >
                                                        <td className="py-3 px-3 text-white">
                                                            <div className="font-medium">{position.outcome}</div>
                                                            <div className="text-xs text-[#6f6f6f] font-mono">
                                                                {position.assetId}
                                                            </div>
                                                        </td>
                                                        <td className="py-3 px-3 text-right text-white font-mono">
                                                            {position.shares.toFixed(2)}
                                                        </td>
                                                        <td className="py-3 px-3 text-right text-white font-mono">
                                                            {position.markPrice !== null
                                                                ? position.markPrice.toFixed(3)
                                                                : "--"}
                                                        </td>
                                                        <td className="py-3 px-3 text-right text-white font-mono">
                                                            {formatCurrency(
                                                                position.marketValue ?? position.invested
                                                            )}
                                                        </td>
                                                        <td className="py-3 px-3 text-right text-white font-mono">
                                                            {formatCurrency(position.invested)}
                                                        </td>
                                                    </tr>
                                                ))
                                            ) : (
                                                <tr>
                                                    <td colSpan={5} className="py-6 text-center text-[#6f6f6f]">
                                                        No open positions for this market
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                <div className="flex items-center gap-2 text-sm text-[#6f6f6f]">
                                    <ShieldCheck className="h-4 w-4 text-[#86efac]" />
                                    Outcomes Overview
                                </div>
                                <div className="mt-4 h-[240px]">
                                    {detailData?.positions?.length ? (
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart data={detailData.positions}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" />
                                                <XAxis
                                                    dataKey="outcome"
                                                    tick={{ fill: "#6f6f6f", fontSize: 10 }}
                                                    axisLine={false}
                                                    tickLine={false}
                                                />
                                                <YAxis
                                                    tick={{ fill: "#6f6f6f" }}
                                                    axisLine={false}
                                                    tickLine={false}
                                                    tickFormatter={(value) => `$${value}`}
                                                />
                                                <Tooltip
                                                    content={({ active, payload }) => {
                                                        if (active && payload && payload.length) {
                                                            return (
                                                                <div className="rounded-lg border border-[#27272A] bg-[#0D0D0D] p-3 text-sm text-white shadow-xl">
                                                                    <div className="text-[#6f6f6f]">
                                                                        {payload[0].payload.outcome}
                                                                    </div>
                                                                    <div className="mt-1 text-[#86efac]">
                                                                        {formatCurrency(payload[0].value as number)}
                                                                    </div>
                                                                </div>
                                                            )
                                                        }
                                                        return null
                                                    }}
                                                />
                                                <Bar dataKey="invested" fill="#86efac" radius={[6, 6, 0, 0]} />
                                            </BarChart>
                                        </ResponsiveContainer>
                                    ) : (
                                        <div className="h-full flex items-center justify-center text-[#6f6f6f]">
                                            No exposure data yet
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </main>
            </div>
        </div>
    )
}
