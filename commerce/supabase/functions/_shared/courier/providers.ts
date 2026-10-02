import {
  type CourierProvider,
  CourierNotSupportedError,
  type ShipmentCreated,
  type ShipmentRef,
  type ShipmentRequest,
  type ShipmentStatus,
  type ShipmentStatusResult,
  type TrackingInfo,
} from './types.ts'

type FetchFn = typeof fetch

function trackingUrl(template: string | null | undefined, tracking: string | null | undefined): string | null {
  return template && tracking ? template.replace('{tracking}', encodeURIComponent(tracking)) : null
}

/** Couriers without an API: tracking numbers are entered by staff. */
export class ManualCourierProvider implements CourierProvider {
  readonly code = 'manual'
  constructor(private readonly trackingTemplate: string | null = null) {}

  createShipment(): Promise<ShipmentCreated> {
    return Promise.reject(new CourierNotSupportedError('This courier has no API connection. Enter the tracking number manually.'))
  }
  cancelShipment(): Promise<void> {
    return Promise.reject(new CourierNotSupportedError('Cancel the parcel with the courier, then update the shipment here.'))
  }
  getShipmentStatus(): Promise<ShipmentStatusResult> {
    return Promise.reject(new CourierNotSupportedError('Status sync is not available for this courier.'))
  }
  getTracking(ref: ShipmentRef): Promise<TrackingInfo> {
    return Promise.resolve({ url: trackingUrl(this.trackingTemplate, ref.trackingNumber), events: [] })
  }
  getDeliveryCost(): Promise<number | null> {
    return Promise.resolve(null)
  }
  testConnection(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({ ok: true, message: 'Manual courier — no API to test' })
  }
}

/** Steadfast Courier (packzy) API. */
export const STEADFAST_STATUS: Record<string, ShipmentStatus | null> = {
  in_review: 'BOOKED',
  pending: 'IN_TRANSIT',
  hold: 'ON_HOLD',
  delivered_approval_pending: 'DELIVERED',
  delivered: 'DELIVERED',
  partial_delivered_approval_pending: 'PARTIALLY_DELIVERED',
  partial_delivered: 'PARTIALLY_DELIVERED',
  cancelled_approval_pending: 'RETURNING',
  cancelled: 'RETURNING',
  unknown_approval_pending: null,
  unknown: null,
}

export function mapSteadfastStatus(value: string | null | undefined): ShipmentStatus | null {
  const key = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  return key in STEADFAST_STATUS ? STEADFAST_STATUS[key] : null
}

export interface SteadfastConfig {
  apiKey: string
  secretKey: string
  baseUrl?: string
  trackingTemplate?: string | null
}

export class SteadfastProvider implements CourierProvider {
  readonly code = 'steadfast'
  constructor(private readonly config: SteadfastConfig, private readonly fetchFn: FetchFn = fetch) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchFn(`${this.config.baseUrl ?? 'https://portal.packzy.com/api/v1'}${path}`, {
      ...init,
      headers: {
        'Api-Key': this.config.apiKey,
        'Secret-Key': this.config.secretKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    })
    const body = (await response.json().catch(() => null)) as T & { status?: number; message?: string; errors?: unknown }
    if (!response.ok || !body || (typeof body.status === 'number' && body.status !== 200)) {
      const detail = body?.errors ? JSON.stringify(body.errors) : body?.message ?? `HTTP ${response.status}`
      throw new Error(`Steadfast: ${detail}`)
    }
    return body
  }

  buildOrder(request: ShipmentRequest): Record<string, unknown> {
    return {
      invoice: request.orderNumber,
      recipient_name: request.recipientName.slice(0, 100),
      recipient_phone: request.recipientPhone,
      recipient_address: [request.recipientAddress, request.area, request.district].filter(Boolean).join(', ').slice(0, 250),
      cod_amount: Math.max(0, Math.round(request.codAmount)),
      note: request.note ?? undefined,
    }
  }

  async createShipment(request: ShipmentRequest): Promise<ShipmentCreated> {
    const body = await this.call<{ consignment: { consignment_id: number; tracking_code: string; status: string } }>(
      '/create_order',
      { method: 'POST', body: JSON.stringify(this.buildOrder(request)) },
    )
    return {
      consignmentId: String(body.consignment.consignment_id),
      trackingNumber: body.consignment.tracking_code,
      status: mapSteadfastStatus(body.consignment.status) ?? 'BOOKED',
      raw: body,
    }
  }

