import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Check, ExternalLink, MessageCircle, Phone, PhoneCall, PhoneOff, SkipForward, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { CourierHistoryTable, courierHistoryOf } from '@/features/fraud/courier-history'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { ORDER_STATUS, PAYMENT_METHOD, RISK_LEVEL } from '@/lib/status'
import { type CallScope, nextCall } from '@/services/order-tools'
import { approveOrders, getOrder, setWebOrderStatus } from '@/services/orders'

const LATER = [
  { label: 'In 1 hour', at: () => new Date(Date.now() + 3_600_000) },
  { label: 'In 3 hours', at: () => new Date(Date.now() + 3 * 3_600_000) },
  { label: 'Tomorrow 10 am', at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d } },
]

const intl = (phone: string) => {
  const d = phone.replace(/\D/g, '')
  return d.startsWith('880') ? d : `88${d}`
}

/**
 * Auto Call Center: one web order at a time. Call the customer, tap what
 * happened, and the next order to call opens by itself — call-backs that are
 * due first, then new orders oldest first, then customers who didn't answer.
 */
export default function CallCenterPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ scope: 'mine' })
  const scope = state.scope as CallScope
  const [skip, setSkip] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [laterOpen, setLaterOpen] = useState(false)
  const [laterAt, setLaterAt] = useState('')
  const queue = useQuery({ queryKey: ['call-queue', scope, skip], queryFn: () => nextCall(scope, skip) })
  const orderId = queue.data?.order_id ?? null
  const order = useQuery({ queryKey: ['order', orderId], queryFn: () => getOrder(orderId!), enabled: !!orderId })
  const o = order.data

  const done = (message: string) => {
    toast.success(message)
    setNote(''); setLaterOpen(false); setLaterAt('')
    void queryClient.invalidateQueries({ queryKey: ['call-queue'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }
  const approve = useMutation({
    mutationFn: async () => {
      const r = await approveOrders([orderId!], note || 'Confirmed on the phone')
      if (!r.approved) throw new Error(r.failed?.[0]?.error ?? 'Could not approve this order')
    },
    onSuccess: () => done(`${o?.order_number} approved`),
  })
  const outcome = useMutation({
    mutationFn: async ({ status, followUp }: { status: string; followUp?: string }) => {
      const r = await setWebOrderStatus([orderId!], status, note || undefined, followUp)
      if (r.failed?.length) throw new Error(r.failed[0].error)
    },
    onSuccess: (_, v) => done(v.status === 'FOLLOW_UP' ? 'Call-back scheduled' : v.status === 'CANCELLED' ? 'Order cancelled' : 'Saved — next customer'),
  })
  const busy = approve.isPending || outcome.isPending
  const counts = queue.data?.counts
  const fc = o?.fraud_check
  const history = fc ? courierHistoryOf(fc.provider_response) : null

  return (
    <div className="space-y-4">
      <PageHeader title="Auto Call Center"
        description="The next web order to call opens by itself. Call, tap what happened, move on. Call-backs that are due come first."
        actions={<Button size="sm" variant="outline" asChild><Link to="/admin/orders/auto-pick">Auto Pick settings</Link></Button>} />

      <Tabs value={scope} onValueChange={(v) => { setSkip([]); update({ scope: v }) }}>
        <TabsList>
          <TabsTrigger value="mine">My orders {counts ? <Badge variant="secondary" className="ml-1">{counts.mine}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="unassigned">Unassigned {counts ? <Badge variant="secondary" className="ml-1">{counts.unassigned}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="all">Everyone {counts ? <Badge variant="secondary" className="ml-1">{counts.all}</Badge> : null}</TabsTrigger>
        </TabsList>
      </Tabs>

      {queue.isLoading || (orderId && order.isLoading) ? <LoadingState /> : !orderId ? (
        <Card><CardContent>
          <EmptyState icon={<PhoneCall className="size-5" />} title="Nobody to call right now"
            description={skip.length ? 'You skipped the rest — start again to see them.' : 'New orders and due call-backs appear here as they come in.'}
            action={skip.length > 0 ? <Button variant="outline" onClick={() => setSkip([])}>Start again</Button>
              : scope === 'mine' && counts && counts.unassigned > 0
                ? <Button variant="outline" onClick={() => update({ scope: 'unassigned' })}>Call the {counts.unassigned} unassigned</Button> : undefined} />
        </CardContent></Card>
      ) : o && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {o.customer_name}
                <StatusBadge value={o.status} map={ORDER_STATUS} />
                {o.follow_up_at && <Badge variant="warning">call-back {timeAgo(o.follow_up_at)}</Badge>}
                {o.contact_attempts > 0 && <Badge variant="neutral">{o.contact_attempts} call{o.contact_attempts === 1 ? '' : 's'} before</Badge>}
              </CardTitle>
              <CardDescription>
                <Link to={`/admin/orders/${o.id}`} className="hover:underline">{o.order_number}</Link> · placed {timeAgo(o.created_at)} · {o.shipping_address}, {o.shipping_area ? `${o.shipping_area}, ` : ''}{o.shipping_district}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex flex-wrap gap-2">
                <Button size="lg" asChild><a href={`tel:${o.customer_phone}`}><Phone /> Call {o.customer_phone}</a></Button>
                <Button size="lg" variant="outline" asChild><a href={`https://wa.me/${intl(o.customer_phone)}`} target="_blank" rel="noreferrer"><MessageCircle /> WhatsApp</a></Button>
                <Button size="lg" variant="ghost" asChild><Link to={`/admin/orders/${o.id}`}><ExternalLink /> Open order</Link></Button>
              </div>

              <div className="rounded-lg border">
                <ul className="divide-y text-sm">
                  {o.order_items.map((i) => (
                    <li key={i.id} className="flex justify-between gap-3 px-3 py-2">
                      <span className="min-w-0 truncate">{i.product_name}{i.variant_title && i.variant_title !== 'Default' ? ` · ${i.variant_title}` : ''} <span className="text-muted-foreground">×{i.quantity}</span></span>
                      <Money value={i.line_total} />
                    </li>
                  ))}
                  <li className="flex justify-between px-3 py-2 font-medium">
                    <span>Total · {PAYMENT_METHOD[o.payment_method]}{Number(o.advance_required) > 0 ? ` · advance ${Number(o.amount_paid) >= Number(o.advance_required) ? 'paid' : 'due'}` : ''}</span>
                    <Money value={o.total_amount} />
                  </li>
                </ul>
              </div>
              {o.customer_note && <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">Customer note: {o.customer_note}</p>}

              <Textarea rows={2} placeholder="Note from the call (optional, saved with the order)" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {can('orders.status') && (
                  <Button className="col-span-2 sm:col-span-1" onClick={() => approve.mutate()} disabled={busy}>{approve.isPending ? <Spinner /> : <Check />} Confirmed — approve</Button>
                )}
                <Button variant="outline" onClick={() => outcome.mutate({ status: 'NO_RESPONSE' })} disabled={busy}><PhoneOff /> No answer</Button>
                <Button variant="outline" onClick={() => outcome.mutate({ status: 'GOOD_NO_RESPONSE' })} disabled={busy}>Rang, didn't pick up</Button>
                <Button variant="outline" onClick={() => setLaterOpen((v) => !v)} disabled={busy}><CalendarClock /> Call back later</Button>
                <Button variant="outline" className="text-red-600" onClick={() => {
                  if (!note.trim()) { toast.error('Write why in the note first'); return }
                  outcome.mutate({ status: 'CANCELLED' })
                }} disabled={busy}><X /> Cancel order</Button>
                <Button variant="ghost" onClick={() => setSkip((s) => [...s, o.id])} disabled={busy}><SkipForward /> Skip</Button>
              </div>
              {laterOpen && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
                  {LATER.map((l) => (
                    <Button key={l.label} size="sm" variant="secondary" disabled={busy}
                      onClick={() => outcome.mutate({ status: 'FOLLOW_UP', followUp: l.at().toISOString() })}>{l.label}</Button>
                  ))}
                  <Input type="datetime-local" className="h-8 w-52" value={laterAt} onChange={(e) => setLaterAt(e.target.value)} aria-label="Call back at" />
                  <Button size="sm" disabled={!laterAt || busy} onClick={() => outcome.mutate({ status: 'FOLLOW_UP', followUp: new Date(laterAt).toISOString() })}>Set</Button>
                </div>
              )}
              {(approve.error || outcome.error) && (
                <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{((approve.error ?? outcome.error) as Error).message.replace(/^[A-Z_]+: /, '')}</p>
              )}
            </CardContent>
          </Card>

          <div className="grid content-start gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Customer</CardTitle></CardHeader>
              <CardContent className="grid gap-3 text-sm">
                {o.customer ? (
                  <dl className="grid grid-cols-2 gap-2 tabular-nums">
                    <div><dt className="text-xs text-muted-foreground">Orders</dt><dd>{formatNumber(o.customer.total_orders)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Delivered</dt><dd className="text-emerald-600">{formatNumber(o.customer.delivered_orders)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Returned</dt><dd>{formatNumber(o.customer.returned_orders)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Cancelled</dt><dd>{formatNumber(o.customer.cancelled_orders)}</dd></div>
                    <div className="col-span-2"><dt className="text-xs text-muted-foreground">Spent</dt><dd><Money value={o.customer.total_spent} /></dd></div>
                  </dl>
                ) : <p className="text-muted-foreground">First order from this number.</p>}
                {o.risk_level && <p>Risk: <Badge variant={RISK_LEVEL[o.risk_level].variant}>{RISK_LEVEL[o.risk_level].label}</Badge></p>}
                {o.last_contact_at && <p className="text-xs text-muted-foreground">Last call {formatDateTime(o.last_contact_at)}</p>}
              </CardContent>
            </Card>
            {history && (
              <Card>
                <CardHeader><CardTitle className="text-sm">Courier history</CardTitle></CardHeader>
                <CardContent><CourierHistoryTable result={history} /></CardContent>
              </Card>
            )}
            <p className="text-xs text-muted-foreground">
              Calls go through your phone. Automatic voice calls (press 1 to confirm) need a PBX / voice provider, which isn't connected yet.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
