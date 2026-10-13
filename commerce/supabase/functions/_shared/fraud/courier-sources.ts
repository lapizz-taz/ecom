// BD Courier and the courier sign-ins working as one source ("use both"):
// a customer check asks both at once and merges them courier by courier. A
// courier's own merchant panel wins for that courier when it answered; BD
// Courier fills in every other courier and keeps its verdict and reports. If
// one side fails the other still answers. The pair is metered once per check
// (see providersFromSettings), and is stored as the courier_history result so
// every screen that shows courier history shows the merged lines.
import type { CourierHistorySummary, CourierLine } from './courier-history.ts'
import type { FraudCheckInput, FraudProvider, FraudProviderResult } from './types.ts'

interface CourierSource {
  readonly name: string
  lookup(phone: string): Promise<CourierHistorySummary>
}

const courierKey = (courier: string) => courier.toLowerCase().replace(/[^a-z]/g, '')
const rateOf = (delivered: number, total: number) => (total > 0 ? Math.round((delivered / total) * 10000) / 100 : null)

/** Each line says where it came from, so the order page can show it. */
const tagged = (s: CourierHistorySummary, source: 'bd_courier' | 'sign_in'): CourierHistorySummary =>
  ({ ...s, couriers: s.couriers.map((c) => ({ ...c, source: c.source ?? source })) })

/** One summary from both: per courier, the panel's own figures replace BD Courier's when the panel answered. */
export function mergeCourierSummaries(bd: CourierHistorySummary | null, signIns: CourierHistorySummary | null): CourierHistorySummary | null {
  const history = bd && tagged(bd, 'bd_courier')
  const panel = signIns && tagged(signIns, 'sign_in')
  if (!history || !panel) return history ?? panel
  const lines = new Map<string, CourierLine>(history.couriers.map((c) => [courierKey(c.courier), c]))
  let { total, delivered, cancelled } = history
  let replaced = false
  for (const p of panel.couriers) {
    const k = courierKey(p.courier)
    const h = lines.get(k)
    if (p.notice) {
      // That courier's sign-in failed: keep BD Courier's line, or show the failure if BD Courier has none.
      if (!h) lines.set(k, p)
      continue
    }
    // A sign-in that gives only a rate never replaces BD Courier's parcel counts for that courier.
    if (p.rate_only && h && !h.rate_only && h.orders > 0) {
      if (p.fraud_reports) lines.set(k, { ...h, fraud_reports: p.fraud_reports })
      continue
    }
    const counted = h && !h.rate_only
    total += p.orders - (counted ? h.orders : 0)
    delivered += p.delivered - (counted ? h.delivered : 0)
    cancelled += p.cancelled - (counted ? h.cancelled : 0)
    lines.set(k, { ...p, courier: h?.courier ?? p.courier, name: h?.name ?? p.name })
    replaced = true
  }
  const couriers = [...lines.values()].sort((a, b) => b.orders - a.orders)
  if (!replaced) return { ...history, couriers }
  return {
    ...history,
    couriers,
    total,
    delivered,
    cancelled,
    success_ratio: rateOf(delivered, total),
    ratio_source: 'counts',
    parcel_floor: Math.max(history.parcel_floor ?? 0, total),
  }
}

/** Fraud provider over BD Courier and the courier sign-ins together. */
export class CourierSourcesProvider implements FraudProvider {
  readonly name = 'courier_history'

  /** The courier sign-ins get this long (a checkout is waiting); BD Courier keeps its own timeout. */
  constructor(private readonly history: CourierSource | null, private readonly panel: CourierSource | null, private readonly panelWaitMs = 12_000) {}

  async lookup(phone: string): Promise<CourierHistorySummary> {
    const ask = (s: CourierSource | null) => (s ? s.lookup(phone) : Promise.resolve(null))
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('took too long')), this.panelWaitMs) })])
    const [h, p] = await Promise.allSettled([ask(this.history), capped(ask(this.panel))])
    clearTimeout(timer)
    const value = (r: PromiseSettledResult<CourierHistorySummary | null>) => (r.status === 'fulfilled' ? r.value : null)
    const failures = [[h, 'BD Courier'], [p, 'Courier sign-ins']]
      .filter(([r]) => (r as PromiseSettledResult<unknown>).status === 'rejected')
      .map(([r, label]) => `${label}: ${((r as PromiseRejectedResult).reason as Error)?.message ?? 'failed'}`)
    const merged = mergeCourierSummaries(value(h), value(p))
    if (!merged) throw new Error(failures.join('; ') || 'No courier source is connected')
    return failures.length ? { ...merged, source_notes: failures } : merged
  }

  async checkCustomer(input: FraudCheckInput): Promise<FraudProviderResult> {
    try {
      const summary = await this.lookup(input.phone)
      return {
        provider: this.name,
        ok: true,
        counts: { total: summary.total, delivered: summary.delivered, returned: summary.cancelled },
        courierScore: summary.ratio_source === 'provider' && summary.success_ratio !== null ? summary.success_ratio : undefined,
        parcelFloor: summary.parcel_floor,
        raw: summary,
      }
    } catch (error) {
      return { provider: this.name, ok: false, counts: {}, error: (error as Error).message }
    }
  }
}
