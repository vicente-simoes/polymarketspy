"use client"

import { Trophy, TrendingUp, TrendingDown } from 'lucide-react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'

export function TopPerformers() {
    const { data, error, isLoading } = useSWR('/api/overview', fetcher, { refreshInterval: 10000 })
    const topMarkets = data?.analytics?.topMarkets || []

    if (isLoading) return <div className="h-64 bg-[#0D0D0D] rounded-2xl flex items-center justify-center text-gray-400">Loading top performers...</div>

    // Placeholder mock for top users since API only returns top markets currently (per previous step)
    // We can expand the API later to return top users.
    const topUsers = [
        { label: "HighVolumeTrader", pnl: 450.20, count: 12 },
        { label: "AlphaSeeker", pnl: 120.50, count: 5 },
        { label: "WhaleWatcher", pnl: -45.00, count: 8 }
    ]

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Markets */}
            <div className="bg-[#0D0D0D] rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-4">
                    <Trophy className="h-5 w-5 text-yellow-500" />
                    <h3 className="text-xl font-medium text-white">Top Markets (PnL)</h3>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="text-gray-500 border-b border-gray-800 text-sm">
                                <th className="pb-3 pl-2">Asset ID</th>
                                <th className="pb-3 text-right pr-2">Realized PnL</th>
                            </tr>
                        </thead>
                        <tbody>
                            {topMarkets.length > 0 ? (
                                topMarkets.map((m: any, idx: number) => (
                                    <tr key={idx} className="border-b border-gray-800 hover:bg-[#1A1A1A] transition-colors last:border-0">
                                        <td className="py-3 pl-2 font-mono text-xs text-gray-400 truncate max-w-[150px]">
                                            {m.assetId}
                                        </td>
                                        <td className={`py-3 pr-2 text-right font-medium ${m.pnl >= 0 ? 'text-[#86efac]' : 'text-red-400'}`}>
                                            {m.pnl >= 0 ? '+' : ''}${m.pnl.toFixed(2)}
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={2} className="py-4 text-center text-gray-500 text-sm">No closed positions yet</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Top Users (Mock/Placeholder for now until API expanded) */}
            <div className="bg-[#0D0D0D] rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-4">
                    <TrendingUp className="h-5 w-5 text-blue-500" />
                    <h3 className="text-xl font-medium text-white">Top Users (Simulation)</h3>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="text-gray-500 border-b border-gray-800 text-sm">
                                <th className="pb-3 pl-2">User</th>
                                <th className="pb-3 text-right">Trades</th>
                                <th className="pb-3 text-right pr-2">PnL</th>
                            </tr>
                        </thead>
                        <tbody>
                            {topUsers.map((u: any, idx: number) => (
                                <tr key={idx} className="border-b border-gray-800 hover:bg-[#1A1A1A] transition-colors last:border-0">
                                    <td className="py-3 pl-2 font-medium text-sm text-white">
                                        {u.label}
                                    </td>
                                    <td className="py-3 text-right text-sm text-gray-400">
                                        {u.count}
                                    </td>
                                    <td className={`py-3 pr-2 text-right font-medium ${u.pnl >= 0 ? 'text-[#86efac]' : 'text-red-400'}`}>
                                        {u.pnl >= 0 ? '+' : ''}${u.pnl.toFixed(2)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}
