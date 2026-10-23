// Sends the customer emails and WhatsApp messages the database queued (notifications-dispatch),
// and the tests and Meta template actions of the messaging function.
//
//   Email     the seller's own mailbox (SMTP; Vault integration key email.smtp) or Fullfilio's
//             email service (Resend; platform Vault key email.resend). The email is rendered from
//             its Liquid template and the order data kept with it.
//   WhatsApp  the approved template, through the WhatsApp number connected in Messaging →
//             Channels (its token is the inbox channel's).
import type { SupabaseClient } from '@supabase/supabase-js'
import { InboxGraph, inboxChannelKey } from '../inbox/meta.ts'
import { META_INBOX_APP_KEY } from '../inbox/oauth.ts'
import { MetaApiError } from '../meta/graph.ts'
import { adminClient, rpc } from '../supabase.ts'
import { htmlToText, LiquidError, renderLiquid } from './liquid.ts'
import { type MailMessage, sendSmtp, type SmtpConfig, SmtpError, type SmtpSecurity } from './smtp.ts'
import { paramValue } from './whatsapp-template.ts'

type FetchFn = typeof fetch

/** A send that failed; permanent ones are not retried (wrong password, template not approved …). */
export class SendError extends Error {
  constructor(message: string, readonly permanent = false) {
    super(message)
    this.name = 'SendError'
  }
}

export const SMTP_SECRET = 'email.smtp'
export const EMAIL_SERVICE_SECRET = 'email.resend'

// ------------------------------------------------------------------ Fullfilio email service
const RESEND_URL = 'https://api.resend.com/emails'

/** One email through Fullfilio's Resend account. */
export async function sendEmailService(apiKey: string, m: MailMessage, fetchFn: FetchFn = fetch): Promise<{ messageId: string }> {
  const from = `${m.from.name.replace(/[\r\n"<>]/g, ' ').trim() || 'Store'} <${m.from.email}>`
  const res = await fetchFn(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string }
  if (!res.ok || !body.id) {
    const msg = String(body.message ?? `HTTP ${res.status}`).split(apiKey).join('[hidden]').slice(0, 300)
    // 4xx (bad address, unverified sender …) will fail the same way again; 429 and 5xx may pass later.
    throw new SendError(`Fullfilio's email service refused it: ${msg}`, res.status >= 400 && res.status < 500 && res.status !== 429)
  }
  return { messageId: body.id }
}

// ------------------------------------------------------------------ WhatsApp (Meta)
export interface TemplateRef { name: string; language: string }

/** Meta's WhatsApp errors in words staff can act on; permanent ones are not retried. */
function whatsappError(e: unknown): SendError {
  if (!(e instanceof MetaApiError)) return new SendError(e instanceof Error ? e.message : String(e))
  const permanent = [131026, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 131051, 190].includes(e.code ?? 0)
  const msg = e.code === 131026 ? 'This number is not on WhatsApp (or cannot receive business messages).'
    : e.code === 132001 ? 'Meta does not know this template in this language: submit it again.'
    : e.code === 132000 ? 'The template\'s placeholders do not match what Meta approved: submit it again.'
    : e.code === 132015 || e.code === 132016 ? 'Meta paused or disabled this template (too many customers blocked or reported it).'
    : e.code === 131049 ? 'Meta did not deliver it, to protect the customer from too many business messages. It may go through later.'
    : e.message
  return new SendError(msg, permanent)
}

/** Sends an approved template with its placeholder values. */
export async function sendWhatsappTemplate(g: InboxGraph, phoneNumberId: string, to: string, t: TemplateRef, params: unknown[]): Promise<{ messageId: string }> {
  try {
    const r = await g.post<{ messages?: Array<{ id: string }> }>(`${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/\D/g, ''), type: 'template',
      template: {
        name: t.name, language: { code: t.language },
        ...(params.length ? { components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: paramValue(p) })) }] } : {}),
      },
    })
    const id = r.messages?.[0]?.id
    if (!id) throw new SendError('Meta did not confirm the message.')
    return { messageId: id }
  } catch (e) {
    throw e instanceof SendError ? e : whatsappError(e)
  }
}

export interface MetaTemplate { id: string; name: string; status: string; language: string; category?: string; rejected_reason?: string }

/** Submits a template for Meta's review (category Utility: order updates). */
export async function submitWhatsappTemplate(g: InboxGraph, wabaId: string, t: { name: string; language: string; text: string; examples: string[] }) {
  return g.post<{ id: string; status?: string; category?: string }>(`${wabaId}/message_templates`, {
    name: t.name, language: t.language, category: 'UTILITY',
    components: [{ type: 'BODY', text: t.text, ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}) }],
  })
}

/** The business account's templates with their review status. */
export async function listWhatsappTemplates(g: InboxGraph, wabaId: string): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = []
  let after = ''
  for (let page = 0; page < 10; page++) {
    const r = await g.get<{ data?: MetaTemplate[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${wabaId}/message_templates`, {
      fields: 'id,name,status,language,category,rejected_reason', limit: '100', ...(after ? { after } : {}),
    })
    out.push(...(r.data ?? []))
    after = r.paging?.next ? r.paging?.cursors?.after ?? '' : ''
    if (!after) break
  }
  return out
}

