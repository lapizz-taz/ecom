import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isoDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

// A month calendar like the reference design: month and year dropdowns, a
// Sunday-first grid, the chosen day in a filled circle. Dates are local
// calendar dates as 'YYYY-MM-DD' strings, the same as <input type="date">.

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/** 'YYYY-MM-DD' → a local Date at midnight (null for anything else). */
export function parseIso(value: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '')
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** "January 15, 2025" */
export function formatLong(value: string | null | undefined): string {
  const d = parseIso(value)
  return d ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : ''
}

/** "Jan 15, 2025", or "Jan 15" when `year` is false. */
export function formatShort(value: string | null | undefined, year = true): string {
  const d = parseIso(value)
  return d ? `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}${year ? `, ${d.getFullYear()}` : ''}` : ''
}

/** "Jan 1 – Jan 15, 2025" (the year once when both ends share it). */
export function formatRange(from: string | null | undefined, to: string | null | undefined): string {
  if (!from) return ''
  if (!to || to === from) return formatShort(from)
  const sameYear = from.slice(0, 4) === to.slice(0, 4)
  return `${formatShort(from, !sameYear)} – ${formatShort(to)}`
}

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

export interface CalendarProps {
  /** The chosen day (single mode) or the start of the range. */
  selected?: string | null
  /** The end of the range; with `selected` it shades the days between. */
  rangeEnd?: string | null
  onSelect: (iso: string) => void
  min?: string
  max?: string
  /** The month to show first; defaults to the selected day's month, else today's. */
  defaultMonth?: string | null
  className?: string
}

export function Calendar({ selected, rangeEnd, onSelect, min, max, defaultMonth, className }: CalendarProps) {
  const today = isoDate(new Date())
  const initial = parseIso(defaultMonth) ?? parseIso(selected) ?? parseIso(max && max < today ? max : today) ?? new Date()
  const [month, setMonth] = useState(() => startOfMonth(initial))
  const [focus, setFocus] = useState(() => isoDate(parseIso(selected) ?? initial))
  const grid = useRef<HTMLDivElement>(null)
  const moved = useRef(false)

  // Show the month of a newly chosen preset or typed value.
  useEffect(() => {
    const d = parseIso(defaultMonth)
    if (d) setMonth(startOfMonth(d))
  }, [defaultMonth])

  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus()
  }, [focus, month])

  const days = useMemo(() => {
    const first = addDays(month, -month.getDay())
    return Array.from({ length: 42 }, (_, i) => addDays(first, i))
  }, [month])

  const year = month.getFullYear()
  // One day in the grid takes Tab focus: the focused day, else the 1st.
  const tabbable = days.some((d) => isoDate(d) === focus) ? focus : isoDate(month)
  const minYear = Math.min(parseIso(min)?.getFullYear() ?? year - 10, year)
  const maxYear = Math.max(parseIso(max)?.getFullYear() ?? new Date().getFullYear() + 5, year)
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i)
  const blocked = (iso: string) => (!!min && iso < min) || (!!max && iso > max)
  const lo = selected && rangeEnd ? (selected < rangeEnd ? selected : rangeEnd) : null
  const hi = selected && rangeEnd ? (selected < rangeEnd ? rangeEnd : selected) : null

  const go = (iso: string) => {
    const d = parseIso(iso)!
    moved.current = true
    setFocus(iso)
    if (d.getMonth() !== month.getMonth() || d.getFullYear() !== year) setMonth(startOfMonth(d))
  }
  const onKey = (e: React.KeyboardEvent) => {
    const d = parseIso(tabbable)
    if (!d) return
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    if (e.key in step) { e.preventDefault(); go(isoDate(addDays(d, step[e.key]))) }
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      go(isoDate(new Date(d.getFullYear(), d.getMonth() + (e.key === 'PageUp' ? -1 : 1), Math.min(d.getDate(), 28))))
    } else if (e.key === 'Home') { e.preventDefault(); go(isoDate(addDays(d, -d.getDay()))) }
    else if (e.key === 'End') { e.preventDefault(); go(isoDate(addDays(d, 6 - d.getDay()))) }
  }

  return (
    <div className={cn('w-[19.5rem] max-w-full select-none', className)}>
      <div className="flex items-center gap-2">
        <Select value={String(month.getMonth())} onValueChange={(v) => setMonth(new Date(year, Number(v), 1))}>
          <SelectTrigger size="sm" className="flex-1 border-transparent bg-muted/70 font-medium shadow-none hover:border-transparent hover:bg-muted" aria-label="Month"><SelectValue /></SelectTrigger>
          <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i)}>{m}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={String(year)} onValueChange={(v) => setMonth(new Date(Number(v), month.getMonth(), 1))}>
          <SelectTrigger size="sm" className="w-[5.5rem] border-transparent bg-muted/70 font-medium shadow-none hover:border-transparent hover:bg-muted" aria-label="Year"><SelectValue /></SelectTrigger>
          <SelectContent className="max-h-64">{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex">
          <button type="button" aria-label="Previous month" onClick={() => setMonth(new Date(year, month.getMonth() - 1, 1))}
            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronLeft className="size-4" /></button>
          <button type="button" aria-label="Next month" onClick={() => setMonth(new Date(year, month.getMonth() + 1, 1))}
            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronRight className="size-4" /></button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-7 text-center text-[11px] font-medium tracking-wide text-muted-foreground" aria-hidden>
        {WEEKDAYS.map((w) => <span key={w} className="py-1.5">{w}</span>)}
      </div>
      <div ref={grid} role="grid" aria-label={`${MONTHS[month.getMonth()]} ${year}`} className="grid grid-cols-7 gap-y-1" onKeyDown={onKey}>
        {days.map((d) => {
          const iso = isoDate(d)
          const outside = d.getMonth() !== month.getMonth()
          const isEnd = iso === selected || iso === rangeEnd
          const inRange = !!lo && !!hi && iso > lo && iso < hi
          const disabled = blocked(iso)
          return (
            <div key={iso} role="gridcell" aria-selected={isEnd || inRange}
              className={cn('relative flex h-9 items-center justify-center',
                inRange && 'bg-brand-soft',
                lo !== hi && iso === lo && 'bg-gradient-to-r from-transparent from-50% to-brand-soft to-50%',
                lo !== hi && iso === hi && 'bg-gradient-to-l from-transparent from-50% to-brand-soft to-50%')}>
              <button type="button" data-day={iso} disabled={disabled} tabIndex={iso === tabbable ? 0 : -1}
                onClick={() => { setFocus(iso); onSelect(iso) }}
                aria-label={formatLong(iso)} aria-current={iso === today ? 'date' : undefined}
                className={cn('relative grid size-9 place-items-center rounded-full text-[13px] tabular-nums transition-colors outline-none',
                  'hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-30',
                  outside && 'text-muted-foreground/60',
                  iso === today && !isEnd && 'font-semibold text-brand',
                  isEnd && 'bg-brand font-semibold text-brand-foreground shadow-sm hover:bg-brand')}>
                {String(d.getDate()).padStart(2, '0')}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
