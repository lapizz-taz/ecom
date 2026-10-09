import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, MessageCircle, Minus, Phone, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { EmptyState, ErrorState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { waNumber } from '@/features/storefront/whatsapp-confirm'
import { useDebounce } from '@/hooks/use-debounce'
import { useStoreConfig } from '@/hooks/use-store-config'
import { invokeFunction } from '@/lib/functions'
import { formatMoney, timeAgo, toNumber } from '@/lib/format'
import { normalizePhone } from '@/lib/phone'
import { ORDER_STATUS } from '@/lib/status'
import { cn } from '@/lib/utils'
import { searchVariants, type VariantSearchRow } from '@/services/catalog'
import { adminQuote, type CourierLineRecord, getOrder, orderCustomerRecord, setOrderItems, updateOrder } from '@/services/orders'

interface Line { variant_id: string; name: string; sku: string; image: string | null; quantity: number; unit_price: number; available: number | null }

const NOTE_MAX = 350
const EDITABLE_STATUSES = ['PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED', 'CONFIRMED', 'PRE_ORDER',
  'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP']

const COURIER_NAME: Record<string, string> = {
  pathao: 'Pathao', steadfast: 'Steadfast', redx: 'RedX', carrybee: 'CarryBee', paperfly: 'Paperfly', parceldex: 'ParcelDex', courierfast: 'CourierFast',
}

/** Brand colours of the couriers BD Courier reports, for the record cards. */
const COURIER_STYLE: Record<string, string> = {
  pathao: 'bg-[#e8202a] text-white',
  steadfast: 'bg-[#13a37a] text-white',
  redx: 'bg-[#e11d2a] text-white',
  carrybee: 'bg-[#f5c518] text-black',
  paperfly: 'bg-[#1f6fd1] text-white',
  parceldex: 'bg-[#6d3fc0] text-white',
  courierfast: 'bg-[#1e3a8a] text-white',
}

export default function OrderEditPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  // Back to where staff came from (usually the order list), else to the order.
  const leave = () => (location.key !== 'default' ? navigate(-1) : navigate(`/admin/orders/${id}`))
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const { data: config } = useStoreConfig()
  const priceOverride = can('orders.price_override')
  const order = useQuery({ queryKey: ['order', id], queryFn: () => getOrder(id) })
  const record = useQuery({ queryKey: ['order-record', id], queryFn: () => orderCustomerRecord(id) })

  const [form, setForm] = useState({ phone: '', name: '', address: '', district: '', method: 'standard', note: '' })
  const [lines, setLines] = useState<Line[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const o = order.data
    if (!o || loaded) return
    setForm({ phone: o.customer_phone, name: o.customer_name, address: o.shipping_address, district: o.shipping_district, method: o.delivery_method, note: o.customer_note ?? '' })
    setLines(o.order_items.map((i) => ({
      variant_id: i.variant_id!, name: `${i.product_name}${i.variant_title ? ` · ${i.variant_title}` : ''}`, sku: i.sku ?? '',
      image: i.image_url, quantity: i.quantity, unit_price: toNumber(i.unit_price), available: null,
    })))
    setLoaded(true)
  }, [order.data, loaded])

  const o = order.data
  const itemsChanged = useMemo(() => {
    if (!o) return false
    const before = o.order_items.map((i) => `${i.variant_id}:${i.quantity}:${toNumber(i.unit_price)}`).sort().join()
    return before !== lines.map((l) => `${l.variant_id}:${l.quantity}:${l.unit_price}`).sort().join()
  }, [o, lines])
  const changes = useMemo(() => {
    if (!o) return {}
    const c: Record<string, unknown> = {}
    if (normalizePhone(form.phone) !== o.customer_phone) c.customer_phone = normalizePhone(form.phone)
    if (form.name.trim() !== o.customer_name) c.customer_name = form.name.trim()
    if (form.address.trim() !== o.shipping_address) c.shipping_address = form.address.trim()
    if (form.district !== o.shipping_district) c.shipping_district = form.district
    if (form.method !== o.delivery_method) c.delivery_method = form.method
    if (form.note.trim() !== (o.customer_note ?? '')) c.customer_note = form.note.trim()
    return c
  }, [o, form])
  const dirty = itemsChanged || Object.keys(changes).length > 0

  const quoteInput = useDebounce({ items: lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity, unit_price: priceOverride ? l.unit_price : undefined })), district: form.district, method: form.method }, 300)
  const quote = useQuery({
    queryKey: ['admin-quote', 'edit', id, quoteInput],
    enabled: loaded && itemsChanged && quoteInput.items.length > 0 && !!quoteInput.district,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: () => adminQuote(quoteInput.items, quoteInput.district, undefined, quoteInput.method),
  })

  const save = useMutation({
    mutationFn: async () => {
      if (itemsChanged) await setOrderItems(id, lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity, unit_price: priceOverride ? l.unit_price : undefined })))
      if (Object.keys(changes).length) await updateOrder(id, changes)
    },
    onSuccess: () => {
      toast.success(`Order ${o?.order_number} updated`)
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      void queryClient.invalidateQueries({ queryKey: ['order', id] })
      leave()
    },
  })

  const recheck = useMutation({
    mutationFn: () => invokeFunction('fraud-check', { phone: o!.customer_phone }),
    onSuccess: () => { toast.success('Courier history refreshed'); void record.refetch() },
  })

  if (order.error) return <ErrorState error={order.error} onRetry={() => order.refetch()} />
  if (!o) return <div className="grid place-items-center py-20"><Spinner /></div>
  const editable = EDITABLE_STATUSES.includes(o.status)
  const shipment = record.data?.shipment
  const check = record.data?.check
  const couriers = (check?.couriers ?? []) as CourierLineRecord[]
  const subtotal = lines.reduce((a, l) => a + l.quantity * l.unit_price, 0)
  const total = itemsChanged && quote.data
    ? toNumber(quote.data.subtotal) - toNumber(o.discount_total) + toNumber(o.delivery_charge) - toNumber(o.delivery_discount)
    : toNumber(o.total_amount)
  const wa = waNumber(o.customer_phone)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={leave} aria-label="Back"><ArrowLeft /></Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Edit order {o.order_number}</h1>
          <p className="text-xs text-muted-foreground">{ORDER_STATUS[o.status].label} · placed {timeAgo(o.created_at)} · <Link to={`/admin/orders/${o.id}`} className="underline">Open order</Link></p>
        </div>
      </div>

      {editable && shipment?.uploaded && (
        <div role="alert" className="flex gap-3 rounded-xl border border-amber-400/60 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-semibold">Order already uploaded to {shipment.courier}</p>
            <p>This order has been uploaded to {shipment.courier}{shipment.cod_amount !== null ? <> with amount to collect {formatMoney(shipment.cod_amount)}</> : null}
              {shipment.tracking_url && <> (<a href={shipment.tracking_url} target="_blank" rel="noreferrer" className="underline">{shipment.consignment_id ?? shipment.tracking_number}</a>)</>}.</p>
            <p className="text-muted-foreground">Any changes to items, prices or delivery charge will not reach the courier and create a mismatch with their records. Update the parcel in {shipment.courier}'s panel too.</p>
          </div>
        </div>
      )}
      {!editable && (
        <div className="rounded-xl border bg-muted/50 p-3 text-sm">This order is {ORDER_STATUS[o.status].label.toLowerCase()}; it can no longer be edited here. Use <Link to={`/admin/orders/super-edit?order=${o.id}`} className="underline">Super Edit</Link> for corrections.</div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 [&>*]:min-w-0">
        <RecordCard title="Our record" tone="bg-violet-500/90 text-white">
          {record.data ? (
            <ul className="space-y-1 text-xs">
              <Row label="Total" value={record.data.ours.total} strong />
              <Row label="Delivered" value={record.data.ours.delivered} />
              <Row label="In progress" value={record.data.ours.in_progress} />
              <Row label="Cancelled" value={record.data.ours.cancelled} />
              <Row label="Returned" value={record.data.ours.returned} />
            </ul>
          ) : <Spinner />}
        </RecordCard>
        <RecordCard title="Overall" tone="bg-foreground text-background"
          action={can('fraud.review') && (
            <button type="button" onClick={() => recheck.mutate()} disabled={recheck.isPending} aria-label="Check again" title="Check the courier history again"
              className="rounded p-0.5 hover:bg-white/15"><RefreshCw className={cn('size-3.5', recheck.isPending && 'animate-spin')} /></button>
          )}>
          {check ? (
            <Stats rate={check.rate} total={check.total} success={check.delivered} cancelled={check.cancelled}
              foot={check.verdict?.label ? `${check.verdict.label} · ${timeAgo(check.checked_at)}` : `Checked ${timeAgo(check.checked_at)}`} />
          ) : <p className="text-xs text-muted-foreground">{record.isLoading ? 'Loading…' : 'Not checked yet'}</p>}
        </RecordCard>
        {couriers.map((c) => (
          <RecordCard key={c.courier} title={c.name ?? COURIER_NAME[c.courier.replace(/[^a-z]/g, '')] ?? c.courier.replace(/^\w/, (x) => x.toUpperCase())}
            tone={COURIER_STYLE[c.courier.replace(/[^a-z]/g, '')] ?? 'bg-muted text-foreground'}>
            <Stats rate={c.success_ratio ?? (c.orders > 0 ? (100 * c.delivered) / c.orders : null)} total={c.rate_only ? c.parcel_range ?? '—' : c.orders}
              success={c.rate_only ? '—' : c.delivered} cancelled={c.rate_only ? '—' : c.cancelled} />
          </RecordCard>
        ))}
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-6 md:grid-cols-3">
          <Field label="Mobile number" htmlFor="e-phone">
            <div className="flex items-center gap-1.5">
              <Input id="e-phone" inputMode="tel" value={form.phone} disabled={!editable} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <Button size="icon" variant="ghost" asChild><a href={`tel:${o.customer_phone}`} aria-label="Call"><Phone className="text-emerald-600" /></a></Button>
              {wa && <Button size="icon" variant="ghost" asChild><a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label="WhatsApp"><MessageCircle className="text-emerald-600" /></a></Button>}
            </div>
          </Field>
          <Field label="Name" htmlFor="e-name"><Input id="e-name" value={form.name} disabled={!editable} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Delivery method">
            <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v })} disabled={!editable}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{(config?.delivery.methods ?? [{ code: 'standard', name: 'Standard' }]).map((m) => <SelectItem key={m.code} value={m.code}>{m.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Address" htmlFor="e-address">
            <Textarea id="e-address" rows={3} value={form.address} disabled={!editable} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <Field label="Shipping note" htmlFor="e-note" hint={`${form.note.length}/${NOTE_MAX}`}>
            <Textarea id="e-note" rows={3} maxLength={NOTE_MAX} value={form.note} disabled={!editable} placeholder="Enter shipping note" onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <Field label="District">
            <Select value={form.district} onValueChange={(v) => setForm({ ...form, district: v })} disabled={!editable}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose district" /></SelectTrigger>
              <SelectContent className="max-h-72">{[...new Set([o.shipping_district, ...(config?.delivery.districts ?? [])])].map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-sm">Ordered products <span className="rounded-full bg-muted px-2 text-xs">{lines.length}</span></CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {lines.length === 0 && <EmptyState title="No products" description="Add products from the list." />}
            {lines.map((l, idx) => (
              <div key={l.variant_id} className="grid gap-3 rounded-xl border p-3">
                <div className="flex gap-3">
                  {l.image
                    ? <img src={l.image} alt="" className="size-16 shrink-0 rounded-lg border bg-muted object-cover" onError={(e) => { e.currentTarget.removeAttribute('src') }} />
                    : <div className="size-16 shrink-0 rounded-lg border bg-muted" />}
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-mono text-xs text-muted-foreground">{l.sku}</p>
                    <p className="truncate font-medium">{l.name}</p>
                    <p className="text-xs text-muted-foreground">{formatMoney(l.unit_price)}{l.available !== null ? ` · Stock: ${l.available}` : ''}</p>
                  </div>
                  {editable && <Button variant="ghost" size="icon-sm" className="text-red-600" onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))} aria-label={`Remove ${l.name}`}><Trash2 /></Button>}
                </div>
                <div className="grid grid-cols-3 items-end gap-2">
                  <Stepper label="Qty" value={l.quantity} min={1} disabled={!editable}
                    onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, quantity: v } : x)))} />
                  <Stepper label="Price" value={l.unit_price} min={0} step={10} disabled={!editable || !priceOverride}
                    onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, unit_price: v } : x)))} />
                  <div className="grid min-w-0 grid-cols-1 gap-1"><span className="text-xs text-muted-foreground">Total</span>
                    <div className="flex h-9 items-center rounded-md border bg-muted/40 px-2 text-sm tabular-nums">{formatMoney(l.quantity * l.unit_price)}</div></div>
                </div>
              </div>
            ))}
            <dl className="space-y-1 border-t pt-3 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Products</dt><dd><Money value={itemsChanged && quote.data ? quote.data.subtotal : subtotal} /></dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Delivery</dt><dd><Money value={toNumber(o.delivery_charge) - toNumber(o.delivery_discount)} /></dd></div>
              {toNumber(o.discount_total) > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Discount</dt><dd><Money value={-toNumber(o.discount_total)} /></dd></div>}
              <div className="flex justify-between border-t pt-1 font-semibold"><dt>Total{itemsChanged ? ' (after saving)' : ''}</dt><dd><Money value={total} /></dd></div>
              {toNumber(o.amount_paid) > 0 && <div className="flex justify-between text-xs"><dt className="text-muted-foreground">Already paid</dt><dd><Money value={o.amount_paid} /></dd></div>}
              <div className="flex justify-between text-xs"><dt className="text-muted-foreground">Cash to collect</dt><dd><Money value={Math.max(total - toNumber(o.amount_paid), 0)} /></dd></div>
            </dl>
            {(quote.data?.stock_errors ?? []).map((e) => <p key={e.variant_id} className="text-xs text-destructive">{e.message}</p>)}
          </CardContent>
        </Card>

        {editable && <AddProducts onAdd={(v) => setLines((ls) => ls.some((l) => l.variant_id === v.variant_id)
          ? ls.map((l) => (l.variant_id === v.variant_id ? { ...l, quantity: l.quantity + 1 } : l))
          : [...ls, { variant_id: v.variant_id!, name: `${v.product_name}${v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''}`, sku: v.sku ?? '', image: null, quantity: 1, unit_price: toNumber(v.unit_price), available: v.track_inventory ? v.available : null }])} />}
      </div>

      {editable && (
        <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
          {save.error && <p className="mr-auto text-sm text-destructive">{(save.error as Error).message.replace(/^[A-Z_]+: /, '')}</p>}
          <Button variant="outline" onClick={leave}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending || lines.length === 0 || (quote.data?.stock_errors.length ?? 0) > 0}>
            {save.isPending && <Spinner />} Save changes
          </Button>
        </div>
      )}
    </div>
  )
}

