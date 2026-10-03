// Bangladesh SMS gateways behind one interface (SmsProvider). Credentials
// come from Vault (saved on the SMS page) and never reach a browser.
import { env } from '../env.ts'

export type SmsDelivery = 'PENDING' | 'DELIVERED' | 'FAILED' | 'UNKNOWN'

export interface SmsMessage {
  /** 8801XXXXXXXXX */
  to: string
  body: string
  senderId?: string | null
  /** Our id for the message (log id), for gateways that take one. */
  clientRef: string
}

export interface SmsSent {
  messageId: string | null
  /** What the gateway charged, when it says. */
  cost: number | null
  /** PENDING when a delivery report can be fetched later. */
  delivery: SmsDelivery
  raw: unknown
}

export interface SmsReport {
  status: SmsDelivery
  cost: number | null
  raw: unknown
}

export interface SmsProvider {
  readonly code: SmsProviderCode
  readonly reportsDelivery: boolean
  send(message: SmsMessage): Promise<SmsSent>
  /** Account balance, or null when the gateway has no balance API. */
  balance(): Promise<number | null>
  report(messageId: string): Promise<SmsReport>
}

/** A send that failed. Permanent failures (bad number, unapproved sender) are not retried. */
export class SmsError extends Error {
  constructor(message: string, readonly permanent = false) {
    super(message)
  }
}

export const SMS_PROVIDER_CODES = ['smsnetbd', 'bulksmsbd', 'sslwireless', 'http'] as const
export type SmsProviderCode = (typeof SMS_PROVIDER_CODES)[number]
export type SmsCredentials = Record<string, string | undefined>

/** Fields each gateway needs, in the order the SMS page asks for them. */
export const SMS_FIELDS: Record<SmsProviderCode, string[]> = {
  smsnetbd: ['api_key'],
  bulksmsbd: ['api_key'],
  sslwireless: ['api_token', 'sid'],
  http: ['url_template'],
}
const OPTIONAL_FIELDS = ['base_url', 'api_key', 'method', 'success_pattern']

export function isSmsProvider(code: unknown): code is SmsProviderCode {
  return typeof code === 'string' && (SMS_PROVIDER_CODES as readonly string[]).includes(code)
}

export function missingSmsFields(code: SmsProviderCode, creds: SmsCredentials): string[] {
  return SMS_FIELDS[code].filter((f) => !String(creds[f] ?? '').trim())
}

/** Only the known fields are kept. */
export function cleanSmsCredentials(code: SmsProviderCode, creds: SmsCredentials): SmsCredentials {
  return Object.fromEntries([...SMS_FIELDS[code], ...OPTIONAL_FIELDS]
    .map((k) => [k, String(creds[k] ?? '').trim()] as const)
    .filter(([, v]) => v !== ''))
}

/** "••••3f9a" for the admin; never the secret itself. */
export function smsCredentialHint(code: SmsProviderCode, creds: SmsCredentials): string {
  const main = code === 'http' ? (creds.api_key ?? '') : (creds[SMS_FIELDS[code][0]] ?? '')
  if (code === 'http' && !main) {
    try {
      return new URL(String(creds.url_template).replace(/\{[a-z]+\}/g, 'x')).host
    } catch {
      return '••••'
    }
  }
  return main ? `••••${main.slice(-4)}` : '••••'
}

/** Credentials only travel over https (a local mock can opt out). */
export function assertSecureUrl(url: string | undefined): void {
  if (url && !url.startsWith('https://') && env('ALLOW_INSECURE_GATEWAY_URL') !== 'true') {
    throw new SmsError('The API address must start with https://', true)
  }
}

type FetchFn = typeof fetch
const TIMEOUT_MS = 15_000

async function readJson(response: Response, gateway: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  try {
    const body = JSON.parse(text)
    if (body && typeof body === 'object') return body as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new SmsError(`${gateway} returned an unexpected reply (HTTP ${response.status}): ${text.slice(0, 160)}`)
}

const toNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^0-9.-]/g, ''))
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n
}

/** Words a gateway uses for a delivery state. */
export function deliveryFromText(value: unknown): SmsDelivery {
  const v = String(value ?? '').toLowerCase()
  if (/undeliver|not deliver|fail|reject|expire|error|invalid|block|cancel/.test(v)) return 'FAILED'
  if (/deliver/.test(v)) return 'DELIVERED'
  return 'PENDING'
}

// -----------------------------------------------------------------------------
// Alpha SMS (sms.net.bd): JSON replies with error = 0 on success; reports
// carry the delivery state and what each message cost.
// -----------------------------------------------------------------------------
const SMSNETBD_PERMANENT = new Set([413, 414, 415, 416, 420, 421])

export class SmsNetBdProvider implements SmsProvider {
  readonly code = 'smsnetbd' as const
  readonly reportsDelivery = true
  constructor(private readonly apiKey: string, private readonly base = 'https://api.sms.net.bd', private readonly fetchFn: FetchFn = fetch) {}

