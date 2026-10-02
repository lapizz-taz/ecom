import { useMutation, useQuery } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { VariantPicker } from '@/features/products/variant-picker'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatMoney, toNumber } from '@/lib/format'
import { PAYMENT_CHANNEL, PAYMENT_METHOD, SHIPMENT_STATUS } from '@/lib/status'
import { listCouriers } from '@/services/couriers'
import {
  applyShipmentStatus, assignCourier, bookWithCourierApi, type OrderDetail, processReturn, recordPayment, refundOrder,
  retainAdvance, setOrderItems, updateOrder, updateShipment,
} from '@/services/orders'
import type { Enums } from '@/types/database'

type Channel = Enums<'payment_channel'>
const CHANNELS = Object.keys(PAYMENT_CHANNEL) as Channel[]

function FormDialog({ open, onOpenChange, title, description, children, submitLabel, onSubmit, busy, disabled, wide }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: ReactNode
  children: ReactNode
  submitLabel: string
  onSubmit: () => void
  busy?: boolean
  disabled?: boolean
  wide?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={wide ? 'sm:max-w-2xl' : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || disabled}>{busy && <Spinner />} {submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface DialogProps {
  order: OrderDetail
  open: boolean
  onOpenChange: (o: boolean) => void
  onDone: () => void
}

function ChannelSelect({ value, onChange }: { value: Channel; onChange: (v: Channel) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Channel)}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>{CHANNELS.map((c) => <SelectItem key={c} value={c}>{PAYMENT_CHANNEL[c]}</SelectItem>)}</SelectContent>
    </Select>
  )
}

