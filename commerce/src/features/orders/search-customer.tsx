import { useQuery } from '@tanstack/react-query'
import { Copy, MessageCircle, Phone } from 'lucide-react'
import { Money } from '@/components/common/money'
import { Skeleton } from '@/components/ui/skeleton'
import { waNumber } from '@/features/storefront/whatsapp-confirm'
import { formatPercent } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { OrderHit } from '@/services/order-search'
import { orderCustomerRecord } from '@/services/orders'

/**
 * The customer behind a search, when every result is the same mobile number:
 * their record with this business and the courier check, with call and
 * WhatsApp at hand.
 */
export function SearchCustomerPanel({ hits }: { hits: OrderHit[] }) {
  const first = hits[0]
  const record = useQuery({
    queryKey: ['order-customer-record', first.id],
    queryFn: () => orderCustomerRecord(first.id),
    staleTime: 60_000,
  })
  const spent = hits.filter((o) => o.status === 'DELIVERED').reduce((sum, o) => sum + o.total_amount, 0)
  const ours = record.data?.ours
  const check = record.data?.check
  const success = ours && ours.delivered + ours.returned + ours.cancelled > 0
    ? ours.delivered / (ours.delivered + ours.returned + ours.cancelled) : null
  const rate = check?.rate ?? null
  const wa = waNumber(first.customer_phone)

  return (
    <section aria-label="Customer" className="grid gap-4 rounded-2xl border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-foreground text-base font-semibold text-background">
          {(first.customer_name || '?').trim().charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold">{first.customer_name}</p>
          <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <span className="tabular-nums">{first.customer_phone}</span>
            <button type="button" aria-label="Copy mobile number" className="rounded p-1 hover:bg-muted hover:text-foreground"
              onClick={() => { void navigator.clipboard.writeText(first.customer_phone).then(() => toast.success('Mobile number copied'), () => undefined) }}>
              <Copy className="size-3.5" />
            </button>
            <a href={`tel:${first.customer_phone}`} aria-label="Call" className="rounded p-1 hover:bg-muted hover:text-foreground"><Phone className="size-3.5" /></a>
            {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label="WhatsApp" className="rounded p-1 hover:bg-muted hover:text-foreground"><MessageCircle className="size-3.5" /></a>}
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {record.isLoading ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12 w-24" />) : (
          <>
            <Stat label="Orders" value={String(ours?.total ?? hits.length)} />
            <Stat label="Delivered" value={String(ours?.delivered ?? 0)} hint={success != null ? formatPercent(success * 100, 0) : undefined} tone={success != null && success < 0.6 ? 'bad' : 'good'} />
            <Stat label="Returned / cancelled" value={`${ours?.returned ?? 0} / ${ours?.cancelled ?? 0}`} />
            <Stat label="Courier record" value={rate != null ? `${Math.round(rate)}%` : '—'} hint={check ? `${check.delivered}/${check.total} parcels` : 'not checked'}
              tone={rate != null && rate < 60 ? 'bad' : 'good'} />
          </>
        )}
      </dl>
      {spent > 0 && <p className="text-xs text-muted-foreground sm:col-span-2">Delivered orders in these results: <Money value={spent} /></p>}
    </section>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-xl bg-muted/50 px-3 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="flex items-baseline gap-1.5">
        <span className="font-semibold tabular-nums">{value}</span>
        {hint && <span className={cn('text-[11px]', tone === 'bad' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>{hint}</span>}
      </dd>
    </div>
  )
}
