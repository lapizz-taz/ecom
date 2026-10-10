import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, History, KeyRound, Search, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { useDebounce } from '@/hooks/use-debounce'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, toNumber } from '@/lib/format'
import { ORDER_STATUS, SHIPMENT_STATUS } from '@/lib/status'
import { listCouriers } from '@/services/couriers'
import { type OverrideChanges, overrideHistory, overrideOrder } from '@/services/order-tools'
import { getOrder } from '@/services/orders'
import { globalSearch } from '@/services/search'
import type { Enums } from '@/types/database'

type OrderStatus = Enums<'order_status'>
type ShipmentStatus = Enums<'shipment_status'>

/**
 * Super Edit — Order Override. Changes the status and courier details of an
 * order that the normal screens won't allow (a parcel marked returned by
 * mistake, a consignment booked by phone…). Owners and admins only; every
 * change is kept in the audit log with who made it.
 */
export default function SuperEditPage() {
  const { can } = useAuth()
  const [state, update] = useUrlState({ order: '' })
  const [q, setQ] = useState('')
  const term = useDebounce(q.trim(), 250)
  const results = useQuery({ queryKey: ['global-search', term], queryFn: () => globalSearch(term), enabled: term.length >= 3 })
  const picks = [
    ...(results.data?.orders ?? []).map((o) => ({ id: o.id, title: o.order_number, detail: `${o.customer_name} · ${o.customer_phone}`, status: o.status })),
    ...(results.data?.parcels ?? []).map((p) => ({ id: p.order_id, title: p.order_number, detail: `${p.courier} · ${p.consignment_id || p.tracking_number}`, status: null })),
  ].filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i)

  return (
    <div className="space-y-4">
      <PageHeader title="Super Edit"
        description="Order Override — change the status and courier details of an order when the normal workflow doesn't allow it. Every override is kept in the audit log." />
      {!can('orders.override') ? (
        <Card><CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground"><ShieldAlert className="size-5" /> Only owners and admins can override orders.</CardContent></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-sm">Find the order</CardTitle>
              <CardDescription>Order number, phone, consignment or tracking ID</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. ISO-10233, 01712345678, CN123…" aria-label="Find an order" />
              </div>
              {results.isFetching && <Spinner />}
              {term.length >= 3 && !results.isFetching && picks.length === 0 && <p className="text-sm text-muted-foreground">No order matches “{term}”.</p>}
              <ul className="grid gap-1">
                {picks.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => update({ order: p.id })}
                      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted/50 ${state.order === p.id ? 'border-ring bg-muted/50' : ''}`}>
                      <span className="min-w-0 flex-1"><span className="block font-medium">{p.title}</span><span className="block truncate text-xs text-muted-foreground">{p.detail}</span></span>
                      {p.status && <StatusBadge value={p.status} map={ORDER_STATUS} />}
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          {state.order ? <OverrideForm orderId={state.order} /> : (
            <Card className="min-w-0"><CardContent><EmptyState icon={<KeyRound className="size-5" />} title="Pick an order" description="Search on the left, then change its status or courier details here." /></CardContent></Card>
          )}
        </div>
      )}
      {can('orders.override') && <OverrideHistory />}
    </div>
  )
}

function OverrideForm({ orderId }: { orderId: string }) {
  const queryClient = useQueryClient()
  const order = useQuery({ queryKey: ['order', orderId], queryFn: () => getOrder(orderId) })
  const couriers = useQuery({ queryKey: ['couriers', 'all'], queryFn: () => listCouriers(false) })
  const o = order.data
  const shipment = useMemo(() => o?.shipments?.find((s) => s.is_active) ?? null, [o])

  const [status, setStatus] = useState<OrderStatus | ''>('')
  const [courierId, setCourierId] = useState('')
  const [tracking, setTracking] = useState('')
  const [consignment, setConsignment] = useState('')
  const [shipStatus, setShipStatus] = useState<ShipmentStatus | ''>('')
  const [cost, setCost] = useState('')
  const [cod, setCod] = useState('')
  const [returnCharge, setReturnCharge] = useState('')
  const [force, setForce] = useState(false)
  const [notify, setNotify] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    setStatus('')
    setCourierId(shipment?.courier_id ?? '')
    setTracking(shipment?.tracking_number ?? '')
    setConsignment(shipment?.consignment_id ?? '')
    setShipStatus('')
    setCost(shipment ? String(shipment.shipping_cost) : '')
    setCod(shipment ? String(shipment.cod_amount) : '')
    setReturnCharge(shipment ? String(shipment.return_charge) : '')
    setForce(false); setNotify(false)
  }, [orderId, shipment])

  const changes: OverrideChanges = {}
  if (status && o && status !== o.status) changes.status = status
  const ship: NonNullable<OverrideChanges['shipment']> = {}
  if (courierId && courierId !== (shipment?.courier_id ?? '')) ship.courier_id = courierId
  if (tracking !== (shipment?.tracking_number ?? '')) ship.tracking_number = tracking
  if (consignment !== (shipment?.consignment_id ?? '')) ship.consignment_id = consignment
  if (shipStatus) ship.status = shipStatus
  if (cost !== '' && toNumber(cost) !== toNumber(shipment?.shipping_cost)) ship.shipping_cost = toNumber(cost)
  if (cod !== '' && toNumber(cod) !== toNumber(shipment?.cod_amount)) ship.cod_amount = toNumber(cod)
  if (returnCharge !== '' && toNumber(returnCharge) !== toNumber(shipment?.return_charge)) ship.return_charge = toNumber(returnCharge)
  if (Object.keys(ship).length) changes.shipment = { ...ship, ...(shipment ? {} : { courier_id: courierId }) }
  const hasChanges = Object.keys(changes).length > 0

  const run = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      return overrideOrder(orderId, changes, '', force, notify)
    },
    onSuccess: (r) => {
      toast.success(r.mode === 'steps' ? `Done: ${r.path?.map((s) => ORDER_STATUS[s as OrderStatus]?.label ?? s).join(' → ')}`
        : r.mode === 'forced' ? 'Status set (forced). Stock and finance were not adjusted.' : 'Courier details saved')
      setConfirmOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['order', orderId] })
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      void queryClient.invalidateQueries({ queryKey: ['override-history'] })
    },
  })

  if (order.isLoading) return <Card><CardContent><LoadingState /></CardContent></Card>
  if (!o) return <Card><CardContent><EmptyState title="Order not found" /></CardContent></Card>

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Link to={`/admin/orders/${o.id}`} className="hover:underline">{o.order_number}</Link>
          <StatusBadge value={o.status} map={ORDER_STATUS} />
          <span className="font-normal text-muted-foreground">{o.customer_name} · {o.customer_phone} · <Money value={o.total_amount} /></span>
          <Button size="icon-sm" variant="ghost" asChild aria-label="Open order"><Link to={`/admin/orders/${o.id}`}><ExternalLink /></Link></Button>
        </CardTitle>
        <CardDescription>
          {shipment ? <>Courier: {shipment.couriers?.name} · {shipment.consignment_id || shipment.tracking_number || 'no consignment'} · <StatusBadge value={shipment.status} map={SHIPMENT_STATUS} /></> : 'Not booked with a courier'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (hasChanges) setConfirmOpen(true) }}>
          <Field label="Order status" htmlFor="se-status" hint="Allowed steps are walked one by one, so stock, finance and the courier record follow.">
            <Select value={status || o.status} onValueChange={(v) => setStatus(v as OrderStatus)}>
              <SelectTrigger id="se-status" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(ORDER_STATUS).map(([k, m]) => <SelectItem key={k} value={k}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>

          <fieldset className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <legend className="px-1 text-xs text-muted-foreground">Courier details</legend>
            <Field label="Courier" htmlFor="se-courier">
              <Select value={courierId} onValueChange={setCourierId}>
                <SelectTrigger id="se-courier" className="w-full"><SelectValue placeholder="Choose a courier" /></SelectTrigger>
                <SelectContent>{(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Parcel status" htmlFor="se-ship-status">
              <Select value={shipStatus || shipment?.status || 'BOOKED'} onValueChange={(v) => setShipStatus(v as ShipmentStatus)}>
                <SelectTrigger id="se-ship-status" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(SHIPMENT_STATUS).map(([k, m]) => <SelectItem key={k} value={k}>{m.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Consignment ID" htmlFor="se-cons"><Input id="se-cons" className="font-mono" value={consignment} onChange={(e) => setConsignment(e.target.value)} /></Field>
            <Field label="Tracking number" htmlFor="se-track"><Input id="se-track" className="font-mono" value={tracking} onChange={(e) => setTracking(e.target.value)} /></Field>
            <Field label="Delivery charge" htmlFor="se-cost"><Input id="se-cost" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
            <Field label="COD to collect" htmlFor="se-cod"><Input id="se-cod" type="number" min={0} step="0.01" value={cod} onChange={(e) => setCod(e.target.value)} /></Field>
            <Field label="Return charge" htmlFor="se-ret"><Input id="se-ret" type="number" min={0} step="0.01" value={returnCharge} onChange={(e) => setReturnCharge(e.target.value)} /></Field>
          </fieldset>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} className="mt-0.5" />
            <span>Force the status if there is no normal way to it<span className="block text-xs text-muted-foreground">Only the status changes — stock, finance and the courier record are not adjusted. Fix those separately.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} className="mt-0.5" />
            <span>Send the customer the usual messages<span className="block text-xs text-muted-foreground">Off: corrections are silent.</span></span>
          </label>
          <div className="flex justify-end">
            <Button type="submit" variant="destructive" disabled={!hasChanges}><AlertTriangle /> Review override</Button>
          </div>
        </form>
      </CardContent>

      <FormDialog open={confirmOpen} onOpenChange={(v) => { if (!v) run.reset(); setConfirmOpen(v) }} title={`Override ${o.order_number}?`} destructive
        description="This bypasses the normal workflow. Check the changes."
        submitLabel="Override order" onSubmit={() => run.mutate()} busy={run.isPending}>
        <ul className="grid gap-1 rounded-lg bg-muted/50 p-3 text-sm">
          {changes.status && <li>Status: <b>{ORDER_STATUS[o.status].label}</b> → <b>{ORDER_STATUS[changes.status].label}</b>{force ? ' (force allowed)' : ''}</li>}
          {changes.shipment && Object.entries(changes.shipment).map(([k, v]) => (
            <li key={k}>{k.replace(/_/g, ' ')}: <b>{k === 'courier_id' ? couriers.data?.find((c) => c.id === v)?.name : String(v || '—')}</b></li>
          ))}
          <li className="text-muted-foreground">{notify ? 'The customer gets the usual messages.' : 'No messages are sent to the customer.'}</li>
        </ul>
        {run.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{(run.error as Error).message.replace(/^[A-Z_]+: /, '')}</p>}
      </FormDialog>
    </Card>
  )
}

function OverrideHistory() {
  const history = useQuery({ queryKey: ['override-history'], queryFn: overrideHistory })
  const rows = history.data ?? []
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><History className="size-4" /> Recent overrides</CardTitle></CardHeader>
      <CardContent>
        {history.isLoading ? <LoadingState /> : rows.length === 0 ? <p className="text-sm text-muted-foreground">No overrides yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground"><tr className="border-b"><th className="py-1.5 text-left font-medium">When</th><th className="text-left font-medium">Order</th><th className="text-left font-medium">By</th><th className="text-left font-medium">Change</th><th className="text-left font-medium">Reason</th></tr></thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const before = r.old_values as { status?: OrderStatus } | null
                  const after = r.new_values as { status?: OrderStatus } | null
                  return (
                    <tr key={r.id}>
                      <td className="py-2 pr-3 whitespace-nowrap text-xs">{formatDateTime(r.created_at)}</td>
                      <td className="pr-3"><Link to={`/admin/orders/${r.order_id}`} className="hover:underline">{r.order_number ?? r.order_id.slice(0, 8)}</Link></td>
                      <td className="pr-3">{r.actor_name ?? r.actor_email}</td>
                      <td className="pr-3 text-xs">
                        {before?.status !== after?.status && before?.status && after?.status
                          ? <>{ORDER_STATUS[before.status]?.label} → {ORDER_STATUS[after.status]?.label}</> : 'Courier details'}
                        {r.mode === 'forced' && <Badge variant="warning" className="ml-1">forced</Badge>}
                      </td>
                      <td className="max-w-80 truncate text-xs text-muted-foreground" title={r.reason ?? ''}>{r.reason ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
