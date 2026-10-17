import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Ban, Hourglass, MessageCircle, PackageCheck, PhoneCall, PhoneMissed, PhoneOff,
  RotateCcw, ShoppingBag, SkipForward, Truck, Wallet,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from '@/lib/toast'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { autoOrderUrl, readAutoNext, writeAutoNext } from '@/features/orders/auto-order'
import { CallButton } from '@/features/pbx/call-button'
import { formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type CallClaim, type CallQueue, autoOrderDashboard, openNextInQueue, releaseCallClaim } from '@/services/order-tools'
import { getCheckoutLead, updateCheckoutLead } from '@/services/orders'

const QUEUES: Array<{ key: CallQueue; label: string; hint: string; icon: typeof PhoneCall }> = [
  { key: 'processing', label: 'Processing', hint: 'New orders, oldest first', icon: PhoneCall },
  { key: 'incomplete', label: 'Incomplete', hint: 'Left at checkout without ordering', icon: ShoppingBag },
  { key: 'good_no_response', label: 'Good But No Response', hint: 'Rang, didn’t pick up', icon: PhoneMissed },
  { key: 'no_response', label: 'No Response', hint: 'Didn’t answer · 30 min between tries', icon: PhoneOff },
  { key: 'advance_payment', label: 'Advance Payment', hint: 'Waiting for the advance', icon: Wallet },
  { key: 'on_hold', label: 'On Hold', hint: 'Call-backs that are due', icon: Hourglass },
]



/** "in 26 min", "at 3:40 pm" or "now" for when a held-back customer comes up again. */
function readyIn(at: string) {
  const mins = Math.ceil((new Date(at).getTime() - Date.now()) / 60_000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins} min`
  return `at ${new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

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
  const navigate = useNavigate()
  const [autoNext, setAutoNext] = useState(readAutoNext)
  const [current, setCurrent] = useState<CallClaim | null>(null)
  const [skip, setSkip] = useState<string[]>([])
  const resumed = useRef(false)

  const dashboard = useQuery({ queryKey: ['auto-order-dashboard'], queryFn: autoOrderDashboard, refetchInterval: 30_000 })
  // Coming back to the page: pick up the checkout you had open (orders open on their own page).
  useEffect(() => {
    if (resumed.current || !dashboard.data) return
    resumed.current = true
    if (dashboard.data.claim?.kind === 'LEAD') setCurrent(dashboard.data.claim)
  }, [dashboard.data])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['auto-order-dashboard'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
    void queryClient.invalidateQueries({ queryKey: ['checkout-leads'] })
  }
  const open = useMutation({
    mutationFn: ({ queue, skipIds }: { queue: CallQueue; skipIds: string[] }) => openNextInQueue(queue, skipIds),
    onSuccess: (claim, v) => {
      refresh()
      if (!claim) { setCurrent(null); toast.info(`Nobody left in ${QUEUES.find((q) => q.key === v.queue)?.label}`); return }
      // An order opens on its full page; the next one follows from there after each update.
      if (claim.kind === 'ORDER') { navigate(autoOrderUrl(claim.id, claim.queue)); return }
      setCurrent(claim)
    },
    onError: (e) => toast.error(e),
  })
  const release = useMutation({ mutationFn: releaseCallClaim, onSettled: () => { setCurrent(null); setSkip([]); refresh() } })

  const setAuto = (v: boolean) => { setAutoNext(v); writeAutoNext(v) }
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
          <LeadWorkspace key={current.id} leadId={current.id} busy={open.isPending} onDone={finished} onSkip={skipCurrent} />
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          {d.claim?.kind === 'ORDER' && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-4 py-3 text-sm xl:col-span-2">
              <span>You still have a customer open from <span className="font-medium">{QUEUES.find((q) => q.key === d.claim!.queue)?.label}</span>.</span>
              <span className="flex gap-2">
                <Button size="sm" asChild><Link to={autoOrderUrl(d.claim.id, d.claim.queue)}>Continue</Link></Button>
                <Button size="sm" variant="ghost" onClick={() => release.mutate()} disabled={release.isPending}>Let go</Button>
              </span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {QUEUES.map((q) => {
              const n = d.queues[q.key] ?? 0
              const w = d.waiting?.[q.key]
              return (
                <div key={q.key} className="flex min-w-0 flex-col justify-between gap-3 rounded-xl border bg-card p-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium"><q.icon className="size-4 shrink-0 text-muted-foreground" /> <span className="truncate">{q.label}</span></p>
                    <p className={cn('mt-2 text-3xl font-semibold tabular-nums', n === 0 && 'text-muted-foreground')}>{formatNumber(n)}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{q.hint}</p>
                    {w && w.count > 0 && (
                      <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                        +{formatNumber(w.count)} waiting{w.next_at ? ` · next ready ${readyIn(w.next_at)}` : ''}
                      </p>
                    )}
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
