import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Ban, CalendarClock, Check, Clock4, ExternalLink, Hourglass, MessageCircle, PackageCheck, PhoneCall, PhoneMissed, PhoneOff,
  RotateCcw, ShoppingBag, SkipForward, Truck, Wallet, X,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { CourierRecordCards } from '@/features/orders/courier-record-cards'
import { CallButton } from '@/features/pbx/call-button'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ORDER_STATUS, PAYMENT_METHOD } from '@/lib/status'
import { type CallClaim, type CallQueue, autoOrderDashboard, openNextInQueue, releaseCallClaim } from '@/services/order-tools'
import { approveOrders, getCheckoutLead, getOrder, setWebOrderStatus, updateCheckoutLead } from '@/services/orders'

const QUEUES: Array<{ key: CallQueue; label: string; hint: string; icon: typeof PhoneCall }> = [
  { key: 'processing', label: 'Processing', hint: 'New orders, oldest first', icon: PhoneCall },
  { key: 'incomplete', label: 'Incomplete', hint: 'Left at checkout without ordering', icon: ShoppingBag },
  { key: 'good_no_response', label: 'Good But No Response', hint: 'Rang, didn’t pick up', icon: PhoneMissed },
  { key: 'no_response', label: 'No Response', hint: 'Didn’t answer · 30 min between tries', icon: PhoneOff },
  { key: 'advance_payment', label: 'Advance Payment', hint: 'Waiting for the advance', icon: Wallet },
  { key: 'on_hold', label: 'On Hold', hint: 'Call-backs that are due', icon: Hourglass },
]

const LATER = [
  { label: 'In 1 hour', at: () => new Date(Date.now() + 3_600_000) },
  { label: 'In 3 hours', at: () => new Date(Date.now() + 3 * 3_600_000) },
  { label: 'Tomorrow 10 am', at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d } },
]

const AUTO_KEY = 'fullfilio.auto-order.open-next'
const readAuto = () => { try { return localStorage.getItem(AUTO_KEY) !== '0' } catch { return true } }

const intl = (phone: string) => {
  const d = phone.replace(/\D/g, '')
  return d.startsWith('880') ? d : `88${d}`
}

/**
 * Auto Order Dashboard: each queue with how many customers wait in it and "Open next".
 * Opening claims the customer for you (no one else gets them meanwhile); record what
 * happened and the next one in the same queue opens by itself, if you want.
 */
