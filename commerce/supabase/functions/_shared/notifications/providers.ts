import { env } from '../env.ts'

export type Channel = 'SMS' | 'WHATSAPP' | 'EMAIL'

export interface OutboundMessage {
  channel: Channel
  to: string
  subject?: string | null
  body: string
  metadata?: Record<string, unknown>
}

export interface NotificationProvider {
  readonly name: string
  send(message: OutboundMessage): Promise<{ messageId?: string }>
}

type FetchFn = typeof fetch

/** Development: logs instead of sending. */
export class ConsoleProvider implements NotificationProvider {
  readonly name = 'console'
  send(message: OutboundMessage): Promise<{ messageId?: string }> {
    console.log(`[notification:${message.channel}] to=${message.to} ${message.subject ?? ''}\n${message.body}`)
    return Promise.resolve({ messageId: `console-${Date.now()}` })
  }
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Posts the message to an automation endpoint (n8n, Make, Zapier, a WhatsApp
 * BSP bridge…). Signed with X-Signature: sha256=<hmac> when a secret is set.
 */
export class WebhookProvider implements NotificationProvider {
  readonly name = 'webhook'
  constructor(private readonly url: string, private readonly secret?: string, private readonly fetchFn: FetchFn = fetch) {}

  async send(message: OutboundMessage): Promise<{ messageId?: string }> {
    const payload = JSON.stringify(message)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.secret) headers['X-Signature'] = `sha256=${await hmacHex(this.secret, payload)}`
    const response = await this.fetchFn(this.url, { method: 'POST', headers, body: payload })
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`)
    return { messageId: response.headers.get('x-message-id') ?? undefined }
  }
}

export interface HttpSmsConfig {
  /** e.g. https://sms.example.com/send?api_key={key}&to={to}&sender={sender}&message={message} */
  urlTemplate: string
  apiKey?: string
  senderId?: string
  method?: 'GET' | 'POST'
  /** Regex the response body must match to count as sent (optional). */
  successPattern?: string
}

/** Generic HTTP SMS gateway (most local SMS gateways use this shape). */
export class HttpSmsProvider implements NotificationProvider {
  readonly name = 'sms_http'
  constructor(private readonly config: HttpSmsConfig, private readonly fetchFn: FetchFn = fetch) {}

  buildUrl(message: OutboundMessage): string {
    const fill = (template: string) =>
      template
        .replaceAll('{key}', encodeURIComponent(this.config.apiKey ?? ''))
        .replaceAll('{sender}', encodeURIComponent(this.config.senderId ?? ''))
        .replaceAll('{to}', encodeURIComponent(message.to))
        .replaceAll('{message}', encodeURIComponent(message.body))
    return fill(this.config.urlTemplate)
  }

  async send(message: OutboundMessage): Promise<{ messageId?: string }> {
    const url = this.buildUrl(message)
    const response = await this.fetchFn(url, { method: this.config.method ?? 'GET' })
    const text = await response.text()
    if (!response.ok) throw new Error(`SMS gateway returned HTTP ${response.status}: ${text.slice(0, 200)}`)
    if (this.config.successPattern && !new RegExp(this.config.successPattern).test(text)) {
      throw new Error(`SMS gateway rejected the message: ${text.slice(0, 200)}`)
    }
    return { messageId: text.slice(0, 120) }
  }
}

/** Transactional email via Resend. */
export class ResendEmailProvider implements NotificationProvider {
  readonly name = 'resend'
  constructor(private readonly apiKey: string, private readonly from: string, private readonly fetchFn: FetchFn = fetch) {}

  async send(message: OutboundMessage): Promise<{ messageId?: string }> {
    const response = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject ?? 'Order update', text: message.body }),
    })
    const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string }
    if (!response.ok) throw new Error(`Resend: ${body.message ?? `HTTP ${response.status}`}`)
    return { messageId: body.id }
  }
}

/** NotificationService provider factory (credentials from secrets). */
export function notificationProvider(name: string): NotificationProvider {
  switch (name) {
    case 'webhook': {
      const url = env('NOTIFY_WEBHOOK_URL')
      if (!url) throw new Error('NOTIFY_WEBHOOK_URL is not set')
      return new WebhookProvider(url, env('NOTIFY_WEBHOOK_SECRET'))
    }
    case 'sms_http': {
      const urlTemplate = env('SMS_API_URL')
      if (!urlTemplate) throw new Error('SMS_API_URL is not set')
      return new HttpSmsProvider({
        urlTemplate,
        apiKey: env('SMS_API_KEY'),
        senderId: env('SMS_SENDER_ID'),
        method: env('SMS_API_METHOD') === 'POST' ? 'POST' : 'GET',
        successPattern: env('SMS_SUCCESS_PATTERN'),
      })
    }
    case 'resend': {
      const apiKey = env('RESEND_API_KEY')
      const from = env('EMAIL_FROM')
      if (!apiKey || !from) throw new Error('RESEND_API_KEY and EMAIL_FROM must be set')
      return new ResendEmailProvider(apiKey, from)
    }
    default:
      return new ConsoleProvider()
  }
}
