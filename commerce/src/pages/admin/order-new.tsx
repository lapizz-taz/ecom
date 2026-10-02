import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { VariantPicker } from '@/features/products/variant-picker'
import { useDebounce } from '@/hooks/use-debounce'
import { useStoreConfig } from '@/hooks/use-store-config'
import { invokeFunction } from '@/lib/functions'
import { formatMoney, toNumber } from '@/lib/format'
import { normalizePhone } from '@/lib/phone'
import { supabase } from '@/lib/supabase'
import { PAYMENT_METHOD } from '@/lib/status'
import { variantsByIds } from '@/services/catalog'
import { adminQuote, createManualOrder, getCheckoutLead, linkCheckoutLead, MANUAL_SOURCES, setOrderSource } from '@/services/orders'
import type { Enums } from '@/types/database'

interface Line {
  variant_id: string
  label: string
  sku: string
  quantity: number
  unit_price: number
  available: number | null
}

export default function NewOrderPage() {
  const navigate = useNavigate()
  const { can } = useAuth()
  const { data: config } = useStoreConfig()
  const [customer, setCustomer] = useState({ full_name: '', phone: '', email: '' })
  const [shipping, setShipping] = useState({ address: '', area: '', city: '', district: '', postal_code: '' })
  const [lines, setLines] = useState<Line[]>([])
  const [method, setMethod] = useState('standard')
  const [paymentMethod, setPaymentMethod] = useState<Enums<'payment_method'>>('COD')
  const [coupon, setCoupon] = useState('')
  const [discount, setDiscount] = useState('')
  const [deliveryOverride, setDeliveryOverride] = useState('')
  const [customerNote, setCustomerNote] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [afterCreate, setAfterCreate] = useState<'confirm' | 'fraud' | 'pending'>('confirm')
  const [orderSource, setOrderSourceChoice] = useState('')
  const priceOverride = can('orders.price_override')

  // Started from an incomplete checkout: bring in what the visitor typed and their cart.
  const [params] = useSearchParams()
  const leadId = params.get('lead')
  const lead = useQuery({ queryKey: ['checkout-lead', leadId], enabled: !!leadId, queryFn: () => getCheckoutLead(leadId!) })
  const prefilled = useRef(false)
  useEffect(() => {
    const l = lead.data
    if (!l || prefilled.current) return
    prefilled.current = true
    setCustomer((c) => ({ ...c, full_name: l.customer_name ?? '', phone: l.phone }))
    setShipping((s) => ({ ...s, address: l.address ?? '', district: l.district ?? '', area: l.area ?? '' }))
    const items = (Array.isArray(l.items) ? l.items : []) as Array<{ variant_id?: string; quantity?: number }>
    void variantsByIds(items.flatMap((i) => (i.variant_id ? [i.variant_id] : []))).then((variants) => {
      setLines(variants.map((v) => ({
        variant_id: v.variant_id!,
        label: `${v.product_name}${v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''}`,
        sku: v.sku ?? '',
        quantity: Math.max(1, items.find((i) => i.variant_id === v.variant_id)?.quantity ?? 1),
        unit_price: toNumber(v.unit_price),
        available: v.track_inventory ? v.available : null,
      })))
    }).catch(() => toast.warning('Could not load the cart from the checkout — add the products by hand'))
  }, [lead.data])

  // Pre-fill from an existing customer when the phone matches.
  const phone = useDebounce(normalizePhone(customer.phone), 400)
  const known = useQuery({
    queryKey: ['customer-by-phone', phone],
    enabled: phone.length >= 10 && can('customers.view'),
    queryFn: async () => {
      const { data } = await supabase.from('customers').select('id, full_name, email, address, area, city, district, segment, status, total_orders, delivered_orders').eq('phone', phone).maybeSingle()
      return data
    },
  })

  const quoteInput = useDebounce({ lines: lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity, unit_price: priceOverride ? l.unit_price : undefined })), district: shipping.district, area: shipping.area, method, coupon }, 300)
  const quote = useQuery({
    queryKey: ['admin-quote', quoteInput],
    enabled: quoteInput.lines.length > 0 && Boolean(quoteInput.district),
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: () => adminQuote(quoteInput.lines, quoteInput.district, quoteInput.area, quoteInput.method, quoteInput.coupon, phone),
  })

  const create = useMutation({
    mutationFn: async () => {
      const order = await createManualOrder({
        customer: { full_name: customer.full_name, phone: normalizePhone(customer.phone), email: customer.email || null },
        shipping: { ...shipping, area: shipping.area || null, city: shipping.city || null, postal_code: shipping.postal_code || null },
        items: lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity, unit_price: priceOverride ? l.unit_price : undefined })),
        delivery_method: method,
        payment_method: paymentMethod,
        coupon_code: coupon || null,
        manual_discount: priceOverride && discount ? Number(discount) : 0,
        delivery_charge: priceOverride && deliveryOverride !== '' ? Number(deliveryOverride) : null,
        customer_note: customerNote || null,
        internal_note: internalNote || null,
      }, afterCreate === 'confirm')
      if (order?.id && leadId) {
        await linkCheckoutLead(leadId, order.id).catch(() => toast.warning('Order created, but it could not be linked to the checkout'))
      } else if (order?.id && orderSource) {
        await setOrderSource(order.id, orderSource).catch(() => toast.warning('Order created, but its source could not be saved'))
      }
      if (afterCreate === 'fraud' && order?.id) {
        await invokeFunction('fraud-check', { order_id: order.id, apply: true }).catch(() => toast.warning('Order created, but the fraud check could not run'))
      }
      return order
    },
    onSuccess: (order) => {
      toast.success(`Order ${order?.order_number} created`)
      navigate(`/admin/orders/${order?.id}`)
    },
  })

  const applyKnown = () => {
    if (!known.data) return
    setCustomer((c) => ({ ...c, full_name: c.full_name || known.data!.full_name, email: c.email || known.data!.email || '' }))
    setShipping((s) => ({
      ...s, address: s.address || known.data!.address || '', area: s.area || known.data!.area || '',
      city: s.city || known.data!.city || '', district: s.district || known.data!.district || '',
    }))
  }

  const q = quote.data
  const ready = customer.full_name.trim().length > 1 && phone.length >= 8 && shipping.address.trim().length > 4 && shipping.district && lines.length > 0

  return (
    <div className="space-y-4">
      <PageHeader title="New order" description="Phone, Messenger or walk-in orders. Prices, stock and delivery are checked on the server." />
      {lead.data && (
        <div className="rounded-lg border bg-card p-3 text-sm">
          From an incomplete checkout · {lead.data.phone}{lead.data.source ? <> · came from <span className="font-medium">{lead.data.source}</span></> : ''}.
          {' '}<span className="text-muted-foreground">The order keeps the visitor's ad source.</span>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Products</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <VariantPicker onPick={(v) => setLines((ls) => ls.some((l) => l.variant_id === v.variant_id)
                ? ls.map((l) => (l.variant_id === v.variant_id ? { ...l, quantity: l.quantity + 1 } : l))
                : [...ls, { variant_id: v.variant_id!, label: `${v.product_name}${v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''}`, sku: v.sku ?? '', quantity: 1, unit_price: toNumber(v.unit_price), available: v.track_inventory ? v.available : null }])} />
              {lines.length === 0 ? <p className="text-sm text-muted-foreground">Search and add products.</p> : (
                <ul className="divide-y rounded-md border">
                  {lines.map((l, idx) => (
                    <li key={l.variant_id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                      <div className="min-w-40 flex-1">
                        <p className="font-medium">{l.label}</p>
                        <p className="text-xs text-muted-foreground">{l.sku}{l.available !== null ? ` · ${l.available} available` : ''}</p>
                      </div>
                      <Input type="number" min={1} className="h-8 w-20" value={l.quantity} aria-label="Quantity"
                        onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x)))} />
                      <Input type="number" min={0} className="h-8 w-28" value={l.unit_price} disabled={!priceOverride} aria-label="Unit price"
                        onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, unit_price: Number(e.target.value) } : x)))} />
                      <span className="w-24 text-right tabular-nums">{formatMoney(l.quantity * l.unit_price)}</span>
                      <Button variant="ghost" size="icon-sm" onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))} aria-label="Remove"><Trash2 /></Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Customer & delivery</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone" htmlFor="n-phone" required>
                <Input id="n-phone" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} inputMode="tel" />
              </Field>
              <Field label="Name" htmlFor="n-name" required><Input id="n-name" value={customer.full_name} onChange={(e) => setCustomer({ ...customer, full_name: e.target.value })} /></Field>
              {known.data && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/60 p-2 text-sm sm:col-span-2">
                  <span>Existing customer <strong>{known.data.full_name}</strong> · {known.data.total_orders} orders, {known.data.delivered_orders} delivered{known.data.status === 'BLOCKED' ? ' · BLOCKED' : ''}</span>
                  <Button size="sm" variant="outline" onClick={applyKnown}>Use saved details</Button>
                </div>
              )}
              <Field label="Email" htmlFor="n-email"><Input id="n-email" value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} /></Field>
              <Field label="District" required>
                <Select value={shipping.district} onValueChange={(v) => setShipping({ ...shipping, district: v })}>
                  <SelectTrigger><SelectValue placeholder="Choose district" /></SelectTrigger>
                  <SelectContent className="max-h-72">{(config?.delivery.districts ?? []).map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Address" htmlFor="n-address" required className="sm:col-span-2">
                <Textarea id="n-address" rows={2} value={shipping.address} onChange={(e) => setShipping({ ...shipping, address: e.target.value })} />
              </Field>
              <Field label="Area" htmlFor="n-area"><Input id="n-area" value={shipping.area} onChange={(e) => setShipping({ ...shipping, area: e.target.value })} /></Field>
              <Field label="City" htmlFor="n-city"><Input id="n-city" value={shipping.city} onChange={(e) => setShipping({ ...shipping, city: e.target.value })} /></Field>
              <Field label="Delivery method">
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{(config?.delivery.methods ?? [{ code: 'standard', name: 'Standard' }]).map((m) => <SelectItem key={m.code} value={m.code}>{m.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Payment method">
                <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as typeof paymentMethod)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(PAYMENT_METHOD).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Customer note" htmlFor="n-cnote"><Input id="n-cnote" value={customerNote} onChange={(e) => setCustomerNote(e.target.value)} /></Field>
              <Field label="Internal note" htmlFor="n-inote"><Input id="n-inote" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} /></Field>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 lg:sticky lg:top-20 lg:h-fit">
          <Card>
            <CardHeader><CardTitle className="text-sm">Summary</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Field label="Coupon" htmlFor="n-coupon"><Input id="n-coupon" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} /></Field>
              {coupon && q?.coupon && !q.coupon.valid && <p className="text-xs text-destructive">{q.coupon.message}</p>}
              {priceOverride && (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Extra discount" htmlFor="n-disc"><Input id="n-disc" type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
                  <Field label="Delivery override" htmlFor="n-del"><Input id="n-del" type="number" min={0} value={deliveryOverride} onChange={(e) => setDeliveryOverride(e.target.value)} placeholder={q ? String(q.delivery_charge) : ''} /></Field>
                </div>
              )}
              <dl className="space-y-1.5 border-t pt-3">
                <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd><Money value={q?.subtotal ?? lines.reduce((s, l) => s + l.quantity * l.unit_price, 0)} /></dd></div>
                {toNumber(q?.coupon_discount) > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Coupon</dt><dd><Money value={-toNumber(q?.coupon_discount)} /></dd></div>}
                {Number(discount) > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Discount</dt><dd><Money value={-Number(discount)} /></dd></div>}
                <div className="flex justify-between"><dt className="text-muted-foreground">Delivery{q?.delivery_zone ? ` · ${q.delivery_zone.name}` : ''}</dt>
                  <dd><Money value={deliveryOverride !== '' ? Number(deliveryOverride) : toNumber(q?.delivery_charge) - toNumber(q?.delivery_discount)} /></dd></div>
                <div className="flex justify-between border-t pt-1.5 font-semibold"><dt>Total</dt>
                  <dd><Money value={toNumber(q?.subtotal) - toNumber(q?.coupon_discount) - Number(discount || 0)
                    + (deliveryOverride !== '' ? Number(deliveryOverride) : toNumber(q?.delivery_charge) - toNumber(q?.delivery_discount))} /></dd></div>
                {can('finance.view') && q?.cost_total !== undefined && <div className="flex justify-between text-xs text-muted-foreground"><dt>Cost of goods</dt><dd><Money value={q.cost_total} /></dd></div>}
              </dl>
              {(q?.stock_errors ?? []).map((e) => <p key={e.variant_id} className="text-xs text-destructive">{e.message}</p>)}
              {quote.error && <p className="text-xs text-destructive">{(quote.error as Error).message.replace(/^[A-Z_]+: /, '')}</p>}
              {!leadId && (
                <Field label="Where did this order come from?" htmlFor="n-source" hint="Shown in reports next to website orders.">
                  <Select value={orderSource} onValueChange={setOrderSourceChoice}>
                    <SelectTrigger id="n-source"><SelectValue placeholder="Choose…" /></SelectTrigger>
                    <SelectContent>{MANUAL_SOURCES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              )}
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">After creating</p>
                {[
                  { v: 'confirm', l: 'Approve now (confirmed on the call)' },
                  { v: 'fraud', l: 'Run fraud check & apply rules', perm: 'fraud.review' },
                  { v: 'pending', l: 'Send to Web Orders to call' },
                ].filter((o) => !o.perm || can(o.perm)).map((o) => (
                  <label key={o.v} className="flex items-center gap-2 text-sm">
                    <Switch checked={afterCreate === o.v} onCheckedChange={(on) => on && setAfterCreate(o.v as typeof afterCreate)} /> {o.l}
                  </label>
                ))}
              </div>
              <Button className="w-full" size="lg" disabled={!ready || create.isPending || (q?.stock_errors.length ?? 0) > 0} onClick={() => create.mutate()}>
                {create.isPending && <Spinner />} Create order
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