/** The Graph client for a store's connected WhatsApp number (its inbox token, the platform app's secret). */
export async function whatsappGraph(admin: SupabaseClient, channelId: string, fetchFn: FetchFn = fetch, platform: SupabaseClient = adminClient()): Promise<InboxGraph> {
  const { data, error } = await admin.rpc('integration_secret_get', { p_key: inboxChannelKey(channelId) })
  if (error) throw new SendError(`Could not read the WhatsApp connection: ${error.message}`)
  const token = (data as { access_token?: string } | null)?.access_token ?? ''
  if (!token) throw new SendError('The WhatsApp number is disconnected: reconnect it in Messaging → Channels.', true)
  const app = await platform.rpc('platform_secret_get', { p_key: META_INBOX_APP_KEY })
  return new InboxGraph(token, (app.data as { app_secret?: string } | null)?.app_secret ?? '', fetchFn)
}

// ------------------------------------------------------------------ email sending
interface EmailPlan {
  channel: 'EMAIL'
  provider: 'smtp' | 'fullfilio' | string
  from_name: string
  reply_to: string | null
  smtp: { host: string; port: number; security: SmtpSecurity; username: string; from_email: string } | null
  service: { from_email: string; from_name: string; ready: boolean } | null
  rendered: boolean
  liquid: boolean
  vars: Record<string, unknown> | null
}

interface WhatsappPlan {
  channel: 'WHATSAPP'
  approved: boolean
  template: string | null
  language: string | null
  params: unknown[]
  channel_id: string | null
  phone_number_id: string | null
  connected: boolean
}

export interface QueuedMessage { id: string; channel: 'EMAIL' | 'WHATSAPP'; recipient: string; subject: string | null; body: string }

/** Test seams: the network, the SMTP client and the platform's database client. */
export interface Deps { fetchFn?: FetchFn; smtp?: typeof sendSmtp; platform?: SupabaseClient }

/** Renders a queued email (when its data came with it) and keeps the result on the log. */
export async function renderQueuedEmail(admin: SupabaseClient, item: QueuedMessage, plan: EmailPlan): Promise<{ subject: string; html: string }> {
  if (!plan.liquid || plan.rendered) return { subject: item.subject ?? '', html: item.body }
  try {
    const vars = plan.vars ?? {}
    const subject = renderLiquid(item.subject ?? '', vars, { mode: 'text' }).replace(/\s+/g, ' ').trim()
    const html = renderLiquid(item.body, vars)
    await rpc(admin, '_notification_log_rendered', { p_id: item.id, p_subject: subject, p_body: html })
    return { subject, html }
  } catch (e) {
    if (e instanceof LiquidError) throw new SendError(`The email template has a mistake: ${e.message}`, true)
    throw e
  }
}

/** Sends one email with the store's chosen way. */
export async function sendEmail(admin: SupabaseClient, plan: EmailPlan, m: Omit<MailMessage, 'from' | 'replyTo'>, deps: Deps = {}): Promise<{ provider: string; messageId: string }> {
  const message = (fromEmail: string, fromName: string): MailMessage => ({ ...m, from: { name: fromName, email: fromEmail }, replyTo: plan.reply_to })
  if (plan.provider === 'smtp') {
    if (!plan.smtp?.host) throw new SendError('Connect your mailbox on the Email page.', true)
    const { data, error } = await admin.rpc('integration_secret_get', { p_key: SMTP_SECRET })
    if (error) throw new SendError(`Could not read the mailbox password: ${error.message}`)
    const password = (data as { password?: string } | null)?.password
    if (!password) throw new SendError('The mailbox is disconnected: connect it again on the Email page.', true)
    const cfg: SmtpConfig = { host: plan.smtp.host, port: plan.smtp.port, security: plan.smtp.security, username: plan.smtp.username, password }
    try {
      const r = await (deps.smtp ?? sendSmtp)(cfg, message(plan.smtp.from_email, plan.from_name))
      return { provider: 'smtp', messageId: r.messageId }
    } catch (e) {
      if (e instanceof SmtpError) throw new SendError(e.message, e.permanent)
      throw e
    }
  }
  if (plan.provider === 'fullfilio') {
    if (!plan.service?.ready || !plan.service.from_email) throw new SendError('Fullfilio\'s email service is not available right now.')
    const { data } = await (deps.platform ?? adminClient()).rpc('platform_secret_get', { p_key: EMAIL_SERVICE_SECRET })
    const apiKey = (data as { api_key?: string } | null)?.api_key
    if (!apiKey) throw new SendError('Fullfilio\'s email service is not available right now.')
    const r = await sendEmailService(apiKey, message(plan.service.from_email, plan.from_name), deps.fetchFn)
    return { provider: 'fullfilio', messageId: r.messageId }
  }
  throw new SendError('Choose how emails are sent on the Email page.', true)
}

/** Sends one queued email or WhatsApp message; throws SendError when it did not go out. */
export async function sendQueued(admin: SupabaseClient, item: QueuedMessage, deps: Deps = {}): Promise<{ provider: string; messageId: string }> {
  const plan = await rpc<EmailPlan | WhatsappPlan | null>(admin, '_notification_send_plan', { p_log_id: item.id })
  if (!plan) throw new SendError('The message is gone.', true)
  if (plan.channel === 'EMAIL') {
    const { subject, html } = await renderQueuedEmail(admin, item, plan)
    return sendEmail(admin, plan, { to: item.recipient, subject, html, text: htmlToText(html) }, deps)
  }
  if (!plan.approved || !plan.template || !plan.language) throw new SendError('This WhatsApp message is not approved by Meta yet.', true)
  if (!plan.connected || !plan.channel_id || !plan.phone_number_id) throw new SendError('The WhatsApp number is not connected: choose it on the WhatsApp page.', true)
  const g = await whatsappGraph(admin, plan.channel_id, deps.fetchFn, deps.platform)
  const r = await sendWhatsappTemplate(g, plan.phone_number_id, item.recipient, { name: plan.template, language: plan.language }, plan.params ?? [])
  return { provider: 'meta', messageId: r.messageId }
}
