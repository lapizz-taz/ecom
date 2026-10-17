import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, PhoneCall, SkipForward } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { type CallQueue, autoOrderDashboard, openNextInQueue, releaseCallClaim } from '@/services/order-tools'

// Working a queue from the Auto Order Dashboard: "Open Next" opens the whole order
// page with ?auto=<queue>; once the status is recorded (or the order approved) the
// next customer in the same queue opens in its place, oldest first.

export const AUTO_QUEUES: Array<{ key: CallQueue; label: string }> = [
  { key: 'processing', label: 'Processing' },
  { key: 'incomplete', label: 'Incomplete' },
  { key: 'good_no_response', label: 'Good But No Response' },
  { key: 'no_response', label: 'No Response' },
  { key: 'advance_payment', label: 'Advance Payment' },
  { key: 'on_hold', label: 'On Hold' },
]
export const queueLabel = (q: CallQueue) => AUTO_QUEUES.find((x) => x.key === q)?.label ?? q

const AUTO_KEY = 'fullfilio.auto-order.open-next'
export const readAutoNext = () => { try { return localStorage.getItem(AUTO_KEY) !== '0' } catch { return true } }
export const writeAutoNext = (v: boolean) => { try { localStorage.setItem(AUTO_KEY, v ? '1' : '0') } catch { /* private mode */ } }

export const DASHBOARD = '/admin/orders/call-center'
export const autoOrderUrl = (id: string, queue: CallQueue, skip: string[] = []) =>
  `/admin/orders/${id}?auto=${queue}${skip.length ? `&skip=${skip.join(',')}` : ''}`

/** The queue this order page was opened from, and how to move on to the next customer. */
export function useAutoOrder(orderId: string) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [moving, setMoving] = useState(false)
  const raw = params.get('auto')
  const queue = AUTO_QUEUES.some((q) => q.key === raw && raw !== 'incomplete') ? (raw as CallQueue) : null
  const skip = (params.get('skip') ?? '').split(',').filter(Boolean)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['auto-order-dashboard'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }
  /** Opens the next customer (this one is skipped so it never comes straight back). */
  const next = async (opts: { skipped?: boolean } = {}) => {
    if (!queue) return
    setMoving(true)
    try {
      const skipping = opts.skipped ? [...skip, orderId] : skip
      if (!readAutoNext() && !opts.skipped) {
        await releaseCallClaim().catch(() => undefined)
        refresh()
        navigate(DASHBOARD)
        return
      }
      const claim = await openNextInQueue(queue, [...skipping, orderId])
      refresh()
      if (!claim || claim.kind !== 'ORDER') {
        toast.info(`Nobody left in ${queueLabel(queue)}`)
        navigate(DASHBOARD)
        return
      }
      navigate(autoOrderUrl(claim.id, queue, skipping), { replace: true })
      window.scrollTo({ top: 0 })
    } catch (e) {
      toast.error(e)
    } finally {
      setMoving(false)
    }
  }
  const back = async () => {
    await releaseCallClaim().catch(() => undefined)
    refresh()
    navigate(DASHBOARD)
  }
  return { queue, skip, next, back, moving }
}

/** Top of the order page while working a queue: which queue, how many are left, skip, back. */
export function AutoOrderBar({ auto }: { auto: ReturnType<typeof useAutoOrder> }) {
  const [autoNext, setAutoNext] = useState(readAutoNext)
  const dashboard = useQuery({ queryKey: ['auto-order-dashboard'], queryFn: autoOrderDashboard, refetchInterval: 30_000, enabled: !!auto.queue })
  if (!auto.queue) return null
  const left = dashboard.data?.queues[auto.queue]
  return (
    <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-[10px] border bg-card px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <PhoneCall className="size-4 text-muted-foreground" />
        <span className="font-medium">Auto order</span>
        <Badge variant="outline">{queueLabel(auto.queue)}</Badge>
        {left !== undefined && <span className="text-muted-foreground">{formatNumber(left)} more waiting{auto.skip.length ? ` · ${auto.skip.length} skipped` : ''}</span>}
        {auto.moving && <Spinner />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={autoNext} onCheckedChange={(v) => { setAutoNext(v); writeAutoNext(v) }} aria-label="Open the next order after updating" />
          Open next after update
        </label>
        <Button size="sm" variant="outline" onClick={() => void auto.next({ skipped: true })} disabled={auto.moving}><SkipForward /> Skip</Button>
        <Button size="sm" variant="ghost" onClick={() => void auto.back()} disabled={auto.moving}><ArrowLeft /> Back to Auto Order</Button>
      </div>
    </div>
  )
}
