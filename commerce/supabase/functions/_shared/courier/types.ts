// Courier integrations implement one interface (CourierService). The database
// stores only provider-neutral shipments; API keys live in function secrets.

export type ShipmentStatus =
  | 'PENDING'
  | 'BOOKED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'PARTIALLY_DELIVERED'
  | 'FAILED'
  | 'RETURNING'
  | 'RETURNED'
  | 'CANCELLED'
  | 'ON_HOLD'

export interface ShipmentRequest {
  orderNumber: string
  recipientName: string
  recipientPhone: string
  recipientAddress: string
  district: string
  area?: string | null
  codAmount: number
  itemCount: number
  weightGrams?: number | null
  note?: string | null
  /** What is in the parcel ("2× Tote, 1× Cap"), when the courier is set to send product names. */
  itemDescription?: string | null
  /** Pickup store for this parcel (Pathao); the courier's default store otherwise. */
  storeId?: string | null
}

export interface ShipmentRef {
  consignmentId?: string | null
  trackingNumber?: string | null
  orderNumber?: string | null
}

export interface ShipmentCreated {
  consignmentId: string | null
  trackingNumber: string | null
  status: ShipmentStatus
  cost?: number | null
  raw: unknown
}

export interface ShipmentStatusResult {
  status: ShipmentStatus | null
  providerStatus: string
  description?: string
  raw: unknown
}

export interface TrackingInfo {
  url: string | null
  events: Array<{ status: string; description?: string; at?: string }>
}

export interface CourierProvider {
  readonly code: string
  createShipment(request: ShipmentRequest): Promise<ShipmentCreated>
  cancelShipment(ref: ShipmentRef): Promise<void>
  getShipmentStatus(ref: ShipmentRef): Promise<ShipmentStatusResult>
  getTracking(ref: ShipmentRef): Promise<TrackingInfo>
  /** Delivery cost quoted by the courier, or null when it has no quote API. */
  getDeliveryCost(request: Pick<ShipmentRequest, 'district' | 'area' | 'weightGrams' | 'codAmount'>): Promise<number | null>
  testConnection(): Promise<{ ok: boolean; message: string }>
}

export class CourierNotSupportedError extends Error {}