  cancelShipment(): Promise<void> {
    return Promise.reject(new CourierNotSupportedError('Steadfast parcels are cancelled from the Steadfast portal.'))
  }

  async getShipmentStatus(ref: ShipmentRef): Promise<ShipmentStatusResult> {
    const path = ref.consignmentId
      ? `/status_by_cid/${encodeURIComponent(ref.consignmentId)}`
      : ref.trackingNumber
        ? `/status_by_trackingcode/${encodeURIComponent(ref.trackingNumber)}`
        : `/status_by_invoice/${encodeURIComponent(ref.orderNumber ?? '')}`
    const body = await this.call<{ delivery_status: string }>(path)
    return { status: mapSteadfastStatus(body.delivery_status), providerStatus: body.delivery_status, raw: body }
  }

  async getTracking(ref: ShipmentRef): Promise<TrackingInfo> {
    const status = await this.getShipmentStatus(ref)
    return {
      url: trackingUrl(this.config.trackingTemplate ?? 'https://steadfast.com.bd/t/{tracking}', ref.trackingNumber),
      events: [{ status: status.providerStatus }],
    }
  }

  getDeliveryCost(): Promise<number | null> {
    return Promise.resolve(null)
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const body = await this.call<{ current_balance: number }>('/get_balance')
      return { ok: true, message: `Connected. Balance: ${body.current_balance}` }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }
}

// -----------------------------------------------------------------------------
// Pathao Courier (merchant API, "aladdin")
// -----------------------------------------------------------------------------
export const PATHAO_STATUS: Record<string, ShipmentStatus | null> = {
  pending: 'BOOKED',
  pickup_requested: 'BOOKED',
  assigned_for_pickup: 'BOOKED',
  picked: 'PICKED_UP',
  pickup_failed: 'ON_HOLD',
  pickup_cancelled: 'CANCELLED',
  at_the_sorting_hub: 'IN_TRANSIT',
  in_transit: 'IN_TRANSIT',
  received_at_last_mile_hub: 'IN_TRANSIT',
  assigned_for_delivery: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  partial_delivery: 'PARTIALLY_DELIVERED',
  delivery_failed: 'FAILED',
  on_hold: 'ON_HOLD',
  return: 'RETURNING',
  paid_return: 'RETURNED',
  exchange: 'RETURNING',
}

export function mapPathaoStatus(value: string | null | undefined): ShipmentStatus | null {
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return key in PATHAO_STATUS ? PATHAO_STATUS[key] : null
}

/** Picks the entry whose name best matches the text (exact, then contains). */
export function matchByName<T>(rows: T[], name: (row: T) => string, wanted: string | null | undefined): T | undefined {
  const w = String(wanted ?? '').trim().toLowerCase()
  if (!w) return undefined
  return rows.find((r) => name(r).trim().toLowerCase() === w)
    ?? rows.find((r) => { const n = name(r).trim().toLowerCase(); return n.includes(w) || w.includes(n) })
}

export interface PathaoConfig {
  clientId: string
  clientSecret: string
  username: string
  password: string
  storeId: string
  sandbox?: boolean
  trackingTemplate?: string | null
}

const pathaoTokens = new Map<string, { token: string; expiresAt: number }>()

export class PathaoProvider implements CourierProvider {
  readonly code = 'pathao'
  constructor(private readonly config: PathaoConfig, private readonly fetchFn: FetchFn = fetch) {}

  private get base(): string {
    return this.config.sandbox ? 'https://courier-api-sandbox.pathao.com' : 'https://api-hermes.pathao.com'
  }

