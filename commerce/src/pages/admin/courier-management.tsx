import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, History, Package, Phone, Printer, Settings2, Tag, Truck, UserPlus, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from '@/lib/toast'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState, Spinner, TableSkeleton } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { BookCourierDialog, trackingUrl } from '@/features/orders/book-courier-dialog'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatDate, formatDateTime, formatMoney, formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type CallCounts, type CallOutcome, courierParcels, listCouriers, logParcelCall, type Parcel, parcelHistory, type ParcelTab, returnAnalysis,
} from '@/services/couriers'
import { assignOrders, autoPickOverview } from '@/services/order-tools'
import { setOrderTags } from '@/services/orders'

const TABS: Array<{ value: ParcelTab; label: string; total: string }> = [
  { value: 'in_transit', label: 'In transit', total: 'Total in-transit parcels' },
  { value: 'assigned', label: 'Assigned for delivery', total: 'Total parcels with a rider' },
  { value: 'cancelled', label: 'Cancelled', total: 'Total cancelled parcels' },
  { value: 'pending_entry', label: 'Pending entry', total: 'Total parcels waiting for courier entry' },
  { value: 'return_pending', label: 'Return pending', total: 'Total return-pending parcels' },
  { value: 'returned', label: 'Returned', total: 'Total returned parcels' },
  { value: 'damage_lost', label: 'Damage & lost', total: 'Total damaged or lost parcels' },
  { value: 'all', label: 'All', total: 'Total parcels' },
]
const RETURN_TABS: ParcelTab[] = ['return_pending', 'returned', 'damage_lost']

const SHIP_STATUS: Record<string, string> = {
  PENDING: 'Booking', BOOKED: 'Booked', PICKED_UP: 'Picked up', IN_TRANSIT: 'In transit', OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered', PARTIALLY_DELIVERED: 'Partly delivered', FAILED: 'Delivery failed', RETURNING: 'Returning',
  RETURNED: 'Returned', CANCELLED: 'Cancelled', ON_HOLD: 'On hold',
}
const OUTCOME: Record<CallOutcome, string> = {
  ANSWERED: 'Answered', NO_ANSWER: 'No answer', BUSY: 'Busy', SWITCHED_OFF: 'Switched off', WRONG_NUMBER: 'Wrong number',
}
const PAGE_SIZE = 25

/** A parcel that needs attention: tried three times, or a week with the courier and still not delivered. */
const isLate = (p: Parcel) => (p.tab === 'in_transit' || p.tab === 'assigned') && (p.attempts >= 3 || (p.age_days ?? 0) >= 7)

