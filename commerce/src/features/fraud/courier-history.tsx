import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CourierHistoryLine, CourierHistoryResult } from '@/services/settings'

const COURIER_NAMES: Record<string, string> = {
  pathao: 'Pathao', steadfast: 'Steadfast', redx: 'RedX', paperfly: 'Paperfly', parceldex: 'ParcelDex', courrierfast: 'CourierFast', carrybee: 'CarryBee',
}

function rateTone(rate: number | null | undefined) {
  if (rate === null || rate === undefined) return 'text-muted-foreground'
  return rate >= 80 ? 'text-emerald-700' : rate >= 50 ? 'text-amber-700' : 'text-red-700'
}

const pct = (rate: number) => `${Number.isInteger(rate) ? rate : rate.toFixed(rate >= 99.95 ? 0 : 1)}%`

/** The courier's rate: its own figure when the service gives one, else delivered ÷ parcels. */
function lineRate(c: CourierHistoryLine): number | null {
  if (c.success_ratio !== undefined) return c.success_ratio ?? null
  return c.orders > 0 ? Math.round((c.delivered / c.orders) * 1000) / 10 : null
}

const VERDICT_TONE: Record<string, string> = {
  good: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  safe: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  review: 'border-amber-300 bg-amber-50 text-amber-900',
  risky: 'border-red-300 bg-red-50 text-red-900',
  high: 'border-red-300 bg-red-50 text-red-900',
}

/** Read the courier-history result stored with a fraud check (staff only). */
export function courierHistoryOf(providerResponse: unknown): CourierHistoryResult | null {
  const r = (providerResponse as { courier_history?: unknown } | null)?.courier_history as CourierHistoryResult | undefined
  return r && Array.isArray(r.couriers) ? r : null
}

/** Parcels per courier for a phone number — for staff, never shown to customers. */
export function CourierHistoryTable({ result, className }: { result: CourierHistoryResult; className?: string }) {
  const rate = result.success_ratio
  const rateOnly = result.couriers.filter((c) => c.rate_only)
  // Couriers with parcels or a rate first, the rest after.
  const lines = [...result.couriers].sort((a, b) => Number(b.orders > 0 || !!b.rate_only) - Number(a.orders > 0 || !!a.rate_only) || b.orders - a.orders)
  const verdict = result.verdict
  return (
    <div className={cn('space-y-2', className)}>
      <div>
        <p className="text-sm">
          <span className={cn('text-lg font-semibold tabular-nums', rateTone(rate))}>{rate === null ? 'No history' : pct(rate)}</span>
          {rate !== null && (
            <span className="text-muted-foreground">
              {' '}delivered · {result.total} parcel{result.total === 1 ? '' : 's'} · {result.delivered} delivered · {result.cancelled} cancelled
              {rateOnly.map((c) => ` · ${COURIER_NAMES[c.courier] ?? c.name ?? c.courier} ${c.parcel_range ?? 'rate only'}`).join('')}
            </span>
          )}
        </p>
        {result.name_on_record && <p className="truncate text-xs text-muted-foreground">Name on courier records: {result.name_on_record}</p>}
      </div>
      {verdict?.label && (
        <div className={cn('rounded-lg border px-3 py-2 text-xs', VERDICT_TONE[verdict.level ?? ''] ?? 'border-border bg-muted/40')}>
          <p className="font-medium">{verdict.label}{verdict.action ? ` — ${verdict.action}` : ''}</p>
          {verdict.reasons.length > 0 && <ul className="mt-0.5 list-disc pl-4">{verdict.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              <th className="px-2.5 py-1.5 text-left font-medium">Courier</th><th className="px-2 py-1.5 text-right font-medium">Total</th>
              <th className="px-2 py-1.5 text-right font-medium">Delivered</th><th className="px-2 py-1.5 text-right font-medium">Cancelled</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {lines.map((c) => {
              const r = lineRate(c)
              const empty = c.orders === 0 && !c.rate_only
              return (
                <tr key={c.courier} className={empty ? 'text-muted-foreground' : undefined} title={c.notice ?? undefined}>
                  <td className="px-2.5 py-1.5">{COURIER_NAMES[c.courier] ?? c.name ?? c.courier}</td>
                  <td className="px-2 py-1.5 text-right">{c.rate_only ? (c.parcel_range ?? '—') : c.orders}</td>
                  <td className="px-2 py-1.5 text-right text-emerald-700">{c.rate_only ? '—' : <span className={empty ? 'text-muted-foreground' : undefined}>{c.delivered}</span>}</td>
                  <td className={cn('px-2 py-1.5 text-right', !c.rate_only && c.cancelled > 0 && 'text-red-700')}>{c.rate_only ? '—' : c.cancelled}</td>
                  <td className={cn('px-2.5 py-1.5 text-right', rateTone(r))}>{r === null || (empty && r === 0) ? '—' : pct(r)}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot className="border-t bg-muted/40 font-medium tabular-nums">
            <tr>
              <td className="px-2.5 py-1.5">Total</td>
              <td className="px-2 py-1.5 text-right">{result.total}</td>
              <td className="px-2 py-1.5 text-right text-emerald-700">{result.delivered}</td>
              <td className={cn('px-2 py-1.5 text-right', result.cancelled > 0 && 'text-red-700')}>{result.cancelled}</td>
              <td className={cn('px-2.5 py-1.5 text-right', rateTone(rate))}>{rate === null ? '—' : pct(rate)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {result.calculation_note && (
        <p className="flex gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />{result.calculation_note}</p>
      )}
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
