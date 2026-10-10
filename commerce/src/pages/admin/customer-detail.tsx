import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Ban, CheckCircle2, Pencil, Phone, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, titleCase } from '@/lib/format'
import { FRAUD_DECISION, ORDER_STATUS, PAYMENT_CHANNEL, PAYMENT_STATUS, RISK_LEVEL, SEGMENT } from '@/lib/status'
import { customerSummary, getCustomer, updateCustomer } from '@/services/customers'
import { searchOrders } from '@/services/orders'
import type { OrderListItem } from '@/types/domain'

export default function CustomerDetailPage() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const customer = useQuery({ queryKey: ['customer', id], queryFn: () => getCustomer(id) })
  const orders = useQuery({ queryKey: ['orders', 'customer', id], queryFn: () => searchOrders({ customer_id: id }, 'created_at', 'desc', 100, 0) })
  const summary = useQuery({ queryKey: ['customer', id, 'summary'], queryFn: () => customerSummary(id) })
  const [editing, setEditing] = useState(false)
  const [blocking, setBlocking] = useState(false)
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['customer', id] }); void queryClient.invalidateQueries({ queryKey: ['customers'] }) }
  const setStatus = useMutation({
    mutationFn: ({ status, reason }: { status: 'ACTIVE' | 'BLOCKED'; reason?: string }) => updateCustomer(id, { status, blocked_reason: reason }),
    onSuccess: (_d, v) => { toast.success(v.status === 'BLOCKED' ? 'Customer blocked' : 'Customer unblocked'); refresh() },
  })

  if (customer.isLoading) return <LoadingState />
  if (customer.error || !customer.data) return <ErrorState error={customer.error ?? new Error('NOT_FOUND: Customer not found')} />
  const c = customer.data
  const finished = c.delivered_orders + c.cancelled_orders + c.returned_orders + c.failed_deliveries

  const orderColumns: Column<OrderListItem>[] = [
    { key: 'order', header: 'Order', primary: true, cell: (o) => <span className="font-medium">{o.order_number}</span> },
    { key: 'date', header: 'Date', cell: (o) => formatDate(o.created_at) },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge value={o.status} map={ORDER_STATUS} /> },
    { key: 'payment', header: 'Payment', cell: (o) => <StatusBadge value={o.payment_status} map={PAYMENT_STATUS} /> },
    { key: 'total', header: 'Total', align: 'right', cell: (o) => <Money value={o.total_amount} /> },
  ]

  return (
    <div className="space-y-4">
      <Link to="/admin/customers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Customers</Link>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{c.full_name} <StatusBadge value={c.segment} map={SEGMENT} /> <StatusBadge value={c.risk_level} map={RISK_LEVEL} /></span>}
        description={<span className="flex flex-wrap gap-x-3"><a href={`tel:${c.phone}`} className="inline-flex items-center gap-1"><Phone className="size-3" />{c.phone}</a>{c.email && <span>{c.email}</span>}<span>Customer since {formatDate(c.created_at)}</span></span>}
        actions={
          <>
            {can('orders.create') && <Button size="sm" variant="outline" asChild><Link to="/admin/orders/new"><Plus /> New order</Link></Button>}
            {can('customers.manage') && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit</Button>}
            {can('customers.manage') && (c.status === 'BLOCKED'
              ? <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ status: 'ACTIVE' })}><CheckCircle2 /> Unblock</Button>
              : <Button size="sm" variant="destructive" onClick={() => setBlocking(true)}><Ban /> Block</Button>)}
          </>
        } />
      {c.status === 'BLOCKED' && <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">Blocked: {c.blocked_reason ?? 'no reason recorded'}. Storefront orders from this phone are refused.</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <StatCard label="Orders" value={formatNumber(c.total_orders)} />
        <StatCard label="Delivered" value={formatNumber(c.delivered_orders)} />
        <StatCard label="Cancelled" value={formatNumber(c.cancelled_orders)} hint={finished ? formatPercent((c.cancelled_orders / finished) * 100) : undefined} />
        <StatCard label="Failed / returned" value={`${c.failed_deliveries} / ${c.returned_orders}`} tone={c.failed_deliveries + c.returned_orders > 1 ? 'warning' : undefined} />
        <StatCard label="Total spent" value={formatMoney(c.total_spent)} />
        <StatCard label="Avg. order" value={formatMoney(c.average_order_value)} hint={`Last order ${formatDate(c.last_order_at)}`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <DataTable columns={orderColumns} rows={orders.data?.items} rowKey={(o) => o.id} loading={orders.isLoading} error={orders.error} rowHref={(o) => `/admin/orders/${o.id}`} />
          <Card>
            <CardHeader><CardTitle className="text-sm">Financial history</CardTitle></CardHeader>
            <CardContent>
              {summary.data && (
                <p className="mb-3 text-sm">Paid <strong>{formatMoney(summary.data.totals.paid)}</strong> · refunded <strong>{formatMoney(summary.data.totals.refunded)}</strong></p>
              )}
              {!summary.data?.payments.length ? <p className="text-sm text-muted-foreground">No payments recorded.</p> : (
                <ul className="divide-y text-sm">
                  {summary.data.payments.map((p) => (
                    <li key={p.id} className="flex justify-between gap-3 py-2">
                      <span>{p.order_number} · {titleCase(p.kind)} · {PAYMENT_CHANNEL[p.channel as keyof typeof PAYMENT_CHANNEL] ?? p.channel} <span className="text-muted-foreground">{formatDateTime(p.created_at)}</span></span>
                      <Money value={p.kind === 'REFUND' ? -p.amount : p.amount} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Addresses</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {c.customer_addresses.length === 0 ? <p className="text-muted-foreground">{c.address ?? 'No saved address'}</p> : c.customer_addresses.map((a) => (
                <div key={a.id} className="rounded-md border p-2">
                  <p>{a.address_line}</p>
                  <p className="text-muted-foreground">{[a.area, a.city, a.district].filter(Boolean).join(', ')}</p>
                  {a.is_default && <Badge variant="secondary" className="mt-1">Default</Badge>}
                </div>
              ))}
              {c.notes && <p className="rounded-md bg-muted/60 p-2"><span className="font-medium">Notes:</span> {c.notes}</p>}
              {c.tags.length > 0 && <div className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}</div>}
            </CardContent>
          </Card>
          {can('fraud.view') && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Fraud history</CardTitle></CardHeader>
              <CardContent>
                {!summary.data?.fraud_checks.length ? <p className="text-sm text-muted-foreground">No checks yet.</p> : (
                  <ul className="space-y-2 text-sm">
                    {summary.data.fraud_checks.slice(0, 10).map((f) => (
                      <li key={f.id} className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5"><StatusBadge value={f.risk_level as never} map={RISK_LEVEL} /> {Math.round(f.risk_score)} · {FRAUD_DECISION[f.decision as keyof typeof FRAUD_DECISION]?.label}</span>
                        <span className="text-xs text-muted-foreground">{formatDate(f.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      {editing && <EditCustomerDialog customer={c} onClose={() => setEditing(false)} onSaved={refresh} />}
      <ConfirmDialog open={blocking} onOpenChange={setBlocking} title={`Block ${c.full_name}?`} description="New storefront orders from this phone number will be refused."
        reason reasonRequired destructive confirmLabel="Block customer" onConfirm={(reason) => setStatus.mutateAsync({ status: 'BLOCKED', reason })} />
    </div>
  )
}

function EditCustomerDialog({ customer, onClose, onSaved }: { customer: NonNullable<Awaited<ReturnType<typeof getCustomer>>>; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState({
    full_name: customer.full_name, email: customer.email ?? '', address: customer.address ?? '', area: customer.area ?? '',
    city: customer.city ?? '', district: customer.district ?? '', notes: customer.notes ?? '', tags: customer.tags.join(', '),
  })
  const save = useMutation({
    mutationFn: () => updateCustomer(customer.id, { ...values, tags: values.tags.split(',').map((t) => t.trim()).filter(Boolean) }),
    onSuccess: () => { toast.success('Customer updated'); onSaved(); onClose() },
  })
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [k]: e.target.value }))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit customer</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="ec-name"><Input id="ec-name" value={values.full_name} onChange={set('full_name')} /></Field>
          <Field label="Email" htmlFor="ec-email"><Input id="ec-email" value={values.email} onChange={set('email')} /></Field>
          <Field label="Address" htmlFor="ec-addr" className="sm:col-span-2"><Input id="ec-addr" value={values.address} onChange={set('address')} /></Field>
          <Field label="Area" htmlFor="ec-area"><Input id="ec-area" value={values.area} onChange={set('area')} /></Field>
          <Field label="District" htmlFor="ec-district"><Input id="ec-district" value={values.district} onChange={set('district')} /></Field>
          <Field label="Tags" htmlFor="ec-tags" hint="Comma separated" className="sm:col-span-2"><Input id="ec-tags" value={values.tags} onChange={set('tags')} /></Field>
          <Field label="Notes" htmlFor="ec-notes" className="sm:col-span-2"><Textarea id="ec-notes" rows={3} value={values.notes} onChange={set('notes')} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Spinner />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
