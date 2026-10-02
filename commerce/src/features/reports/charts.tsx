import type { ReactNode } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { EmptyState } from '@/components/common/states'
import { formatMoney, formatNumber, formatShortDate } from '@/lib/format'

// Categorical slots in their validated order. A series keeps its slot no
// matter which other series are visible.
export const SERIES_COLORS = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`)

export type ValueFormat = 'money' | 'number' | 'percent'

export function formatValue(value: unknown, format: ValueFormat): string {
  if (format === 'money') return formatMoney(value)
  if (format === 'percent') return `${formatNumber(value, 1)}%`
  return formatNumber(value)
}

function compact(value: number, format: ValueFormat): string {
  const abs = Math.abs(value)
  const short = abs >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : abs >= 1_000 ? `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k` : `${Math.round(value)}`
  return format === 'percent' ? `${short}%` : short
}

export interface Series {
  key: string
  label: string
  /** 1-based categorical slot. */
  slot: number
}

function ChartTooltip({ active, payload, label, format, labelFormat }: {
  active?: boolean
  payload?: Array<{ dataKey: string; name: string; value: number; color: string }>
  label?: string
  format: ValueFormat
  labelFormat?: (label: string) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-foreground">{labelFormat ? labelFormat(String(label)) : label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="size-2.5 rounded-sm" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">{formatValue(p.value, format)}</span>
        </div>
      ))}
    </div>
  )
}

const axisProps = {
  tick: { fill: 'var(--muted-foreground)', fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const

function Frame({ height, empty, children }: { height: number; empty: boolean; children: ReactNode }) {
  if (empty) return <EmptyState title="No data for this period" className="py-10" />
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer>
    </div>
  )
}

/** Change over time. One y-axis; ≥2 series get a legend. */
export function TrendChart({
  data, xKey, series, format = 'number', height = 260, area = false, dateAxis = true,
}: {
  data: object[]
  xKey: string
  series: Series[]
  format?: ValueFormat
  height?: number
  area?: boolean
  dateAxis?: boolean
}) {
  const xFormat = (v: string) => (dateAxis ? formatShortDate(v) : v)
  const common = (
    <>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
      <XAxis dataKey={xKey} {...axisProps} tickFormatter={xFormat} minTickGap={24} />
      <YAxis {...axisProps} width={48} tickFormatter={(v: number) => compact(v, format)} />
      <Tooltip content={<ChartTooltip format={format} labelFormat={xFormat} />} cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }} />
      {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }} />}
    </>
  )
  return (
    <Frame height={height} empty={data.length === 0}>
      {area ? (
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {common}
          {series.map((s) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SERIES_COLORS[s.slot - 1]}
              fill={SERIES_COLORS[s.slot - 1]} fillOpacity={0.12} strokeWidth={2} activeDot={{ r: 4 }} />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {common}
          {series.map((s) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SERIES_COLORS[s.slot - 1]}
              strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          ))}
        </LineChart>
      )}
    </Frame>
  )
}

/** Magnitude by period or category. */
export function BarsChart({
  data, xKey, series, format = 'number', height = 260, stacked = false, dateAxis = false, horizontal = false,
}: {
  data: object[]
  xKey: string
  series: Series[]
  format?: ValueFormat
  height?: number
  stacked?: boolean
  dateAxis?: boolean
  horizontal?: boolean
}) {
  const xFormat = (v: string) => (dateAxis ? formatShortDate(v) : v)
  return (
    <Frame height={height} empty={data.length === 0}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
        <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="var(--chart-grid)" />
        {horizontal ? (
          <>
            <XAxis type="number" {...axisProps} tickFormatter={(v: number) => compact(v, format)} />
            <YAxis type="category" dataKey={xKey} {...axisProps} width={110} />
          </>
        ) : (
          <>
            <XAxis dataKey={xKey} {...axisProps} tickFormatter={xFormat} minTickGap={16} />
            <YAxis {...axisProps} width={48} tickFormatter={(v: number) => compact(v, format)} />
          </>
        )}
        <Tooltip content={<ChartTooltip format={format} labelFormat={xFormat} />} cursor={{ fill: 'var(--muted)', opacity: 0.6 }} />
        {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }} />}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES_COLORS[s.slot - 1]} stackId={stacked ? 'a' : undefined}
            stroke="var(--card)" strokeWidth={stacked ? 1 : 0} maxBarSize={36}
            radius={stacked && i < series.length - 1 ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} />
        ))}
      </BarChart>
    </Frame>
  )
}

/** Share of a whole as a compact ranked bar list (clearer than a pie). */
export function ShareList({ items, format = 'number' }: { items: Array<{ label: string; value: number }>; format?: ValueFormat }) {
  const total = items.reduce((s, i) => s + i.value, 0)
  if (!total) return <EmptyState title="No data for this period" className="py-8" />
  const sorted = [...items].sort((a, b) => b.value - a.value)
  return (
    <ul className="space-y-2.5">
      {sorted.map((item) => (
        <li key={item.label} className="text-sm">
          <div className="mb-1 flex justify-between gap-2">
            <span className="truncate">{item.label}</span>
            <span className="tabular-nums text-muted-foreground">{formatValue(item.value, format)} · {formatNumber((item.value / total) * 100, 0)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${(item.value / total) * 100}%`, background: SERIES_COLORS[0] }} />
          </div>
        </li>
      ))}
    </ul>
  )
}
