// Email and WhatsApp pages: what needs a password, an API key or Meta (notifications.manage).
//   email_connect     checks a mailbox by sending a test email to the staff member, then keeps it
//                     (the password in Vault, integration key email.smtp)
//   email_disconnect  forgets the mailbox
//   email_test        one email (a notification's text, saved or not yet saved) to the staff member's own address
//   whatsapp_submit   submits one WhatsApp text to Meta as a message template (Utility; Marketing for cart and review)
//   whatsapp_sync     Meta's review status for the store's templates
//   whatsapp_test     an approved template, with example values, to a phone number
// For customers (no sign-in; the order's unguessable token is the key):
//   order_reply_view  the order behind an email's "Confirm your order" link
//   order_reply       the customer's Confirm or Cancel from that page
// For pg_cron (x-cron-secret), every 5 minutes while a store uses them:
//   scheduled         abandoned cart reminders, review requests and the owner's daily summary
// Runs on Supabase in production (SUPABASE_FUNCTIONS), next to notifications-dispatch, so a mailbox
// that passes the test here also works for the real emails.
import { z } from 'zod'
import { isCronRequest } from '../_shared/cron.ts'
import { EVENT_INFO, type MessageEvent, SAMPLE_DATA, WHATSAPP_BUTTONS, WHATSAPP_VARIABLES } from '../_shared/notifications/defaults.ts'
import { htmlToText, LiquidError, renderLiquid } from '../_shared/notifications/liquid.ts'
import {
  listWhatsappTemplates, SendError, sendEmail, sendWhatsappTemplate, SMTP_SECRET, submitWhatsappTemplate, whatsappGraph,
} from '../_shared/notifications/senders.ts'
import { isEmail, sendSmtp, SMTP_PORTS, SmtpError, smtpHostProblem } from '../_shared/notifications/smtp.ts'
import { exampleValues, fillWhatsapp, templateName, toPositional, whatsappProblems } from '../_shared/notifications/whatsapp-template.ts'
import { MetaApiError } from '../_shared/meta/graph.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { storefrontBase } from '../_shared/storefront.ts'
import { adminClient, forEachMerchant, requireStaff, rpc, type StaffContext } from '../_shared/supabase.ts'

const uuid = z.string().uuid()
const replyToken = z.string().regex(/^[0-9a-f]{40}$/)
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('scheduled') }),
  z.object({ action: z.literal('order_reply_view'), merchant_id: uuid, token: replyToken }),
  z.object({ action: z.literal('order_reply'), merchant_id: uuid, token: replyToken, reply: z.enum(['confirm', 'cancel']) }),
  z.object({
    action: z.literal('email_connect'),
    host: z.string().trim().toLowerCase().min(3).max(253),
    port: z.number().int().refine((p) => (SMTP_PORTS as readonly number[]).includes(p), 'Use an email port'),
    security: z.enum(['ssl', 'starttls']),
    username: z.string().trim().min(1).max(200),
    // Empty: keep the saved password (changing only the sender address, say).
    password: z.string().max(500).optional(),
    from_email: z.string().trim().toLowerCase().max(200).refine(isEmail, 'Enter the sender email address'),
  }),
  z.object({ action: z.literal('email_disconnect') }),
  z.object({ action: z.literal('email_test'), notification_id: uuid, subject: z.string().max(300).optional(), template: z.string().max(200_000).optional(), data: z.record(z.string(), z.unknown()).optional() }),
  z.object({ action: z.literal('whatsapp_submit'), notification_id: uuid }),
  z.object({ action: z.literal('whatsapp_sync') }),
  z.object({ action: z.literal('whatsapp_test'), notification_id: uuid, to: z.string().trim().min(10).max(20) }),
])
type Input = z.infer<typeof schema>

