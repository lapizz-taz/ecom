import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Camera, Clock, Copy, Globe, Loader2, PackageCheck, Printer, Search as SearchIcon, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { CameraScanner } from '@/features/fulfillment/camera-scanner'
import { SearchCustomerPanel } from '@/features/orders/search-customer'
import { OrderStatusMenu } from '@/features/orders/status-menu'
import { useDebounce } from '@/hooks/use-debounce'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, timeAgo } from '@/lib/format'
import { PAYMENT_METHOD, PAYMENT_STATUS, SHIPMENT_STATUS, STAGE, stageOf } from '@/lib/status'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type OrderHit, type SearchField, searchOrders } from '@/services/order-search'

const FIELDS: Array<{ key: SearchField; label: string; placeholder: string }> = [
  { key: 'all', label: 'Everything', placeholder: 'Invoice, mobile, name, tracking ID or transaction ID' },
  { key: 'invoice', label: 'Invoice', placeholder: 'Invoice number, e.g. 1036 or ISO-10054' },
  { key: 'phone', label: 'Mobile', placeholder: 'Mobile number, e.g. 01712345678' },
  { key: 'name', label: 'Name', placeholder: 'Customer name' },
  { key: 'tracking', label: 'Tracking ID', placeholder: 'Courier tracking or consignment ID' },
  { key: 'transaction', label: 'Transaction', placeholder: 'bKash / Nagad transaction ID or payment reference' },
]
const MATCH_LABEL: Record<Exclude<SearchField, 'all'>, string> = {
  invoice: 'Invoice', phone: 'Mobile', name: 'Name', tracking: 'Tracking', transaction: 'Transaction',
}
type ListKey = 'all' | 'web' | 'approved'
type SortKey = 'new' | 'old' | 'amount'

const RECENT_KEY = 'fullfilio.order-search.recent'
function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]').filter((x: unknown) => typeof x === 'string').slice(0, 6) } catch { return [] }
}
function saveRecent(term: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([term, ...readRecent().filter((t) => t !== term)].slice(0, 6))) } catch { /* private window */ }
}

/** What a typed term looks like, to say where it will most likely match. */
function guess(term: string): string | null {
  const digits = term.replace(/\D/g, '')
  if (/^(\+?88)?01[3-9]\d{8}$/.test(term.replace(/[\s-]/g, ''))) return 'a mobile number'
  if (/^[A-Z]{2,5}-?\d{3,}$/i.test(term) || (/^\d{1,7}$/.test(term) && digits.length <= 7)) return 'an invoice number'
  if (/^[A-Z0-9]{8,}$/i.test(term) && /\d/.test(term) && /[A-Z]/i.test(term)) return 'a tracking or transaction ID'
  return null
}

