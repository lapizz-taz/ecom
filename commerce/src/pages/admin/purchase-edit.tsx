import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, PackageCheck, Plus, Printer, Sparkles, Trash2, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { VariantPicker } from '@/features/products/variant-picker'
import { formatDate, formatMoney, titleCase, toNumber } from '@/lib/format'
import { PAYMENT_CHANNEL } from '@/lib/status'
import {
  getPurchaseOrder, listSuppliers, receivePurchaseOrder, recordPurchasePayment, saveSupplier, savePurchaseOrder, setPurchaseOrderStatus,
} from '@/services/purchases'
import { clearPurchasePrefill, inventoryInsights, readPurchasePrefill } from '@/services/inventory'
import type { Enums } from '@/types/database'
import { PO_STATUS, SETTLEMENT } from './purchases'

interface Line { variant_id: string; label: string; quantity: number; unit_cost: number }

export default function PurchaseEditPage() {
  const { id } = useParams()
  const isNew = !id
  const navigate = useNavigate()
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const po = useQuery({ queryKey: ['purchase', id], enabled: !isNew, queryFn: () => getPurchaseOrder(id!) })
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: listSuppliers })
  const [supplierId, setSupplierId] = useState('')
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10))
  const [expected, setExpected] = useState('')
  const [shipping, setShipping] = useState('0')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>(() => (isNew ? readPurchasePrefill() : []))
  useEffect(() => { if (isNew) clearPurchasePrefill() }, [isNew])
  const [receiving, setReceiving] = useState(false)
  const [paying, setPaying] = useState(false)
  const [newSupplier, setNewSupplier] = useState(false)
  const insights = useQuery({ queryKey: ['inventory', 'insights', 7, 30, 60], queryFn: () => inventoryInsights(7, 30, 60), staleTime: 60_000, enabled: can('inventory.view') })
  const stockOf = (variantId: string) => insights.data?.items.find((i) => i.variant_id === variantId)
  const addSuggestions = () => {
    const have = new Set(lines.map((l) => l.variant_id))
    const add = (insights.data?.items ?? []).filter((i) => (i.suggest ?? 0) > 0 && ['OUT', 'CRITICAL', 'LOW'].includes(i.status) && !have.has(i.variant_id))
      .map((i) => ({ variant_id: i.variant_id, label: `${i.product_name}${i.variant_title && i.variant_title !== 'Default' ? ` · ${i.variant_title}` : ''} (${i.sku})`, quantity: i.suggest!, unit_cost: toNumber(i.unit_cost) }))
    if (!add.length) { toast.info('No more products need restocking right now'); return }
    setLines((ls) => [...ls, ...add])
    toast.success(`Added ${add.length} product${add.length === 1 ? '' : 's'} that are running low`)
  }

  useEffect(() => {
    const d = po.data
    if (!d) return
    setSupplierId(d.supplier_id); setOrderDate(d.order_date); setExpected(d.expected_date ?? ''); setShipping(String(d.shipping_cost)); setNotes(d.notes ?? '')
    setLines(d.purchase_order_items.map((i) => ({ variant_id: i.variant_id, label: `${i.products?.name}${i.product_variants?.title && i.product_variants.title !== 'Default' ? ` · ${i.product_variants.title}` : ''} (${i.product_variants?.sku})`, quantity: i.quantity, unit_cost: toNumber(i.unit_cost) })))
  }, [po.data])

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['purchase', id] }); void queryClient.invalidateQueries({ queryKey: ['purchases'] }) }
  const save = useMutation({
    mutationFn: (status?: Enums<'purchase_status'>) => savePurchaseOrder({
      id, supplier_id: supplierId, order_date: orderDate, expected_date: expected || null, shipping_cost: Number(shipping) || 0, notes,
      status: status ?? po.data?.status ?? 'DRAFT', items: lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity, unit_cost: l.unit_cost })),
    }),
    onSuccess: (saved) => { toast.success('Purchase order saved'); refresh(); if (isNew && saved?.id) navigate(`/admin/purchases/${saved.id}`, { replace: true }) },
  })
  const setStatus = useMutation({ mutationFn: (s: Enums<'purchase_status'>) => setPurchaseOrderStatus(id!, s), onSuccess: refresh })

  if (!isNew && po.isLoading) return <LoadingState />
  if (!isNew && (po.error || !po.data)) return <ErrorState error={po.error ?? new Error('NOT_FOUND: Purchase order not found')} />
  const d = po.data
  const editable = can('purchases.manage') && (isNew || ['DRAFT', 'ORDERED'].includes(d!.status)) && !(d?.purchase_order_items.some((i) => i.received_quantity > 0))
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0)

  return (
    <div className="space-y-4">
      <Link to="/admin/purchases" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Purchases</Link>
      <PageHeader
        title={isNew ? 'New purchase order' : <span className="flex items-center gap-2">{d!.po_number} <Badge variant={PO_STATUS[d!.status]}>{titleCase(d!.status)}</Badge> <Badge variant={SETTLEMENT[d!.payment_status]}>{titleCase(d!.payment_status)}</Badge></span>}
        actions={
          <>
            {editable && <Button variant="outline" onClick={() => save.mutate(undefined)} disabled={save.isPending || !supplierId || !lines.length}>{save.isPending && <Spinner />} Save{isNew ? ' draft' : ''}</Button>}
            {editable && (isNew || d?.status === 'DRAFT') && <Button onClick={() => save.mutate('ORDERED')} disabled={save.isPending || !supplierId || !lines.length}>Save & mark ordered</Button>}
            {!isNew && can('purchases.manage') && ['ORDERED', 'PARTIALLY_RECEIVED', 'DRAFT'].includes(d!.status) && <Button onClick={() => setReceiving(true)}><PackageCheck /> Receive stock</Button>}
            {!isNew && can('purchases.manage') && can('finance.manage') && toNumber(d!.total_cost) > toNumber(d!.amount_paid) && d!.status !== 'CANCELLED' && <Button variant="outline" onClick={() => setPaying(true)}><Wallet /> Record payment</Button>}
            {!isNew && <Button variant="outline" onClick={() => window.print()}><Printer /> Print</Button>}
            {!isNew && can('purchases.manage') && ['DRAFT', 'ORDERED'].includes(d!.status) && <Button variant="ghost" onClick={() => setStatus.mutate('CANCELLED')}>Cancel PO</Button>}
          </>
        } />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-sm">Items {lines.length > 0 && <span className="font-normal text-muted-foreground">· {lines.length} products · {lines.reduce((t, l) => t + l.quantity, 0)} units</span>}</CardTitle>
            {editable && can('inventory.view') && (
              <Button size="sm" variant="outline" onClick={addSuggestions} disabled={!insights.data}><Sparkles /> Add low-stock suggestions</Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {editable && <VariantPicker showCost onPick={(v) => setLines((ls) => ls.some((l) => l.variant_id === v.variant_id) ? ls
              : [...ls, { variant_id: v.variant_id!, label: `${v.product_name}${v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''} (${v.sku})`, quantity: 1, unit_cost: toNumber(v.unit_cost) }])} />}
            <ul className="divide-y rounded-md border">
              {lines.map((l, idx) => {
                const received = d?.purchase_order_items.find((i) => i.variant_id === l.variant_id)?.received_quantity ?? 0
                return (
                  <li key={l.variant_id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                    <div className="min-w-40 flex-1">
                      <p className="font-medium">{l.label}</p>
                      {!isNew && <p className="text-xs text-muted-foreground">Received {received} of {l.quantity}</p>}
                      {(() => {
                        const st = stockOf(l.variant_id)
                        if (!st) return null
                        return (
                          <p className="text-xs text-muted-foreground">
                            In stock {st.available} · sold {st.sold_30} in 30 days{st.cover_days !== null ? ` · ${Math.floor(st.cover_days)} days left` : ''}
                            {editable && (st.suggest ?? 0) > 0 && st.suggest !== l.quantity && (
                              <> · <button type="button" className="text-foreground underline underline-offset-2"
                                onClick={() => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, quantity: st.suggest! } : x)))}>use suggested {st.suggest}</button></>
                            )}
                          </p>
                        )
                      })()}
                    </div>
                    <label className="flex items-center gap-1 text-xs">Qty<Input type="number" min={1} className="h-8 w-20" disabled={!editable} value={l.quantity}
                      onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x)))} /></label>
                    <label className="flex items-center gap-1 text-xs">Unit cost<Input type="number" min={0} className="h-8 w-24" disabled={!editable} value={l.unit_cost}
                      onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, unit_cost: Number(e.target.value) } : x)))} /></label>
                    <span className="w-24 text-right tabular-nums">{formatMoney(l.quantity * l.unit_cost)}</span>
                    {editable && <Button variant="ghost" size="icon-sm" onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))} aria-label="Remove"><Trash2 /></Button>}
                  </li>
                )
              })}
              {!lines.length && <li className="p-3 text-sm text-muted-foreground">Add products to order.</li>}
            </ul>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3">
              <Field label="Supplier" required>
                <Select value={supplierId} onValueChange={setSupplierId} disabled={!editable}>
                  <SelectTrigger><SelectValue placeholder="Choose supplier" /></SelectTrigger>
                  <SelectContent>{(suppliers.data ?? []).filter((s) => s.is_active || s.id === supplierId).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
                {editable && <button type="button" onClick={() => setNewSupplier(true)} className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><Plus className="size-3" /> New supplier</button>}
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Order date" htmlFor="po-date"><Input id="po-date" type="date" value={orderDate} disabled={!editable} onChange={(e) => setOrderDate(e.target.value)} /></Field>
                <Field label="Expected" htmlFor="po-exp"><Input id="po-exp" type="date" value={expected} disabled={!editable} onChange={(e) => setExpected(e.target.value)} /></Field>
              </div>
              <Field label="Shipping / landed cost" htmlFor="po-ship" hint="Spread across items when stock is received"><Input id="po-ship" type="number" min={0} value={shipping} disabled={!editable} onChange={(e) => setShipping(e.target.value)} /></Field>
              <Field label="Notes" htmlFor="po-notes"><Textarea id="po-notes" rows={2} value={notes} disabled={!editable} onChange={(e) => setNotes(e.target.value)} /></Field>
              <dl className="space-y-1 border-t pt-3 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">Items</dt><dd><Money value={subtotal} /></dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Shipping</dt><dd><Money value={Number(shipping) || 0} /></dd></div>
                <div className="flex justify-between font-semibold"><dt>Total</dt><dd><Money value={subtotal + (Number(shipping) || 0)} /></dd></div>
                {d && <div className="flex justify-between"><dt className="text-muted-foreground">Paid</dt><dd><Money value={d.amount_paid} /></dd></div>}
                {d && <div className="flex justify-between font-medium"><dt>Payable</dt><dd><Money value={toNumber(d.total_cost) - toNumber(d.amount_paid)} /></dd></div>}
              </dl>
            </CardContent>
          </Card>
          {d && d.finance_transactions.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Payments</CardTitle></CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">{d.finance_transactions.map((t) => <li key={t.id} className="flex justify-between"><span>{formatDate(t.txn_date)} · {t.payment_channel ? PAYMENT_CHANNEL[t.payment_channel] : ''}</span><Money value={t.amount} /></li>)}</ul>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      <NewSupplierDialog open={newSupplier} onOpenChange={setNewSupplier}
        onCreated={(id) => { void queryClient.invalidateQueries({ queryKey: ['suppliers'] }); setSupplierId(id) }} />
      {d && <ReceiveDialog po={d} open={receiving} onOpenChange={setReceiving} onDone={refresh} />}
      {d && <PayDialog poId={d.id} due={toNumber(d.total_cost) - toNumber(d.amount_paid)} open={paying} onOpenChange={setPaying} onDone={refresh} />}
    </div>
  )
}

