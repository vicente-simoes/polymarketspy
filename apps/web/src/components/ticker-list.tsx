"use client"

import { ChevronsUpDown } from 'lucide-react'
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'

export function GlobalPositions() {
  const { data, error, isLoading } = useSWR('/api/portfolio/global', fetcher, { refreshInterval: 10000 })
  const positions = data?.positions || []

  if (isLoading) return <div className="bg-[#0D0D0D] rounded-2xl p-4 md:p-6 text-gray-400">Loading positions...</div>
  if (error) return <div className="bg-[#0D0D0D] rounded-2xl p-4 md:p-6 text-red-500">Failed to load positions</div>

  if (positions.length === 0) {
    return (
      <div className="bg-[#0D0D0D] rounded-2xl p-4 md:p-6 text-gray-500 text-center">
        No open positions
      </div>
    )
  }

  return (
    <div className="bg-[#0D0D0D] rounded-2xl p-4 md:p-6">
      <h3 className="text-lg md:text-xl font-medium text-white mb-4">Global Positions</h3>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-[#919191] text-sm border-b border-transparent">
              <th className="pb-4 text-left font-medium pl-2">
                <div className="flex items-center gap-1">
                  Market / Outcome
                  <ChevronsUpDown className="h-4 w-4" />
                </div>
              </th>
              <th className="pb-4 text-right font-medium">Shares</th>
              <th className="pb-4 text-right font-medium">Invested (Approx)</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((item: any) => (
              <tr
                key={item.assetId}
                className="group transition-colors border-b border-transparent hover:bg-[#1A1A1A]"
              >
                <td className="py-4 pl-2 rounded-l-xl">
                  <div className="flex flex-col">
                    <span className="font-bold text-white text-sm">{item.marketTitle}</span>
                    <span className="text-gray-400 text-xs">{item.outcome}</span>
                  </div>
                </td>
                <td className="py-4 text-right text-white font-medium">
                  {Number(item.shares).toLocaleString()}
                </td>
                <td className="py-4 text-right text-white font-medium pr-2 rounded-r-xl">
                  ${Number(item.invested).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
