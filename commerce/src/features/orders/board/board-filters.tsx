import { Check, ChevronDown, ChevronsUpDown, ChevronUp, Clock, Filter, MapPin, Search, Truck, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { OrdersBoardOptions } from '@/services/order-tools'
import {
  activeFilters, type BoardValues, COURIER_PAYMENT, DATE_BY, EMPTY_BOARD, END_OF_DAY, HALF_HOURS, splitList, statusChoices, timeLabel,
} from './board-state'

const OPEN_KEY = 'orders-board-filters'

/** Open unless hidden before; on a phone it starts folded so the orders are not pushed below twelve fields. */
function readOpen(): boolean {
  try {
    const saved = localStorage.getItem(OPEN_KEY)
    if (saved) return saved !== 'hidden'
  } catch { /* private window: fall through to the screen size */ }
  return typeof window === 'undefined' || window.matchMedia('(min-width: 640px)').matches
}

/** The Orders Dashboard's filter panel: every field applies at once (typed text after a short pause). */
export function BoardFilterPanel({ values, onChange, options }: {
  values: BoardValues
  onChange: (next: BoardValues) => void
  options: OrdersBoardOptions | undefined
}) {
  const [open, setOpen] = useState(readOpen)
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem(OPEN_KEY, o ? 'hidden' : 'shown') } catch { /* private window: the panel just opens next time */ }
    return !o
  })
  const set = (patch: Partial<BoardValues>) => onChange({ ...values, ...patch })
  const active = activeFilters(values)
  const timeTitle = DATE_BY.find((d) => d.value === values.by)?.time ?? 'Time range'
  const statuses = useMemo(() => statusChoices(options?.call_statuses), [options?.call_statuses])

  return (
    <section className="rounded-xl border bg-card shadow-xs" aria-label="Filters">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><Filter className="size-4" /></span>
        <h2 className="text-sm font-semibold">Filters</h2>
        {active > 0 && <Badge variant="info" className="tabular-nums">{active} on</Badge>}
        <div className="ml-auto flex items-center gap-1">
          {active > 0 && (
            <button type="button" onClick={() => onChange({ ...EMPTY_BOARD, by: values.by })}
              className="rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
              Clear all
            </button>
          )}
          <button type="button" onClick={toggle} aria-expanded={open}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium text-brand hover:bg-brand-soft">
            {open ? <>Hide <ChevronUp className="size-4" /></> : <>Show <ChevronDown className="size-4" /></>}
          </button>
        </div>
      </div>

      {open && (
        <div className="grid gap-x-4 gap-y-3.5 border-t px-4 pt-3.5 pb-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-4">
          <Field label="Filter by">
            <Select value={values.by} onValueChange={(by) => set({ by })}>
              <SelectTrigger aria-label="Filter by"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DATE_BY.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Date range">
            <DateRangePicker size="default" clearable fullWidth placeholder="Pick a date range" aria-label="Date range"
              value={{ from: values.from, to: values.to }} onChange={(r) => set({ from: r.from, to: r.to })} />
          </Field>

          <Field label={timeTitle}>
            <div className="grid grid-cols-2 gap-2">
              <TimeSelect label="From" value={values.tfrom} onChange={(tfrom) => set({ tfrom })} />
              <TimeSelect label="To" value={values.tto} onChange={(tto) => set({ tto })} end />
            </div>
          </Field>

          <Field label="Search">
            <TextFilter value={values.product} onChange={(product) => set({ product })} placeholder="Product name or SKU…" label="Search products" />
          </Field>

          <Field label="Source">
            <OneOf label="Source" value={values.source} onChange={(source) => set({ source })} all="All sources"
              choices={(options?.sources ?? []).map((s) => ({ value: s, label: s }))} />
          </Field>

          <Field label="Courier">
            <OneOf label="Courier" value={values.courier} onChange={(courier) => set({ courier })} all="All couriers" icon={<Truck />}
              choices={[{ value: 'none', label: 'Not booked yet' },
                ...(options?.couriers ?? []).map((c) => ({ value: c.id, label: c.active ? c.name : `${c.name} (off)` }))]} />
          </Field>

          <Field label="Taken by">
            <SearchPick label="Taken by" value={values.taken} onChange={(taken) => set({ taken })} all="All users"
              choices={(options?.staff ?? []).map((p) => ({ value: p.id, label: p.active ? p.name : `${p.name} (left)` }))} />
          </Field>

          <Field label="Courier payment status">
            <OneOf label="Courier payment status" value={values.pay} onChange={(pay) => set({ pay })} all="All"
              choices={Object.entries(COURIER_PAYMENT).map(([value, label]) => ({ value, label }))} />
          </Field>

          <Field label="Invoice search (order/courier)">
            <TextFilter value={values.invoice} onChange={(invoice) => set({ invoice })} placeholder="Order or invoice number…" label="Invoice search" />
          </Field>

          <Field label="Status tags">
            <ManyOf label="Status" value={values.status} onChange={(status) => set({ status })} all="All statuses"
              groups={[
                { title: 'Approved orders', choices: statuses.filter((s) => s.group === 'approved').map((s) => ({ value: s.key, label: s.label })) },
                { title: 'Web orders', choices: [{ value: 'WEB', label: 'Every web order' },
                  ...statuses.filter((s) => s.group === 'web').map((s) => ({ value: s.key, label: s.label }))] },
              ]} />
          </Field>

          <Field label="Order tags">
            <ManyOf label="Order tags" value={values.tags} onChange={(tags) => set({ tags })} all="All tags"
              empty="No tags yet. Add tags to orders from the order lists."
              groups={[{ choices: (options?.tags ?? []).map((t) => ({ value: t.name, label: t.name })) }]} />
          </Field>

          <Field label="District">
            <SearchPick label="District" value={values.district} onChange={(district) => set({ district })} all="All districts" icon={<MapPin />}
              choices={(options?.districts ?? []).map((d) => ({ value: d, label: d }))} />
          </Field>
        </div>
      )}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <span className="truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  )
}

