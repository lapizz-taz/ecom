import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Filter, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { FRAUD_STATUS, PAYMENT_STATUS, RISK_LEVEL } from '@/lib/status'
import { cn } from '@/lib/utils'
import { type OrderFilters, orderFilterOptions } from '@/services/orders'

/** Filter values as they live in the URL (all strings; tags comma-separated). */
export const FILTER_KEYS = [
  'date_from', 'date_to', 'reference', 'web_source', 'channel', 'tags', 'employee', 'product_code', 'product_name', 'only_product',
  'qty_min', 'qty_max', 'orders_min', 'orders_max', 'rate_min', 'rate_max', 'printed', 'uploaded', 'fraud_status',
  'payment_status', 'risk_level', 'source', 'district',
] as const
export type FilterKey = (typeof FILTER_KEYS)[number]
export type FilterValues = Record<FilterKey, string>
export const EMPTY_FILTERS = Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])) as FilterValues

const num = (v: string) => (v === '' ? undefined : Number(v))

/** URL values → the server's filter object. */
export function filtersFromValues(v: FilterValues): OrderFilters {
  return {
    date_from: v.date_from || undefined,
    date_to: v.date_to || undefined,
    reference: v.reference || undefined,
    web_source: v.web_source || undefined,
    channel: v.channel || undefined,
    tags: v.tags ? v.tags.split(',').filter(Boolean) : undefined,
    employee: v.employee || undefined,
    product_code: v.product_code || undefined,
    product_name: v.product_name || undefined,
    only_product: v.only_product === '1' || undefined,
    qty_min: num(v.qty_min), qty_max: num(v.qty_max),
    customer_orders_min: num(v.orders_min), customer_orders_max: num(v.orders_max),
    success_min: num(v.rate_min), success_max: num(v.rate_max),
    label: (v.printed || undefined) as OrderFilters['label'],
    uploaded: (v.uploaded || undefined) as OrderFilters['uploaded'],
    fraud_status: v.fraud_status || undefined,
    payment_status: v.payment_status || undefined,
    risk_level: v.risk_level || undefined,
    source: v.source || undefined,
    district: v.district || undefined,
  }
}

export function activeFilterCount(v: FilterValues) {
  const pairs: FilterKey[][] = [['date_from', 'date_to'], ['qty_min', 'qty_max'], ['orders_min', 'orders_max'], ['rate_min', 'rate_max']]
  const paired = new Set(pairs.flat())
  return FILTER_KEYS.filter((k) => !paired.has(k) && k !== 'only_product' && v[k]).length + pairs.filter((p) => p.some((k) => v[k])).length
}

type View = 'web' | 'approved' | 'all'

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
function preset(key: string): [string, string] {
  const today = new Date()
  const ago = (n: number) => ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n))
  switch (key) {
    case 'today': return [ago(0), ago(0)]
    case 'yesterday': return [ago(1), ago(1)]
    case '7d': return [ago(6), ago(0)]
    case '30d': return [ago(29), ago(0)]
    case 'month': return [ymd(new Date(today.getFullYear(), today.getMonth(), 1)), ago(0)]
    default: return ['', '']
  }
}
const PRESETS = [
  { key: 'all', label: 'All dates' }, { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' }, { key: '30d', label: 'Last 30 days' }, { key: 'month', label: 'This month' }, { key: 'custom', label: 'Custom' },
]
function presetOf(from: string, to: string) {
  if (!from && !to) return 'all'
  return PRESETS.find((p) => p.key !== 'all' && p.key !== 'custom' && preset(p.key).join() === [from, to].join())?.key ?? 'custom'
}

const label = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export function OrderFilterButton({ view, values, onApply, incomplete, onIncomplete, countFor }: {
  view: View
  values: FilterValues
  onApply: (next: FilterValues) => void
  /** Web orders: the incomplete-checkout list is a tab; the panel can switch to it. */
  incomplete?: boolean
  onIncomplete?: (on: boolean) => void
  countFor: (values: FilterValues) => Promise<number>
}) {
  const [open, setOpen] = useState(false)
  const active = activeFilterCount(values)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Filter /> Filters{active > 0 && <Badge variant="secondary">{active}</Badge>}
      </Button>
      {open && (
        <OrderFilterPanel view={view} initial={values} incomplete={incomplete} onIncomplete={onIncomplete}
          countFor={countFor} onClose={() => setOpen(false)} onApply={(v) => { onApply(v); setOpen(false) }} />
      )}
    </>
  )
}

