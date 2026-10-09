import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, MessageCircle, Minus, Phone, Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { ErrorState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { SuccessPanel } from '@/features/orders/success-panel'
import { waNumber } from '@/features/storefront/whatsapp-confirm'
import { useDebounce } from '@/hooks/use-debounce'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatMoney, toNumber } from '@/lib/format'
import { normalizePhone } from '@/lib/phone'
import { ORDER_STATUS } from '@/lib/status'
import { cn } from '@/lib/utils'
import { searchVariants, type VariantSearchRow } from '@/services/catalog'
import { adminQuote, getOrder, orderCustomerRecord, setOrderItems, updateOrder } from '@/services/orders'

interface Line { variant_id: string; name: string; sku: string; image: string | null; quantity: number; unit_price: number; available: number | null }

const NOTE_MAX = 350
const EDITABLE_STATUSES = ['PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED', 'CONFIRMED', 'PRE_ORDER',
  'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP']

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

  if (order.error) return <ErrorState error={order.error} onRetry={() => order.refetch()} />
  if (!o) return <div className="grid place-items-center py-20"><Spinner /></div>
  const editable = EDITABLE_STATUSES.includes(o.status)
  const shipment = record.data?.shipment
  const subtotal = lines.reduce((a, l) => a + l.quantity * l.unit_price, 0)
  const total = itemsChanged && quote.data
    ? toNumber(quote.data.subtotal) - toNumber(o.discount_total) + toNumber(o.delivery_charge) - toNumber(o.delivery_discount)
    : toNumber(o.total_amount)
  const wa = waNumber(o.customer_phone)
  const addLine = (v: VariantSearchRow) => setLines((ls) => ls.some((l) => l.variant_id === v.variant_id)
    ? ls.map((l) => (l.variant_id === v.variant_id ? { ...l, quantity: l.quantity + 1 } : l))
    : [...ls, { variant_id: v.variant_id!, name: `${v.product_name}${v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''}`, sku: v.sku ?? '', image: null, quantity: 1, unit_price: toNumber(v.unit_price), available: v.track_inventory ? v.available : null }])

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={leave} aria-label="Back"><ArrowLeft /></Button>
        <h1 className="text-lg font-semibold">{o.order_number}</h1>
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{ORDER_STATUS[o.status].label}</span>
        <Link to={`/admin/orders/${o.id}`} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Open order</Link>
      </div>

      {editable && shipment?.uploaded && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <AlertTriangle className="size-4 shrink-0" />
          <span>Already with {shipment.courier}{shipment.tracking_url ? <> (<a href={shipment.tracking_url} target="_blank" rel="noreferrer" className="underline">{shipment.consignment_id ?? shipment.tracking_number}</a>)</> : ''} — changes here won't reach the courier.</span>
        </p>
      )}
      {!editable && (
        <p className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">This order can't be edited any more. Use <Link to={`/admin/orders/super-edit?order=${o.id}`} className="text-foreground underline">Super Edit</Link>.</p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Phone" htmlFor="e-phone">
                <div className="flex items-center gap-1">
                  <Input id="e-phone" inputMode="tel" value={form.phone} disabled={!editable} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  <Button size="icon" variant="ghost" asChild><a href={`tel:${o.customer_phone}`} aria-label="Call"><Phone /></a></Button>
                  {wa && <Button size="icon" variant="ghost" asChild><a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label="WhatsApp"><MessageCircle /></a></Button>}
                </div>
              </Field>
              <Field label="Name" htmlFor="e-name"><Input id="e-name" value={form.name} disabled={!editable} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Address" htmlFor="e-address" className="sm:col-span-2">
                <Input id="e-address" value={form.address} disabled={!editable} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </Field>
              <Field label="District">
                <Select value={form.district} onValueChange={(v) => setForm({ ...form, district: v })} disabled={!editable}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="District" /></SelectTrigger>
                  <SelectContent className="max-h-72">{[...new Set([o.shipping_district, ...(config?.delivery.districts ?? [])])].map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Delivery">
                <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v })} disabled={!editable}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{(config?.delivery.methods ?? [{ code: 'standard', name: 'Standard' }]).map((m) => <SelectItem key={m.code} value={m.code}>{m.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Note" htmlFor="e-note" className="sm:col-span-2">
                <Textarea id="e-note" rows={2} maxLength={NOTE_MAX} value={form.note} disabled={!editable} placeholder="Shipping note" onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Products</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {lines.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No products</p>}
              {lines.map((l, idx) => (
                <div key={l.variant_id} className="flex flex-wrap items-center gap-3 rounded-lg border p-2">
                  <Thumb src={l.image} />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="truncate font-medium">{l.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{l.sku}{l.available !== null ? ` · ${l.available} in stock` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Stepper label="Qty" value={l.quantity} min={1} disabled={!editable}
                      onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, quantity: v } : x)))} />
                    <Stepper label="Price" value={l.unit_price} min={0} step={10} disabled={!editable || !priceOverride}
                      onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, unit_price: v } : x)))} />
                    <span className="w-20 text-right text-sm font-medium tabular-nums">{formatMoney(l.quantity * l.unit_price)}</span>
                    {editable && <Button variant="ghost" size="icon-sm" onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))} aria-label={`Remove ${l.name}`}><X /></Button>}
                  </div>
                </div>
              ))}
              {(quote.data?.stock_errors ?? []).map((e) => <p key={e.variant_id} className="text-xs text-destructive">{e.message}</p>)}
              {editable && <AddProducts onAdd={addLine} />}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card><CardContent><SuccessPanel orderId={o.id} phone={o.customer_phone} compact /></CardContent></Card>
          <Card>
            <CardContent>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">Products</dt><dd><Money value={itemsChanged && quote.data ? quote.data.subtotal : subtotal} /></dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Delivery</dt><dd><Money value={toNumber(o.delivery_charge) - toNumber(o.delivery_discount)} /></dd></div>
                {toNumber(o.discount_total) > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Discount</dt><dd><Money value={-toNumber(o.discount_total)} /></dd></div>}
                {toNumber(o.amount_paid) > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Paid</dt><dd><Money value={-toNumber(o.amount_paid)} /></dd></div>}
                <div className="flex justify-between border-t pt-1.5 font-semibold"><dt>To collect</dt><dd><Money value={Math.max(total - toNumber(o.amount_paid), 0)} /></dd></div>
              </dl>
              {editable && (
                <div className="mt-4 grid gap-2">
                  <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending || lines.length === 0 || (quote.data?.stock_errors.length ?? 0) > 0}>
                    {save.isPending && <Spinner />} Save
                  </Button>
                  <Button variant="ghost" onClick={leave}>Cancel</Button>
                  {save.error && <p className="text-sm text-destructive">{(save.error as Error).message.replace(/^[A-Z_]+: /, '')}</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Thumb({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false)
  if (!src || broken) return <div className="size-10 shrink-0 rounded-md border bg-muted" />
  return <img src={src} alt="" className="size-10 shrink-0 rounded-md border bg-muted object-cover" onError={() => setBroken(true)} />
}

function Stepper({ label, value, onChange, min = 0, step = 1, disabled }: { label: string; value: number; onChange: (v: number) => void; min?: number; step?: number; disabled?: boolean }) {
  return (
    <div className={cn('flex h-8 min-w-0 items-center rounded-md border', label === 'Qty' ? 'w-24' : 'w-28')}>
      <button type="button" className="grid h-full w-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={disabled || value - step < min}
        onClick={() => onChange(Math.max(min, value - step))} aria-label={`Less ${label.toLowerCase()}`}><Minus className="size-3.5" /></button>
      <input className="h-full w-0 min-w-0 flex-1 bg-transparent text-center text-sm tabular-nums outline-none disabled:opacity-60" inputMode="numeric" value={value} disabled={disabled}
        aria-label={label} onChange={(e) => onChange(Math.max(min, Number(e.target.value.replace(/[^\d.]/g, '')) || min))} />
      <button type="button" className="grid h-full w-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={disabled}
        onClick={() => onChange(value + step)} aria-label={`More ${label.toLowerCase()}`}><Plus className="size-3.5" /></button>
    </div>
  )
}

function AddProducts({ onAdd }: { onAdd: (v: VariantSearchRow) => void }) {
  const [q, setQ] = useState('')
  const term = useDebounce(q.trim(), 250)
  const results = useQuery({ queryKey: ['variant-search', 'edit', term], queryFn: () => searchVariants(term, 8), enabled: term.length > 0, placeholderData: keepPreviousData })
  return (
    <div className="space-y-1 pt-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add product — name or SKU" className="pl-8" aria-label="Add product" />
      </div>
      {term && (
        <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
          {(results.data ?? []).map((v) => {
            const out = v.track_inventory && (v.available ?? 0) <= 0
            return (
              <li key={v.variant_id}>
                <button type="button" onClick={() => { onAdd(v); setQ('') }} disabled={!!out}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 disabled:opacity-50">
                  <span className="min-w-0 flex-1 truncate">{v.product_name}{v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''} <span className="text-xs text-muted-foreground">{v.sku}</span></span>
                  <span className="text-xs text-muted-foreground">{v.track_inventory ? `${v.available ?? 0} left` : 'To order'}</span>
                  <span className="w-16 text-right tabular-nums">{formatMoney(v.unit_price)}</span>
                </button>
              </li>
            )
          })}
          {results.data?.length === 0 && <li className="p-3 text-center text-sm text-muted-foreground">No products match.</li>}
          {results.isLoading && <li className="grid place-items-center p-3"><Spinner /></li>}
        </ul>
      )}
    </div>
  )
}