export function RecordPaymentDialog({ order, open, onOpenChange, onDone }: DialogProps) {
  const due = toNumber(order.total_amount) - toNumber(order.amount_paid)
  const advanceDue = Math.max(toNumber(order.advance_required) - toNumber(order.amount_paid), 0)
  const [kind, setKind] = useState<Enums<'order_payment_kind'>>(advanceDue > 0 ? 'ADVANCE' : 'BALANCE')
  const [channel, setChannel] = useState<Channel>('BKASH')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [key, setKey] = useState(() => crypto.randomUUID())
  useEffect(() => {
    if (open) {
      setAmount(String(advanceDue > 0 ? advanceDue : due))
      setKey(crypto.randomUUID())
    }
  }, [open, advanceDue, due])
  const save = useMutation({
    mutationFn: () => recordPayment({ orderId: order.id, kind, channel, amount: Number(amount), reference, note, idempotencyKey: key }),
    onSuccess: () => { toast.success('Payment recorded'); onOpenChange(false); onDone() },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Record payment" submitLabel="Record payment"
      description={<>Money already received outside the website. Due: <Money value={due} />{advanceDue > 0 && <> · advance due <Money value={advanceDue} /></>}</>}
      onSubmit={() => save.mutate()} busy={save.isPending} disabled={!(Number(amount) > 0)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type">
          <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ADVANCE">Advance</SelectItem>
              <SelectItem value="FULL">Full payment</SelectItem>
              <SelectItem value="BALANCE">Balance</SelectItem>
              <SelectItem value="COD">Cash on delivery</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Method"><ChannelSelect value={channel} onChange={setChannel} /></Field>
        <Field label="Amount" htmlFor="pay-amount"><Input id="pay-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reference / TrxID" htmlFor="pay-ref"><Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>
      <Field label="Note" htmlFor="pay-note"><Textarea id="pay-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDialog>
  )
}

export function RefundDialog({ order, open, onOpenChange, onDone }: DialogProps) {
  const [amount, setAmount] = useState('')
  const [channel, setChannel] = useState<Channel>('BKASH')
  const [reason, setReason] = useState('')
  const [key, setKey] = useState(() => crypto.randomUUID())
  useEffect(() => {
    if (open) { setAmount(String(toNumber(order.amount_paid))); setKey(crypto.randomUUID()) }
  }, [open, order.amount_paid])
  const save = useMutation({
    mutationFn: () => refundOrder({ orderId: order.id, amount: Number(amount), channel, reason, idempotencyKey: key }),
    onSuccess: () => { toast.success('Refund recorded'); onOpenChange(false); onDone() },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Refund customer" submitLabel="Record refund"
      description={<>Paid so far: <Money value={order.amount_paid} />. Refunds on delivered orders reduce revenue; advance refunds on undelivered orders don't touch profit.</>}
      onSubmit={() => save.mutate()} busy={save.isPending} disabled={!(Number(amount) > 0) || !reason.trim()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount" htmlFor="refund-amount"><Input id="refund-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Refunded via"><ChannelSelect value={channel} onChange={setChannel} /></Field>
      </div>
      <Field label="Reason" htmlFor="refund-reason" required><Textarea id="refund-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormDialog>
  )
}

export function RetainAdvanceDialog({ order, open, onOpenChange, onDone }: DialogProps) {
  const [note, setNote] = useState('')
  const save = useMutation({
    mutationFn: () => retainAdvance(order.id, note),
    onSuccess: () => { toast.success('Advance recorded as income'); onOpenChange(false); onDone() },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Keep the advance" submitLabel="Keep advance as income"
      description={<>The <Money value={order.amount_paid} /> advance becomes other income (e.g. to cover delivery and return charges).</>}
      onSubmit={() => save.mutate()} busy={save.isPending} disabled={!note.trim()}>
      <Field label="Reason" htmlFor="retain-note" required><Textarea id="retain-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDialog>
  )
}

export function AssignCourierDialog({ order, open, onOpenChange, onDone }: DialogProps) {
  const active = order.shipments.find((s) => s.is_active)
  const couriers = useQuery({ queryKey: ['couriers', 'active'], queryFn: () => listCouriers(true), enabled: open })
  const [courierId, setCourierId] = useState(active?.courier_id ?? '')
  const [tracking, setTracking] = useState(active?.tracking_number ?? '')
  const [cost, setCost] = useState(active ? String(active.shipping_cost) : '')
  const [note, setNote] = useState('')
  const courier = couriers.data?.find((c) => c.id === courierId)
  useEffect(() => {
    if (courier && !cost && courier.default_shipping_cost != null) setCost(String(courier.default_shipping_cost))
  }, [courier, cost])
  const manual = useMutation({
    mutationFn: () => assignCourier({ orderId: order.id, courierId, trackingNumber: tracking, shippingCost: cost === '' ? null : Number(cost), note }),
    onSuccess: () => { toast.success('Courier assigned'); onOpenChange(false); onDone() },
  })
  const api = useMutation({
    mutationFn: () => bookWithCourierApi(order.id, courierId, note),
    onSuccess: () => { toast.success(`Booked with ${courier?.name}`); onOpenChange(false); onDone() },
  })
  const busy = manual.isPending || api.isPending
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{active ? 'Update courier' : 'Assign courier'}</DialogTitle>
          <DialogDescription>COD to collect: <Money value={order.cod_amount} /></DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Courier">
            <Select value={courierId} onValueChange={setCourierId}>
              <SelectTrigger><SelectValue placeholder="Choose courier" /></SelectTrigger>
              <SelectContent>{(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}{c.api_enabled ? ' · API' : ''}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tracking number" htmlFor="tracking" hint={courier?.api_enabled ? 'Leave empty to book through the courier API' : undefined}>
              <Input id="tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} />
            </Field>
            <Field label="Shipping cost (paid to courier)" htmlFor="ship-cost"><Input id="ship-cost" type="number" min="0" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
          </div>
          <Field label="Note" htmlFor="ship-note"><Input id="ship-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          {courier?.api_enabled && !tracking && (
            <Button variant="secondary" onClick={() => api.mutate()} disabled={busy}>{api.isPending && <Spinner />} Book via {courier.name} API</Button>
          )}
          <Button onClick={() => manual.mutate()} disabled={busy || !courierId}>{manual.isPending && <Spinner />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ShipmentStatusDialog({ order, open, onOpenChange, onDone }: DialogProps) {
  const shipment = order.shipments.find((s) => s.is_active)
  const [status, setStatus] = useState<Enums<'shipment_status'>>('IN_TRANSIT')
  const [description, setDescription] = useState('')
  const [returnCharge, setReturnCharge] = useState(String(shipment?.return_charge ?? ''))
  const save = useMutation({
    mutationFn: async () => {
      if (!shipment) return
      if (returnCharge !== '' && Number(returnCharge) !== toNumber(shipment.return_charge)) {
        await updateShipment(shipment.id, { return_charge: Number(returnCharge) })
      }
      await applyShipmentStatus(shipment.id, status, description)
    },
    onSuccess: () => { toast.success('Shipment updated'); onOpenChange(false); onDone() },
  })
  if (!shipment) return null
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Update delivery status" submitLabel="Update"
      description="Courier status updates move the order automatically (picked up → shipped, delivered → delivered, returned → failed delivery)."
      onSubmit={() => save.mutate()} busy={save.isPending}>
      <Field label="Courier status">
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(SHIPMENT_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label="Details" htmlFor="ship-desc"><Input id="ship-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Customer not reachable" /></Field>
      <Field label="Return charge (if returned)" htmlFor="ret-charge"><Input id="ret-charge" type="number" min="0" value={returnCharge} onChange={(e) => setReturnCharge(e.target.value)} /></Field>
    </FormDialog>
  )
}

export function EditOrderDialog({ order, open, onOpenChange, onDone }: DialogProps) {
  const { can } = useAuth()
  const { data: config } = useStoreConfig()
  const [values, setValues] = useState(() => ({
    customer_name: order.customer_name, customer_phone: order.customer_phone, customer_email: order.customer_email ?? '',
    shipping_address: order.shipping_address, shipping_area: order.shipping_area ?? '', shipping_city: order.shipping_city ?? '',
    shipping_district: order.shipping_district, shipping_postal_code: order.shipping_postal_code ?? '',
    delivery_charge: String(toNumber(order.delivery_charge) - toNumber(order.delivery_discount)),
    manual_discount: String(order.manual_discount), payment_method: order.payment_method, customer_note: order.customer_note ?? '',
  }))
  const priceOverride = can('orders.price_override')
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [k]: e.target.value }))
  const save = useMutation({
    mutationFn: () => {
      const changes: Record<string, unknown> = {
        customer_name: values.customer_name, customer_phone: values.customer_phone, customer_email: values.customer_email,
        shipping_address: values.shipping_address, shipping_area: values.shipping_area, shipping_city: values.shipping_city,
        shipping_district: values.shipping_district, shipping_postal_code: values.shipping_postal_code,
        payment_method: values.payment_method, customer_note: values.customer_note,
      }
      if (priceOverride) {
        if (Number(values.delivery_charge) !== toNumber(order.delivery_charge) - toNumber(order.delivery_discount)) changes.delivery_charge = Number(values.delivery_charge)
        if (Number(values.manual_discount) !== toNumber(order.manual_discount)) changes.manual_discount = Number(values.manual_discount)
      }
      return updateOrder(order.id, changes)
    },
    onSuccess: () => { toast.success('Order updated'); onOpenChange(false); onDone() },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Edit order" submitLabel="Save changes" onSubmit={() => save.mutate()} busy={save.isPending} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer name" htmlFor="e-name"><Input id="e-name" value={values.customer_name} onChange={set('customer_name')} /></Field>
        <Field label="Phone" htmlFor="e-phone" hint="Changing the phone moves the order to that customer"><Input id="e-phone" value={values.customer_phone} onChange={set('customer_phone')} /></Field>
        <Field label="Email" htmlFor="e-email"><Input id="e-email" value={values.customer_email} onChange={set('customer_email')} /></Field>
        <Field label="Payment method">
          <Select value={values.payment_method} onValueChange={(v) => setValues((s) => ({ ...s, payment_method: v as typeof s.payment_method }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(PAYMENT_METHOD).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Address" htmlFor="e-addr" className="sm:col-span-2"><Textarea id="e-addr" rows={2} value={values.shipping_address} onChange={set('shipping_address')} /></Field>
        <Field label="District">
          <Select value={values.shipping_district} onValueChange={(v) => setValues((s) => ({ ...s, shipping_district: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              {[...new Set([values.shipping_district, ...(config?.delivery.districts ?? [])])].map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Area" htmlFor="e-area"><Input id="e-area" value={values.shipping_area} onChange={set('shipping_area')} /></Field>
        <Field label="City" htmlFor="e-city"><Input id="e-city" value={values.shipping_city} onChange={set('shipping_city')} /></Field>
        <Field label="Postal code" htmlFor="e-postal"><Input id="e-postal" value={values.shipping_postal_code} onChange={set('shipping_postal_code')} /></Field>
        {priceOverride && (
          <>
            <Field label="Delivery charge" htmlFor="e-del"><Input id="e-del" type="number" min="0" value={values.delivery_charge} onChange={set('delivery_charge')} /></Field>
            <Field label="Extra discount" htmlFor="e-disc"><Input id="e-disc" type="number" min="0" value={values.manual_discount} onChange={set('manual_discount')} /></Field>
          </>
        )}
        <Field label="Customer note" htmlFor="e-note" className="sm:col-span-2"><Textarea id="e-note" rows={2} value={values.customer_note} onChange={set('customer_note')} /></Field>
      </div>
    </FormDialog>
  )
}

interface ItemDraft {
  variant_id: string
  label: string
  sku: string
  quantity: number
  unit_price: number
}

export function EditItemsDialog({ order, open, onOpenChange, onDone }: DialogProps) {
  const { can } = useAuth()
  const [items, setItems] = useState<ItemDraft[]>([])
  useEffect(() => {
    if (open) {
      setItems(order.order_items.map((i) => ({
        variant_id: i.variant_id, label: `${i.product_name}${i.variant_title ? ` · ${i.variant_title}` : ''}`, sku: i.sku,
        quantity: i.quantity, unit_price: toNumber(i.unit_price),
      })))
    }
  }, [open, order.order_items])
  const save = useMutation({
    mutationFn: () => setOrderItems(order.id, items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity, unit_price: i.unit_price }))),
    onSuccess: () => { toast.success('Items updated — stock re-reserved'); onOpenChange(false); onDone() },
  })
  const update = (idx: number, patch: Partial<ItemDraft>) => setItems((list) => list.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  const total = items.reduce((s, i) => s + i.quantity * i.unit_price, 0)
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Edit items" submitLabel="Save items" wide
      description="Stock reservations are updated to match. Prices are re-checked on the server."
      onSubmit={() => save.mutate()} busy={save.isPending} disabled={items.length === 0}>
      <VariantPicker onPick={(v) => {
        if (!v.variant_id) return
        setItems((list) => list.some((i) => i.variant_id === v.variant_id)
          ? list.map((i) => (i.variant_id === v.variant_id ? { ...i, quantity: i.quantity + 1 } : i))
          : [...list, { variant_id: v.variant_id!, label: `${v.product_name}${v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''}`, sku: v.sku ?? '', quantity: 1, unit_price: toNumber(v.unit_price) }])
      }} />
      <ul className="divide-y rounded-md border">
        {items.map((item, idx) => (
          <li key={item.variant_id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
            <div className="min-w-40 flex-1"><p className="font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.sku}</p></div>
            <Input type="number" min="1" className="h-8 w-20" value={item.quantity} onChange={(e) => update(idx, { quantity: Math.max(1, Number(e.target.value)) })} aria-label="Quantity" />
            <Input type="number" min="0" className="h-8 w-28" value={item.unit_price} disabled={!can('orders.price_override')}
              onChange={(e) => update(idx, { unit_price: Number(e.target.value) })} aria-label="Unit price" />
            <span className="w-24 text-right tabular-nums">{formatMoney(item.quantity * item.unit_price)}</span>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setItems((l) => l.filter((_, i) => i !== idx))} aria-label="Remove item"><Trash2 /></Button>
          </li>
        ))}
        {items.length === 0 && <li className="p-3 text-sm text-muted-foreground">Add at least one product.</li>}
      </ul>
      <p className="text-right text-sm">Items subtotal: <strong>{formatMoney(total)}</strong></p>
    </FormDialog>
  )
}

export function ReturnDialog({ order, open, onOpenChange, onDone }: DialogProps) {
  const [rows, setRows] = useState<Record<string, { restock: number; damaged: number }>>({})
  const [note, setNote] = useState('')
  useEffect(() => {
    if (open) {
      setRows(Object.fromEntries(order.order_items.map((i) => [i.id, { restock: i.quantity - i.returned_quantity - i.damaged_quantity, damaged: 0 }])))
    }
  }, [open, order.order_items])
  const save = useMutation({
    mutationFn: () => processReturn(order.id, Object.entries(rows).flatMap(([id, r]) => [
      ...(r.restock > 0 ? [{ order_item_id: id, quantity: r.restock, condition: 'RESTOCK' as const }] : []),
      ...(r.damaged > 0 ? [{ order_item_id: id, quantity: r.damaged, condition: 'DAMAGED' as const }] : []),
    ]), note),
    onSuccess: () => { toast.success('Return received and stock updated'); onOpenChange(false); onDone() },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Receive returned parcel" submitLabel="Complete return" wide
      description="Good items go back to sellable stock; damaged items go to the damaged bucket."
      onSubmit={() => save.mutate()} busy={save.isPending}>
      <ul className="divide-y rounded-md border text-sm">
        {order.order_items.map((i) => {
          const r = rows[i.id] ?? { restock: 0, damaged: 0 }
          const max = i.quantity - i.returned_quantity - i.damaged_quantity
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-3 p-2">
              <div className="min-w-40 flex-1"><p className="font-medium">{i.product_name}</p><p className="text-xs text-muted-foreground">{i.sku} · shipped {i.quantity}</p></div>
              <label className="flex items-center gap-1 text-xs">Restock
                <Input type="number" min="0" max={max} className="h-8 w-16" value={r.restock}
                  onChange={(e) => setRows((s) => ({ ...s, [i.id]: { ...r, restock: Math.min(max - r.damaged, Math.max(0, Number(e.target.value))) } }))} />
              </label>
              <label className="flex items-center gap-1 text-xs">Damaged
                <Input type="number" min="0" max={max} className="h-8 w-16" value={r.damaged}
                  onChange={(e) => setRows((s) => ({ ...s, [i.id]: { ...r, damaged: Math.min(max - r.restock, Math.max(0, Number(e.target.value))) } }))} />
              </label>
            </li>
          )
        })}
      </ul>
      <Field label="Note" htmlFor="ret-note"><Input id="ret-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDialog>
  )
}

export function FraudDecisionDialog({ order, open, onOpenChange, onConfirm, action }: {
  order: { total_amount: number; advance_required: number; delivery_charge?: number }
  open: boolean
  onOpenChange: (o: boolean) => void
  action: 'APPROVE' | 'REQUEST_ADVANCE' | 'REJECT'
  onConfirm: (input: { advance?: number; note?: string; blockCustomer?: boolean }) => Promise<unknown>
}) {
  const [advance, setAdvance] = useState('')
  const [note, setNote] = useState('')
  const [block, setBlock] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setAdvance(String(toNumber(order.advance_required) || toNumber(order.delivery_charge)))
      setNote('')
      setBlock(false)
    }
  }, [open, order.advance_required, order.delivery_charge])
  const titles = { APPROVE: 'Approve order', REQUEST_ADVANCE: 'Request advance payment', REJECT: 'Reject order' }
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={titles[action]}
      submitLabel={titles[action]} busy={busy} disabled={action === 'REJECT' && !note.trim()}
      description={action === 'APPROVE' ? 'The order is confirmed with cash on delivery for the remaining amount.'
        : action === 'REQUEST_ADVANCE' ? 'The customer is notified and the order waits for this payment.'
        : 'Stock is released and the decision is recorded.'}
      onSubmit={async () => {
        setBusy(true)
        try {
          await onConfirm({ advance: action === 'REQUEST_ADVANCE' ? Number(advance) : undefined, note, blockCustomer: block })
          onOpenChange(false)
        } finally {
          setBusy(false)
        }
      }}>
      {action === 'REQUEST_ADVANCE' && (
        <Field label="Advance amount" htmlFor="adv" hint={`Order total ${formatMoney(order.total_amount)}`}>
          <Input id="adv" type="number" min="1" max={toNumber(order.total_amount)} value={advance} onChange={(e) => setAdvance(e.target.value)} />
        </Field>
      )}
      <Field label={action === 'REJECT' ? 'Reason' : 'Note'} htmlFor="fd-note" required={action === 'REJECT'}>
        <Textarea id="fd-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {action === 'REJECT' && (
        <label className="flex items-center gap-2 text-sm"><Switch checked={block} onCheckedChange={setBlock} /> Also block this customer from ordering online</label>
      )}
    </FormDialog>
  )
}