interface EmailSettings {
  provider: string; from_name: string; reply_to: string; ready: boolean
  smtp: { host: string; port: number; security: 'ssl' | 'starttls'; username: string; from_email: string }
  service: { available: boolean; from_email: string | null }
  store: { name: string; email: string; logo_url: string | null }
  design: { logo_url: string | null; accent_color: string }
}
interface WhatsappSettings { channel_id: string | null; language: 'en' | 'bn'; numbers: Array<{ id: string; waba_id: string | null; status: string }> }
interface Notification {
  id: string; event: string; channel: 'EMAIL' | 'WHATSAPP'; subject: string | null; template: string
  wa_name: string | null; wa_language: string | null; wa_status: string | null; wa_template_id: string | null; wa_params: string[] | null; wa_version: number
  wa_body: string | null; reply_buttons: boolean; wa_buttons: boolean
}

const bad = (message: string, code = 'VALIDATION') => new HttpError(422, message, code)
const hint = (username: string, host: string) => `${username.slice(0, 40)} @ ${host}`.slice(0, 120)

/** Bangladesh mobile numbers in WhatsApp's form (8801XXXXXXXXX); other countries as typed, digits only. */
function waPhone(raw: string): string {
  let d = raw.replace(/\D/g, '')
  if (/^01[3-9]\d{8}$/.test(d)) d = `88${d}`
  if (!/^\d{10,15}$/.test(d)) throw bad('Enter the phone number with its country code, like 01711000000 or 8801711000000.')
  return d
}

async function notification(staff: StaffContext, id: string, channel: 'EMAIL' | 'WHATSAPP'): Promise<Notification> {
  // The service role reads past row security, so the store is named here.
  const { data, error } = await staff.admin.from('notifications').select('*')
    .eq('id', id).eq('merchant_id', staff.merchantId).eq('channel', channel).maybeSingle()
  if (error) throw new HttpError(500, error.message, 'DB_ERROR')
  if (!data) throw new HttpError(404, 'Message not found', 'NOT_FOUND')
  return data as Notification
}

/** The store's email setup as the senders need it. */
function emailPlan(s: EmailSettings) {
  return {
    channel: 'EMAIL' as const, provider: s.provider, from_name: s.from_name || s.store.name || 'Store', reply_to: s.reply_to || s.store.email || null,
    smtp: s.smtp, service: { from_email: s.service.from_email ?? '', from_name: '', ready: s.service.available }, rendered: true, liquid: false, vars: null,
  }
}

/** Sends a logged test message and records how it went. */
async function logged<T extends { messageId: string }>(staff: StaffContext, log: { channel: 'EMAIL' | 'WHATSAPP'; to: string; subject: string | null; body: string; provider: string }, send: () => Promise<T>): Promise<T> {
  const id = await rpc<string>(staff.admin, '_notification_log_test', {
    p_channel: log.channel, p_recipient: log.to, p_subject: log.subject, p_body: log.body, p_provider: log.provider, p_actor: staff.user.id,
  })
  try {
    const sent = await send()
    await rpc(staff.admin, 'complete_notification', { p_id: id, p_success: true, p_provider: log.provider, p_provider_message_id: sent.messageId, p_error: null })
    return sent
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await rpc(staff.admin, 'complete_notification', { p_id: id, p_success: false, p_provider: log.provider, p_provider_message_id: null, p_error: message, p_permanent: true }).catch(() => undefined)
    throw e
  }
}