/** Find any order by any field; results come back as Web orders and Approved orders, each workable in place. */
export default function SearchPage() {
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ field: 'all', q: '', list: 'all', sort: 'new' })
  const field = (FIELDS.some((f) => f.key === state.field) ? state.field : 'all') as SearchField
  const list = (['all', 'web', 'approved'].includes(state.list) ? state.list : 'all') as ListKey
  const sort = (['new', 'old', 'amount'].includes(state.sort) ? state.sort : 'new') as SortKey
  const term = useDebounce(state.q.trim(), 250)
  const input = useRef<HTMLInputElement>(null)
  const [camera, setCamera] = useState(false)
  const [recent, setRecent] = useState(readRecent)

  useEffect(() => { input.current?.focus() }, [field])
  // "/" jumps to the search box from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); input.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const results = useQuery({
    queryKey: ['order-search', field, term],
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    queryFn: () => searchOrders(field, term),
  })
  useEffect(() => {
    if (results.data && results.data.length > 0 && term.length >= 2) { saveRecent(term); setRecent(readRecent()) }
  }, [results.data, term])

  const hits = useMemo(() => {
    const rows = [...(results.data ?? [])]
    if (sort === 'old') rows.sort((a, b) => a.created_at.localeCompare(b.created_at))
    else if (sort === 'amount') rows.sort((a, b) => b.total_amount - a.total_amount)
    return rows
  }, [results.data, sort])
  const web = hits.filter((o) => !o.confirmed_at)
  const approved = hits.filter((o) => o.confirmed_at)
  const onePerson = hits.length > 0 && new Set(hits.map((o) => o.customer_phone)).size === 1
  const meta = FIELDS.find((f) => f.key === field)!
  const busy = results.isFetching && term.length >= 2
  const hint = field === 'all' && state.q.trim().length >= 2 ? guess(state.q.trim()) : null
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['order-search'] })

  return (
    <div className="space-y-4">
      <PageHeader title="Search orders" description="Find any order by invoice, mobile, name, courier tracking ID or payment transaction, and work on it right here." />

      <section className="rounded-2xl border bg-card p-3 sm:p-4">
        <div className="flex gap-2">
          <label className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-xl border bg-background px-3.5 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15">
            {busy ? <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" /> : <SearchIcon className="size-5 shrink-0 text-muted-foreground" />}
            <input ref={input} value={state.q} onChange={(e) => update({ q: e.target.value })} placeholder={meta.placeholder}
              inputMode={field === 'phone' ? 'tel' : undefined} aria-label={meta.placeholder} enterKeyHint="search"
              onKeyDown={(e) => { if (e.key === 'Escape') update({ q: '' }) }}
              className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground" />
            {state.q ? (
              <button type="button" aria-label="Clear" onClick={() => { update({ q: '' }); input.current?.focus() }}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button>
            ) : <kbd className="hidden shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">/</kbd>}
          </label>
          <Button type="button" variant="outline" className="h-12 shrink-0 px-3.5" aria-pressed={camera} onClick={() => setCamera((c) => !c)}>
            <Camera /> <span className="hidden sm:inline">Scan</span>
          </Button>
        </div>

        <div className="no-scrollbar -mx-3 mt-3 flex items-center gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:flex-wrap sm:px-0" role="tablist" aria-label="Search in">
          {FIELDS.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={field === f.key} onClick={() => update({ field: f.key })}
              className={cn('h-8 shrink-0 rounded-full border px-3 text-[13px] transition-colors',
                field === f.key ? 'border-foreground bg-foreground text-background' : 'bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground')}>
              {f.label}
            </button>
          ))}
          {hint && <span className="ml-1 shrink-0 text-xs text-muted-foreground">Looks like {hint}</span>}
        </div>

        {camera && (
          <div className="mt-3 max-w-xl">
            <CameraScanner onScan={(code) => { update({ q: code, field: 'all' }); setCamera(false) }} onClose={() => setCamera(false)} />
          </div>
        )}

        {!state.q && recent.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="size-3.5" /> Recent</span>
            {recent.map((r) => (
              <button key={r} type="button" onClick={() => update({ q: r })} className="h-7 max-w-48 truncate rounded-full bg-muted px-2.5 hover:bg-muted/70">{r}</button>
            ))}
          </div>
        )}
      </section>

      {term.length < 2 ? (
        <SearchTips />
      ) : results.error ? <ErrorState error={results.error} onRetry={() => results.refetch()} />
        : results.data && results.data.length === 0 ? (
          <EmptyState icon={<SearchIcon />} title="No orders found"
            description={`Nothing matches “${term}”${field === 'all' ? '' : ` in ${meta.label.toLowerCase()}`}. Try another field, or fewer characters.`} />
        ) : results.data && (
          <>
            {onePerson && <SearchCustomerPanel hits={hits} />}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="no-scrollbar -mx-1 flex max-w-full gap-1.5 overflow-x-auto px-1" role="tablist" aria-label="Which list">
                <Chip on={list === 'all'} onClick={() => update({ list: 'all' })}>All <Count n={hits.length} /></Chip>
                <Chip on={list === 'web'} onClick={() => update({ list: 'web' })}><Globe className="size-3.5" /> Web orders <Count n={web.length} /></Chip>
                <Chip on={list === 'approved'} onClick={() => update({ list: 'approved' })}><PackageCheck className="size-3.5" /> Approved orders <Count n={approved.length} /></Chip>
              </div>
              <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                Sort
                <select value={sort} onChange={(e) => update({ sort: e.target.value })} className="h-8 rounded-lg border bg-background px-2 text-[13px] text-foreground">
                  <option value="new">Newest first</option>
                  <option value="old">Oldest first</option>
                  <option value="amount">Highest amount</option>
                </select>
              </label>
            </div>
            {hits.length === 50 && <p className="text-xs text-muted-foreground">Showing the first 50 matches. Add more characters to narrow it down.</p>}

            {list !== 'approved' && (
              <OrderList title="Web orders" description="Not approved yet: call, approve or cancel from here." icon={<Globe className="size-4" />} rows={web} web onChanged={refresh}
                empty="No web order matches." to="/admin/orders/web" />
            )}
            {list !== 'web' && (
              <OrderList title="Approved orders" description="Confirmed orders on their way through packing, courier and delivery." icon={<PackageCheck className="size-4" />} rows={approved} onChanged={refresh}
                empty="No approved order matches." to="/admin/orders/approved" />
            )}
          </>
        )}
    </div>
  )
}

const Count = ({ n }: { n: number }) => <span className="rounded-full bg-current/10 px-1.5 text-[11px] tabular-nums">{n}</span>
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick}
      className={cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
        on ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground hover:text-foreground')}>
      {children}
    </button>
  )
}

