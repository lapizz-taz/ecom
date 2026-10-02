// Fraud detection is provider-agnostic. Every provider returns the same
// normalised shape; the database merges it with the store's own order history
// and applies the configurable rules (see record_fraud_check()).

export interface FraudCheckInput {
  phone: string
  name?: string
  address?: string
  district?: string
  orderValue?: number
}

export interface OutcomeCounts {
  total?: number
  delivered?: number
  cancelled?: number
  returned?: number
  failed?: number
}

export interface FraudProviderResult {
  provider: string
  ok: boolean
  /** 0–100, higher is riskier. Optional: many providers only return history. */
  riskScore?: number
  /** Delivery success ratio across the courier network, 0–100. */
  courierScore?: number
  counts: OutcomeCounts
  recommendation?: string
  raw?: unknown
  error?: string
}

export interface FraudProvider {
  readonly name: string
  checkCustomer(input: FraudCheckInput): Promise<FraudProviderResult>
}

/** Payload accepted by the record_fraud_check() database function. */
export interface RecordFraudCheckPayload {
  phone: string
  order_id?: string
  provider: string
  providers: string[]
  status: 'SUCCESS' | 'PARTIAL' | 'ERROR'
  error?: string
  provider_risk_score?: number
  provider_courier_score?: number
  provider_counts: OutcomeCounts
  provider_response: Record<string, unknown>
  recommendation?: string
  context?: Record<string, unknown>
}
