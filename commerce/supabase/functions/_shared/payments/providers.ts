import type { PaymentInitContext, PaymentInitResult, PaymentProvider, VerifiedPayment } from './types.ts'

type FetchFn = typeof fetch

/**
 * Manual mobile banking (bKash / Nagad / Rocket "Send Money"). The customer
 * pays outside the site and submits the transaction ID; staff verify it
 * against their statement before it counts (verify_manual_payment).
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly code = 'manual'

  constructor(private readonly settings: { instructions?: string; accounts?: Array<{ channel: string; label: string; number: string }> }) {}

  initiate(_ctx: PaymentInitContext): Promise<PaymentInitResult> {
    return Promise.resolve({
      type: 'manual',
      instructions: this.settings.instructions ?? 'Send the amount and enter the transaction ID.',
      accounts: (this.settings.accounts ?? []).filter((a) => a.number),
    })
  }
}

export interface SslCommerzConfig {
  storeId: string
  storePassword: string
  sandbox: boolean
}

/**
 * SSLCommerz hosted checkout (cards, mobile banking, internet banking).
 * Every callback is re-verified with the validation API; callback fields are
 * never trusted on their own.
 */
export class SslCommerzProvider implements PaymentProvider {
  readonly code = 'sslcommerz'

  constructor(private readonly config: SslCommerzConfig, private readonly fetchFn: FetchFn = fetch) {}

  private get base(): string {
    return this.config.sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com'
  }

  buildInitForm(ctx: PaymentInitContext): URLSearchParams {
    const { payment, order, urls } = ctx
    // A payment to the platform (credits, an invoice) is a service; a store order is goods.
    const billing = payment.purpose === 'BILLING'
    return new URLSearchParams({
      store_id: this.config.storeId,
      store_passwd: this.config.storePassword,
      total_amount: payment.amount.toFixed(2),
      currency: payment.currency,
      tran_id: payment.reference,
      success_url: urls.success,
      fail_url: urls.fail,
      cancel_url: urls.cancel,
      ipn_url: urls.ipn,
      cus_name: order.customer_name,
      cus_email: order.customer_email ?? 'customer@example.com',
      cus_phone: order.customer_phone,
      cus_add1: order.shipping_address.slice(0, 120),
      cus_city: order.shipping_district,
      cus_country: 'Bangladesh',
      shipping_method: 'NO',
      product_name: billing ? `Fullfilio ${order.order_number}` : `Order ${order.order_number}`,
      product_category: billing ? 'service' : 'ecommerce',
      product_profile: billing ? 'non-physical-goods' : 'physical-goods',
      value_a: order.order_number,
      value_b: payment.purpose,
    })
  }

  async initiate(ctx: PaymentInitContext): Promise<PaymentInitResult> {
    const response = await this.fetchFn(`${this.base}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.buildInitForm(ctx),
    })
    const body = (await response.json().catch(() => null)) as Record<string, string> | null
    if (!response.ok || !body || body.status !== 'SUCCESS' || !body.GatewayPageURL) {
      throw new Error(`SSLCommerz could not start the payment: ${body?.failedreason ?? `HTTP ${response.status}`}`)
    }
    return { type: 'redirect', redirectUrl: body.GatewayPageURL, providerData: { sessionkey: body.sessionkey } }
  }

  async verifyCallback(params: Record<string, string>): Promise<VerifiedPayment> {
    const tranId = params.tran_id ?? ''
    const status = (params.status ?? '').toUpperCase()
    if (!params.val_id || (status !== 'VALID' && status !== 'VALIDATED')) {
      return {
        reference: tranId,
        providerTransactionId: null,
        amount: null,
        currency: null,
        success: false,
        eventId: `${tranId}:${status || 'UNKNOWN'}`,
        eventType: `callback.${status.toLowerCase() || 'unknown'}`,
        reason: params.error ?? params.failedreason ?? status,
        raw: params,
      }
    }

    const url = new URL(`${this.base}/validator/api/validationserverAPI.php`)
    url.search = new URLSearchParams({
      val_id: params.val_id,
      store_id: this.config.storeId,
      store_passwd: this.config.storePassword,
      v: '1',
      format: 'json',
    }).toString()
    const response = await this.fetchFn(url.toString())
    const body = (await response.json().catch(() => null)) as Record<string, string> | null
    const validated = !!body && (body.status === 'VALID' || body.status === 'VALIDATED') && body.tran_id === tranId
    return {
      reference: body?.tran_id ?? tranId,
      providerTransactionId: body?.bank_tran_id || params.val_id,
      amount: body?.amount ? Number(body.amount) : null,
      currency: body?.currency ?? body?.currency_type ?? null,
      success: validated,
      eventId: `val:${params.val_id}`,
      eventType: 'validation',
      reason: validated ? undefined : `Validation returned ${body?.status ?? 'no response'}`,
      raw: body ?? params,
    }
  }

  /**
   * A payment whose browser never came back: SSLCommerz is asked for the transaction by its id
   * (our reference), and a paid one is confirmed through the validation API like a callback.
   */
  async reconcile(_session: string, reference: string, ageMinutes: number): Promise<VerifiedPayment | null> {
    const url = new URL(`${this.base}/validator/api/merchantTransIDvalidationAPI.php`)
    url.search = new URLSearchParams({ tran_id: reference, store_id: this.config.storeId, store_passwd: this.config.storePassword, format: 'json' }).toString()
    const response = await this.fetchFn(url.toString())
    const body = (await response.json().catch(() => null)) as { APIConnect?: string; element?: Array<Record<string, string>> } | null
    if (!response.ok || body?.APIConnect !== 'DONE') {
      throw new Error(`SSLCommerz could not look up ${reference}: ${body?.APIConnect ?? `HTTP ${response.status}`}`)
    }
    const found = body.element ?? []
    const paid = found.find((e) => (e.status === 'VALID' || e.status === 'VALIDATED') && e.val_id && e.tran_id === reference)
    if (paid) return this.verifyCallback({ tran_id: reference, val_id: paid.val_id, status: paid.status })
    if (ageMinutes < 90) return null
    return {
      reference, providerTransactionId: null, amount: null, currency: null, success: false,
      eventId: `sslcommerz:${reference}:expired`, eventType: 'reconcile.expired',
      reason: found[0]?.status ? `SSLCommerz says ${found[0].status}` : 'No payment arrived from SSLCommerz', raw: body,
    }
  }

  /** Checks the store ID and password by opening a ৳10 payment page that nobody pays — nothing is charged. */
  async test(callbackUrl = 'https://example.com/sslcommerz-test'): Promise<string> {
    const reference = `TEST${Date.now()}`
    await this.initiate({
      payment: { id: reference, reference, amount: 10, currency: 'BDT', purpose: 'BILLING' },
      order: { order_number: 'Connection test', customer_name: 'Connection test', customer_phone: '01700000000', customer_email: null,
        shipping_address: 'Connection test', shipping_district: 'Dhaka' },
      urls: { success: callbackUrl, fail: callbackUrl, cancel: callbackUrl, ipn: callbackUrl },
    }).catch((error: Error) => { throw new Error(error.message.replace('could not start the payment', 'refused the store ID or password')) })
    return 'Connected to SSLCommerz (store ID and password accepted)'
  }
}
