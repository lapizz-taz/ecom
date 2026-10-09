import type { PaymentInitContext, PaymentInitResult, PaymentProvider, VerifiedPayment } from './types.ts'

type FetchFn = typeof fetch

/**
 * PayStation hosted checkout (bKash, Nagad, Rocket, Upay and cards in one page).
 *
 *   initiate-payment → customer pays on PayStation → callback →
 *   transaction-status (server) → the order is paid.
 *
 * The callback's status is never trusted: the payment counts only when the
 * transaction-status API reports it successful for our invoice number, and
 * confirm_payment() checks the amount.
 */
export const PAYSTATION_URL = 'https://api.paystation.com.bd'

export interface PaystationConfig {
  merchantId: string
  password: string
  /** Extra token header some older PayStation accounts were issued; the status API needs only the merchant ID. */
  token?: string
  baseUrl?: string
  /** 1 = the customer pays the gateway charge on top; 0 = the store absorbs it. */
  payWithCharge?: boolean
  timeoutMs?: number
}

type Body = Record<string, unknown>

function text(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

const SUCCESS = /^(success|successful|completed|paid)$/i
const FAILED = /^(failed|failure|fail|cancel|canceled|cancelled|declined|expired)$/i

export class PaystationProvider implements PaymentProvider {
  readonly code = 'paystation'

  constructor(private readonly config: PaystationConfig, private readonly fetchFn: FetchFn = fetch) {}

  private get base(): string {
    return (this.config.baseUrl || PAYSTATION_URL).replace(/\/+$/, '')
  }

  private async post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Body> {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.set(k, v)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20_000)
    try {
      const response = await this.fetchFn(`${this.base}${path}`, {
        method: 'POST', headers: { Accept: 'application/json', ...headers }, body: form, signal: controller.signal,
      })
      const json = (await response.json().catch(() => null)) as Body | null
      if (!json) throw new Error(`PayStation answered HTTP ${response.status} without a body`)
      return json
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error('PayStation did not answer in time')
      if (error instanceof TypeError) throw new Error('Could not reach PayStation')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async initiate(ctx: PaymentInitContext): Promise<PaymentInitResult> {
    const { payment, order, urls } = ctx
    const body = await this.post('/initiate-payment', {
      merchantId: this.config.merchantId,
      password: this.config.password,
      invoice_number: payment.reference,
      currency: payment.currency || 'BDT',
      payment_amount: payment.amount.toFixed(2),
      pay_with_charge: this.config.payWithCharge ? '1' : '0',
      reference: order.order_number,
      cust_name: order.customer_name.slice(0, 80),
      cust_phone: order.customer_phone,
      cust_email: order.customer_email || 'no-reply@example.com',
      cust_address: order.shipping_address.slice(0, 120),
      callback_url: urls.success,
      checkout_items: `Order ${order.order_number} (${payment.purpose.toLowerCase()})`,
    })
    const url = text(body.payment_url)
    if (String(body.status_code) !== '200' || String(body.status).toLowerCase() !== 'success' || !url) {
      throw new Error(`PayStation could not start the payment: ${text(body.message) ?? `status ${text(body.status_code) ?? 'unknown'}`}`)
    }
    return { type: 'redirect', redirectUrl: url, session: payment.reference }
  }

  /**
   * The transaction as PayStation's server sees it: POST /transaction-status
   * with the merchant ID in a `merchantId` header and invoice_number in the
   * body (PayStation answers "Invalid Merchant ID" without that header).
   */
  async status(invoice: string): Promise<Body> {
    const headers: Record<string, string> = { merchantId: this.config.merchantId }
    if (this.config.token) headers.token = this.config.token
    return this.post('/transaction-status', { invoice_number: invoice }, headers)
  }

  private result(invoice: string, body: Body, source: string): VerifiedPayment | null {
    const data = (body.data ?? {}) as Body
    const state = text(data.trx_status) ?? text(data.status) ?? ''
    if (SUCCESS.test(state) && text(data.trx_id)) {
      return {
        reference: text(data.invoice_number) ?? invoice,
        providerTransactionId: text(data.trx_id),
        amount: Number(data.payment_amount ?? data.amount),
        currency: text(data.currency) ?? 'BDT',
        success: true,
        eventId: `paystation:trx:${data.trx_id}`,
        eventType: `${source}.success`,
        raw: body,
      }
    }
    if (FAILED.test(state)) {
      return {
        reference: invoice,
        providerTransactionId: null,
        amount: null,
        currency: null,
        success: false,
        eventId: `paystation:${invoice}:${state.toLowerCase()}`,
        eventType: `${source}.${state.toLowerCase()}`,
        reason: `PayStation reports the payment ${state.toLowerCase()}`,
        raw: body,
      }
    }
    return null
  }

  async verifyCallback(params: Record<string, string>): Promise<VerifiedPayment> {
    const invoice = params.invoice_number || params.reference || ''
    if (!invoice) throw new Error('PayStation callback without an invoice number')
    const body = await this.status(invoice)
    const result = this.result(invoice, body, 'callback')
    if (result) return result
    // Cancelled on the page and PayStation has no record of a payment.
    const callbackStatus = (params.status ?? '').toLowerCase()
    if (FAILED.test(callbackStatus) && String(body.status_code) !== '200') {
      return {
        reference: invoice, providerTransactionId: null, amount: null, currency: null, success: false,
        eventId: `paystation:${invoice}:${callbackStatus}`, eventType: `callback.${callbackStatus}`,
        reason: callbackStatus.startsWith('cancel') ? 'Cancelled on the PayStation page' : 'The payment failed on the PayStation page',
        raw: { callback: params, status: body },
      }
    }
    throw new Error(`PayStation has not confirmed invoice ${invoice} yet (${text(body.message) ?? 'processing'})`)
  }

  async reconcile(session: string, _reference: string, ageMinutes: number): Promise<VerifiedPayment | null> {
    const body = await this.status(session)
    const result = this.result(session, body, 'reconcile')
    if (result) return result
    if (ageMinutes < 90) return null
    return {
      reference: session, providerTransactionId: null, amount: null, currency: null, success: false,
      eventId: `paystation:${session}:expired`, eventType: 'reconcile.expired',
      reason: 'No payment arrived from PayStation', raw: body,
    }
  }

  /**
   * Checks both credentials: the merchant ID against the status API (with an
   * invoice that cannot exist), then the password by opening a ৳10 test
   * checkout link that nobody pays — nothing is charged.
   */
  async test(callbackUrl = 'https://example.com/paystation-test'): Promise<string> {
    const refused = (body: Body) => {
      const msg = text(body.message) ?? ''
      return ['401', '403'].includes(String(body.status_code)) || /unauthori[sz]ed|invalid (token|merchant|credential|password)|token mismatch|wrong password/i.test(msg)
    }
    const invoice = `TEST${Date.now()}`
    const status = await this.status(invoice)
    if (refused(status)) throw new Error(`PayStation refused the merchant ID: ${text(status.message) ?? `status ${text(status.status_code)}`}`)
    const start = await this.post('/initiate-payment', {
      merchantId: this.config.merchantId, password: this.config.password, invoice_number: invoice, currency: 'BDT',
      payment_amount: '10', pay_with_charge: '0', reference: 'Connection test', cust_name: 'Connection test',
      cust_phone: '01700000000', cust_email: 'no-reply@example.com', cust_address: 'Connection test',
      callback_url: callbackUrl, checkout_items: 'Connection test (not charged)',
    })
    if (String(start.status_code) !== '200' || !text(start.payment_url)) {
      throw new Error(`PayStation refused the credentials: ${text(start.message) ?? `status ${text(start.status_code) ?? 'unknown'}`}`)
    }
    return 'Connected to PayStation (merchant ID and password accepted)'
  }
}