async function emailConnect(staff: StaffContext, input: Extract<Input, { action: 'email_connect' }>) {
  const problem = smtpHostProblem(input.host, input.port)
  if (problem) throw bad(problem)
  const to = staff.user.email
  if (!to || !isEmail(to)) throw bad('Your sign-in has no email address to send the test to.')
  let password = input.password ?? ''
  if (!password) {
    const { data } = await staff.admin.rpc('integration_secret_get', { p_key: SMTP_SECRET })
    password = (data as { password?: string } | null)?.password ?? ''
    if (!password) throw bad('Enter the password (or app password) of the mailbox.')
  }
  const s = await rpc<EmailSettings>(staff.admin, 'email_settings')
  const fromName = s.from_name || s.store.name || 'Store'
  try {
    await sendSmtp({ host: input.host, port: input.port, security: input.security, username: input.username, password }, {
      from: { name: fromName, email: input.from_email }, to, replyTo: null,
      subject: `${fromName}: your mailbox is connected to Fullfilio`,
      text: `This test email shows that Fullfilio can send your customer emails from ${input.from_email}.`,
      html: `<p>This test email shows that Fullfilio can send your customer emails from <strong>${input.from_email}</strong>.</p>`,
    })
  } catch (e) {
    throw bad(e instanceof SmtpError ? e.message : `Could not send the test email: ${(e as Error).message}`, 'SMTP_FAILED')
  }
  await rpc(staff.admin, 'integration_secret_store', {
    p_key: SMTP_SECRET, p_value: { username: input.username, password }, p_hint: hint(input.username, input.host), p_actor: staff.user.id,
  })
  await rpc(staff.admin, '_email_smtp_connected', {
    p_smtp: { host: input.host, port: input.port, security: input.security, username: input.username, from_email: input.from_email }, p_actor: staff.user.id,
  })
  return { ok: true, sent_to: to }
}

async function emailTest(staff: StaffContext, input: Extract<Input, { action: 'email_test' }>) {
  const to = staff.user.email
  if (!to || !isEmail(to)) throw bad('Your sign-in has no email address to send the test to.')
  const n = await notification(staff, input.notification_id, 'EMAIL')
  const s = await rpc<EmailSettings>(staff.admin, 'email_settings')
  if (!s.ready) throw bad('Choose how emails are sent first: connect your mailbox or use Fullfilio\'s email service.')
  const data = input.data && JSON.stringify(input.data).length < 200_000 ? input.data : SAMPLE_DATA
  let subject: string
  let html: string
  try {
    subject = `[Test] ${renderLiquid(input.subject ?? n.subject ?? '', data, { mode: 'text' }).replace(/\s+/g, ' ').trim()}`
    html = renderLiquid(input.template ?? n.template, data)
  } catch (e) {
    throw bad(e instanceof LiquidError ? `The email template has a mistake: ${e.message}` : String(e))
  }
  const plan = emailPlan(s)
  await logged(staff, { channel: 'EMAIL', to, subject, body: html, provider: s.provider }, () =>
    sendEmail(staff.admin, plan, { to, subject, html, text: htmlToText(html) }).catch((e) => {
      throw e instanceof SendError ? bad(e.message, 'SEND_FAILED') : e
    }))
  return { ok: true, sent_to: to }
}

/** Meta's category for a message: Marketing for cart reminders and review requests, Utility for order updates. */
const templateCategory = (event: string) => (EVENT_INFO[event as MessageEvent]?.group === 'Marketing' ? 'MARKETING' : 'UTILITY')
const categoryNote = (event: string, category?: string) =>
  category && category !== templateCategory(event) ? `Meta filed it as ${category.toLowerCase()}, which costs more per message.` : ''

async function whatsappSubmit(staff: StaffContext, id: string) {
  const s = await rpc<WhatsappSettings>(staff.admin, 'whatsapp_settings')
  const number = s.numbers.find((x) => x.id === s.channel_id)
  if (!number?.waba_id) throw bad('Choose the WhatsApp number that sends the messages first.')
  const n = await notification(staff, id, 'WHATSAPP')
  const problems = whatsappProblems(n.template)
  if (problems.length) throw bad(problems.join(' '))
  const { text, params } = toPositional(n.template)
  const g = await whatsappGraph(staff.admin, number.id).catch((e) => { throw bad((e as Error).message) })
  let version = (n.wa_version ?? 0) + 1
  for (let attempt = 0; ; attempt++) {
    const name = templateName(n.event, version)
    try {
      // The order confirmation's Confirm / Cancel are part of the template Meta approves.
      const buttons = n.event === 'ORDER_CREATED' && n.reply_buttons ? [WHATSAPP_BUTTONS[s.language].confirm, WHATSAPP_BUTTONS[s.language].cancel] : []
      const r = await submitWhatsappTemplate(g, number.waba_id, { name, language: s.language, text, examples: exampleValues(params), buttons, category: templateCategory(n.event) })
      const status = (r.status ?? 'PENDING').toUpperCase()
      await rpc(staff.admin, '_whatsapp_template_record', { p_id: n.id, p: {
        name, language: s.language, status, template_id: r.id, params, body: n.template, version, buttons: buttons.length > 0,
        reason: categoryNote(n.event, r.category),
      } })
      return { ok: true, name, status }
    } catch (e) {
      // The name is taken (an earlier submission): the next version.
      if (e instanceof MetaApiError && attempt < 3 && /already exists|name.*(taken|exists)/i.test(e.message)) {
        version++
        continue
      }
      void logEvent({ level: 'WARN', category: 'OTHER', source: 'messaging', message: `WhatsApp template not accepted: ${(e as Error).message}`, merchantId: staff.merchantId })
      throw bad(`Meta did not accept the template: ${(e as Error).message}`, 'META_REJECTED')
    }
  }
}