function RecordCard({ title, tone, action, children }: { title: string; tone: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className={cn('flex items-center justify-between gap-2 px-3 py-1.5 text-xs font-semibold', tone)}>
        <span className="truncate">{title}</span>{action}
      </div>
      <div className="px-3 py-2">{children}</div>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return <li className={cn('flex justify-between gap-2', strong && 'font-semibold')}><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{value}</span></li>
}

function Stats({ rate, total, success, cancelled, foot }: { rate: number | null; total: number | string; success: number | string; cancelled: number | string; foot?: string }) {
  const tone = rate === null ? 'text-muted-foreground' : rate >= 80 ? 'text-emerald-600' : rate >= 50 ? 'text-amber-600' : 'text-red-600'
  const bar = rate === null ? 'bg-muted' : rate >= 80 ? 'bg-emerald-500' : rate >= 50 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="space-y-1 text-xs">
      <div className="flex justify-between"><span className="text-muted-foreground">Success rate</span><span className={cn('font-semibold tabular-nums', tone)}>{rate === null ? '—' : `${Math.round(rate)}%`}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Total</span><span className="tabular-nums">{total}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Success</span><span className="tabular-nums">{success}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Cancelled</span><span className="tabular-nums">{cancelled}</span></div>
      <div className="h-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', bar)} style={{ width: `${Math.min(Math.max(rate ?? 0, 0), 100)}%` }} /></div>
      {foot && <p className="truncate text-[11px] text-muted-foreground">{foot}</p>}
    </div>
  )
}