/** Text that filters after a short pause, so the list does not reload on every key. */
function TextFilter({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  const [text, setText] = useState(value)
  const last = useRef(value)
  // The address changed elsewhere (Clear all, back button): show it.
  useEffect(() => { if (value !== last.current) { last.current = value; setText(value) } }, [value])
  useEffect(() => {
    const next = text.trim()
    if (next === last.current) return
    const t = window.setTimeout(() => { last.current = next; onChange(next) }, 350)
    return () => window.clearTimeout(t)
  }, [text, onChange])
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={label} className="pr-8 pl-9" />
      {text && (
        <button type="button" onClick={() => setText('')} aria-label={`Clear ${label.toLowerCase()}`}
          className="absolute top-1/2 right-2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function TimeSelect({ label, value, onChange, end }: { label: string; value: string; onChange: (v: string) => void; end?: boolean }) {
  // "To" offers 11:59 pm so a range can run to the end of the day.
  const times = end ? [...HALF_HOURS.slice(1), END_OF_DAY] : HALF_HOURS
  return (
    <Select value={value || 'any'} onValueChange={(v) => onChange(v === 'any' ? '' : v)}>
      <SelectTrigger aria-label={label} className="px-2.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <Clock className="text-muted-foreground" />
          <span className={cn('truncate', !value && 'text-muted-foreground')}>{value ? timeLabel(Number(value)) : label}</span>
        </span>
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectItem value="any">Any time</SelectItem>
        <SelectSeparator />
        {times.map((m) => <SelectItem key={m} value={String(m)} className="tabular-nums">{timeLabel(m)}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

interface Choice { value: string; label: string }

/** A short list: a plain dropdown. */
function OneOf({ label, value, onChange, all, choices, icon }: {
  label: string; value: string; onChange: (v: string) => void; all: string; choices: Choice[]; icon?: ReactNode
}) {
  const known = !value || choices.some((c) => c.value === value)
  return (
    <Select value={value || 'all'} onValueChange={(v) => onChange(v === 'all' ? '' : v)}>
      <SelectTrigger aria-label={label}>
        <span className="flex min-w-0 items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
          {icon}
          <span className="truncate"><SelectValue /></span>
        </span>
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectItem value="all">{all}</SelectItem>
        {choices.length > 0 && <SelectSeparator />}
        {choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
        {/* A value from a shared link that is not in the list any more still shows. */}
        {!known && <SelectItem value={value}>{value}</SelectItem>}
      </SelectContent>
    </Select>
  )
}

const triggerClass = cn(
  'flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm shadow-xs outline-none',
  'transition-[color,box-shadow,border-color] hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/15',
  'data-[state=open]:border-ring data-[state=open]:ring-[3px] data-[state=open]:ring-ring/15',
)

/** A long list (staff, districts): a dropdown with a search box. */
function SearchPick({ label, value, onChange, all, choices, icon }: {
  label: string; value: string; onChange: (v: string) => void; all: string; choices: Choice[]; icon?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const picked = choices.find((c) => c.value === value)
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? choices.filter((c) => c.label.toLowerCase().includes(t)) : choices
  }, [q, choices])
  const choose = (v: string) => { onChange(v); setOpen(false); setQ('') }
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ('') }}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClass} aria-label={label}>
          {icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}
          <span className={cn('min-w-0 flex-1 truncate', !value && 'text-foreground')}>{picked?.label ?? (value || all)}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0">
        <div className="border-b p-2">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} className="h-8"
            onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); choose(shown[0].value) } }} />
        </div>
        <div className="max-h-64 overflow-y-auto p-1" role="listbox" aria-label={label}>
          {!q && <Row on={!value} onClick={() => choose('')}>{all}</Row>}
          {shown.map((c) => <Row key={c.value} on={c.value === value} onClick={() => choose(c.value)}>{c.label}</Row>)}
          {shown.length === 0 && <p className="px-2 py-3 text-center text-[13px] text-muted-foreground">Nothing found</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Several choices at once (statuses, tags). */
function ManyOf({ label, value, onChange, all, groups, empty }: {
  label: string; value: string; onChange: (v: string) => void; all: string
  groups: Array<{ title?: string; choices: Choice[] }>; empty?: string
}) {
  const picked = useMemo(() => new Set(splitList(value)), [value])
  const choices = groups.flatMap((g) => g.choices)
  const names = choices.filter((c) => picked.has(c.value)).map((c) => c.label)
  const toggle = (v: string) => {
    const next = new Set(picked)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange([...next].join(','))
  }
  const summary = picked.size === 0 ? all : picked.size <= 2 && names.length === picked.size ? names.join(', ') : `${picked.size} selected`
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClass} aria-label={label}>
          <span className="min-w-0 flex-1 truncate">{summary}</span>
          {picked.size > 0 && <span className="rounded-full bg-foreground px-1.5 text-[11px] text-background tabular-nums">{picked.size}</span>}
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-60 p-0">
        <div className="max-h-80 overflow-y-auto p-1">
          {choices.length === 0 && <p className="px-2 py-3 text-[13px] text-muted-foreground">{empty ?? 'Nothing to pick yet.'}</p>}
          {groups.map((g, i) => g.choices.length > 0 && (
            <div key={g.title ?? i} role="group" aria-label={g.title}>
              {g.title && <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{g.title}</p>}
              {g.choices.map((c) => <Row key={c.value} on={picked.has(c.value)} onClick={() => toggle(c.value)} check>{c.label}</Row>)}
            </div>
          ))}
        </div>
        {picked.size > 0 && (
          <div className="border-t p-1">
            <button type="button" onClick={() => onChange('')} className="w-full rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
              Clear {label.toLowerCase()}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Row({ on, onClick, children, check }: { on: boolean; onClick: () => void; children: ReactNode; check?: boolean }) {
  return (
    <button type="button" onClick={onClick} role="option" aria-selected={on}
      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted', on && 'font-medium')}>
      {check
        ? <span className={cn('grid size-4 shrink-0 place-items-center rounded border', on ? 'border-foreground bg-foreground text-background' : 'border-input')}>{on && <Check className="size-3" />}</span>
        : <Check className={cn('size-4 shrink-0', on ? 'opacity-100' : 'opacity-0')} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}
