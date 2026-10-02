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