async function whatsappSync(staff: StaffContext) {
  const s = await rpc<WhatsappSettings>(staff.admin, 'whatsapp_settings')
  const number = s.numbers.find((x) => x.id === s.channel_id)
  if (!number?.waba_id) throw bad('Choose the WhatsApp number that sends the messages first.')
  const g = await whatsappGraph(staff.admin, number.id).catch((e) => { throw bad((e as Error).message) })
  const templates = await listWhatsappTemplates(g, number.waba_id).catch((e) => { throw bad(`Could not read the templates from Meta: ${(e as Error).message}`, 'META_REJECTED') })
  const { data } = await staff.admin.from('notifications').select('id, event, wa_name, wa_language, wa_template_id')
    .eq('merchant_id', staff.merchantId).eq('channel', 'WHATSAPP').not('wa_name', 'is', null)
  let updated = 0
  for (const n of (data ?? []) as Array<Pick<Notification, 'id' | 'event' | 'wa_name' | 'wa_language' | 'wa_template_id'>>) {
    const t = templates.find((x) => x.id === n.wa_template_id) ?? templates.find((x) => x.name === n.wa_name && x.language === n.wa_language)
    const status = t ? t.status.toUpperCase() : 'DELETED'
    const reason = !t ? 'The template is no longer at Meta: submit it again.'
      : status === 'REJECTED' ? `Meta rejected it${t.rejected_reason && t.rejected_reason !== 'NONE' ? `: ${t.rejected_reason.toLowerCase().replace(/_/g, ' ')}` : ''}.`
      : categoryNote(n.event, t.category)
    await rpc(staff.admin, '_whatsapp_template_record', { p_id: n.id, p: { status, reason, ...(t ? { template_id: t.id } : {}) } })
    updated++
  }
  return { ok: true, updated }
}

async function whatsappTest(staff: StaffContext, input: Extract<Input, { action: 'whatsapp_test' }>) {
  const to = waPhone(input.to)
  const n = await notification(staff, input.notification_id, 'WHATSAPP')
  if (n.wa_status !== 'APPROVED' || !n.wa_name || !n.wa_language) throw bad('Meta has not approved this message yet.')
  const s = await rpc<WhatsappSettings>(staff.admin, 'whatsapp_settings')
  const number = s.numbers.find((x) => x.id === s.channel_id)
  if (!number) throw bad('Choose the WhatsApp number that sends the messages first.')
  const { data: ch } = await staff.admin.from('inbox_channels').select('external_id').eq('id', number.id).eq('merchant_id', staff.merchantId).maybeSingle()
  if (!ch) throw bad('The WhatsApp number is not connected any more.')
  const values = exampleValues(n.wa_params ?? [])
  // The text Meta approved (the editor may hold a newer, not yet submitted one).
  const body = fillWhatsapp(n.wa_body ?? n.template, Object.fromEntries(WHATSAPP_VARIABLES.map((v) => [v.name, v.example])))
  const g = await whatsappGraph(staff.admin, number.id).catch((e) => { throw bad((e as Error).message) })
  await logged(staff, { channel: 'WHATSAPP', to, subject: null, body, provider: 'meta' }, () =>
    sendWhatsappTemplate(g, (ch as { external_id: string }).external_id, to, { name: n.wa_name!, language: n.wa_language! }, values,
      n.wa_buttons ? ['ffo:test:confirm', 'ffo:test:cancel'] : []).catch((e) => {
      throw e instanceof SendError ? bad(e.message, 'SEND_FAILED') : e
    }))
  return { ok: true, sent_to: to }
}

