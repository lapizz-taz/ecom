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
import { appBase, customerLinkBase } from '../storefront.ts'
import { adminClient, rpc } from '../supabase.ts'
import { type Lang, withUnsubscribeFooter } from './defaults.ts'
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
    body: JSON.stringify({
      from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}), ...(m.headers ? { headers: m.headers } : {}),
    }),
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

/**
 * Sends an approved template with its placeholder values. `buttons`: the payload of each quick-reply
 * button the template has (Confirm / Cancel carry the order's token), in the template's order.
 */
export async function sendWhatsappTemplate(g: InboxGraph, phoneNumberId: string, to: string, t: TemplateRef, params: unknown[], buttons: string[] = []): Promise<{ messageId: string }> {
  const components: Array<Record<string, unknown>> = []
  if (params.length) components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: paramValue(p) })) })
  buttons.forEach((payload, index) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] }))
  try {
    const r = await g.post<{ messages?: Array<{ id: string }> }>(`${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/\D/g, ''), type: 'template',
      template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) },
    })
    const id = r.messages?.[0]?.id
    if (!id) throw new SendError('Meta did not confirm the message.')
    return { messageId: id }
  } catch (e) {
    throw e instanceof SendError ? e : whatsappError(e)
  }
}

export interface MetaTemplate { id: string; name: string; status: string; language: string; category?: string; rejected_reason?: string }

export type TemplateCategory = 'UTILITY' | 'MARKETING'

/**
 * Submits a template for Meta's review, with its quick-reply buttons if any. Order updates are
 * Utility; cart reminders and review requests are Marketing under Meta's rules (dearer per message),
 * and are submitted as that rather than re-filed by Meta.
 */
export async function submitWhatsappTemplate(g: InboxGraph, wabaId: string, t: {
  name: string; language: string; text: string; examples: string[]; buttons?: string[]; category?: TemplateCategory
}) {
  return g.post<{ id: string; status?: string; category?: string }>(`${wabaId}/message_templates`, {
    name: t.name, language: t.language, category: t.category ?? 'UTILITY',
    components: [
      { type: 'BODY', text: t.text, ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}) },
      ...(t.buttons?.length ? [{ type: 'BUTTONS', buttons: t.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) }] : []),
    ],
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
  /** The order confirmation asks the customer to confirm: the order's token (and store) for the page link. */
  reply_token?: string | null
  /** A cart reminder or review request: the address's token for the unsubscribe page and headers. */
  unsubscribe_token?: string | null
  /** The store's message language (the unsubscribe line). */
  language?: string | null
  merchant_id?: string | null
}

interface WhatsappPlan {
  channel: 'WHATSAPP'
  approved: boolean
  template: string | null
  language: string | null
  params: unknown[]
  /** The approved template's Confirm / Cancel payloads (null: no buttons). */
  buttons?: string[] | null
  channel_id: string | null
  phone_number_id: string | null
  connected: boolean
}

export interface QueuedMessage { id: string; channel: 'EMAIL' | 'WHATSAPP'; recipient: string; subject: string | null; body: string }

/**
 * Test seams: the network, the SMTP client, the platform's database client, where the app lives
 * and where the store's customer links open.
 */
export interface Deps { fetchFn?: FetchFn; smtp?: typeof sendSmtp; platform?: SupabaseClient; appUrl?: string; linkBase?: string }

/** Where the app lives, for the links an email carries (null: not set up, the email goes without them). */
function appUrl(deps: Deps): string | null {
  if (deps.appUrl) return deps.appUrl.replace(/\/+$/, '')
  try {
    return appBase()
  } catch {
    return null
  }
}

const TOKEN = /^[0-9a-f]{40}$/

/** The saved mailbox password, with the mail server it was connected to (passwords saved before the server was kept have none). */
export interface SavedMailbox { host?: string; port?: number; security?: string; username?: string; password?: string }

/**
 * Whether a saved mailbox password may sign in to this server: only the one it was connected with.
 * For a password saved without its server, the server recorded when the mailbox was connected counts.
 */
export function sameMailbox(
  saved: SavedMailbox | null,
  server: { host: string; port: number; security: string; username: string },
  connected: { host: string; port: number; security: string } | null = null,
): boolean {
  if (!saved?.password || !saved.username || saved.username !== server.username) return false
  const was = saved.host ? { host: saved.host, port: saved.port, security: saved.security } : connected
  return !!was?.host && was.host.toLowerCase() === server.host.toLowerCase() && was.port === server.port && was.security === server.security
}

/**
 * The copy of a sent email kept for the log has "hidden" in place of the customer's link tokens.
 * Sending it again puts them back from this send's plan.
 */
export function restoreHiddenLinks(html: string, plan: Pick<EmailPlan, 'reply_token' | 'unsubscribe_token'>): { html: string; unsubscribe: string | null } {
  let out = html
  if (plan.reply_token && TOKEN.test(plan.reply_token)) {
    out = out.replace(/(\/order-confirm\/[0-9a-fA-F-]{36}\/)hidden\b/g, `$1${plan.reply_token}`)
  }
  let unsubscribe: string | null = null
  if (plan.unsubscribe_token && TOKEN.test(plan.unsubscribe_token)) {
    out = out.replace(/(\/unsubscribe\/[0-9a-fA-F-]{36}\/)hidden\b/g, `$1${plan.unsubscribe_token}`)
    unsubscribe = /https?:\/\/[^\s"'<>]+\/unsubscribe\/[0-9a-fA-F-]{36}\/[0-9a-f]{40}/.exec(out)?.[0] ?? null
  }
  return { html: out, unsubscribe }
}

/** The order's confirm / cancel page: https://<store or app>/order-confirm/<store>/<token>. */
export function replyUrl(base: string, merchantId: string, token: string): string {
  return `${base}/order-confirm/${merchantId}/${token}`
}

/**
 * The unsubscribe page: opening it changes nothing; a POST to the same address (a mail app's own
 * unsubscribe button, RFC 8058) unsubscribes at once.
 */
export function unsubscribeUrl(base: string, merchantId: string, token: string): string {
  return `${base}/unsubscribe/${merchantId}/${token}`
}

/** The headers that make Gmail, Outlook and Apple Mail show their own one-click unsubscribe. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
}

/**
 * Links that depend on where things run, added to the email's data when it is rendered: the
 * customer's pages (confirm, unsubscribe) on the store's address, the owner's on the app's.
 */
export function withAppLinks(
  vars: Record<string, unknown>, plan: Pick<EmailPlan, 'reply_token' | 'unsubscribe_token' | 'merchant_id'>, base: string | null, customerBase: string | null = base,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...vars }
  const order = vars.order as Record<string, unknown> | undefined
  if (customerBase && order && plan.reply_token && plan.merchant_id && TOKEN.test(plan.reply_token)) {
    out.order = { ...order, reply_url: replyUrl(customerBase, plan.merchant_id, plan.reply_token) }
  }
  if (customerBase && plan.unsubscribe_token && plan.merchant_id && TOKEN.test(plan.unsubscribe_token)) {
    out.unsubscribe_url = unsubscribeUrl(customerBase, plan.merchant_id, plan.unsubscribe_token)
  }
  const summary = vars.summary as Record<string, unknown> | undefined
  if (base && summary && !summary.admin_url) out.summary = { ...summary, admin_url: `${base}/admin` }
  return out
}

export interface RenderedEmail { subject: string; html: string; headers?: Record<string, string> }

/** Renders a queued email (when its data came with it) and keeps the result on the log. */
export async function renderQueuedEmail(admin: SupabaseClient, item: QueuedMessage, plan: EmailPlan, deps: Deps = {}): Promise<RenderedEmail> {
  if (!plan.liquid) return { subject: item.subject ?? '', html: item.body }
  if (plan.rendered) {
    // Sent before (this is "Send again"): the kept copy, with the customer's links put back.
    const { html, unsubscribe } = restoreHiddenLinks(item.body, plan)
    return { subject: item.subject ?? '', html, ...(unsubscribe ? { headers: unsubscribeHeaders(unsubscribe) } : {}) }
  }
  try {
    const app = plan.vars?.summary ? appUrl(deps) : null
    const customer = plan.reply_token || plan.unsubscribe_token
      ? deps.linkBase?.replace(/\/+$/, '') ?? await customerLinkBase(admin).catch(() => appUrl(deps))
      : null
    const vars = withAppLinks(plan.vars ?? {}, plan, app, customer)
    const subject = renderLiquid(item.subject ?? '', vars, { mode: 'text' }).replace(/\s+/g, ' ').trim()
    let html = renderLiquid(item.body, vars)
    const unsubscribe = typeof vars.unsubscribe_url === 'string' ? vars.unsubscribe_url : null
    // Offers and reminders always say how to stop them, whatever the template.
    if (unsubscribe) html = withUnsubscribeFooter(html, unsubscribe, (plan.language === 'bn' ? 'bn' : 'en') as Lang)
    await rpc(admin, '_notification_log_rendered', { p_id: item.id, p_subject: subject, p_body: html })
    return { subject, html, ...(unsubscribe ? { headers: unsubscribeHeaders(unsubscribe) } : {}) }
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
    const saved = data as SavedMailbox | null
    const password = saved?.password
    if (!password) throw new SendError('The mailbox is disconnected: connect it again on the Email page.', true)
    // The password signs in only to the server it was connected with.
    if (saved?.host && !sameMailbox(saved, plan.smtp)) {
      throw new SendError('The mail server changed since the mailbox was connected: connect it again on the Email page.', true)
    }
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
    const { subject, html, headers } = await renderQueuedEmail(admin, item, plan, deps)
    return sendEmail(admin, plan, { to: item.recipient, subject, html, text: htmlToText(html), ...(headers ? { headers } : {}) }, deps)
  }
  if (!plan.approved || !plan.template || !plan.language) throw new SendError('This WhatsApp message is not approved by Meta yet.', true)
  if (!plan.connected || !plan.channel_id || !plan.phone_number_id) throw new SendError('The WhatsApp number is not connected: choose it on the WhatsApp page.', true)
  const g = await whatsappGraph(admin, plan.channel_id, deps.fetchFn, deps.platform)
  const r = await sendWhatsappTemplate(g, plan.phone_number_id, item.recipient, { name: plan.template, language: plan.language }, plan.params ?? [], plan.buttons ?? [])
  return { provider: 'meta', messageId: r.messageId }
}