/** Every parcel by where it is, with courier age, delivery attempts, calls and who is in charge. */
export default function CourierManagementPage() {
  const { can } = useAuth()
  const [state, update] = useUrlState({
    view: 'parcels', tab: 'in_transit', q: '', courier: '', charge: '', age_from: '', age_to: '', att_from: '', att_to: '', page: '1',
  })
  const view = state.view === 'analysis' ? 'analysis' : state.view === 'returns' ? 'returns' : 'parcels'
  const NAV: Array<{ key: string; label: string; active: boolean; go: () => void }> = [
    { key: 'parcels', label: 'All parcels', active: view === 'parcels' && state.tab !== 'pending_entry', go: () => update({ view: 'parcels', tab: 'in_transit' }) },
    { key: 'returns', label: 'Return management', active: view === 'returns', go: () => update({ view: 'returns', tab: 'return_pending' }) },
    { key: 'analysis', label: 'Return analysis', active: view === 'analysis', go: () => update({ view: 'analysis' }) },
    { key: 'entry', label: 'Courier entry', active: view === 'parcels' && state.tab === 'pending_entry', go: () => update({ view: 'parcels', tab: 'pending_entry' }) },
  ]
  return (
    <div className="space-y-4">
      <PageHeader title="Courier management" description="Every parcel by where it is — from courier entry to the customer's door, or back to you."
        actions={can('couriers.view') && <Button size="sm" variant="outline" asChild><Link to="/admin/courier-invoices">Courier invoices</Link></Button>} />
      <nav className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0" aria-label="Courier management">
        {NAV.map((n) => (
          <button key={n.key} type="button" onClick={n.go}
            className={cn('shrink-0 border-b-2 px-3 py-2 text-sm transition-colors', n.active ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {n.label}
          </button>
        ))}
        {can('settings.manage') && (
          <Link to="/admin/couriers" className="flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            <Settings2 className="size-3.5" /> Courier settings
          </Link>
        )}
      </nav>
      {view === 'analysis' ? <ReturnAnalysisView /> : <ParcelsView state={state} update={update} returnsOnly={view === 'returns'} />}
    </div>
  )
}

type State = Record<'view' | 'tab' | 'q' | 'courier' | 'charge' | 'age_from' | 'age_to' | 'att_from' | 'att_to' | 'page', string>

function ParcelsView({ state, update, returnsOnly }: {
  state: State; update: (p: Partial<State>, o?: { resetPage?: boolean }) => void; returnsOnly: boolean
}) {
  const { can } = useAuth()
  const navigate = useNavigate()
  const tabs = returnsOnly ? TABS.filter((t) => RETURN_TABS.includes(t.value)) : TABS
  const tab = (tabs.some((t) => t.value === state.tab) ? state.tab : tabs[0].value) as ParcelTab
  const page = Number(state.page) || 1
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [booking, setBooking] = useState(false)
  const [history, setHistory] = useState<Parcel | null>(null)
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const agents = useQuery({ queryKey: ['auto-pick'], queryFn: autoPickOverview, staleTime: 60_000 })
  const parcels = useQuery({
    queryKey: ['courier-parcels', tab, state.q, state.courier, state.charge, state.age_from, state.age_to, state.att_from, state.att_to, page],
    placeholderData: keepPreviousData,
    queryFn: () => courierParcels({
      tab, q: state.q, courierId: state.courier, inCharge: state.charge, ageFrom: state.age_from, ageTo: state.age_to,
      attemptFrom: state.att_from, attemptTo: state.att_to, page, pageSize: PAGE_SIZE,
    }),
  })
  const rows = parcels.data?.items ?? []
  const counts = parcels.data?.counts
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const pendingSelected = rows.filter((r) => selected.has(r.id) && r.tab === 'pending_entry').map((r) => r.id)
  const refresh = () => void parcels.refetch()
  const range = (from: 'age_from' | 'att_from', to: 'age_to' | 'att_to', label: string, unit: string) => (
    <div className="flex items-center gap-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <Input inputMode="numeric" value={state[from]} onChange={(e) => update({ [from]: e.target.value.replace(/\D/g, '') })} placeholder="From" className="h-8 w-16" aria-label={`${label} from (${unit})`} />
      <span className="text-xs text-muted-foreground">–</span>
      <Input inputMode="numeric" value={state[to]} onChange={(e) => update({ [to]: e.target.value.replace(/\D/g, '') })} placeholder="To" className="h-8 w-16" aria-label={`${label} to (${unit})`} />
    </div>
  )
  const active = tabs.find((t) => t.value === tab)!

  return (
    <>
      <div className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        {tabs.map((t) => (
          <button key={t.value} type="button" onClick={() => { setSelected(new Set()); update({ tab: t.value }) }}
            className={cn('flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-all duration-200',
              tab === t.value ? 'border-foreground bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:border-foreground/40 hover:text-foreground')}>
            {t.label}
            <span className={cn('rounded-full px-1.5 text-[11px] tabular-nums', tab === t.value ? 'bg-background/20' : 'bg-muted')}>{counts ? counts[t.value] : '·'}</span>
          </button>
        ))}
      </div>

      <Card className="gap-3 p-3">
        <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
          {range('age_from', 'age_to', 'Courier age', 'days')}
          {range('att_from', 'att_to', 'Rider attempt', 'attempts')}
          <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Invoice, phone, name or consignment" className="sm:w-64" />
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Select value={state.courier || 'all'} onValueChange={(v) => update({ courier: v === 'all' ? '' : v })}>
              <SelectTrigger size="sm" className="w-full sm:w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All couriers</SelectItem>
                {(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={state.charge || 'all'} onValueChange={(v) => update({ charge: v === 'all' ? '' : v })}>
              <SelectTrigger size="sm" className="w-full sm:w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                <SelectItem value="none">No one in charge</SelectItem>
                {(agents.data?.agents ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {parcels.isFetching && !parcels.isLoading && <Spinner className="size-4 text-muted-foreground" />}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <p className="text-sm">{active.total}: <strong className="tabular-nums">{formatNumber(parcels.data?.total ?? 0)}</strong></p>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto animate-in fade-in-0 slide-in-from-right-2">
              <span className="text-sm text-muted-foreground">{selected.size} selected</span>
              {can('orders.fulfill') && <Button size="sm" variant="outline" onClick={() => navigate(`/admin/labels?ids=${[...selected].join(',')}`)}><Printer /> Print labels</Button>}
              {can('orders.fulfill') && pendingSelected.length > 0 && <Button size="sm" onClick={() => setBooking(true)}><Truck /> Book {pendingSelected.length} with courier</Button>}
            </div>
          )}
        </div>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        {parcels.isLoading ? <div className="p-4"><TableSkeleton rows={6} /></div>
          : parcels.error ? <ErrorState error={parcels.error} onRetry={refresh} />
            : !rows.length ? <EmptyState title="No parcels here" description={tab === 'pending_entry' ? 'Approved orders waiting to be booked show here.' : 'Try clearing the filters.'} />
              : (
                <>
                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full min-w-[1320px] text-sm">
                      <thead>
                        <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                          <th className="w-8 px-3 py-2.5"><Checkbox checked={allOn} onCheckedChange={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" /></th>
                          <th className="px-3 py-2.5">Invoice</th>
                          <th className="px-3 py-2.5">Products</th>
                          <th className="px-3 py-2.5">Customer</th>
                          <th className="px-3 py-2.5">Customer calls</th>
                          <th className="px-3 py-2.5 text-right">Amount</th>
                          <th className="px-3 py-2.5">Courier tracking</th>
                          <th className="px-3 py-2.5">Counts</th>
                          <th className="px-3 py-2.5">Rider</th>
                          <th className="px-3 py-2.5">Rider calls</th>
                          <th className="px-3 py-2.5">Tags</th>
                          <th className="px-3 py-2.5">In charge</th>
                          <th className="px-3 py-2.5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((p) => (
                          <ParcelRow key={p.id} p={p} selected={selected.has(p.id)} onToggle={() => toggle(p.id)}
                            actions={<RowActions p={p} agents={agents.data?.agents ?? []} onHistory={() => setHistory(p)} onDone={refresh} />} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <ul className="divide-y md:hidden">
                    {rows.map((p) => (
                      <ParcelCard key={p.id} p={p} selected={selected.has(p.id)} onToggle={() => toggle(p.id)}
                        actions={<RowActions p={p} agents={agents.data?.agents ?? []} onHistory={() => setHistory(p)} onDone={refresh} />} />
                    ))}
                  </ul>
                </>
              )}
        {rows.length > 0 && (
          <div className="border-t px-3 py-2">
            <Pagination page={page} pageSize={PAGE_SIZE} total={parcels.data?.total ?? 0} onPage={(n) => update({ page: String(n) }, { resetPage: false })} />
          </div>
        )}
      </Card>

      <BookCourierDialog open={booking} onOpenChange={setBooking} orderIds={pendingSelected}
        orderNumber={(id) => rows.find((r) => r.id === id)?.order_number ?? id}
        onDone={() => { setSelected(new Set()); refresh() }} />
      <HistoryDialog parcel={history} onClose={() => setHistory(null)} />
    </>
  )
}

function Calls({ c }: { c: CallCounts }) {
  if (!c.total) return <span className="text-xs whitespace-nowrap text-muted-foreground">No calls</span>
  return (
    <span className="block text-xs">
      <span className="flex gap-1.5 tabular-nums">
        <span className="rounded bg-muted px-1.5 py-0.5">AM {c.am}</span>
        <span className="rounded bg-muted px-1.5 py-0.5">PM {c.pm}</span>
      </span>
      {c.last_outcome && <span className="mt-0.5 block text-[11px] text-muted-foreground">{OUTCOME[c.last_outcome]}{c.last_at ? ` · ${timeAgo(c.last_at)}` : ''}</span>}
    </span>
  )
}

function Counts({ p }: { p: Parcel }) {
  if (!p.shipment) return <span className="text-xs text-muted-foreground">—</span>
  const moving = p.tab === 'in_transit' || p.tab === 'assigned'
  return (
    <span className="flex flex-col items-start gap-1 text-[11px] whitespace-nowrap tabular-nums">
      <span className={cn('rounded-full px-2 py-0.5', moving && p.attempts >= 3 ? 'bg-red-600 text-white' : 'bg-muted')}>Attempt {p.attempts}</span>
      {p.age_days !== null && <span className={cn('rounded-full px-2 py-0.5', moving && (p.age_days ?? 0) >= 7 ? 'bg-red-600 text-white' : 'border')}>Courier age {p.age_days}d</span>}
    </span>
  )
}

function Tracking({ p }: { p: Parcel }) {
  const code = p.shipment?.consignment_id ?? p.shipment?.tracking_number
  const url = code ? trackingUrl(p.courier, code) : null
  if (!p.shipment) return <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Not booked</span>
  return (
    <span className="block text-xs">
      <span className="block text-sm font-medium whitespace-nowrap">{p.courier?.name ?? 'Courier'}</span>
      {code && (url
        ? <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono hover:underline">{code}<ExternalLink className="size-3" /></a>
        : <span className="font-mono">{code}</span>)}
      <span className="mt-1 block"><span className="inline-block rounded-full border px-2 py-0.5 text-[11px]">{SHIP_STATUS[p.shipment.status] ?? p.shipment.status}</span></span>
    </span>
  )
}

function Rider({ p }: { p: Parcel }) {
  return p.rider?.name
    ? <span className="block text-xs"><span className="block font-medium">{p.rider.name}</span>{p.rider.phone && <a href={`tel:${p.rider.phone}`} className="tabular-nums hover:underline">{p.rider.phone}</a>}
      {p.rider_note && <span className="mt-0.5 line-clamp-2 block text-muted-foreground" title={p.rider_note}>{p.rider_note}</span>}</span>
    : <span className="text-xs text-muted-foreground">{p.rider_note ? <span className="line-clamp-2" title={p.rider_note}>{p.rider_note}</span> : '—'}</span>
}

function Products({ p }: { p: Parcel }) {
  return (
    <div className="space-y-1">
      {p.products.slice(0, 2).map((i, n) => (
        <div key={n} className="flex items-center gap-2">
          {i.image ? <img src={i.image} alt="" className="size-8 shrink-0 rounded bg-muted object-cover" onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />
            : <span className="grid size-8 shrink-0 place-items-center rounded bg-muted"><Package className="size-3.5 text-muted-foreground" /></span>}
          <span className="min-w-0 text-xs">
            <span className="line-clamp-1 font-medium">{i.name}</span>
            <span className="text-muted-foreground">{i.variant && i.variant !== 'Default' ? `${i.variant} · ` : ''}×{i.qty}{i.damaged ? ` · ${i.damaged} damaged` : ''}</span>
          </span>
        </div>
      ))}
      {p.products.length > 2 && <span className="text-[11px] text-muted-foreground">+{p.products.length - 2} more</span>}
    </div>
  )
}

function Amount({ p }: { p: Parcel }) {
  const due = Math.max(0, p.total - p.amount_paid)
  return (
    <>
      <span className="block font-medium tabular-nums">{formatMoney(p.total)}</span>
      <span className="block text-[11px] text-muted-foreground">{due > 0 ? `COD ${formatMoney(p.cod_amount || due)}` : 'Paid'}</span>
    </>
  )
}

function TagList({ p }: { p: Parcel }) {
  return p.tags.length
    ? <div className="flex max-w-[140px] flex-wrap gap-1">{p.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{t}</span>)}</div>
    : <span className="text-xs text-muted-foreground">—</span>
}

function ParcelRow({ p, selected, onToggle, actions }: { p: Parcel; selected: boolean; onToggle: () => void; actions: ReactNode }) {
  return (
    <tr className={cn('border-b align-top transition-colors last:border-0 hover:bg-muted/30', isLate(p) && 'bg-red-500/10 hover:bg-red-500/15', selected && 'bg-muted/40')}>
      <td className="px-3 py-3"><Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${p.order_number}`} /></td>
      <td className="px-3 py-3">
        <Link to={`/admin/orders/${p.id}`} className="font-medium whitespace-nowrap hover:underline">{p.order_number}</Link>
        <span className="block text-xs whitespace-nowrap text-muted-foreground">{formatDate(p.created_at)}</span>
      </td>
      <td className="max-w-[220px] px-3 py-3"><Products p={p} /></td>
      <td className="max-w-[200px] px-3 py-3 text-xs">
        <span className="block text-sm font-medium">{p.customer.name}</span>
        <a href={`tel:${p.customer.phone}`} className="block tabular-nums hover:underline">{p.customer.phone}</a>
        <span className="line-clamp-2 text-muted-foreground">{[p.customer.address, p.customer.area, p.customer.district].filter(Boolean).join(', ')}</span>
      </td>
      <td className="px-3 py-3"><Calls c={p.customer_calls} /></td>
      <td className="px-3 py-3 text-right"><Amount p={p} /></td>
      <td className="px-3 py-3"><Tracking p={p} /></td>
      <td className="px-3 py-3"><Counts p={p} /></td>
      <td className="max-w-[180px] px-3 py-3"><Rider p={p} /></td>
      <td className="px-3 py-3"><Calls c={p.rider_calls} /></td>
      <td className="px-3 py-3"><TagList p={p} /></td>
      <td className="px-3 py-3 text-xs">{p.in_charge?.name ?? <span className="text-muted-foreground">—</span>}</td>
      <td className="px-3 py-3"><div className="flex justify-end">{actions}</div></td>
    </tr>
  )
}

function ParcelCard({ p, selected, onToggle, actions }: { p: Parcel; selected: boolean; onToggle: () => void; actions: ReactNode }) {
  return (
    <li className={cn('space-y-3 p-3', isLate(p) && 'bg-red-500/10', selected && 'bg-muted/40')}>
      <div className="flex items-start gap-3">
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${p.order_number}`} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link to={`/admin/orders/${p.id}`} className="font-medium hover:underline">{p.order_number}</Link>
            <span className="text-right text-sm"><Amount p={p} /></span>
          </div>
          <p className="text-sm">{p.customer.name} · <a href={`tel:${p.customer.phone}`} className="tabular-nums underline">{p.customer.phone}</a></p>
          <p className="line-clamp-1 text-xs text-muted-foreground">{[p.customer.address, p.customer.district].filter(Boolean).join(', ')}</p>
        </div>
      </div>
      <Products p={p} />
      <div className="grid grid-cols-2 gap-3 rounded-lg border p-2.5">
        <Tracking p={p} />
        <Counts p={p} />
        <div><p className="mb-1 text-[11px] text-muted-foreground">Customer calls</p><Calls c={p.customer_calls} /></div>
        <div><p className="mb-1 text-[11px] text-muted-foreground">Rider</p><Rider p={p} /></div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-xs text-muted-foreground">{p.in_charge?.name ? `In charge: ${p.in_charge.name}` : 'No one in charge'}{p.tags.length ? ` · ${p.tags.join(', ')}` : ''}</div>
        {actions}
      </div>
    </li>
  )
}

function RowActions({ p, agents, onHistory, onDone }: { p: Parcel; agents: Array<{ id: string; name: string }>; onHistory: () => void; onDone: () => void }) {
  const { can } = useAuth()
  return (
    <div className="flex gap-0.5">
      <CallAction p={p} onDone={onDone} />
      {can('orders.update') && <TagAction p={p} onDone={onDone} />}
      <Button size="icon-sm" variant="ghost" onClick={onHistory} aria-label="History" title="History"><History /></Button>
      {can('orders.assign') && <AssignAction p={p} agents={agents} onDone={onDone} />}
    </div>
  )
}

function CallAction({ p, onDone }: { p: Parcel; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [party, setParty] = useState<'CUSTOMER' | 'RIDER'>('CUSTOMER')
  const [note, setNote] = useState('')
  const log = useMutation({
    mutationFn: (outcome: CallOutcome) => logParcelCall(p.id, party, outcome, note),
    onSuccess: () => { toast.success('Call logged'); setOpen(false); setNote(''); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const phone = party === 'CUSTOMER' ? p.customer.phone : p.rider?.phone
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Call" title="Call"><Phone /></Button></PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-sm">
          {(['CUSTOMER', 'RIDER'] as const).map((x) => (
            <button key={x} type="button" onClick={() => setParty(x)} className={cn('rounded-md py-1', party === x && 'bg-background font-medium shadow-sm')}>{x === 'CUSTOMER' ? 'Customer' : 'Rider'}</button>
          ))}
        </div>
        {phone
          ? <Button asChild size="sm" className="w-full"><a href={`tel:${phone}`}><Phone /> Call {phone}</a></Button>
          : <p className="text-xs text-muted-foreground">The courier hasn't sent the rider's number.</p>}
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="h-8" maxLength={500} />
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">Log how it went</p>
          <div className="flex flex-wrap gap-1">
            {(Object.keys(OUTCOME) as CallOutcome[]).map((o) => (
              <Button key={o} size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={log.isPending} onClick={() => log.mutate(o)}>{OUTCOME[o]}</Button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TagAction({ p, onDone }: { p: Parcel; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [tag, setTag] = useState('')
  const save = useMutation({
    mutationFn: ({ add, remove }: { add: string[]; remove: string[] }) => setOrderTags([p.id], add, remove),
    onSuccess: () => { setTag(''); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Tags" title="Tags"><Tag /></Button></PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2 p-3">
        <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (tag.trim()) save.mutate({ add: [tag.trim()], remove: [] }) }}>
          <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add a tag" className="h-8" maxLength={40} autoFocus />
          <Button size="sm" type="submit" disabled={!tag.trim() || save.isPending}>Add</Button>
        </form>
        <div className="flex flex-wrap gap-1">
          {p.tags.map((t) => (
            <button key={t} type="button" onClick={() => save.mutate({ add: [], remove: [t] })} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-muted/70" aria-label={`Remove ${t}`}>
              {t}<X className="size-3" />
            </button>
          ))}
          {!p.tags.length && <span className="text-xs text-muted-foreground">No tags yet</span>}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AssignAction({ p, agents, onDone }: { p: Parcel; agents: Array<{ id: string; name: string }>; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const assign = useMutation({
    mutationFn: (agent: string | null) => assignOrders([p.id], agent),
    onSuccess: () => { toast.success('In charge updated'); setOpen(false); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Assign" title="Assign"><UserPlus /></Button></PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <ul className="max-h-64 overflow-y-auto text-sm">
          {agents.map((a) => (
            <li key={a.id}>
              <button type="button" disabled={assign.isPending} onClick={() => assign.mutate(a.id)}
                className={cn('w-full rounded px-2 py-1.5 text-left hover:bg-muted', p.in_charge?.id === a.id && 'font-medium')}>{a.name}</button>
            </li>
          ))}
          {p.in_charge && <li><button type="button" onClick={() => assign.mutate(null)} className="w-full rounded px-2 py-1.5 text-left text-muted-foreground hover:bg-muted">Remove {p.in_charge.name}</button></li>}
          {!agents.length && <li className="px-2 py-1.5 text-xs text-muted-foreground">No staff to assign</li>}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function HistoryDialog({ parcel, onClose }: { parcel: Parcel | null; onClose: () => void }) {
  const h = useQuery({ queryKey: ['parcel-history', parcel?.id], queryFn: () => parcelHistory(parcel!.id), enabled: !!parcel })
  return (
    <Dialog open={!!parcel} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{parcel?.order_number} history</DialogTitle>
          <DialogDescription>Courier updates, calls and status changes, newest first.</DialogDescription>
        </DialogHeader>
        {h.isLoading ? <LoadingState /> : h.error ? <ErrorState error={h.error} onRetry={() => h.refetch()} /> : (
          <ol className="max-h-[60dvh] space-y-3 overflow-y-auto border-l pl-4">
            {(h.data ?? []).map((e, i) => (
              <li key={i} className="relative text-sm">
                <span className={cn('absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background', e.kind === 'CALL' ? 'bg-muted-foreground' : 'bg-foreground')} />
                <p className="font-medium">
                  {e.kind === 'CALL' ? `Called ${e.party === 'RIDER' ? 'rider' : 'customer'} · ${OUTCOME[e.status as CallOutcome] ?? e.status}`
                    : e.kind === 'COURIER' ? (SHIP_STATUS[e.status ?? ''] ?? e.status) : `Order ${(e.status ?? '').toLowerCase().replace(/_/g, ' ')}`}
                </p>
                {e.text && <p className="text-xs text-muted-foreground">{e.text}</p>}
                <p className="text-[11px] text-muted-foreground">{formatDateTime(e.at)}{e.by ? ` · ${e.by}` : ''}</p>
              </li>
            ))}
            {!h.data?.length && <li className="text-sm text-muted-foreground">Nothing recorded yet.</li>}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  )
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

function ReturnAnalysisView() {
  const [range, setRange] = useState(() => ({ from: iso(new Date(Date.now() - 29 * 86_400_000)), to: iso(new Date()) }))
  const a = useQuery({ queryKey: ['return-analysis', range], queryFn: () => returnAnalysis(range.from, range.to), placeholderData: keepPreviousData })
  const s = a.data?.summary
  const rate = s && s.delivered + s.returned > 0 ? Math.round((1000 * s.returned) / (s.delivered + s.returned)) / 10 : null
  const table = (title: string, head: string, rows: Array<{ name: string; closed: number; returned: number; rate: number | null }>) => (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-3"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground"><th className="px-3 py-2">{head}</th><th className="px-3 py-2 text-right">Parcels</th><th className="px-3 py-2 text-right">Returned</th><th className="px-3 py-2 text-right">Rate</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t">
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.closed}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.returned}</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', (r.rate ?? 0) >= 25 && 'font-semibold text-red-600')}>{r.rate ?? 0}%</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">No returns in this period</td></tr>}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} className="h-8 w-40" aria-label="From" />
        <span className="text-sm text-muted-foreground">to</span>
        <Input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} className="h-8 w-40" aria-label="To" />
        <span className="text-xs text-muted-foreground">Parcels booked in this period. The rate counts finished parcels only (delivered or returned).</span>
      </div>
      {a.isLoading ? <LoadingState /> : a.error ? <ErrorState error={a.error} onRetry={() => a.refetch()} /> : a.data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard label="Parcels" value={formatNumber(s!.parcels)} hint={`${s!.open} still on the way`} />
            <StatCard label="Delivered" value={formatNumber(s!.delivered)} />
            <StatCard label="Returned" value={formatNumber(s!.returned)} tone={s!.returned ? 'negative' : 'default'} />
            <StatCard label="Return rate" value={rate === null ? '—' : `${rate}%`} />
            <StatCard label="Returned value" value={formatMoney(s!.return_value)} hint={s!.return_charges ? `${formatMoney(s!.return_charges)} return charges` : undefined} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {table('By courier', 'Courier', a.data.by_courier.map((r) => ({ name: r.courier, closed: r.closed, returned: r.returned, rate: r.rate })))}
            {table('By district', 'District', a.data.by_district.map((r) => ({ name: r.district, closed: r.closed, returned: r.returned, rate: r.rate })))}
            {table('By product', 'Product', a.data.by_product.map((r) => ({ name: r.product, closed: r.sold, returned: r.returned, rate: r.rate })))}
            <Card className="gap-0 py-0">
              <CardHeader className="border-b py-3"><CardTitle className="text-sm">Why parcels came back</CardTitle></CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y text-sm">
                  {a.data.reasons.map((r) => (
                    <li key={r.reason} className="flex justify-between gap-3 px-3 py-2"><span className="min-w-0 truncate" title={r.reason}>{r.reason}</span><span className="tabular-nums">{r.count}</span></li>
                  ))}
                  {!a.data.reasons.length && <li className="px-3 py-6 text-center text-xs text-muted-foreground">No returns in this period</li>}
                </ul>
                <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">As the courier reported it; "Not given" when the courier sent no reason.</p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
