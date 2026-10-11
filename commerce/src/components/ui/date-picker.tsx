import { CalendarDays, X } from 'lucide-react'
import { useState } from 'react'
import { Calendar, formatLong, formatRange } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { type DateRange, RANGE_PRESETS, type RangePreset, rangeFor } from '@/lib/dates'
import { cn } from '@/lib/utils'

// Date fields that open the calendar (see calendar.tsx). Values stay
// 'YYYY-MM-DD' strings so they drop in where <input type="date"> was.

const trigger = (size: 'sm' | 'default') => cn(
  'flex min-w-0 items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow,border-color] outline-none',
  'hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
  'data-[state=open]:border-ring data-[state=open]:ring-[3px] data-[state=open]:ring-ring/15',
  size === 'sm' ? 'h-8 rounded-[7px] text-[13px]' : 'h-9',
)

/** Opening the calendar puts keyboard focus on the chosen (or today's) day. */
const focusDay = (e: Event) => {
  const day = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLButtonElement>('[data-day][tabindex="0"]')
  if (day) { e.preventDefault(); day.focus() }
}

function Footer({ label, onCancel, onConfirm, canConfirm }: { label: string; onCancel: () => void; onConfirm: () => void; canConfirm: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t px-4 py-3">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      <button type="button" onClick={onCancel} className="rounded-md px-1 text-sm font-medium text-muted-foreground hover:text-foreground">Cancel</button>
      <button type="button" onClick={onConfirm} disabled={!canConfirm} className="rounded-md px-1 text-sm font-semibold text-brand hover:opacity-80 disabled:opacity-40">Confirm</button>
    </div>
  )
}

export interface DatePickerProps {
  value: string | null | undefined
  onChange: (value: string) => void
  min?: string
  max?: string
  placeholder?: string
  disabled?: boolean
  /** Shows a clear button; clearing calls onChange(''). */
  clearable?: boolean
  size?: 'sm' | 'default'
  id?: string
  className?: string
  align?: 'start' | 'center' | 'end'
  'aria-label'?: string
  'aria-invalid'?: boolean
}

/** One date: a field that opens the calendar; the choice applies on Confirm. */
export function DatePicker({ value, onChange, min, max, placeholder = 'Pick a date', disabled, clearable, size = 'default', id, className, align = 'start', ...aria }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string | null>(value || null)
  const toggle = (next: boolean) => { if (next) setDraft(value || null); setOpen(next) }
  return (
    <Popover open={open} onOpenChange={toggle}>
      <div className={cn('relative w-full', className)}>
        <PopoverTrigger asChild disabled={disabled}>
          <button type="button" id={id} className={cn(trigger(size), 'w-full', clearable && value && 'pr-8')} aria-label={aria['aria-label']} aria-invalid={aria['aria-invalid']}>
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
            <span className={cn('min-w-0 flex-1 truncate', !value && 'text-muted-foreground')}>{value ? formatLong(value) : placeholder}</span>
          </button>
        </PopoverTrigger>
        {clearable && value && !disabled && (
          <button type="button" aria-label="Clear date" onClick={() => onChange('')}
            className="absolute top-1/2 right-2 grid size-5 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3.5" /></button>
        )}
      </div>
      <PopoverContent align={align} onOpenAutoFocus={focusDay} className="w-auto overflow-hidden rounded-2xl p-0 shadow-xl">
        <div className="p-4 pb-3">
          <Calendar selected={draft} onSelect={setDraft} min={min} max={max} />
        </div>
        <Footer label={draft ? formatLong(draft) : 'No date chosen'} canConfirm={!!draft}
          onCancel={() => setOpen(false)} onConfirm={() => { if (draft) onChange(draft); setOpen(false) }} />
      </PopoverContent>
    </Popover>
  )
}

