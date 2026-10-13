// The delivery-risk label on an order, and the evidence behind it. It reads the tier the
// database worked out when the courier check ran (Settings → Fraud → delivery success):
//   rate = delivered ÷ (delivered + returned or cancelled at the door), over the couriers
//   that report parcel counts; a courier that reports only its own rate (Steadfast) is
//   used on its own only when no courier reports counts.
//   GOOD (rate ≥ good_min) → Low risk, MID (≥ mid_min) → Medium risk, below → High risk,
//   fewer than min_parcels parcels → Insufficient data, a check that could not run →
//   Verification unavailable. A cancelled or returned parcel alone never makes a fraud label.
import type { CourierLineRecord, DeliveryPolicy, OrderCustomerRecord } from '@/services/orders'

export type RiskLevel = 'low' | 'medium' | 'high' | 'insufficient' | 'unavailable' | 'unchecked'

export interface DeliveryRisk {
  level: RiskLevel
  label: string
  /** Plain-language evidence, most important first. */
  reasons: string[]
}

const DEFAULT_POLICY: DeliveryPolicy = { good_min: 80, mid_min: 50, min_parcels: 1 }
const NAMES: Record<string, string> = { pathao: 'Pathao', steadfast: 'Steadfast', redx: 'RedX', carrybee: 'CarryBee' }
const nameOf = (c: CourierLineRecord) => NAMES[c.courier.toLowerCase().replace(/[^a-z]/g, '')] ?? c.name ?? c.courier
const pct = (n: number) => `${Math.round(n * 10) / 10}%`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function deliveryRisk(record: Pick<OrderCustomerRecord, 'check' | 'last_failure' | 'policy'>): DeliveryRisk {
  const policy = record.policy ?? DEFAULT_POLICY
  const check = record.check
  const failure = record.last_failure
  if (!check) {
    return failure
      ? { level: 'unavailable', label: 'Verification unavailable', reasons: [`The courier check could not run: ${failure.error || 'no source answered'}`] }
      : { level: 'unchecked', label: 'Not checked yet', reasons: [] }
  }

  const lines = check.couriers ?? []
  const counted = lines.filter((c) => !c.notice && !c.rate_only && c.orders > 0)
  const rateOnly = lines.filter((c) => !c.notice && c.rate_only && c.success_ratio !== null && c.success_ratio !== undefined)
  const failed = lines.filter((c) => c.notice)
  const reasons: string[] = []

  const parcels = counted.reduce((s, c) => s + c.orders, 0)
  const delivered = counted.reduce((s, c) => s + c.delivered, 0)
  if (parcels > 0) {
    const names = counted.map(nameOf).join(', ')
    reasons.push(`${delivered} of ${plural(parcels, 'parcel')} delivered${check.rate !== null ? ` (${pct(check.rate)})` : ''} — ${names}`)
    const back = parcels - delivered
    if (back > 0) reasons.push(`${plural(back, 'parcel')} cancelled or returned at the door`)
  }
  for (const c of rateOnly) {
    reasons.push(`${nameOf(c)} reports only its own rate: ${pct(c.success_ratio as number)} delivered${c.parcel_range ? `, volume ${c.parcel_range}` : ''} (no parcel counts)`)
  }
  for (const c of lines.filter((l) => l.fraud_reports)) {
    reasons.push(`${nameOf(c)}: ${plural(c.fraud_reports as number, 'fraud report')} by other merchants`)
  }
  const unreached = [...(check.notes ?? []), ...failed.map((c) => `${nameOf(c)}: ${c.notice}`)]
  if (unreached.length) reasons.push(`Not reached: ${unreached.join('; ')}`)
  if (failure) reasons.push(`A newer check failed: ${failure.error || 'no source answered'}`)

  const rate = check.rate
  const tier = check.tier ?? (check.status === 'ERROR' ? 'ERROR' : null)
  if (tier === 'ERROR' || check.status === 'ERROR') {
    return { level: 'unavailable', label: 'Verification unavailable', reasons: reasons.length ? reasons : ['No courier source answered'] }
  }
  if (tier === 'GOOD') {
    return { level: 'low', label: 'Low risk', reasons: [...reasons, `At or above the store's Good mark of ${policy.good_min}%`] }
  }
  if (tier === 'MID') {
    return { level: 'medium', label: 'Medium risk', reasons: [...reasons, `Between the Medium (${policy.mid_min}%) and Good (${policy.good_min}%) marks`] }
  }
  if (tier === 'LOW') {
    return { level: 'high', label: 'High risk', reasons: [...reasons, `Below the store's Medium mark of ${policy.mid_min}%`] }
  }
  // NEW, or a check from before tiers existed.
  if (rate !== null && rate !== undefined && tier === null && (parcels >= policy.min_parcels || rateOnly.length)) {
    const level: RiskLevel = rate >= policy.good_min ? 'low' : rate >= policy.mid_min ? 'medium' : 'high'
    const label = level === 'low' ? 'Low risk' : level === 'medium' ? 'Medium risk' : 'High risk'
    return { level, label, reasons }
  }
  return {
    level: 'insufficient',
    label: 'Insufficient data',
    reasons: [
      ...reasons,
      parcels === 0 && !rateOnly.length
        ? 'No parcels on record with the couriers checked'
        : `Fewer than ${plural(policy.min_parcels, 'parcel')} on record — not enough to judge`,
    ],
  }
}