export default function AutoOrderDashboardPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const canWork = can('orders.update') || can('orders.status')
  const [autoNext, setAutoNext] = useState(readAuto)
  const [current, setCurrent] = useState<CallClaim | null>(null)
  const [skip, setSkip] = useState<string[]>([])
  const resumed = useRef(false)

  const dashboard = useQuery({ queryKey: ['auto-order-dashboard'], queryFn: autoOrderDashboard, refetchInterval: 30_000 })
  // Coming back to the page: pick up the customer you had open.
  useEffect(() => {
    if (resumed.current || !dashboard.data) return
    resumed.current = true
    if (dashboard.data.claim) setCurrent(dashboard.data.claim)
  }, [dashboard.data])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['auto-order-dashboard'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
    void queryClient.invalidateQueries({ queryKey: ['checkout-leads'] })
  }
  const open = useMutation({
    mutationFn: ({ queue, skipIds }: { queue: CallQueue; skipIds: string[] }) => openNextInQueue(queue, skipIds),
    onSuccess: (claim, v) => {
      setCurrent(claim)
      if (!claim) toast.info(`Nobody left in ${QUEUES.find((q) => q.key === v.queue)?.label}`)
      refresh()
    },
    onError: (e) => toast.error(e),
  })
  const release = useMutation({ mutationFn: releaseCallClaim, onSettled: () => { setCurrent(null); setSkip([]); refresh() } })

  const setAuto = (v: boolean) => {
    setAutoNext(v)
    try { localStorage.setItem(AUTO_KEY, v ? '1' : '0') } catch { /* private mode */ }
  }
  /** After a status update: the next one in the same queue, or back to the queues. */
  const finished = (message: string) => {
    toast.success(message)
    if (current && autoNext) open.mutate({ queue: current.queue, skipIds: skip })
    else release.mutate()
  }
  const skipCurrent = () => {
    if (!current) return
    const next = [...skip, current.id]
    setSkip(next)
    open.mutate({ queue: current.queue, skipIds: next })
  }

  const d = dashboard.data
  const queue = current ? QUEUES.find((q) => q.key === current.queue) : null

  return (
    <div className="space-y-4">
      <PageHeader title="Auto Order Dashboard"
        description="Pick a queue and open the next customer. Each one is yours until you record what happened, so nobody calls the same customer twice."
        actions={(
          <>
            {can('orders.assign') && <Button size="sm" variant="outline" asChild><Link to="/admin/orders/auto-pick">Auto Pick settings</Link></Button>}
          </>
        )} />

      <label className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
        <span>
          <span className="block text-sm font-medium">Open next automatically after status update</span>
          <span className="block text-xs text-muted-foreground">Off: you come back here after each customer.</span>
        </span>
        <Switch checked={autoNext} onCheckedChange={setAuto} />
      </label>

      {!d ? <LoadingState /> : current ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => release.mutate()} disabled={release.isPending}><ArrowLeft /> All queues</Button>
            <p className="text-xs text-muted-foreground">
              {queue?.label} · {formatNumber(d.queues[current.queue])} more waiting{skip.length ? ` · ${skip.length} skipped` : ''}
            </p>
          </div>
          {current.kind === 'ORDER'
            ? <OrderWorkspace key={current.id} orderId={current.id} busy={open.isPending} onDone={finished} onSkip={skipCurrent} />
            : <LeadWorkspace key={current.id} leadId={current.id} busy={open.isPending} onDone={finished} onSkip={skipCurrent} />}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {QUEUES.map((q) => {
              const n = d.queues[q.key] ?? 0
              return (
                <div key={q.key} className="flex min-w-0 flex-col justify-between gap-3 rounded-xl border bg-card p-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium"><q.icon className="size-4 shrink-0 text-muted-foreground" /> <span className="truncate">{q.label}</span></p>
                    <p className={cn('mt-2 text-3xl font-semibold tabular-nums', n === 0 && 'text-muted-foreground')}>{formatNumber(n)}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{q.hint}</p>
                  </div>
                  <Button size="sm" variant={n > 0 ? 'default' : 'outline'} disabled={!canWork || n === 0 || open.isPending}
                    onClick={() => { setSkip([]); open.mutate({ queue: q.key, skipIds: [] }) }}>
                    {open.isPending && open.variables?.queue === q.key ? <Spinner /> : null} Open Next
                  </Button>
                </div>
              )
            })}
          </div>
          <Card className="h-fit">
            <CardHeader>
              <CardTitle className="text-sm">My Daily Report</CardTitle>
              <CardDescription>Today, for orders you took or approved.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2">
              <ReportTile icon={<PhoneCall className="size-4" />} label="Taken" value={d.report.taken} hint={`${d.report.approved} approved`} />
              <ReportTile icon={<Truck className="size-4" />} label="Shipped" value={d.report.shipped} />
              <ReportTile icon={<PackageCheck className="size-4" />} label="Delivered" value={d.report.delivered} tone="text-emerald-600" />
              <ReportTile icon={<RotateCcw className="size-4" />} label="Returned" value={d.report.returned} tone={d.report.returned ? 'text-red-600' : undefined} />
            </CardContent>
          </Card>
          {!canWork && <p className="text-xs text-muted-foreground xl:col-span-2">You can see the queues; opening customers needs permission to update orders.</p>}
        </div>
      )}
    </div>
  )
}

function ReportTile({ icon, label, value, hint, tone }: { icon: ReactNode; label: string; value: number; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon} {label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular-nums', tone)}>{formatNumber(value)}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** One web order to call: the call buttons, what they ordered, and the outcome buttons. */
function OrderWorkspace({ orderId, busy: opening, onDone, onSkip }: { orderId: string; busy: boolean; onDone: (message: string) => void; onSkip: () => void }) {
  const { can } = useAuth()
  const [note, setNote] = useState('')
  const [laterOpen, setLaterOpen] = useState(false)
  const [laterAt, setLaterAt] = useState('')
  const order = useQuery({ queryKey: ['order', orderId], queryFn: () => getOrder(orderId) })
  const o = order.data
  const approve = useMutation({
    mutationFn: async () => {
      const r = await approveOrders([orderId], note || 'Confirmed on the phone')
      if (!r.approved) throw new Error(r.failed?.[0]?.error ?? 'Could not approve this order')
    },
    onSuccess: () => onDone(`${o?.order_number} approved`),
  })
  const outcome = useMutation({
    mutationFn: async ({ status, followUp }: { status: string; followUp?: string }) => {
      const r = await setWebOrderStatus([orderId], status, note || undefined, followUp)
      if (r.failed?.length) throw new Error(r.failed[0].error)
    },
    onSuccess: (_, v) => onDone(v.status === 'FOLLOW_UP' ? 'Call-back scheduled' : v.status === 'CANCELLED' ? 'Order cancelled' : 'Saved'),
  })
  const busy = approve.isPending || outcome.isPending || opening
  if (order.isLoading) return <LoadingState />
  if (!o) return <p className="text-sm text-muted-foreground">This order could not be loaded.</p>
  const advanceDue = o.status === 'ADVANCE_REQUIRED'

  return (
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
            <CallButton size="lg" phone={o.customer_phone} orderId={o.id} />
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
          {advanceDue && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              Waiting for an advance of <Money value={o.advance_required} />. Ask the customer to pay it; the order moves on by itself once the payment is verified.
            </p>
          )}
          {o.customer_note && <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">Customer note: {o.customer_note}</p>}

          <Textarea rows={2} placeholder="Note from the call (optional, saved with the order)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {can('orders.status') && !advanceDue && (
              <Button className="col-span-2 sm:col-span-1" onClick={() => approve.mutate()} disabled={busy}>{approve.isPending ? <Spinner /> : <Check />} Confirmed — approve</Button>
            )}
            <Button variant="outline" onClick={() => outcome.mutate({ status: 'GOOD_NO_RESPONSE' })} disabled={busy}><PhoneMissed /> Rang, no pick-up</Button>
            <Button variant="outline" onClick={() => outcome.mutate({ status: 'NO_RESPONSE' })} disabled={busy}><PhoneOff /> No answer</Button>
            <Button variant="outline" onClick={() => setLaterOpen((v) => !v)} disabled={busy}><CalendarClock /> Hold · call later</Button>
            <Button variant="outline" className="text-red-600" onClick={() => {
              if (!note.trim()) { toast.error('Write why in the note first'); return }
              outcome.mutate({ status: 'CANCELLED' })
            }} disabled={busy}><X /> Cancel order</Button>
            <Button variant="ghost" onClick={onSkip} disabled={busy}><SkipForward /> Skip</Button>
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
            <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-400" role="alert">{((approve.error ?? outcome.error) as Error).message.replace(/^[A-Z_]+: /, '')}</p>
          )}
          {o.last_contact_at && <p className="text-xs text-muted-foreground"><Clock4 className="mr-1 inline size-3" />Last call {formatDateTime(o.last_contact_at)}</p>}
        </CardContent>
      </Card>
      <CourierRecordCards orderId={o.id} phone={o.customer_phone} createdAt={o.created_at} className="h-fit" />
    </div>
  )
}

