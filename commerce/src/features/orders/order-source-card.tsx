import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { formatDateTime } from '@/lib/format'
import { MANUAL_SOURCES, type OrderDetail, setOrderSource } from '@/services/orders'

type Attribution = NonNullable<OrderDetail['attribution']>

/** Paid / Organic / Direct / Referral / Unknown — only what the data shows, never a guess. */
export function paidBadge(a: { is_paid: boolean | null; channel: string }) {
  if (a.channel === 'unknown') return <Badge variant="neutral" title="The store did not pass on where this visit came from">Unknown</Badge>
  if (a.channel === 'direct') return <Badge variant="neutral">Direct</Badge>
  if (a.is_paid === true) return <Badge variant="violet">Paid</Badge>
  if (a.is_paid === null) {
    return <Badge variant="warning" title="The visit came from this site, but without ad tags (UTM). Add UTM tags to your ads to tell ads from posts.">Paid or organic?</Badge>
  }
  if (a.channel === 'referral') return <Badge variant="neutral">Referral</Badge>
  if (a.channel.startsWith('organic')) return <Badge variant="success">Organic</Badge>
  const label: Record<string, string> = { email: 'Email', sms: 'SMS', messaging: 'Messaging' }
  return <Badge variant="neutral">{label[a.channel] ?? 'Unpaid'}</Badge>
}

function Row({ label, value, id }: { label: string; value: string | null | undefined; id?: string | null }) {
  if (!value && !id) return null
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value ?? <span className="text-muted-foreground">—</span>}{id && <span className="ml-1.5 font-mono text-xs text-muted-foreground">#{id}</span>}</dd>
    </div>
  )
}

/** Where the sale came from: source, campaign / ad set / ad, first touch and the visitor's journey. */
export function OrderSourceCard({ orderId, attribution, orderStatus }: { orderId: string; attribution: Attribution | null; orderStatus: string }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [choice, setChoice] = useState('')
  const a = attribution
  const save = useMutation({
    mutationFn: () => setOrderSource(orderId, choice),
    onSuccess: () => {
      toast.success('Order source saved')
      setChoice('')
      void queryClient.invalidateQueries({ queryKey: ['order', orderId] })
    },
  })
  const canSet = can('orders.update') && (!a || a.recorded_by !== 'STOREFRONT' || ['unknown', 'direct'].includes(a.channel))
  const journey = (a?.journey ?? {}) as { visits?: number; page_views?: number; product_views?: number; add_to_cart?: number; checkouts?: number; first_seen_at?: string }
  const steps = [
    { label: 'Visits', value: journey.visits },
    { label: 'Product views', value: journey.product_views },
    { label: 'Add to cart', value: journey.add_to_cart },
    { label: 'Checkout', value: journey.checkouts },
  ].filter((s) => typeof s.value === 'number')
  const landingPath = a?.landing_page?.split('?')[0]

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Source</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">{a?.source ?? 'Unknown'}</span>
          {paidBadge({ is_paid: a?.is_paid ?? null, channel: a?.channel ?? 'unknown' })}
          {a?.recorded_by === 'STAFF' && <Badge variant="outline">Set by staff</Badge>}
        </div>
        {a && a.channel !== 'unknown' && (
          <dl className="divide-y divide-border/60">
            <Row label="Campaign" value={a.campaign} id={a.campaign_id} />
            <Row label="Ad set" value={a.adset} id={a.adset_id} />
            <Row label="Ad" value={a.ad} id={a.ad_id} />
            <Row label="Medium" value={a.utm_medium ?? a.medium} />
            <Row label="Landing" value={landingPath} />
            <Row label="Referrer" value={a.referrer_host} />
            <Row label="Click ID" value={a.click_id_type} />
            {a.first_source && (a.first_source !== a.source || a.first_channel !== a.channel) && (
              <Row label="First visit" value={`${a.first_source}${a.first_touch_at ? ` · ${formatDateTime(a.first_touch_at)}` : ''}`} />
            )}
            {a.note && <Row label="Note" value={a.note} />}
          </dl>
        )}
        {(!a || a.channel === 'unknown') && (
          <p className="text-muted-foreground">No tracking data came with this order. If it was taken by chat or phone, set where it came from.</p>
        )}
        {steps.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">Journey{journey.first_seen_at ? ` since ${formatDateTime(journey.first_seen_at)}` : ''}</p>
            <ol className="flex flex-wrap items-center gap-1.5 text-xs">
              {steps.map((s) => (
                <li key={s.label} className="flex items-center gap-1.5">
                  <span className="rounded-md bg-muted px-2 py-1"><span className="font-semibold tabular-nums">{s.value}</span> <span className="text-muted-foreground">{s.label}</span></span>
                  <ArrowRight className="size-3 text-muted-foreground" />
                </li>
              ))}
              <li className="flex items-center gap-1 rounded-md bg-brand-soft px-2 py-1 font-medium text-brand"><Check className="size-3" /> Order · {orderStatus.toLowerCase().replace(/_/g, ' ')}</li>
            </ol>
          </div>
        )}
        {canSet && (
          <div className="flex gap-2 pt-1">
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger className="h-8 flex-1" aria-label="Order source"><SelectValue placeholder={a && a.channel !== 'unknown' ? 'Change source…' : 'Set source…'} /></SelectTrigger>
              <SelectContent>{MANUAL_SOURCES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={!choice || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : 'Save'}</Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
