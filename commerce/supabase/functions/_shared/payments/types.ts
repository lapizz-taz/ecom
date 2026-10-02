// Payment providers plug into one interface. The database decides how much is
// due (start_order_payment) and records money only after a provider has
// confirmed it server-to-server (confirm_payment), so a browser can never mark
// an order as paid.

export interface PaymentInitContext {
  payment: { id: string; reference: string; amount: number; currency: string; purpose: string }
  order: {
    order_number: string
    customer_name: string
    customer_phone: string
    customer_email: string | null
    shipping_address: string
    shipping_district: string
  }
  urls: { success: string; fail: string; cancel: string; ipn: string }
}

export interface PaymentInitResult {
  type: 'redirect' | 'manual'
  redirectUrl?: string
  instructions?: string
  accounts?: Array<{ channel: string; label: string; number: string }>
  providerData?: Record<string, unknown>
}

export interface VerifiedPayment {
  /** Our payment reference (payments.reference). */
  reference: string
  providerTransactionId: string | null
  amount: number | null
  currency: string | null
  success: boolean
  /** Stable id used to deduplicate repeated callbacks. */
  eventId: string
  eventType: string
  reason?: string
  raw: unknown
}

export interface PaymentProvider {
  readonly code: string
  initiate(ctx: PaymentInitContext): Promise<PaymentInitResult>
  /** Verifies a callback (IPN or browser return) with the provider's server. */
  verifyCallback?(params: Record<string, string>): Promise<VerifiedPayment>
}
