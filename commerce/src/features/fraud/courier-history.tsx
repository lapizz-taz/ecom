import { cn } from '@/lib/utils'
import type { CourierHistoryResult } from '@/services/settings'

const COURIER_NAMES: Record<string, string> = {
  pathao: 'Pathao', steadfast: 'Steadfast', redx: 'RedX', paperfly: 'Paperfly', parceldex: 'ParcelDex', courrierfast: 'CourierFast', carrybee: 'CarryBee',
}

function rateTone(rate: number | null) {
  if (rate === null) return 'text-muted-foreground'
  return rate >= 80 ? 'text-emerald-700' : rate >= 50 ? 'text-amber-700' : 'text-red-700'
}

/** Read the courier-history result stored with a fraud check (staff only). */
export function courierHistoryOf(providerResponse: unknown): CourierHistoryResult | null {
  const r = (providerResponse as { courier_history?: unknown } | null)?.courier_history as CourierHistoryResult | undefined
  return r && Array.isArray(r.couriers) ? r : null
}

/** Parcels per courier for a phone number — for staff, never shown to customers. */
export function CourierHistoryTable({ result, className }: { result: CourierHistoryResult; className?: string }) {
  const rate = result.success_ratio
  return (
    <div className={cn('space-y-2', className)}>
      <div>
        <p className="text-sm">
          <span className={cn('text-lg font-semibold tabular-nums', rateTone(rate))}>{rate === null ? 'No history' : `${Math.round(rate)}%`}</span>
          {rate !== null && <span className="text-muted-foreground"> received · {result.delivered} of {result.total} parcels</span>}
        </p>
        {result.name_on_record && <p className="truncate text-xs text-muted-foreground">Name on courier records: {result.name_on_record}</p>}
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr><th className="px-2.5 py-1.5 text-left font-medium">Courier</th><th className="px-2 py-1.5 text-right font-medium">Parcels</th><th className="px-2 py-1.5 text-right font-medium">Cancelled</th><th className="px-2.5 py-1.5 text-right font-medium">Rate</th></tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {result.couriers.map((c) => {
              const r = c.orders > 0 ? Math.round((c.delivered / c.orders) * 100) : null
              return (
                <tr key={c.courier} className={c.orders === 0 ? 'text-muted-foreground' : undefined}>
                  <td className="px-2.5 py-1.5">{COURIER_NAMES[c.courier] ?? c.courier}</td>
                  <td className="px-2 py-1.5 text-right">{c.orders}</td>
                  <td className={cn('px-2 py-1.5 text-right', c.cancelled > 0 && 'text-red-700')}>{c.cancelled}</td>
                  <td className={cn('px-2.5 py-1.5 text-right', rateTone(r))}>{r === null ? '—' : `${r}%`}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!!result.reports?.length && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-2.5 text-xs">
          <p className="font-medium text-red-800">{result.reports.length} fraud report{result.reports.length > 1 ? 's' : ''} from other merchants</p>
          <ul className="mt-1.5 space-y-1.5">
            {result.reports.slice(0, 5).map((r, i) => (
              <li key={i} className="text-muted-foreground">
                <span className="text-foreground">{r.details || 'Reported'}</span>
                {[r.name, r.courier, r.created_at?.slice(0, 10)].filter(Boolean).length > 0 && <> · {[r.name, r.courier, r.created_at?.slice(0, 10)].filter(Boolean).join(' · ')}</>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
