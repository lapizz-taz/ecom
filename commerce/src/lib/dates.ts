// Date range helpers for reports and dashboards (local calendar dates).

export interface DateRange {
  from: string
  to: string
}

export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + days)
  return copy
}

export const RANGE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'year', label: 'This year' },
] as const

export type RangePreset = (typeof RANGE_PRESETS)[number]['key']

export function rangeFor(preset: RangePreset, now = new Date()): DateRange {
  const today = isoDate(now)
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: isoDate(addDays(now, -6)), to: today }
    case '30d':
      return { from: isoDate(addDays(now, -29)), to: today }
    case '90d':
      return { from: isoDate(addDays(now, -89)), to: today }
    case 'month':
      return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
    case 'last_month':
      return {
        from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)),
      }
    case 'year':
      return { from: isoDate(new Date(now.getFullYear(), 0, 1)), to: today }
  }
}

export function granularityFor(range: DateRange): 'day' | 'week' | 'month' {
  const days = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000
  if (days <= 45) return 'day'
  if (days <= 200) return 'week'
  return 'month'
}

/** The equally long period that ends the day before `range` starts (for comparisons). */
export function previousPeriod(range: DateRange): DateRange {
  const from = new Date(`${range.from}T00:00:00`)
  const to = new Date(`${range.to}T00:00:00`)
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
  const prevTo = addDays(from, -1)
  return { from: isoDate(addDays(prevTo, -(days - 1))), to: isoDate(prevTo) }
}