function OrderList({ title, description, icon, rows, web = false, onChanged, empty, to }: {
  title: string; description: string; icon: ReactNode; rows: OrderHit[]; web?: boolean; onChanged: () => void; empty: string; to: string
}) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-card" aria-label={title}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">{icon} {title} <span className="text-muted-foreground tabular-nums">{rows.length}</span></h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Link to={to} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">Open list <ArrowRight className="size-3.5" /></Link>
      </header>
      {rows.length === 0 ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p> : (
        <ul className="divide-y">
          {rows.map((o) => <OrderRow key={o.id} o={o} web={web} onChanged={onChanged} />)}
        </ul>
      )}
    </section>
  )
}

function OrderRow({ o, web, onChanged }: { o: OrderHit; web: boolean; onChanged: () => void }) {
  const stage = stageOf(o.status, o.confirmed_at)
  const copy = (text: string, what: string) => { void navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`), () => undefined) }
  return (
    <li className="grid gap-x-4 gap-y-1.5 px-4 py-3 md:grid-cols-[minmax(0,10rem)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
      <div className="flex items-start justify-between gap-2 md:block">
        <div className="flex items-baseline gap-2 md:block">
          <Link to={`/admin/orders/${o.id}`} className="font-semibold hover:underline">{o.order_number}</Link>
          <p className="text-xs text-muted-foreground" title={formatDateTime(o.created_at)}>{timeAgo(o.created_at)}</p>
        </div>
        <p className="font-semibold tabular-nums md:hidden"><Money value={o.total_amount} /></p>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 md:block">
        <p className="truncate text-sm font-medium">{o.customer_name}</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
          {o.customer_phone}
          <button type="button" aria-label="Copy mobile number" className="rounded p-0.5 hover:bg-muted hover:text-foreground" onClick={() => copy(o.customer_phone, 'Mobile number')}><Copy className="size-3" /></button>
        </p>
        </div>
        <p className="truncate text-xs text-muted-foreground">{[o.shipping_address, o.shipping_district].filter(Boolean).join(', ')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <OrderStatusMenu orderId={o.id} orderNumber={o.order_number} status={o.status} web={web} reviewStatus={o.review_status} onChanged={onChanged} />
        <span className="hidden flex-wrap items-center gap-1.5 md:inline-flex">
          {!web && STAGE[stage] && <StatusBadge value={stage} map={STAGE} />}
          <StatusBadge value={o.payment_status} map={PAYMENT_STATUS} />
        </span>
        <span className="text-xs text-muted-foreground md:text-[11px]">
          <span className="md:hidden">{[!web && STAGE[stage]?.label, PAYMENT_STATUS[o.payment_status]?.label].filter(Boolean).join(' · ')} · </span>
          {PAYMENT_METHOD[o.payment_method] ?? o.payment_method}
        </span>
      </div>
      <div className="min-w-0 text-xs">
        {o.parcel ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{o.parcel.courier}</span>
            {o.parcel.tracking && (
              <button type="button" className="max-w-40 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted/70" title="Copy tracking ID"
                onClick={() => copy(o.parcel!.tracking!, 'Tracking ID')}>{o.parcel.tracking}</button>
            )}
            <span className="hidden md:inline-flex"><StatusBadge value={o.parcel.status} map={SHIPMENT_STATUS} /></span>
            <span className="text-muted-foreground md:hidden">{SHIPMENT_STATUS[o.parcel.status]?.label ?? o.parcel.status}</span>
          </div>
        ) : <span className="text-muted-foreground">{web ? 'Not approved yet' : 'No parcel yet'}</span>}
        <div className="mt-1 flex flex-wrap gap-1">
          {o.matched.map((m) => (
            <span key={m.field} className="text-[10px] text-brand md:rounded md:bg-brand-soft md:px-1.5 md:py-0.5" title={m.value}>Matched {MATCH_LABEL[m.field].toLowerCase()}</span>
          ))}
        </div>
      </div>
      <div className="-mt-1 flex items-center justify-end gap-1 md:mt-0">
        <p className="mr-2 hidden font-semibold tabular-nums md:block"><Money value={o.total_amount} /></p>
        {!web && (
          <Button asChild size="icon-sm" variant="ghost" aria-label={`Print label for ${o.order_number}`}>
            <Link to={`/admin/labels?ids=${o.id}`}><Printer /></Link>
          </Button>
        )}
        <Button asChild size="sm" variant="outline">
          <Link to={`/admin/orders/${o.id}`}>Open</Link>
        </Button>
      </div>
    </li>
  )
}

function SearchTips() {
  const tips = [
    ['Mobile number', 'All orders of a customer, with their delivery record'],
    ['Invoice', 'The order number, from this store or Shopify / WooCommerce'],
    ['Tracking ID', 'Scan the label with the camera to find the parcel'],
    ['Transaction ID', 'bKash or Nagad payments, to match a payment to its order'],
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tips.map(([title, text]) => (
        <div key={title} className="rounded-2xl border border-dashed p-4">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{text}</p>
        </div>
      ))}
    </div>
  )
}