function Stepper({ label, value, onChange, min = 0, step = 1, disabled }: { label: string; value: number; onChange: (v: number) => void; min?: number; step?: number; disabled?: boolean }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex h-9 min-w-0 items-center rounded-md border">
        <button type="button" className="grid h-full w-8 shrink-0 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={disabled || value - step < min}
          onClick={() => onChange(Math.max(min, value - step))} aria-label={`Less ${label.toLowerCase()}`}><Minus className="size-3.5" /></button>
        <input className="h-full w-0 min-w-0 flex-1 bg-transparent text-center text-sm tabular-nums outline-none disabled:opacity-60" inputMode="numeric" value={value} disabled={disabled}
          aria-label={label} onChange={(e) => onChange(Math.max(min, Number(e.target.value.replace(/[^\d.]/g, '')) || min))} />
        <button type="button" className="grid h-full w-8 shrink-0 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={disabled}
          onClick={() => onChange(value + step)} aria-label={`More ${label.toLowerCase()}`}><Plus className="size-3.5" /></button>
      </div>
    </div>
  )
}

function AddProducts({ onAdd }: { onAdd: (v: VariantSearchRow) => void }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const term = useDebounce(code.trim() || name.trim(), 250)
  const results = useQuery({ queryKey: ['variant-search', 'edit', term], queryFn: () => searchVariants(term, 20), placeholderData: keepPreviousData })
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Click to add products</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Code / SKU" htmlFor="a-code"><Input id="a-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Type to search…" className="font-mono" /></Field>
          <Field label="Name" htmlFor="a-name"><Input id="a-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Type to search…" /></Field>
        </div>
        <ul className="max-h-[28rem] divide-y overflow-y-auto rounded-xl border">
          {(results.data ?? []).map((v) => {
            const out = v.track_inventory && (v.available ?? 0) <= 0
            return (
              <li key={v.variant_id}>
                <button type="button" onClick={() => onAdd(v)} disabled={!!out}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 disabled:opacity-50">
                  <div className="grid size-11 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground"><Search className="size-4" /></div>
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="truncate font-medium">{v.product_name}{v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''}</p>
                    <p className="truncate font-mono text-xs text-violet-600">SKU: {v.sku}</p>
                  </div>
                  <div className="text-right text-xs">
                    <p className="font-medium">{formatMoney(v.unit_price)}</p>
                    <p className="text-muted-foreground">{v.track_inventory ? `Stock: ${v.available ?? 0}` : 'Made to order'}</p>
                  </div>
                </button>
              </li>
            )
          })}
          {results.data?.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">No products match.</li>}
          {results.isLoading && <li className="grid place-items-center p-4"><Spinner /></li>}
        </ul>
      </CardContent>
    </Card>
  )
}
