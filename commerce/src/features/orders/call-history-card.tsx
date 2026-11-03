import { useQuery } from '@tanstack/react-query'
import { Check, PhoneCall, PhoneOutgoing, ShieldCheck } from 'lucide-react'
import { LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/lib/format'
import { type CallEvent, orderCallHistory } from '@/services/calls'

const ICON = { TAP: PhoneOutgoing, STATUS: PhoneCall, APPROVED: Check } as const

function what(e: CallEvent): string {
  if (e.kind === 'TAP') return `Tapped Call${e.source ? ` (${e.source})` : ''}`
  if (e.kind === 'APPROVED') return e.actor_id ? 'Approved the order' : 'Approved automatically'
  return `Set the call status: ${e.status_label ?? e.status ?? '—'}`
}

/**
 * Who tapped Call, set a call status or approved this order, and when. For the Owner and Admins
 * (calls.view): the staff do not see it. A tap shows the Call button was used, not that the customer
 * answered; Cloud Calling records the call itself.
 */
export function CallHistoryCard({ orderId }: { orderId: string }) {
  const q = useQuery({ queryKey: ['order-call-history', orderId], queryFn: () => orderCallHistory(orderId), refetchInterval: 30_000 })
  const h = q.data
  const neverTapped = h && h.taps === 0
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="size-4 text-muted-foreground" /> Call history</CardTitle>
        <CardDescription>Only the Owner and Admins see this. A tap shows the Call button was used, not that the customer answered.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? <LoadingState className="py-6" /> : !h ? null : (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant={neverTapped ? 'warning' : 'success'} className="tabular-nums">{neverTapped ? 'Call never tapped' : `Call tapped ${h.taps}×`}</Badge>
              <Badge variant="neutral" className="tabular-nums">{h.statuses} call status{h.statuses === 1 ? '' : 'es'} set</Badge>
              {h.not_reached > 0 && <Badge variant="neutral" className="tabular-nums">Not reached {h.not_reached}×</Badge>}
            </div>
            {h.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody has called or set a call status yet.</p>
            ) : (
              <ol className="space-y-2">
                {h.events.map((e, i) => {
                  const Icon = ICON[e.kind]
                  return (
                    <li key={i} className="flex items-start gap-2.5 text-sm">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p><span className="font-medium">{e.actor_name ?? (e.kind === 'APPROVED' ? 'Fullfilio' : 'Someone')}</span> · {what(e)}</p>
                        <p className="text-xs text-muted-foreground tabular-nums">{formatDateTime(e.at)}</p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
