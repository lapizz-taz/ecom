import type { PaymentInitContext, PaymentInitResult, PaymentProvider, VerifiedPayment } from './types.ts'

type FetchFn = typeof fetch

/**
 * bKash Tokenized Checkout (the official Merchant API).
 *
 *   grant token → create payment → customer approves on bKash → callback →
 *   execute payment (server) → the order is paid.
 *
 * The callback's `status=success` is only a hint: money is recorded after
 * execute (or a status query) returns transactionStatus "Completed" for this
 * paymentID, and confirm_payment() checks the amount against what was due.
 * A payment the merchant never executes is reversed by bKash automatically.
 */
export const BKASH_LIVE_URL = 'https://tokenized.pay.bka.sh/v1.2.0-beta'
export const BKASH_SANDBOX_URL = 'https://tokenized.sandbox.bka.sh/v1.2.0-beta'

export interface BkashConfig {
  appKey: string
  appSecret: string
  username: string
  password: string
  sandbox: boolean
  baseUrl?: string
  timeoutMs?: number
}

type BkashResponse = Record<string, unknown>

interface GrantedToken { token: string; expiresAt: number }

/**
 * Where an id_token is shared between function instances, so the store grants
 * one per hour rather than one per instance. `id` ties it to the credentials
 * it was granted for: a token for an older key is ignored.
 */
export interface BkashTokenStore {
  get(): Promise<(GrantedToken & { id: string }) | null>
  set(value: GrantedToken & { id: string }): Promise<void>
}

// id_token lasts an hour; bKash asks merchants not to grant one per request.
const tokens = new Map<string, GrantedToken>()

/** bKash rejected the token itself (expired or revoked): grant a new one and try once more. */
class TokenRejected extends Error {}

