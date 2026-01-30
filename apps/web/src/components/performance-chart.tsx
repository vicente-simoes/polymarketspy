"use client"

import { Calendar, Download, TrendingUp } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts"
import useSWR from 'swr'
import { fetcher } from '@/lib/fetcher'

import { useState } from 'react'

export function PerformanceChart() {
  const [timeRange, setTimeRange] = useState('1M')
  const { data: apiData, error, isLoading } = useSWR(`/api/overview?range=${timeRange}`, fetcher, { refreshInterval: 10000 })

  const equityCurve = apiData?.equityCurve || []
  const hasData = equityCurve.length > 0

  // Fallback if no data yet (e.g. fresh DB)
  if (isLoading && !hasData) return <div className="h-[260px] sm:h-[320px] lg:h-[400px] flex items-center justify-center text-gray-400 bg-[#0D0D0D] rounded-2xl">Loading chart...</div>

  // Calculate domain for Y axis to look good
  const values = equityCurve.map((d: any) => d.value)
  const minVal = values.length > 0 ? Math.min(...values) * 0.99 : 0
  const maxVal = values.length > 0 ? Math.max(...values) * 1.01 : 100

  const formatXAxis = (tickItem: string) => {
    const date = new Date(tickItem)
    if (timeRange === '1H') {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    if (timeRange === '1D') {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 bg-[#0D0D0D] rounded-2xl">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 md:gap-2 lg:gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-medium text-white">Performance</h2>
          <div className="flex items-center gap-2 px-3 py-1 bg-[#1A1A1A] rounded-full border border-[#333]">
            <div className="w-4 h-4 rounded-full bg-green-600 flex items-center justify-center">
              <TrendingUp className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-medium text-white">Global Equity</span>
          </div>
        </div>

        <div className="flex items-center gap-4 md:gap-2 lg:gap-4">
          <div className="flex items-center bg-[#1A1A1A] rounded-lg p-1 max-w-full overflow-x-auto no-scrollbar">
            {['1H', '1D', '1W', '1M', 'ALL'].map((period) => (
              <button
                key={period}
                onClick={() => setTimeRange(period)}
                className={`px-3 md:px-2 lg:px-3 py-1 text-sm md:text-xs lg:text-sm rounded-md transition-colors shrink-0 ${timeRange === period
                  ? 'bg-[#2A2A2A] text-white shadow-sm'
                  : 'text-gray-400 hover:text-white'
                  }`}
              >
                {period}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button className="p-2 text-gray-400 hover:text-white bg-[#1A1A1A] rounded-lg transition-colors">
              <Calendar className="h-5 w-5" />
            </button>
            <button className="p-2 text-gray-400 hover:text-white bg-[#1A1A1A] rounded-lg transition-colors">
              <Download className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="h-[260px] sm:h-[320px] lg:h-[400px] w-full">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={equityCurve}>
              <defs>
                <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#86efac" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#86efac" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" vertical={false} />
              <XAxis
                dataKey="date"
                hide
              />
              <YAxis
                domain={[minVal, maxVal]}
                orientation="left"
                tick={{ fill: '#666' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(val) => `$${val.toFixed(0)}`}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const dateStr = payload[0].payload.date
                    const date = new Date(dateStr)
                    const formattedDate = timeRange === '1H' || timeRange === '1D'
                      ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                      : date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })

                    return (
                      <div className="bg-[#1A1A1A] border border-[#333] p-2 rounded-lg shadow-xl">
                        <p className="text-white font-medium">
                          {(Number(payload[0].value)).toFixed(2)} USD <span className="text-gray-400 text-sm ml-2">{formattedDate}</span>
                        </p>
                      </div>
                    )
                  }
                  return null
                }}
              />

              <Area
                type="monotone"
                dataKey="value"
                stroke="#86efac"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorPrice)"
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full flex items-center justify-center text-gray-500">
            No performance data yet (wait for snapshots)
          </div>
        )}
      </div>
    </div>
  )
}
