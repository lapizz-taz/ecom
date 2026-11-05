// A parcel's journey: every step the courier shows on its own tracking page (hubs, the rider, the
// delivery), so staff can follow a parcel without opening the courier's panel.
//
// Pathao's merchant API only gives the current status, so the journey is read from its public
// tracking page (merchant.pathao.com/tracking), which needs only the consignment id. RedX has an
// official tracking endpoint. It is not a promise from Pathao: if the page changes, the caller falls
// back to the courier updates Fullfilio stored itself.
import type { TrackingStep } from './types.ts'

type FetchFn = typeof fetch
type Json = Record<string, unknown>

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
  return s ? s : null
}

/** "Nov 4, 2026 4:05 PM" on Pathao's page is Dhaka time (UTC+6). */
export function pathaoTime(value: unknown): string | null {
  const m = String(value ?? '').trim().match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])$/)
  if (!m) return null
  const month = MONTHS.indexOf(m[1].toLowerCase())
  if (month < 0) return null
  const hour = (Number(m[4]) % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0)
  const at = new Date(Date.UTC(Number(m[3]), month, Number(m[2]), hour - 6, Number(m[5])))
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/** Pathao's public tracking answer → steps, newest first, and where the parcel is now. */
export function parsePathaoJourney(body: unknown): { steps: TrackingStep[]; stage: string | null } | null {
  const data = (body && typeof body === 'object' ? (body as Json).data : null) as Json | null
  if (!data || !Array.isArray(data.log)) return null
  const steps: TrackingStep[] = []
  for (const item of data.log as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const row = item as Json
    const what = text(row.desc)
    if (!what) continue
    const group = Array.isArray(row.grouped_status) ? text(row.grouped_status[0]) : null
    steps.push({ at: pathaoTime(row.created_at), text: what, note: text(row.notes), stage: group })
  }
  const state = data.state && typeof data.state === 'object' ? text((data.state as Json).name) : null
  return { steps: steps.reverse(), stage: state ?? steps[0]?.stage ?? null }
}

/** Reads a Pathao parcel's journey from its public tracking page. */
export async function fetchPathaoJourney(consignmentId: string, fetchFn: FetchFn = fetch) {
  const response = await fetchFn('https://merchant.pathao.com/api/v1/user/tracking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ consignment_id: consignmentId }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`Pathao tracking: HTTP ${response.status}`)
  const journey = parsePathaoJourney(body)
  if (!journey) throw new Error('Pathao tracking: no journey in the answer')
  return journey
}

/** RedX GET /parcel/track/{id}: { tracking: [{ message_en, message_bn, time }] }. */
export function parseRedxJourney(body: unknown): { steps: TrackingStep[]; stage: string | null } | null {
  const rows = body && typeof body === 'object' ? (body as Json).tracking : null
  if (!Array.isArray(rows)) return null
  const steps: TrackingStep[] = []
  for (const item of rows as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const row = item as Json
    const what = text(row.message_en) ?? text(row.message_bn)
    if (!what) continue
    const at = text(row.time)
    steps.push({ at: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null, text: what, note: null, stage: null })
  }
  // Newest first, keeping the courier's own order for steps in the same minute.
  if (steps.length > 1 && (steps[0].at ?? '') < (steps[steps.length - 1].at ?? '')) steps.reverse()
  return { steps, stage: null }
}