// ------------------------------------------------------------------ customers: confirm / cancel
interface ReplyView { state: string; can_confirm: boolean; can_cancel: boolean; [k: string]: unknown }

/** The confirm page (no sign-in): the order's token is the key, the store is named in the link. */
async function orderReply(req: Request, input: Extract<Input, { action: 'order_reply_view' | 'order_reply' }>) {
  rateLimit(`order-reply:${clientIp(req)}`, 30)
  const admin = adminClient(input.merchant_id)
  if (input.action === 'order_reply') {
    const r = await rpc<{ result: string }>(admin, 'order_reply_apply', { p_token: input.token, p_action: input.reply, p_via: 'EMAIL', p_phone: null })
    if (r.result === 'not_found') throw new HttpError(404, 'This link is not valid any more.', 'NOT_FOUND')
  }
  const view = await rpc<ReplyView | null>(admin, 'order_reply_view', { p_token: input.token })
  if (!view) throw new HttpError(404, 'This link is not valid any more.', 'NOT_FOUND')
  return view
}

// ------------------------------------------------------------------ pg_cron: reminders, reviews, daily summary
interface DueCart { source: 'own' | 'shopify'; id: string; step: number; url: string | null }

async function scheduled() {
  const run = await forEachMerchant('messaging', async (admin) => {
    const reviews = await rpc<number>(admin, 'messaging_run_reviews', { p_limit: 100 })
    const summary = await rpc<{ sent: number }>(admin, 'messaging_run_summary')
    const due = await rpc<DueCart[]>(admin, 'messaging_due_carts', { p_limit: 50 })
    let carts = 0
    let store: string | null = null
    for (const c of due ?? []) {
      let url = c.url
      if (c.source === 'own') {
        // "Finish your order" puts the same items back in the customer's cart on the store.
        store ??= await storefrontBase(admin).catch(() => '')
        url = store ? `${store}/cart?restore=${c.id}` : null
      }
      if (!url) continue
      carts += await rpc<number>(admin, 'messaging_queue_cart', { p_source: c.source, p_id: c.id, p_step: c.step, p_url: url })
    }
    return { reviews, summaries: summary?.sent ?? 0, carts }
  })
  const total = (k: 'reviews' | 'summaries' | 'carts') => run.results.reduce((n, r) => n + (r.ok ? r.result[k] : 0), 0)
  return { ok: true, merchants: run.merchants, failed: run.failed, reviews: total('reviews'), summaries: total('summaries'), carts: total('carts') }
}

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const input = parse(schema, await readJson(req))
    if (input.action === 'scheduled') {
      if (!(await isCronRequest(req, adminClient()))) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED')
      return json(req, await scheduled())
    }
    if (input.action === 'order_reply_view' || input.action === 'order_reply') return json(req, await orderReply(req, input))
    const staff = await requireStaff(req, 'notifications.manage')
    switch (input.action) {
      case 'email_connect': return json(req, await emailConnect(staff, input))
      case 'email_disconnect':
        await rpc(staff.admin, 'integration_secret_clear', { p_key: SMTP_SECRET, p_actor: staff.user.id })
        await rpc(staff.admin, '_email_smtp_disconnected')
        return json(req, { ok: true })
      case 'email_test': return json(req, await emailTest(staff, input))
      case 'whatsapp_submit': return json(req, await whatsappSubmit(staff, input.notification_id))
      case 'whatsapp_sync': return json(req, await whatsappSync(staff))
      case 'whatsapp_test': return json(req, await whatsappTest(staff, input))
    }
  })
)