/** A visitor who left at checkout: call them, then create the order, log the call or let it go. */
function LeadWorkspace({ leadId, busy: opening, onDone, onSkip }: { leadId: string; busy: boolean; onDone: (message: string) => void; onSkip: () => void }) {
  const { can } = useAuth()
  const [note, setNote] = useState('')
  const lead = useQuery({ queryKey: ['checkout-lead', leadId], queryFn: () => getCheckoutLead(leadId) })
  const save = useMutation({
    mutationFn: (status: 'CONTACTED' | 'DISMISSED') => updateCheckoutLead(leadId, status, note || undefined),
    onSuccess: (_, status) => onDone(status === 'DISMISSED' ? 'Removed from the list' : 'Call logged'),
    onError: (e) => toast.error(e),
  })
  const busy = save.isPending || opening
  if (lead.isLoading) return <LoadingState />
  const l = lead.data
  if (!l) return <p className="text-sm text-muted-foreground">This checkout could not be loaded.</p>
  const items = (Array.isArray(l.items) ? l.items : []) as Array<{ name?: string; variant?: string | null; quantity?: number }>
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">{l.customer_name || 'No name yet'} <Badge variant="outline">Incomplete checkout</Badge></CardTitle>
        <CardDescription>{l.phone}{l.district ? ` · ${l.district}` : ''} · left {timeAgo(l.updated_at)}{l.source ? ` · came from ${l.source}` : ''}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          <CallButton size="lg" phone={l.phone} />
          <Button size="lg" variant="outline" asChild><a href={`https://wa.me/${intl(l.phone)}`} target="_blank" rel="noreferrer"><MessageCircle /> WhatsApp</a></Button>
        </div>
        <ul className="divide-y rounded-lg border text-sm">
          {items.length === 0 ? <li className="px-3 py-2 text-muted-foreground">Cart not recorded</li> : items.map((i, n) => (
            <li key={n} className="flex justify-between gap-3 px-3 py-2"><span className="min-w-0 truncate">{i.name ?? 'Item'}{i.variant ? ` · ${i.variant}` : ''}</span><span className="text-muted-foreground">×{i.quantity ?? 1}</span></li>
          ))}
          <li className="flex justify-between px-3 py-2 font-medium"><span>Cart total</span><Money value={l.total} /></li>
        </ul>
        <Textarea rows={2} placeholder="What the customer said (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {can('orders.create') && <Button className="col-span-2 sm:col-span-1" asChild><Link to={`/admin/orders/new?lead=${l.id}`}><ShoppingBag /> Create order</Link></Button>}
          <Button variant="outline" onClick={() => save.mutate('CONTACTED')} disabled={busy}><PhoneCall /> Called · log it</Button>
          <Button variant="outline" className="text-red-600" onClick={() => save.mutate('DISMISSED')} disabled={busy}><Ban /> Not interested</Button>
          <Button variant="ghost" onClick={onSkip} disabled={busy}><SkipForward /> Skip</Button>
        </div>
      </CardContent>
    </Card>
  )
}
