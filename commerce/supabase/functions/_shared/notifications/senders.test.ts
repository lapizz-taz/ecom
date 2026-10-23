import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { InboxGraph } from '../inbox/meta.ts'
import { EMAIL_DEFAULTS, SAMPLE_DATA } from './defaults.ts'
import { SendError, sendEmailService, sendQueued, sendWhatsappTemplate, submitWhatsappTemplate } from './senders.ts'
import { SmtpError } from './smtp.ts'

type Calls = Array<{ fn: string; args: Record<string, unknown> }>

/** A pretend database: each RPC answers from the table, and every call is recorded. */
function db(answers: Record<string, unknown>, calls: Calls = []): SupabaseClient {
  return { rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args })
    return { data: typeof answers[fn] === 'function' ? (answers[fn] as (a: unknown) => unknown)(args) : answers[fn] ?? null, error: null }
  } } as unknown as SupabaseClient
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const mail = { from: { name: 'Isolation', email: 'mail@send.fullfilio.com' }, to: 'rahim@example.com', replyTo: 'help@isolation.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' }

describe('Fullfilio email service (Resend)', () => {
  it('sends with the store name, the reply-to and both versions', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'msg_1' }))
    expect(await sendEmailService('re_key', mail, fetchFn as unknown as typeof fetch)).toEqual({ messageId: 'msg_1' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_key')
    expect(JSON.parse(init.body as string)).toEqual({ from: 'Isolation <mail@send.fullfilio.com>', to: ['rahim@example.com'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', reply_to: 'help@isolation.com' })
  })

  it('a refused email is not retried, a busy service is; the key never shows in the error', async () => {
    const refused = await sendEmailService('re_secret', mail, (async () => json({ message: 'Invalid `to` re_secret' }, 422)) as unknown as typeof fetch).catch((e) => e)
    expect(refused).toBeInstanceOf(SendError)
    expect(refused.permanent).toBe(true)
    expect(refused.message).not.toContain('re_secret')
    const busy = await sendEmailService('k', mail, (async () => json({ message: 'slow down' }, 429)) as unknown as typeof fetch).catch((e) => e)
    expect(busy.permanent).toBe(false)
  })
})

describe('WhatsApp templates (Meta)', () => {
  it('sends an approved template with its values in WhatsApp\'s form', async () => {
    const fetchFn = vi.fn(async () => json({ messages: [{ id: 'wamid.1' }] }))
    const g = new InboxGraph('token', '', fetchFn as unknown as typeof fetch)
    expect(await sendWhatsappTemplate(g, '109876543210', '8801711000802', { name: 'ff_order_confirmed_v1', language: 'en' }, ['Rahim', 'ORD-1\n42', ''])).toEqual({ messageId: 'wamid.1' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/109876543210\/messages$/)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token')
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '8801711000802', type: 'template',
      template: { name: 'ff_order_confirmed_v1', language: { code: 'en' }, components: [{ type: 'body', parameters: [
        { type: 'text', text: 'Rahim' }, { type: 'text', text: 'ORD-1 42' }, { type: 'text', text: '-' }] }] },
    })
  })

  it('explains Meta\'s refusals and does not retry the hopeless ones', async () => {
    const g = new InboxGraph('t', '', (async () => json({ error: { code: 131026, message: 'Message undeliverable' } }, 400)) as unknown as typeof fetch)
    const e = await sendWhatsappTemplate(g, '1', '8801711000802', { name: 'x', language: 'en' }, []).catch((x) => x)
    expect(e).toBeInstanceOf(SendError)
    expect(e.message).toMatch(/not on WhatsApp/)
    expect(e.permanent).toBe(true)
  })

  it('submits a Utility template with example values', async () => {
    const fetchFn = vi.fn(async () => json({ id: '998877', status: 'PENDING', category: 'UTILITY' }))
    const g = new InboxGraph('t', '', fetchFn as unknown as typeof fetch)
    const r = await submitWhatsappTemplate(g, '2233445566', { name: 'ff_order_shipped_v1', language: 'bn', text: 'Hi {{1}}, order {{2}} is on the way.', examples: ['Rahim', 'ISO-1042'] })
    expect(r).toMatchObject({ id: '998877', status: 'PENDING' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/2233445566\/message_templates$/)
    expect(JSON.parse(init.body as string)).toEqual({ name: 'ff_order_shipped_v1', language: 'bn', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} is on the way.', example: { body_text: [['Rahim', 'ISO-1042']] } }] })
  })
})

describe('sending a queued message', () => {
  const queuedEmail = { id: 'log-1', channel: 'EMAIL' as const, recipient: 'rahim@example.com', subject: EMAIL_DEFAULTS.ORDER_CREATED.subject, body: EMAIL_DEFAULTS.ORDER_CREATED.template }
  const emailPlan = (provider: string) => ({
    channel: 'EMAIL', provider, from_name: 'Isolation', reply_to: 'help@isolation.com', liquid: true, rendered: false, vars: SAMPLE_DATA,
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl', username: 'shop@gmail.com', from_email: 'shop@gmail.com' },
    service: { from_email: 'mail@send.fullfilio.com', from_name: 'Fullfilio', ready: true },
  })

  it('renders the email, keeps the result, and sends it from the store\'s own mailbox', async () => {
    const calls: Calls = []
    const admin = db({ _notification_send_plan: emailPlan('smtp'), integration_secret_get: { username: 'shop@gmail.com', password: 'app-pass' } }, calls)
    const smtp = vi.fn(async () => ({ messageId: 'm-1', response: 'OK' }))
    expect(await sendQueued(admin, queuedEmail, { smtp })).toEqual({ provider: 'smtp', messageId: 'm-1' })
    const rendered = calls.find((c) => c.fn === '_notification_log_rendered')!.args
    expect(rendered.p_subject).toBe('Order ORD-1042 received')
    expect(rendered.p_body).toContain('Thank you for your order!')
    const [cfg, msg] = smtp.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, any>]
    expect(cfg).toEqual({ host: 'smtp.gmail.com', port: 465, security: 'ssl', username: 'shop@gmail.com', password: 'app-pass' })
    expect(msg.from).toEqual({ name: 'Isolation', email: 'shop@gmail.com' })
    expect(msg.replyTo).toBe('help@isolation.com')
    expect(msg.text).toContain('Cotton panjabi')
  })

  it('a mistake in the template, a wrong password or a missing mailbox stops it for good', async () => {
    const broken = { ...queuedEmail, body: 'Hi {{ customer.name | nope }}' }
    const e1 = await sendQueued(db({ _notification_send_plan: emailPlan('smtp') }), broken).catch((e) => e)
    expect(e1.message).toMatch(/template has a mistake.*nope/)
    expect(e1.permanent).toBe(true)
    const wrong = vi.fn(async () => { throw new SmtpError('The mailbox did not accept the username or password (535).', 535, true) })
    const e2 = await sendQueued(db({ _notification_send_plan: emailPlan('smtp'), integration_secret_get: { password: 'x' } }), queuedEmail, { smtp: wrong }).catch((e) => e)
    expect(e2).toMatchObject({ permanent: true })
    const e3 = await sendQueued(db({ _notification_send_plan: emailPlan('smtp'), integration_secret_get: null }), queuedEmail).catch((e) => e)
    expect(e3.message).toMatch(/disconnected/)
  })

  it('sends through Fullfilio\'s email service with the platform key', async () => {
    const fetchFn = vi.fn(async () => json({ id: 'msg_9' }))
    const platform = db({ platform_secret_get: { api_key: 're_platform' } })
    const r = await sendQueued(db({ _notification_send_plan: emailPlan('fullfilio') }), queuedEmail, { fetchFn: fetchFn as unknown as typeof fetch, platform })
    expect(r).toEqual({ provider: 'fullfilio', messageId: 'msg_9' })
    expect(JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).from).toBe('Isolation <mail@send.fullfilio.com>')
  })

  it('a WhatsApp message goes out only when approved, from the chosen number', async () => {
    const plan = { channel: 'WHATSAPP', approved: true, template: 'ff_order_confirmed_v1', language: 'en', params: ['Rahim', 'ORD-1042'], channel_id: 'ch-1', phone_number_id: '109876543210', connected: true }
    const fetchFn = vi.fn(async () => json({ messages: [{ id: 'wamid.7' }] }))
    const admin = db({ _notification_send_plan: plan, integration_secret_get: { access_token: 'EAAB' } })
    const platform = db({ platform_secret_get: { app_secret: '' } })
    const item = { id: 'log-2', channel: 'WHATSAPP' as const, recipient: '8801711000802', subject: null, body: 'Hi Rahim' }
    expect(await sendQueued(admin, item, { fetchFn: fetchFn as unknown as typeof fetch, platform })).toEqual({ provider: 'meta', messageId: 'wamid.7' })
    const e = await sendQueued(db({ _notification_send_plan: { ...plan, approved: false } }), item).catch((x) => x)
    expect(e).toMatchObject({ permanent: true })
    expect(e.message).toMatch(/not approved/)
  })
})
