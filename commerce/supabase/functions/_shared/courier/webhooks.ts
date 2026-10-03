import { scrub } from '../monitoring.ts'
import { mapSteadfastStatus, PATHAO_STATUS } from './providers.ts'
import type { ShipmentStatus } from './types.ts'

/** One courier callback in the shape record_courier_webhook() stores. */
export interface CourierEvent {
  event_key: string
  event_type: string
  consignment_id: string | null
  order_ref: string | null
  provider_status: string | null
  status: ShipmentStatus | null
  occurred_at: string | null
  charges: { delivery_fee?: number; return_fee?: number; cod_fee?: number; collected?: number }
  payload: Record<string, unknown>
}

type Body = Record<string, unknown>

const text = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim())

/** A non-negative amount, or undefined when the field is missing or not a number. */
function amount(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined
}

function charges(entries: Record<string, number | undefined>): CourierEvent['charges'] {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)) as CourierEvent['charges']
}

async function digest(raw: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(bytes).slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Couriers in Bangladesh send local time without a zone; read it as Dhaka time. */
export function courierTime(iso: unknown, local: unknown): string | null {
  const zoned = text(iso)
  if (zoned && !Number.isNaN(Date.parse(zoned)) && /[zZ]|[+-]\d{2}:?\d{2}$/.test(zoned)) return new Date(zoned).toISOString()
  const plain = text(local)
  const m = plain?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/)
  if (m) return new Date(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}+06:00`).toISOString()
  return null
}

// Pathao webhook events ("order.delivered", "order.pickup-cancelled", …) on top of its order statuses.
const PATHAO_EVENTS: Record<string, ShipmentStatus | null> = {
  ...PATHAO_STATUS,
  created: 'BOOKED',
  updated: null,
  returned: 'RETURNED',
  return_in_transit: 'RETURNING',
  exchanged: 'RETURNING',
  paid: null,
}

export function mapPathaoEvent(event: unknown): ShipmentStatus | null {
  const key = String(event ?? '').trim().toLowerCase().replace(/^order\./, '').replace(/[\s.-]+/g, '_')
  return key in PATHAO_EVENTS ? PATHAO_EVENTS[key] : null
}

export async function normalizePathao(body: Body, raw: string): Promise<CourierEvent> {
  const event = text(body.event) ?? text(body.order_status_slug) ?? text(body.order_status) ?? 'unknown'
  const consignment = text(body.consignment_id)
  const when = text(body.updated_at) ?? text(body.timestamp)
  return {
    event_key: `pathao:${consignment ?? text(body.merchant_order_id) ?? '-'}:${event}:${when ?? await digest(raw)}`,
    event_type: event,
    consignment_id: consignment,
    order_ref: text(body.merchant_order_id),
    provider_status: event.replace(/^order\./, ''),
    status: mapPathaoEvent(event),
    occurred_at: courierTime(body.timestamp, body.updated_at),
    charges: charges({
      delivery_fee: amount(body.delivery_fee),
      return_fee: amount(body.return_fee ?? body.return_charge),
      cod_fee: amount(body.cod_fee),
      collected: amount(body.collected_amount),
    }),
    payload: scrub(body) as Body,
  }
}

export async function normalizeSteadfast(body: Body, raw: string): Promise<CourierEvent> {
  const kind = text(body.notification_type) ?? 'delivery_status'
  const status = text(body.status)
  const consignment = text(body.consignment_id)
  const when = text(body.updated_at)
  return {
    event_key: `steadfast:${consignment ?? text(body.invoice) ?? '-'}:${kind}:${status ?? '-'}:${when ?? await digest(raw)}`,
    event_type: kind,
    consignment_id: consignment,
    order_ref: text(body.invoice),
    provider_status: status,
    status: kind === 'tracking_update' ? null : mapSteadfastStatus(status),
    occurred_at: courierTime(null, body.updated_at),
    charges: charges({ delivery_fee: amount(body.delivery_charge), collected: amount(body.cod_amount) }),
    payload: scrub(body) as Body,
  }
}

/** Constant-time comparison for webhook secrets. */
export function sameSecret(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