  private async token(): Promise<string> {
    const key = `${this.base}|${this.config.clientId}|${this.config.username}`
    const cached = pathaoTokens.get(key)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const response = await this.fetchFn(`${this.base}/aladdin/api/v1/issue-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        username: this.config.username,
        password: this.config.password,
        grant_type: 'password',
      }),
    })
    const body = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number; message?: string } | null
    if (!response.ok || !body?.access_token) throw new Error(`Pathao: ${body?.message ?? `could not sign in (HTTP ${response.status})`}`)
    pathaoTokens.set(key, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 })
    return body.access_token
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchFn(`${this.base}/aladdin/api/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    })
    const body = (await response.json().catch(() => null)) as (T & { message?: string; errors?: unknown }) | null
    if (!response.ok || !body) {
      const detail = body?.errors ? JSON.stringify(body.errors) : body?.message ?? `HTTP ${response.status}`
      throw new Error(`Pathao: ${detail}`)
    }
    return body
  }

  /** City and zone ids for a district / area name. */
  async resolveLocation(district: string, area?: string | null): Promise<{ cityId: number; zoneId: number }> {
    const cities = await this.call<{ data: { data: Array<{ city_id: number; city_name: string }> } }>('/city-list')
    const city = matchByName(cities.data.data, (c) => c.city_name, district)
    if (!city) throw new Error(`Pathao: no city matches "${district}"`)
    const zones = await this.call<{ data: { data: Array<{ zone_id: number; zone_name: string }> } }>(`/cities/${city.city_id}/zone-list`)
    const zone = matchByName(zones.data.data, (z) => z.zone_name, area) ?? matchByName(zones.data.data, (z) => z.zone_name, district)
    if (!zone) throw new Error(`Pathao: no zone in ${city.city_name} matches "${area ?? district}" — add the area (thana) to the order`)
    return { cityId: city.city_id, zoneId: zone.zone_id }
  }

  async createShipment(request: ShipmentRequest): Promise<ShipmentCreated> {
    const { cityId, zoneId } = await this.resolveLocation(request.district, request.area)
    const body = await this.call<{ data: { consignment_id: string; order_status: string; delivery_fee?: number } }>('/orders', {
      method: 'POST',
      body: JSON.stringify({
        store_id: Number(this.config.storeId),
        merchant_order_id: request.orderNumber,
        recipient_name: request.recipientName.slice(0, 100),
        recipient_phone: request.recipientPhone,
        recipient_address: [request.recipientAddress, request.area, request.district].filter(Boolean).join(', ').slice(0, 220),
        recipient_city: cityId,
        recipient_zone: zoneId,
        delivery_type: 48,
        item_type: 2,
        item_quantity: Math.max(request.itemCount, 1),
        item_weight: Math.max((request.weightGrams ?? 500) / 1000, 0.5),
        amount_to_collect: Math.max(0, Math.round(request.codAmount)),
        special_instruction: request.note ?? undefined,
      }),
    })
    return {
      consignmentId: String(body.data.consignment_id),
      trackingNumber: String(body.data.consignment_id),
      status: mapPathaoStatus(body.data.order_status) ?? 'BOOKED',
      cost: body.data.delivery_fee ?? null,
      raw: body,
    }
  }

  cancelShipment(): Promise<void> {
    return Promise.reject(new CourierNotSupportedError('Cancel Pathao parcels from the Pathao merchant panel.'))
  }

  async getShipmentStatus(ref: ShipmentRef): Promise<ShipmentStatusResult> {
    const id = ref.consignmentId ?? ref.trackingNumber
    if (!id) throw new Error('Pathao: the shipment has no consignment id')
    const body = await this.call<{ data: { order_status: string; order_status_slug?: string } }>(`/orders/${encodeURIComponent(id)}/info`)
    const providerStatus = body.data.order_status_slug ?? body.data.order_status
    return { status: mapPathaoStatus(providerStatus), providerStatus, raw: body }
  }

  async getTracking(ref: ShipmentRef): Promise<TrackingInfo> {
    const status = await this.getShipmentStatus(ref)
    return {
      url: trackingUrl(this.config.trackingTemplate ?? 'https://merchant.pathao.com/tracking?consignment_id={tracking}', ref.trackingNumber ?? ref.consignmentId),
      events: [{ status: status.providerStatus }],
    }
  }

  getDeliveryCost(): Promise<number | null> {
    return Promise.resolve(null)
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const body = await this.call<{ data: { data: Array<{ store_id: number; store_name: string }> } }>('/stores')
      const store = body.data.data.find((s) => String(s.store_id) === String(this.config.storeId))
      if (!store) return { ok: false, message: `Signed in, but store ${this.config.storeId} was not found in this Pathao account` }
      return { ok: true, message: `Connected to Pathao store "${store.store_name}"` }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }
}

