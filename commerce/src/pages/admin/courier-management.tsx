import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ExternalLink, Package, Printer, Truck } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, ErrorState, Spinner, TableSkeleton } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { BookCourierDialog, trackingUrl } from '@/features/orders/book-courier-dialog'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatMoney, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { courierParcels, listCouriers, type Parcel, type ParcelTab } from '@/services/couriers'

const TABS: Array<{ value: ParcelTab; label: string }> = [
  { value: 'all', label: 'All parcels' },
  { value: 'assigned', label: 'Assigned for delivery' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'pending_entry', label: 'Pending entry' },
  { value: 'return_pending', label: 'Return pending' },
  { value: 'returned', label: 'Returned' },
  { value: 'damage_lost', label: 'Damage & lost' },
]

const SHIP_STATUS: Record<string, string> = {
  PENDING: 'Booking', BOOKED: 'Booked', PICKED_UP: 'Picked up', IN_TRANSIT: 'In transit', OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered', PARTIALLY_DELIVERED: 'Partly delivered', FAILED: 'Delivery failed', RETURNING: 'Returning',
  RETURNED: 'Returned', CANCELLED: 'Cancelled', ON_HOLD: 'On hold',
}
const PAGE_SIZE = 25

/** Every parcel by where it is: waiting to be booked, with the rider, coming back, back, or lost. */
export default function CourierManagementPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const [state, update] = useUrlState({ tab: 'all', q: '', courier: '', page: '1' })
  const tab = (TABS.some((t) => t.value === state.tab) ? state.tab : 'all') as ParcelTab
  const page = Number(state.page) || 1
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [booking, setBooking] = useState(false)
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const parcels = useQuery({
    queryKey: ['courier-parcels', tab, state.q, state.courier, page],
    placeholderData: keepPreviousData,
    queryFn: () => courierParcels({ tab, q: state.q, courierId: state.courier, page, pageSize: PAGE_SIZE }),
  })
  const rows = parcels.data?.items ?? []
  const counts = parcels.data?.counts
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const pendingSelected = rows.filter((r) => selected.has(r.id) && r.tab === 'pending_entry').map((r) => r.id)

  return (
    <div className="space-y-4">
      <PageHeader title="Courier management" description="Every parcel by where it is — from booking to the customer's door, or back to you."
        actions={can('couriers.view') && <Button size="sm" variant="outline" asChild><Link to="/admin/courier-invoices">Courier invoices</Link></Button>} />

      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {TABS.map((t) => (
          <button key={t.value} type="button" onClick={() => { setSelected(new Set()); update({ tab: t.value }) }}
            className={cn('flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-all duration-200',
              tab === t.value ? 'border-foreground bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:border-foreground/40 hover:text-foreground')}>
            {t.label}
            <span className={cn('rounded-full px-1.5 text-[11px] tabular-nums', tab === t.value ? 'bg-background/20' : 'bg-muted')}>{counts ? counts[t.value] : '·'}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Invoice, phone, name or consignment" />
        <Select value={state.courier || 'all'} onValueChange={(v) => update({ courier: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All couriers</SelectItem>
            {(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {parcels.isFetching && !parcels.isLoading && <Spinner className="size-4 text-muted-foreground" />}
        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2 animate-in fade-in-0 slide-in-from-right-2">
            <span className="text-sm text-muted-foreground">{selected.size} selected</span>
            {can('orders.fulfill') && <Button size="sm" variant="outline" onClick={() => navigate(`/admin/labels?ids=${[...selected].join(',')}`)}><Printer /> Print labels</Button>}
            {can('orders.fulfill') && pendingSelected.length > 0 && <Button size="sm" onClick={() => setBooking(true)}><Truck /> Book {pendingSelected.length} with courier</Button>}
          </div>
        )}
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        {parcels.isLoading ? <div className="p-4"><TableSkeleton rows={6} /></div>
          : parcels.error ? <ErrorState error={parcels.error} onRetry={() => parcels.refetch()} />
            : !rows.length ? <EmptyState title="No parcels here" description={tab === 'pending_entry' ? 'Approved orders waiting to be booked show here.' : undefined} />
              : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1180px] text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                        <th className="w-8 px-3 py-2.5"><Checkbox checked={allOn} onCheckedChange={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" /></th>
                        <th className="px-3 py-2.5">Invoice</th>
                        <th className="px-3 py-2.5">Products</th>
                        <th className="px-3 py-2.5">Customer</th>
                        <th className="px-3 py-2.5">Customer note</th>
                        <th className="px-3 py-2.5 text-right">Amount</th>
                        <th className="px-3 py-2.5">Courier booking</th>
                        <th className="px-3 py-2.5 text-center">Counts</th>
                        <th className="px-3 py-2.5">Rider</th>
                        <th className="px-3 py-2.5">Rider note</th>
                        <th className="px-3 py-2.5">Tags</th>
                        <th className="px-3 py-2.5">In charge</th>
                        <th className="px-3 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => <ParcelRow key={p.id} p={p} selected={selected.has(p.id)} onToggle={() => toggle(p.id)} />)}
                    </tbody>
                  </table>
                </div>
              )}
        {rows.length > 0 && (
          <div className="border-t px-3 py-2">
            <Pagination page={page} pageSize={PAGE_SIZE} total={parcels.data?.total ?? 0} onPage={(n) => update({ page: String(n) }, { resetPage: false })} />
          </div>
        )}
      </Card>

      <BookCourierDialog open={booking} onOpenChange={setBooking} orderIds={pendingSelected}
        orderNumber={(id) => rows.find((r) => r.id === id)?.order_number ?? id}
        onDone={() => { setSelected(new Set()); void parcels.refetch() }} />
    </div>
  )
}

function ParcelRow({ p, selected, onToggle }: { p: Parcel; selected: boolean; onToggle: () => void }) {
  const code = p.shipment?.consignment_id ?? p.shipment?.tracking_number
  const url = code ? trackingUrl(p.courier, code) : null
  const due = Math.max(0, p.total - p.amount_paid)
  return (
    <tr className={cn('border-b align-top transition-colors last:border-0 hover:bg-muted/30', selected && 'bg-muted/40')}>
      <td className="px-3 py-3"><Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${p.order_number}`} /></td>
      <td className="px-3 py-3">
        <Link to={`/admin/orders/${p.id}`} className="font-medium whitespace-nowrap hover:underline">{p.order_number}</Link>
        <span className="block text-xs whitespace-nowrap text-muted-foreground">{formatDate(p.created_at)}</span>
      </td>
      <td className="max-w-[220px] px-3 py-3">
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
      </td>
      <td className="max-w-[200px] px-3 py-3 text-xs">
        <span className="block text-sm font-medium">{p.customer.name}</span>
        <a href={`tel:${p.customer.phone}`} className="block tabular-nums hover:underline">{p.customer.phone}</a>
        <span className="line-clamp-2 text-muted-foreground">{[p.customer.address, p.customer.area, p.customer.district].filter(Boolean).join(', ')}</span>
      </td>
      <td className="max-w-[160px] px-3 py-3 text-xs text-muted-foreground"><span className="line-clamp-3">{p.customer_note || '—'}</span></td>
      <td className="px-3 py-3 text-right">
        <span className="block font-medium tabular-nums">{formatMoney(p.total)}</span>
        <span className="block text-[11px] text-muted-foreground">{due > 0 ? `COD ${formatMoney(p.cod_amount || due)}` : 'Paid'}</span>
      </td>
      <td className="px-3 py-3 text-xs">
        {p.shipment ? (
          <>
            <span className="block text-sm font-medium whitespace-nowrap">{p.courier?.name ?? 'Courier'}</span>
            {code && (url
              ? <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono hover:underline">{code}<ExternalLink className="size-3" /></a>
              : <span className="font-mono">{code}</span>)}
            <span className="mt-1 inline-block rounded-full border px-2 py-0.5 text-[11px]">{SHIP_STATUS[p.shipment.status] ?? p.shipment.status}</span>
          </>
        ) : <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Not booked</span>}
      </td>
      <td className="px-3 py-3 text-center text-xs tabular-nums">
        <span className="block">{p.item_count} item{p.item_count === 1 ? '' : 's'}</span>
        <span className="block text-muted-foreground">{p.attempts} attempt{p.attempts === 1 ? '' : 's'}</span>
      </td>
      <td className="px-3 py-3 text-xs">
        {p.rider?.name ? <><span className="block font-medium">{p.rider.name}</span>{p.rider.phone && <a href={`tel:${p.rider.phone}`} className="tabular-nums hover:underline">{p.rider.phone}</a>}</>
          : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="max-w-[180px] px-3 py-3 text-xs">
        {p.rider_note ? <><span className="line-clamp-2">{p.rider_note}</span>{p.last_update_at && <span className="text-[11px] text-muted-foreground">{timeAgo(p.last_update_at)}</span>}</>
          : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-3">
        <div className="flex max-w-[140px] flex-wrap gap-1">
          {p.tags.length ? p.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{t}</span>) : <span className="text-xs text-muted-foreground">—</span>}
        </div>
      </td>
      <td className="px-3 py-3 text-xs">{p.in_charge?.name ?? <span className="text-muted-foreground">—</span>}</td>
      <td className="px-3 py-3">
        <div className="flex justify-end gap-0.5">
          <Button size="icon-sm" variant="ghost" asChild><Link to={`/admin/labels?ids=${p.id}`} aria-label="Print label"><Printer /></Link></Button>
          <Button size="sm" variant="ghost" asChild><Link to={`/admin/orders/${p.id}`}>Open</Link></Button>
        </div>
      </td>
    </tr>
  )
}
