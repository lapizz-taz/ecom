// Email and WhatsApp pages: what needs a password, an API key or Meta (notifications.manage).
//   email_connect     checks a mailbox by sending a test email to the staff member, then keeps it
//                     (the password in Vault, integration key email.smtp)
//   email_disconnect  forgets the mailbox
//   email_test        one email (a notification's text, saved or not yet saved) to the staff member's own address
//   whatsapp_submit   submits one WhatsApp text to Meta as a message template (category Utility)
//   whatsapp_sync     Meta's review status for the store's templates
//   whatsapp_test     an approved template, with example values, to a phone number
// Runs on Supabase in production (SUPABASE_FUNCTIONS), next to notifications-dispatch, so a mailbox
// that passes the test here also works for the real emails.
import { z } from 'zod'
import { SAMPLE_DATA, WHATSAPP_VARIABLES } from '../_shared/notifications/defaults.ts'
import { htmlToText, LiquidError, renderLiquid } from '../_shared/notifications/liquid.ts'
import {
  listWhatsappTemplates, SendError, sendEmail, sendWhatsappTemplate, SMTP_SECRET, submitWhatsappTemplate, whatsappGraph,
} from '../_shared/notifications/senders.ts'
import { isEmail, sendSmtp, SMTP_PORTS, SmtpError, smtpHostProblem } from '../_shared/notifications/smtp.ts'
import { exampleValues, fillWhatsapp, templateName, toPositional, whatsappProblems } from '../_shared/notifications/whatsapp-template.ts'
import { MetaApiError } from '../_shared/meta/graph.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { requireStaff, rpc, type StaffContext } from '../_shared/supabase.ts'

const uuid = z.string().uuid()
const schema = z.discriminatedUnion('action', [
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
  wa_body: string | null
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
      const r = await submitWhatsappTemplate(g, number.waba_id, { name, language: s.language, text, examples: exampleValues(params) })
      const status = (r.status ?? 'PENDING').toUpperCase()
      await rpc(staff.admin, '_whatsapp_template_record', { p_id: n.id, p: {
        name, language: s.language, status, template_id: r.id, params, body: n.template, version,
        reason: r.category && r.category !== 'UTILITY' ? `Meta filed it as ${r.category.toLowerCase()}, which costs more per message.` : '',
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
  const { data } = await staff.admin.from('notifications').select('id, wa_name, wa_language, wa_template_id')
    .eq('merchant_id', staff.merchantId).eq('channel', 'WHATSAPP').not('wa_name', 'is', null)
  let updated = 0
  for (const n of (data ?? []) as Array<Pick<Notification, 'id' | 'wa_name' | 'wa_language' | 'wa_template_id'>>) {
    const t = templates.find((x) => x.id === n.wa_template_id) ?? templates.find((x) => x.name === n.wa_name && x.language === n.wa_language)
    const status = t ? t.status.toUpperCase() : 'DELETED'
    const reason = !t ? 'The template is no longer at Meta: submit it again.'
      : status === 'REJECTED' ? `Meta rejected it${t.rejected_reason && t.rejected_reason !== 'NONE' ? `: ${t.rejected_reason.toLowerCase().replace(/_/g, ' ')}` : ''}.`
      : t.category && t.category !== 'UTILITY' ? `Meta filed it as ${t.category.toLowerCase()}, which costs more per message.` : ''
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
    sendWhatsappTemplate(g, (ch as { external_id: string }).external_id, to, { name: n.wa_name!, language: n.wa_language! }, values).catch((e) => {
      throw e instanceof SendError ? bad(e.message, 'SEND_FAILED') : e
    }))
  return { ok: true, sent_to: to }
}

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const input = parse(schema, await readJson(req))
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