// -----------------------------------------------------------------------------
// RedX (open API)
// -----------------------------------------------------------------------------
export const REDX_STATUS: Record<string, ShipmentStatus | null> = {
  'pickup-pending': 'BOOKED',
  'pickup-processing': 'BOOKED',
  'ready-for-delivery': 'IN_TRANSIT',
  'delivery-in-progress': 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  'agent-hold': 'ON_HOLD',
  'agent-returning': 'RETURNING',
  returned: 'RETURNED',
  'agent-area-change': 'IN_TRANSIT',
  cancelled: 'CANCELLED',
}

export function mapRedxStatus(value: string | null | undefined): ShipmentStatus | null {
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')
  return key in REDX_STATUS ? REDX_STATUS[key] : null
}

export interface RedxConfig {
  accessToken: string
  sandbox?: boolean
  trackingTemplate?: string | null
}

export class RedxProvider implements CourierProvider {
  readonly code = 'redx'
  constructor(private readonly config: RedxConfig, private readonly fetchFn: FetchFn = fetch) {}

  private get base(): string {
    return this.config.sandbox ? 'https://sandbox.redx.com.bd/v1.0.0-beta' : 'https://openapi.redx.com.bd/v1.0.0-beta'
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.config.accessToken.replace(/^Bearer\s+/i, '')
    const response = await this.fetchFn(`${this.base}${path}`, {
      ...init,
      headers: { 'API-ACCESS-TOKEN': `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    })
    const body = (await response.json().catch(() => null)) as (T & { message?: string; validation_errors?: unknown }) | null
    if (!response.ok || !body) {
      const detail = body?.validation_errors ? JSON.stringify(body.validation_errors) : body?.message ?? `HTTP ${response.status}`
      throw new Error(`RedX: ${detail}`)
    }
    return body
  }

  async resolveArea(district: string, area?: string | null): Promise<{ id: number; name: string }> {
    const body = await this.call<{ areas: Array<{ id: number; name: string }> }>(`/areas?district_name=${encodeURIComponent(district)}`)
    const found = matchByName(body.areas, (a) => a.name, area) ?? matchByName(body.areas, (a) => a.name, district) ?? body.areas[0]
    if (!found) throw new Error(`RedX: no delivery area found for "${district}"`)
    return found
  }

  async createShipment(request: ShipmentRequest): Promise<ShipmentCreated> {
    const area = await this.resolveArea(request.district, request.area)
    const body = await this.call<{ tracking_id: string }>('/parcel', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: request.recipientName.slice(0, 100),
        customer_phone: request.recipientPhone,
        delivery_area: area.name,
        delivery_area_id: area.id,
        customer_address: [request.recipientAddress, request.area, request.district].filter(Boolean).join(', ').slice(0, 250),
        merchant_invoice_id: request.orderNumber,
        cash_collection_amount: String(Math.max(0, Math.round(request.codAmount))),
        parcel_weight: Math.max(request.weightGrams ?? 500, 100),
        value: Math.max(0, Math.round(request.codAmount)),
        instruction: request.note ?? undefined,
      }),
    })
    return { consignmentId: body.tracking_id, trackingNumber: body.tracking_id, status: 'BOOKED', raw: body }
  }

  cancelShipment(): Promise<void> {
    return Promise.reject(new CourierNotSupportedError('Cancel RedX parcels from the RedX merchant panel.'))
  }

  async getShipmentStatus(ref: ShipmentRef): Promise<ShipmentStatusResult> {
    const id = ref.trackingNumber ?? ref.consignmentId
    if (!id) throw new Error('RedX: the shipment has no tracking id')
    const body = await this.call<{ parcel: { status: string } }>(`/parcel/info/${encodeURIComponent(id)}`)
    return { status: mapRedxStatus(body.parcel.status), providerStatus: body.parcel.status, raw: body }
  }

  async getTracking(ref: ShipmentRef): Promise<TrackingInfo> {
    const status = await this.getShipmentStatus(ref)
    return {
      url: trackingUrl(this.config.trackingTemplate ?? 'https://redx.com.bd/track-parcel/?trackingId={tracking}', ref.trackingNumber),
      events: [{ status: status.providerStatus }],
    }
  }

  getDeliveryCost(): Promise<number | null> {
    return Promise.resolve(null)
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const body = await this.call<{ areas: unknown[] }>('/areas?district_name=Dhaka')
      return { ok: true, message: `Connected to RedX (${body.areas.length} Dhaka delivery areas available)` }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }
}