function OrderFilterPanel({ view, initial, onApply, onClose, incomplete, onIncomplete, countFor }: {
  view: View
  initial: FilterValues
  onApply: (next: FilterValues) => void
  onClose: () => void
  incomplete?: boolean
  onIncomplete?: (on: boolean) => void
  countFor: (values: FilterValues) => Promise<number>
}) {
  const [draft, setDraft] = useState<FilterValues>(initial)
  const [debounced, setDebounced] = useState(draft)
  const [datePreset, setDatePreset] = useState(() => presetOf(initial.date_from, initial.date_to))
  useEffect(() => { const t = setTimeout(() => setDebounced(draft), 300); return () => clearTimeout(t) }, [draft])
  const set = (patch: Partial<FilterValues>) => setDraft((d) => ({ ...d, ...patch }))

  const options = useQuery({ queryKey: ['order-filter-options'], queryFn: orderFilterOptions, staleTime: 60_000 })
  const count = useQuery({ queryKey: ['orders', 'filter-count', view, debounced], queryFn: () => countFor(debounced), placeholderData: keepPreviousData })
  const tags = useMemo(() => new Set(draft.tags.split(',').filter(Boolean)), [draft.tags])
  const toggleTag = (t: string) => {
    const next = new Set(tags)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    set({ tags: [...next].join(',') })
  }
  const sources = options.data?.sources ?? []
  const channels = options.data?.channels ?? []
  const product = draft.product_code || draft.product_name

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="flex max-h-[min(88dvh,760px)] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-lg">
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div>
            <DialogTitle className="text-base">Filter orders</DialogTitle>
            <DialogDescription className="text-xs">{view === 'web' ? 'Web orders' : view === 'approved' ? 'Approved orders' : 'All orders'}</DialogDescription>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => { setDraft(EMPTY_FILTERS); setDatePreset('all') }}>Reset filters</Button>
            <DialogClose asChild><Button variant="ghost" size="icon-sm" aria-label="Close"><X /></Button></DialogClose>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <Section title={view === 'approved' ? 'Date range' : 'Date'}>
            <Chips value={datePreset} options={PRESETS} onChange={(k) => {
              setDatePreset(k)
              if (k !== 'custom') { const [from, to] = preset(k); set({ date_from: from, date_to: to }) }
            }} />
            {datePreset === 'custom' && (
              <div className="grid grid-cols-2 gap-2">
                <Input type="date" aria-label="From" value={draft.date_from} onChange={(e) => set({ date_from: e.target.value })} />
                <Input type="date" aria-label="To" value={draft.date_to} onChange={(e) => set({ date_to: e.target.value })} />
              </div>
            )}
          </Section>

          {view === 'web' && onIncomplete && (
            <ToggleRow title="Incomplete orders" hint="Visitors who typed a phone at checkout but did not order"
              checked={!!incomplete} onChange={(on) => { onIncomplete(on); onClose() }} />
          )}

          {view !== 'web' && (
            <div className="grid gap-5 sm:grid-cols-2">
              <Section title="Print status">
                <Chips value={draft.printed || 'any'} onChange={(v) => set({ printed: v === 'any' ? '' : v })}
                  options={[{ key: 'any', label: 'Any' }, { key: 'printed', label: 'Printed' }, { key: 'not_printed', label: 'Not printed' }]} />
              </Section>
              <Section title="Upload status">
                <Chips value={draft.uploaded || 'any'} onChange={(v) => set({ uploaded: v === 'any' ? '' : v })}
                  options={[{ key: 'any', label: 'Any' }, { key: 'yes', label: 'Uploaded' }, { key: 'no', label: 'Not uploaded' }]} />
              </Section>
            </div>
          )}

          {view === 'web' && (
            <Section title="Reference" hint="Campaign, referring site or landing page">
              <Input value={draft.reference} onChange={(e) => set({ reference: e.target.value })} placeholder="e.g. eid-sale, facebook.com" />
            </Section>
          )}

          <Section title={view === 'web' ? 'Web source' : 'Order source'}>
            <Chips value={draft.web_source || 'any'} onChange={(v) => set({ web_source: v === 'any' ? '' : v })}
              options={[{ key: 'any', label: 'Any' }, ...sources.map((s) => ({ key: s, label: s }))]} />
          </Section>

          {view !== 'web' && channels.length > 0 && (
            <Section title="Channel">
              <Chips value={draft.channel || 'any'} onChange={(v) => set({ channel: v === 'any' ? '' : v })}
                options={[{ key: 'any', label: 'Any' }, ...channels.map((c) => ({ key: c, label: label(c) }))]} />
            </Section>
          )}

          <Section title={view === 'web' ? 'Tags' : 'Order tags'}>
            {(options.data?.tags ?? []).length === 0
              ? <p className="text-xs text-muted-foreground">No tags yet. Add tags to orders from the list.</p>
              : (
                <div className="flex flex-wrap gap-1.5">
                  {(options.data?.tags ?? []).map((t) => (
                    <Pill key={t.name} on={tags.has(t.name)} onClick={() => toggleTag(t.name)}>{t.name}</Pill>
                  ))}
                </div>
              )}
          </Section>

          {view !== 'web' && (
            <Section title="Fraud status">
              <Chips value={draft.fraud_status || 'any'} onChange={(v) => set({ fraud_status: v === 'any' ? '' : v })}
                options={[{ key: 'any', label: 'Any' }, ...Object.entries(FRAUD_STATUS).map(([k, m]) => ({ key: k, label: m.label }))]} />
            </Section>
          )}

          {view !== 'approved' && (
            <Section title="Employee" hint="Created, called, assigned or approved by">
              <Select value={draft.employee || 'any'} onValueChange={(v) => set({ employee: v === 'any' ? '' : v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Anyone</SelectItem>
                  {(options.data?.employees ?? []).map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Section>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <Section title={view === 'web' ? 'Product code' : 'Product SKU'}>
              <Input value={draft.product_code} onChange={(e) => set({ product_code: e.target.value })} placeholder="SKU" className="font-mono" />
            </Section>
            <Section title="Product name">
              <Input value={draft.product_name} onChange={(e) => set({ product_name: e.target.value })} placeholder="e.g. Earring" />
            </Section>
          </div>
          <ToggleRow title="Include other products" hint={product ? 'Off: only orders with nothing but this product' : 'Applies when a product is chosen'}
            checked={draft.only_product !== '1'} disabled={!product} onChange={(on) => set({ only_product: on ? '' : '1' })} />

          <Section title="Product quantity" hint="Items in the order">
            <RangeField min={1} max={20} value={[draft.qty_min, draft.qty_max]} onChange={([a, b]) => set({ qty_min: a, qty_max: b })} />
          </Section>

          {view === 'web' && (
            <>
              <Section title="Total orders" hint="The customer's orders with this store">
                <RangeField min={0} max={50} value={[draft.orders_min, draft.orders_max]} onChange={([a, b]) => set({ orders_min: a, orders_max: b })} />
              </Section>
              <Section title="Success orders (rating)" hint="Delivery success rate from the courier check">
                <RangeField min={0} max={100} step={5} suffix="%" value={[draft.rate_min, draft.rate_max]} onChange={([a, b]) => set({ rate_min: a, rate_max: b })} />
              </Section>
            </>
          )}

          <details className="group rounded-xl border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">More filters</summary>
            <div className="mt-3 grid gap-4 pb-1">
              <Section title="Payment">
                <Chips value={draft.payment_status || 'any'} onChange={(v) => set({ payment_status: v === 'any' ? '' : v })}
                  options={[{ key: 'any', label: 'Any' }, ...Object.entries(PAYMENT_STATUS).map(([k, m]) => ({ key: k, label: m.label }))]} />
              </Section>
              <Section title="Risk level">
                <Chips value={draft.risk_level || 'any'} onChange={(v) => set({ risk_level: v === 'any' ? '' : v })}
                  options={[{ key: 'any', label: 'Any' }, ...Object.entries(RISK_LEVEL).map(([k, m]) => ({ key: k, label: m.label }))]} />
              </Section>
              <Section title="Placed by">
                <Chips value={draft.source || 'any'} onChange={(v) => set({ source: v === 'any' ? '' : v })}
                  options={[{ key: 'any', label: 'Any' }, { key: 'STOREFRONT', label: 'Website' }, { key: 'ADMIN', label: 'Staff' }]} />
              </Section>
              {view === 'approved' && (
                <Section title="Employee">
                  <Select value={draft.employee || 'any'} onValueChange={(v) => set({ employee: v === 'any' ? '' : v })}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Anyone</SelectItem>
                      {(options.data?.employees ?? []).map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Section>
              )}
              <Section title="District">
                <Input value={draft.district} onChange={(e) => set({ district: e.target.value })} placeholder="e.g. Dhaka" />
              </Section>
            </div>
          </details>
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-5 py-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onApply(draft)} className="min-w-40">
            {count.isFetching ? <Spinner /> : null}
            Show {count.data ?? '…'} order{count.data === 1 ? '' : 's'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={cn('press rounded-full border px-3 py-1 text-xs transition-colors',
        on ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground')}>
      {children}
    </button>
  )
}

function Chips({ value, options, onChange }: { value: string; options: Array<{ key: string; label: string }>; onChange: (key: string) => void }) {
  return (
    <div className="flex flex-wrap content-start items-start gap-1.5" role="radiogroup">
      {options.map((o) => <Pill key={o.key} on={value === o.key} onClick={() => onChange(o.key)}>{o.label}</Pill>)}
    </div>
  )
}

function ToggleRow({ title, hint, checked, onChange, disabled }: { title: string; hint?: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn('flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5', disabled && 'opacity-60')}>
      <span><span className="block text-sm font-medium">{title}</span>{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={title} />
    </label>
  )
}

/** Two-handle slider with number boxes; an end at its limit means "no limit". */
function RangeField({ min, max, step = 1, suffix = '', value, onChange }: {
  min: number; max: number; step?: number; suffix?: string
  value: [string, string]
  onChange: (next: [string, string]) => void
}) {
  const lo = value[0] === '' ? min : Math.max(min, Math.min(Number(value[0]), max))
  const hi = value[1] === '' ? max : Math.max(min, Math.min(Number(value[1]), max))
  const emit = (a: number, b: number) => onChange([a <= min ? '' : String(a), b >= max ? '' : String(b)])
  const pct = (n: number) => ((n - min) / (max - min)) * 100
  return (
    <div className="grid gap-3">
      <div className="dual-range relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
        <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-foreground" style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }} />
        <input type="range" min={min} max={max} step={step} value={lo} aria-label="Minimum"
          onChange={(e) => emit(Math.min(Number(e.target.value), hi), hi)} />
        <input type="range" min={min} max={max} step={step} value={hi} aria-label="Maximum"
          onChange={(e) => emit(lo, Math.max(Number(e.target.value), lo))} />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Input inputMode="numeric" className="h-8 w-20 tabular-nums" aria-label="From" value={value[0]} placeholder={`${min}${suffix}`}
          onChange={(e) => onChange([e.target.value.replace(/\D/g, ''), value[1]])} />
        <span>to</span>
        <Input inputMode="numeric" className="h-8 w-20 tabular-nums" aria-label="To" value={value[1]} placeholder={`${max}+${suffix}`}
          onChange={(e) => onChange([value[0], e.target.value.replace(/\D/g, '')])} />
        <span className="ml-auto tabular-nums">{value[0] || value[1] ? `${lo}${suffix} – ${hi}${hi >= max && !value[1] ? '+' : ''}${suffix}` : 'Any'}</span>
      </div>
    </div>
  )
}