function ReceiveDialog({ po, open, onOpenChange, onDone }: { po: NonNullable<Awaited<ReturnType<typeof getPurchaseOrder>>>; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, number>>({})
  const [note, setNote] = useState('')
  useEffect(() => { if (open) setQty(Object.fromEntries(po.purchase_order_items.map((i) => [i.id, i.quantity - i.received_quantity]))) }, [open, po])
  const receive = useMutation({
    mutationFn: () => receivePurchaseOrder(po.id, Object.entries(qty).filter(([, q]) => q > 0).map(([item_id, quantity]) => ({ item_id, quantity })), note),
    onSuccess: () => { toast.success('Stock received and inventory updated'); onOpenChange(false); onDone() },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>Receive stock</DialogTitle><DialogDescription>Adds stock, records purchase movements and updates average cost.</DialogDescription></DialogHeader>
        <ul className="divide-y rounded-md border text-sm">
          {po.purchase_order_items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 p-2">
              <span>{i.products?.name} · {i.product_variants?.sku} <span className="text-muted-foreground">({i.received_quantity}/{i.quantity})</span></span>
              <Input type="number" min={0} max={i.quantity - i.received_quantity} className="h-8 w-20" value={qty[i.id] ?? 0}
                onChange={(e) => setQty((q) => ({ ...q, [i.id]: Math.min(i.quantity - i.received_quantity, Math.max(0, Number(e.target.value))) }))} />
            </li>
          ))}
        </ul>
        <Field label="Note" htmlFor="rcv-note"><Input id="rcv-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => receive.mutate()} disabled={receive.isPending || !Object.values(qty).some((q) => q > 0)}>{receive.isPending && <Spinner />} Receive</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PayDialog({ poId, due, open, onOpenChange, onDone }: { poId: string; due: number; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [amount, setAmount] = useState('')
  const [channel, setChannel] = useState<Enums<'payment_channel'>>('BANK_TRANSFER')
  const [reference, setReference] = useState('')
  useEffect(() => { if (open) setAmount(String(due)) }, [open, due])
  const pay = useMutation({
    mutationFn: () => recordPurchasePayment(poId, Number(amount), channel, undefined, reference),
    onSuccess: () => { toast.success('Supplier payment recorded'); onOpenChange(false); onDone() },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Pay supplier</DialogTitle><DialogDescription>Recorded as a Product Purchase cash outflow. Outstanding: {formatMoney(due)}</DialogDescription></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount" htmlFor="pp-amt"><Input id="pp-amt" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Method">
            <Select value={channel} onValueChange={(v) => setChannel(v as typeof channel)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(PAYMENT_CHANNEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Reference" htmlFor="pp-ref" className="sm:col-span-2"><Input id="pp-ref" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => pay.mutate()} disabled={pay.isPending || !(Number(amount) > 0)}>{pay.isPending && <Spinner />} Record payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NewSupplierDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '' })
  useEffect(() => { if (open) setForm({ name: '', phone: '', email: '', address: '' }) }, [open])
  const save = useMutation({
    mutationFn: () => saveSupplier({ name: form.name.trim(), phone: form.phone.trim() || null, email: form.email.trim() || null, address: form.address.trim() || null }),
    onSuccess: (s) => { toast.success('Supplier added'); onOpenChange(false); if (s?.id) onCreated(s.id) },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>New supplier</DialogTitle><DialogDescription>Saved to your supplier list and chosen for this order.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <Field label="Name" htmlFor="sup-name" required><Input id="sup-name" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Phone" htmlFor="sup-phone"><Input id="sup-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Email" htmlFor="sup-email"><Input id="sup-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          </div>
          <Field label="Address" htmlFor="sup-addr"><Input id="sup-addr" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || form.name.trim().length < 2}>{save.isPending && <Spinner />} Add supplier</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