export interface DateRangePickerProps {
  /** Empty strings mean "any date" (with `clearable`). */
  value: DateRange
  onChange: (value: DateRange) => void
  /** Quick ranges (Today, Last 7 days…) beside the calendar. */
  presets?: boolean
  min?: string
  max?: string
  placeholder?: string
  clearable?: boolean
  size?: 'sm' | 'default'
  className?: string
  /** Stretch to the container at every width (inside panels and forms). */
  fullWidth?: boolean
  align?: 'start' | 'center' | 'end'
  'aria-label'?: string
}

/** A from–to range: pick two days (or a quick range), then Confirm. */
export function DateRangePicker({ value, onChange, presets = true, min, max, placeholder = 'Any date', clearable, size = 'sm', className, fullWidth, align = 'start', ...aria }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState<string | null>(value.from || null)
  const [to, setTo] = useState<string | null>(value.to || null)
  const [view, setView] = useState<string | null>(value.from || null)
  const toggle = (next: boolean) => { if (next) { setFrom(value.from || null); setTo(value.to || null); setView(value.from || null) } setOpen(next) }
  const preset = RANGE_PRESETS.find((p) => { const r = rangeFor(p.key); return r.from === value.from && r.to === value.to })
  const draftPreset = RANGE_PRESETS.find((p) => { const r = rangeFor(p.key); return r.from === from && r.to === (to ?? from) })
  const pick = (iso: string) => {
    if (!from || to) { setFrom(iso); setTo(null); return }
    if (iso < from) { setTo(from); setFrom(iso) } else setTo(iso)
  }
  const choose = (key: RangePreset) => { const r = rangeFor(key); setFrom(r.from); setTo(r.to); setView(r.from) }
  const label = value.from ? (preset ? preset.label : formatRange(value.from, value.to)) : placeholder
  const hasValue = !!value.from

  return (
    <Popover open={open} onOpenChange={toggle}>
      <div className={cn('relative w-full', !fullWidth && 'sm:w-auto', className)}>
        <PopoverTrigger asChild>
          <button type="button" className={cn(trigger(size), 'w-full', !fullWidth && 'sm:w-auto', clearable && hasValue && 'pr-8')} aria-label={aria['aria-label'] ?? 'Date range'}>
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
            <span className={cn('min-w-0 flex-1 truncate', !hasValue && 'text-muted-foreground')}>{label}</span>
            {preset && <span className="hidden text-muted-foreground lg:inline">· {formatRange(value.from, value.to)}</span>}
          </button>
        </PopoverTrigger>
        {clearable && hasValue && (
          <button type="button" aria-label="Clear dates" onClick={() => onChange({ from: '', to: '' })}
            className="absolute top-1/2 right-2 grid size-5 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3.5" /></button>
        )}
      </div>
      <PopoverContent align={align} collisionPadding={12} onOpenAutoFocus={focusDay} className="w-auto max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl p-0 shadow-xl">
        <div className="flex flex-col sm:flex-row">
          {presets && (
            <div className="flex gap-1 overflow-x-auto border-b p-2 sm:w-40 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0">
              {RANGE_PRESETS.map((p) => (
                <button key={p.key} type="button" onClick={() => choose(p.key)}
                  className={cn('shrink-0 rounded-lg px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap transition-colors hover:bg-muted',
                    draftPreset?.key === p.key ? 'bg-brand-soft font-medium text-brand hover:bg-brand-soft' : 'text-muted-foreground hover:text-foreground')}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <div className="p-4 pb-3">
            <Calendar selected={from} rangeEnd={to} onSelect={pick} min={min} max={max} defaultMonth={view} />
          </div>
        </div>
        <Footer
          label={from ? formatRange(from, to ?? from) + (to ? '' : ' · pick the end day') : 'Pick the first day'}
          canConfirm={!!from}
          onCancel={() => setOpen(false)}
          onConfirm={() => { if (from) onChange({ from, to: to ?? from }); setOpen(false) }} />
      </PopoverContent>
    </Popover>
  )
}