  private async call(path: string, init?: RequestInit) {
    const response = await this.fetchFn(`${this.base.replace(/\/+$/, '')}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const body = await readJson(response, 'sms.net.bd')
    const code = Number(body.error)
    if (code !== 0) {
      const message = String(body.msg ?? body.message ?? `error ${body.error}`)
      throw new SmsError(`sms.net.bd: ${message}`, SMSNETBD_PERMANENT.has(code))
    }
    return (body.data ?? {}) as Record<string, unknown>
  }

  async send(message: SmsMessage): Promise<SmsSent> {
    const form = new URLSearchParams({ api_key: this.apiKey, msg: message.body, to: message.to })
    if (message.senderId) form.set('sender_id', message.senderId)
    const data = await this.call('/sendsms', { method: 'POST', body: form })
    const id = data.request_id ?? data.requestId
    return { messageId: id === undefined || id === null ? null : String(id), cost: null, delivery: id ? 'PENDING' : 'UNKNOWN', raw: data }
  }

  async balance(): Promise<number | null> {
    const data = await this.call(`/user/balance/?api_key=${encodeURIComponent(this.apiKey)}`)
    return toNumber(data.balance)
  }

  async report(messageId: string): Promise<SmsReport> {
    const data = await this.call(`/report/request/${encodeURIComponent(messageId)}/?api_key=${encodeURIComponent(this.apiKey)}`)
    const recipients = Array.isArray(data.recipients) ? data.recipients as Array<Record<string, unknown>> : []
    const first = recipients[0]
    const status = deliveryFromText(first?.status ?? data.request_status)
    const cost = toNumber(data.request_charge) ?? toNumber(first?.charge)
    return { status, cost, raw: data }
  }
}

// -----------------------------------------------------------------------------
// BulkSMSBD: response_code 202 means submitted; 10xx codes are errors.
// -----------------------------------------------------------------------------
export const BULKSMSBD_ERRORS: Record<number, string> = {
  1001: 'Invalid number',
  1002: 'Sender ID is not correct or is disabled',
  1003: 'Required fields are missing (contact the provider)',
  1005: 'Internal error at the provider',
  1006: 'Balance validity is not available',
  1007: 'Not enough SMS balance',
  1011: 'User ID not found',
  1012: 'Masking SMS must be sent in Bengali',
  1013: 'This sender ID has no gateway for this API key',
  1014: 'Sender type not found for this sender ID',
  1015: 'This sender ID has no valid gateway for this API key',
  1016: 'Sender type has no active price',
  1017: 'Sender type has no price',
  1018: 'This account is disabled',
  1019: 'The price for this sender type is disabled on this account',
  1020: 'The parent account was not found',
  1021: 'The parent account has no active price for this sender type',
  1031: 'This account is not verified',
  1032: 'This server\'s IP address is not whitelisted',
}
const BULKSMSBD_RETRYABLE = new Set([1005, 1006, 1007])

export class BulkSmsBdProvider implements SmsProvider {
  readonly code = 'bulksmsbd' as const
  readonly reportsDelivery = false
  constructor(private readonly apiKey: string, private readonly base = 'https://bulksmsbd.net/api', private readonly fetchFn: FetchFn = fetch) {}

  private async call(path: string, params: Record<string, string>) {
    const url = `${this.base.replace(/\/+$/, '')}${path}?${new URLSearchParams({ api_key: this.apiKey, ...params })}`
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const body = await readJson(response, 'BulkSMSBD')
    const code = Number(body.response_code)
    if (code !== 202) {
      const message = BULKSMSBD_ERRORS[code] ?? String(body.error_message || body.message || `response code ${body.response_code}`)
      throw new SmsError(`BulkSMSBD: ${message} (${body.response_code})`, !BULKSMSBD_RETRYABLE.has(code))
    }
    return body
  }

  async send(message: SmsMessage): Promise<SmsSent> {
    if (!message.senderId) throw new SmsError('BulkSMSBD needs a sender ID: add it on the SMS page', true)
    const body = await this.call('/smsapi', { type: 'text', number: message.to, senderid: message.senderId, message: message.body })
    const id = body.message_id ?? body.messageId
    return { messageId: id === undefined || id === null ? null : String(id), cost: null, delivery: 'UNKNOWN', raw: body }
  }

  async balance(): Promise<number | null> {
    const body = await this.call('/getBalanceApi', {})
    return toNumber(body.balance)
  }

  report(): Promise<SmsReport> {
    return Promise.resolve({ status: 'UNKNOWN', cost: null, raw: null })
  }
}

// -----------------------------------------------------------------------------
// SSL Wireless ISMS Plus (v3): JSON in and out, status_code 200 on success.
// The csms_id we send is unique per message, so a retried call can't send twice.
// -----------------------------------------------------------------------------
export class SslWirelessProvider implements SmsProvider {
  readonly code = 'sslwireless' as const
  readonly reportsDelivery = false
  constructor(
    private readonly apiToken: string,
    private readonly sid: string,
    private readonly base = 'https://smsplus.sslwireless.com/api/v3',
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async send(message: SmsMessage): Promise<SmsSent> {
    const response = await this.fetchFn(`${this.base.replace(/\/+$/, '')}/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        api_token: this.apiToken, sid: this.sid, msisdn: message.to, sms: message.body,
        csms_id: message.clientRef.replace(/-/g, '').slice(0, 20),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await readJson(response, 'SSL Wireless')
    const info = Array.isArray(body.smsinfo) ? (body.smsinfo as Array<Record<string, unknown>>)[0] : undefined
    const ok = Number(body.status_code) === 200 && String(info?.sms_status ?? 'SUCCESS').toUpperCase() === 'SUCCESS'
    if (!ok) {
      const reason = String(info?.status_message || body.error_message || body.status || `status ${body.status_code}`)
      // 4xx from the gateway means the request itself is wrong (number, token, sid).
      const status = Number(body.status_code)
      throw new SmsError(`SSL Wireless: ${reason}`, status >= 400 && status < 500 && !/balance/i.test(reason))
    }
    const id = info?.reference_id
    return { messageId: id === undefined || id === null ? null : String(id), cost: null, delivery: 'UNKNOWN', raw: body }
  }

  balance(): Promise<number | null> {
    return Promise.resolve(null)
  }

  report(): Promise<SmsReport> {
    return Promise.resolve({ status: 'UNKNOWN', cost: null, raw: null })
  }
}

// -----------------------------------------------------------------------------
// Any other gateway with an HTTP API: a URL template with {to}, {message},
// {sender} and {key}; the reply must match success_pattern when one is set.
// -----------------------------------------------------------------------------
export interface HttpGatewayConfig {
  urlTemplate: string
  apiKey?: string
  method?: 'GET' | 'POST'
  successPattern?: string
}

export class HttpSmsGateway implements SmsProvider {
  readonly code = 'http' as const
  readonly reportsDelivery = false
  constructor(private readonly config: HttpGatewayConfig, private readonly fetchFn: FetchFn = fetch) {}