/** For tests. */
export function clearBkashTokens(): void {
  tokens.clear()
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

/** bKash puts its result in statusCode/statusMessage, or errorCode/errorMessage on failure. */
function message(body: BkashResponse | null, fallback: string): string {
  if (!body) return fallback
  return text(body.statusMessage) ?? text(body.errorMessage) ?? text(body.message) ?? text(body.msg) ?? fallback
}

export class BkashProvider implements PaymentProvider {
  readonly code = 'bkash'

  constructor(
    private readonly config: BkashConfig,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
    private readonly store?: BkashTokenStore,
  ) {}

  private get base(): string {
    return (this.config.baseUrl || (this.config.sandbox ? BKASH_SANDBOX_URL : BKASH_LIVE_URL)).replace(/\/+$/, '')
  }

  private async post(path: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<BkashResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20_000)
    try {
      const response = await this.fetchFn(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const json = (await response.json().catch(() => null)) as BkashResponse | null
      if (response.status === 401 && headers.Authorization) throw new TokenRejected(message(json, 'token rejected'))
      if (!json) throw new Error(`bKash answered HTTP ${response.status} without a body`)
      if (!response.ok && !json.statusCode && !json.errorCode) throw new Error(`bKash answered HTTP ${response.status}: ${message(json, 'no detail')}`)
      return json
    } catch (error) {
      if (error instanceof TokenRejected) throw error
      if ((error as Error).name === 'AbortError') throw new Error('bKash did not answer in time')
      if (error instanceof TypeError) throw new Error('Could not reach bKash')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private get tokenKey(): string {
    return `${this.base}|${this.config.appKey}|${this.config.username}`
  }

  /** A valid id_token, granted once an hour per credential set. */
  async token(fresh = false): Promise<string> {
    const key = this.tokenKey
    const valid = (t: GrantedToken | null | undefined) => !!t && t.expiresAt > this.now() + 60_000
    const cached = tokens.get(key)
    if (!fresh && valid(cached)) return cached!.token
    const id = this.store ? await fingerprint(key) : ''
    if (!fresh && this.store) {
      const shared = await this.store.get()
      if (shared && shared.id === id && valid(shared)) {
        tokens.set(key, { token: shared.token, expiresAt: shared.expiresAt })
        return shared.token
      }
    }
    const body = await this.post('/tokenized/checkout/token/grant',
      { app_key: this.config.appKey, app_secret: this.config.appSecret },
      { username: this.config.username, password: this.config.password })
    const token = text(body.id_token)
    if (!token) throw new Error(`bKash refused the credentials: ${message(body, 'no token returned')}`)
    const granted = { token, expiresAt: this.now() + (Number(body.expires_in) || 3600) * 1000 }
    tokens.set(key, granted)
    if (this.store) await this.store.set({ id, ...granted })
    return token
  }

  private async call(path: string, body: Record<string, unknown>): Promise<BkashResponse> {
    const send = async (fresh: boolean) =>
      this.post(path, body, { Authorization: await this.token(fresh), 'X-APP-Key': this.config.appKey })
    try {
      return await send(false)
    } catch (error) {
      if (!(error instanceof TokenRejected)) throw error
      tokens.delete(this.tokenKey)
      return send(true)
    }
  }

  async initiate(ctx: PaymentInitContext): Promise<PaymentInitResult> {
    const body = await this.call('/tokenized/checkout/create', {
      mode: '0011',
      payerReference: ctx.order.customer_phone,
      // bKash returns to this URL with ?paymentID=…&status=success|failure|cancel
      callbackURL: ctx.urls.success,
      amount: ctx.payment.amount.toFixed(2),
      currency: ctx.payment.currency || 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: ctx.payment.reference,
    })
    const paymentId = text(body.paymentID)
    const url = text(body.bkashURL)
    if (body.statusCode !== '0000' || !paymentId || !url) {
      throw new Error(`bKash could not start the payment: ${message(body, 'no payment link')}`)
    }
    return { type: 'redirect', redirectUrl: url, session: paymentId, providerData: { bkash_payment_id: paymentId } }
  }

  /** Execute, or — if that already happened or timed out — ask bKash for the payment's status. */
  private async settle(paymentId: string): Promise<BkashResponse | null> {
    let executed: BkashResponse | null = null
    try {
      executed = await this.call('/tokenized/checkout/execute', { paymentID: paymentId })
      if (executed.statusCode === '0000' && executed.transactionStatus === 'Completed') return executed
    } catch {
      executed = null
    }
    const status = await this.call('/tokenized/checkout/payment/status', { paymentID: paymentId }).catch(() => null)
    return status?.transactionStatus ? status : executed
  }

  private result(paymentId: string, reference: string, body: BkashResponse | null, source: string): VerifiedPayment {
    const completed = !!body && body.transactionStatus === 'Completed' && (!body.statusCode || body.statusCode === '0000') && !!text(body.trxID)
    return {
      reference: text(body?.merchantInvoiceNumber) ?? reference,
      providerTransactionId: completed ? text(body!.trxID) : null,
      amount: completed ? Number(body!.amount) : null,
      currency: completed ? text(body!.currency) ?? 'BDT' : null,
      success: completed,
      eventId: completed ? `bkash:trx:${body!.trxID}` : `bkash:${paymentId}:${text(body?.transactionStatus) ?? 'failed'}`,
      eventType: completed ? `${source}.completed` : `${source}.${(text(body?.transactionStatus) ?? 'failed').toLowerCase()}`,
      reason: completed ? undefined : message(body, 'bKash did not confirm the payment'),
      raw: body,
    }
  }

  async verifyCallback(params: Record<string, string>): Promise<VerifiedPayment> {
    const paymentId = params.paymentID ?? ''
    const status = (params.status ?? '').toLowerCase()
    const reference = params.reference ?? ''
    if (!paymentId) throw new Error('bKash callback without a paymentID')
    if (status !== 'success') {
      return {
        reference,
        providerTransactionId: null,
        amount: null,
        currency: null,
        success: false,
        eventId: `bkash:${paymentId}:${status || 'unknown'}`,
        eventType: `callback.${status || 'unknown'}`,
        reason: status === 'cancel' ? 'Cancelled on the bKash page' : 'The payment failed on the bKash page',
        raw: { paymentID: paymentId, status },
      }
    }
    const body = await this.settle(paymentId)
    // Could not reach bKash at all, or the payment is still authorised but not
    // executed: leave it pending so the reconcile job tries again.
    if (!body || body.transactionStatus === 'Authorized') {
      throw new Error(`Could not confirm bKash payment ${paymentId} yet`)
    }
    return this.result(paymentId, reference, body, 'execute')
  }

  /** For payments whose customer never came back from bKash. null = still waiting. */
  async reconcile(session: string, reference: string, ageMinutes: number): Promise<VerifiedPayment | null> {
    const status = await this.call('/tokenized/checkout/payment/status', { paymentID: session })
    const state = text(status.transactionStatus)
    if (state === 'Completed') return this.result(session, reference, status, 'reconcile')
    if (state === 'Authorized') return this.result(session, reference, await this.settle(session), 'reconcile')
    if (state === 'Initiated' && ageMinutes < 60) return null
    return this.result(session, reference, { ...status, statusMessage: state ? `bKash reports ${state}` : message(status, 'Unknown payment') }, 'reconcile')
  }

  /** Proves the credentials work (Settings → Payments → Connect). */
  async test(): Promise<string> {
    clearBkashTokens()
    await this.token()
    return this.config.sandbox ? 'Connected to the bKash sandbox' : 'Connected to bKash'
  }
}