  buildUrl(message: SmsMessage): string {
    return this.config.urlTemplate
      .replaceAll('{key}', encodeURIComponent(this.config.apiKey ?? ''))
      .replaceAll('{sender}', encodeURIComponent(message.senderId ?? ''))
      .replaceAll('{to}', encodeURIComponent(message.to))
      .replaceAll('{message}', encodeURIComponent(message.body))
  }

  async send(message: SmsMessage): Promise<SmsSent> {
    const url = this.buildUrl(message)
    let response: Response
    if (this.config.method === 'POST') {
      // Query parameters move into a form body so the message isn't in the URL.
      const parsed = new URL(url)
      const form = new URLSearchParams(parsed.search)
      parsed.search = ''
      response = await this.fetchFn(parsed.toString(), { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } else {
      response = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    }
    const text = await response.text()
    if (!response.ok) throw new SmsError(`SMS gateway returned HTTP ${response.status}: ${text.slice(0, 160)}`, response.status >= 400 && response.status < 500)
    if (this.config.successPattern && !new RegExp(this.config.successPattern).test(text)) {
      throw new SmsError(`SMS gateway did not accept the message: ${text.slice(0, 160)}`)
    }
    let id: unknown = null
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      id = body.message_id ?? body.messageId ?? body.request_id ?? body.id ?? null
    } catch {
      // plain-text reply
    }
    return { messageId: id === null || id === undefined ? null : String(id).slice(0, 120), cost: null, delivery: 'UNKNOWN', raw: text.slice(0, 500) }
  }

  balance(): Promise<number | null> {
    return Promise.resolve(null)
  }

  report(): Promise<SmsReport> {
    return Promise.resolve({ status: 'UNKNOWN', cost: null, raw: null })
  }
}

/** SmsProvider factory from saved credentials. */
export function smsProviderFromCredentials(code: SmsProviderCode, creds: SmsCredentials, fetchFn: FetchFn = fetch): SmsProvider {
  const missing = missingSmsFields(code, creds)
  if (missing.length) throw new SmsError(`Enter ${missing.join(', ').replace(/_/g, ' ')}`, true)
  assertSecureUrl(creds.base_url)
  switch (code) {
    case 'smsnetbd':
      return new SmsNetBdProvider(creds.api_key!, creds.base_url || undefined, fetchFn)
    case 'bulksmsbd':
      return new BulkSmsBdProvider(creds.api_key!, creds.base_url || undefined, fetchFn)
    case 'sslwireless':
      return new SslWirelessProvider(creds.api_token!, creds.sid!, creds.base_url || undefined, fetchFn)
    case 'http': {
      assertSecureUrl(creds.url_template)
      if (!/\{to\}/.test(creds.url_template!) || !/\{message\}/.test(creds.url_template!)) {
        throw new SmsError('The URL template must contain {to} and {message}', true)
      }
      if (creds.success_pattern) {
        try {
          new RegExp(creds.success_pattern)
        } catch {
          throw new SmsError('The success pattern is not a valid regular expression', true)
        }
      }
      return new HttpSmsGateway({
        urlTemplate: creds.url_template!, apiKey: creds.api_key,
        method: creds.method?.toUpperCase() === 'POST' ? 'POST' : 'GET', successPattern: creds.success_pattern,
      }, fetchFn)
    }
  }
}
