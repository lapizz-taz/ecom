// Messaging inbox: Facebook Messenger, Instagram DMs, WhatsApp, and Facebook /
// Instagram post and ad comments.
//
// Staff (POST, signed in):
//   config            the webhook address and verify token to paste into the Meta app
//   save_app          the store's Meta app id and app secret (Vault)          inbox.manage
//   connect_page      a Facebook Page by its Page access token, and the
//                     Instagram account linked to it                         inbox.manage
//   connect_whatsapp  a WhatsApp Cloud API number                            inbox.manage
//   channel           turn comments on/off for a channel                     inbox.manage
//   disconnect        forget a channel's token (conversations stay)          inbox.manage
//   send              reply in a conversation (text, file, product image)    inbox.reply
//   media             a WhatsApp photo / voice note / file for the inbox      inbox.view
//
// Meta (no sign-in), one address per store: /inbox?m=<merchant id>
//   GET   webhook verification (hub.verify_token must match the store's token)
//   POST  events, signed with the store's app secret (X-Hub-Signature-256)
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { attachmentType, hint, InboxGraph, type OutgoingFile, sendMessage } from '../_shared/inbox/meta.ts'
import { type InboxEvent, insideReplyWindow, parseWebhook, validSignature } from '../_shared/inbox/parse.ts'
import { MetaApiError } from '../_shared/meta/graph.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, requireStaff, rpc } from '../_shared/supabase.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APP_KEY = 'inbox.app'
const channelKey = (id: string) => `inbox.channel.${id.replace(/-/g, '')}`
/** 10 MB of file, as base64 in the request. */
const MAX_FILE_BASE64 = 14 * 1024 * 1024

interface AppSecrets { app_id?: string; app_secret?: string; verify_token?: string }
interface Channel {
  id: string; platform: 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP'; external_id: string; page_id: string | null
  name: string; status: string; receive_comments: boolean
}

const file = z.object({
  name: z.string().trim().min(1).max(200),
  mime: z.string().trim().regex(/^[a-z]+\/[a-z0-9.+-]+(;.*)?$/i).max(100),
  data: z.string().min(1).max(MAX_FILE_BASE64),
})
const digits = z.string().trim().regex(/^[0-9]{3,40}$/, 'Use the number shown in Meta')
const token = z.string().trim().min(20).max(1000).regex(/^[A-Za-z0-9_|.-]+$/, 'That does not look like a Meta access token')

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('config') }),
  z.object({ action: z.literal('save_app'), app_id: digits, app_secret: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, 'The App Secret is a 32-character code from App settings → Basic').optional() }),
  z.object({ action: z.literal('connect_page'), page_token: token, instagram: z.boolean().default(true), comments: z.boolean().default(true) }),
  z.object({ action: z.literal('connect_whatsapp'), phone_number_id: digits, waba_id: digits, token }),
  z.object({ action: z.literal('channel'), id: z.string().uuid(), receive_comments: z.boolean() }),
  z.object({ action: z.literal('disconnect'), id: z.string().uuid() }),
  z.object({
    action: z.literal('send'), conversation_id: z.string().uuid(), text: z.string().max(4000).optional(),
    file: file.optional(), image_url: z.string().url().max(1000).optional(), reply_to_id: z.string().uuid().optional(),
    private_reply: z.boolean().optional(),
  }),
  z.object({ action: z.literal('media'), channel_id: z.string().uuid(), media_id: digits }),
])

async function secret<T>(admin: SupabaseClient, key: string): Promise<T> {
  const { data, error } = await admin.rpc('integration_secret_get', { p_key: key })
  if (error) throw new Error(`Could not read saved credentials: ${error.message}`)
  return (data ?? {}) as T
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const metaError = (e: unknown) => new HttpError(422, e instanceof Error ? e.message : String(e), 'META_REJECTED')

// ------------------------------------------------------------------ webhook
async function webhook(req: Request, merchantId: string): Promise<Response> {
  const admin = adminClient(merchantId)
  const app = await secret<AppSecrets>(admin, APP_KEY)
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode')
    const given = url.searchParams.get('hub.verify_token') ?? ''
    if (mode === 'subscribe' && app.verify_token && given === app.verify_token) {
      return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }
    throw new HttpError(403, 'Verify token does not match', 'FORBIDDEN')
  }

  const raw = await req.text()
  if (raw.length > 1024 * 1024) throw new HttpError(413, 'Too large', 'PAYLOAD_TOO_LARGE')
  if (!app.app_secret || !(await validSignature(raw, req.headers.get('x-hub-signature-256'), app.app_secret))) {
    throw new HttpError(401, 'Bad signature', 'BAD_SIGNATURE')
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'Not JSON', 'INVALID_JSON')
  }

  const events = parseWebhook(body)
  const channels = new Map<string, Channel | null>()
  const tokens = new Map<string, string>()
  const channelFor = async (e: InboxEvent): Promise<Channel | null> => {
    const k = `${e.platform}:${e.account_id}`
    if (!channels.has(k)) {
      const rows = await rpc<Channel[]>(admin, 'inbox_channels_for', { p_id: null, p_platform: e.platform, p_external_id: e.account_id })
      channels.set(k, rows.find((c) => c.status !== 'DISCONNECTED') ?? null)
    }
    return channels.get(k) ?? null
  }
  const tokenFor = async (c: Channel): Promise<string> => {
    if (!tokens.has(c.id)) tokens.set(c.id, (await secret<{ access_token?: string }>(admin, channelKey(c.id))).access_token ?? '')
    return tokens.get(c.id)!
  }

  let stored = 0
  for (const e of events) {
    try {
      const channel = await channelFor(e)
      if (!channel) continue
      if (e.type === 'status' && e.status) {
        await rpc(admin, 'inbox_message_status', { p_channel: channel.id, p_external_id: e.status.external_id, p_status: e.status.status, p_error: e.status.error ?? null })
        continue
      }
      if (e.type === 'read' && e.thread_key && e.read_until) {
        await rpc(admin, 'inbox_mark_seen_until', { p_channel: channel.id, p_thread_key: e.thread_key, p_until: e.read_until })
        continue
      }
      if (e.type !== 'message' || !e.thread_key || !e.message) continue
      if (e.kind === 'COMMENT' && !channel.receive_comments) continue
      const r = await rpc<{ conversation_id: string; needs_profile: boolean; duplicate: boolean }>(admin, 'inbox_ingest', {
        p: { channel_id: channel.id, kind: e.kind ?? 'MESSAGE', thread_key: e.thread_key, customer: e.customer ?? {}, post: e.post ?? null, message: e.message },
      })
      if (!r.duplicate) stored++
      // Messenger and Instagram send only an id: look the name up once.
      if (r.needs_profile && channel.platform !== 'WHATSAPP' && e.customer?.external_id) {
        const t = await tokenFor(channel)
        if (t) {
          const g = new InboxGraph(t, app.app_secret)
          const p = await g.get<{ first_name?: string; last_name?: string; name?: string; username?: string; profile_pic?: string }>(e.customer.external_id,
            { fields: channel.platform === 'INSTAGRAM' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic' }).catch(() => null)
          const name = p ? (p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username) : null
          if (name || p?.profile_pic) await rpc(admin, 'inbox_set_profile', { p_conversation: r.conversation_id, p_name: name ?? null, p_avatar: p?.profile_pic ?? null })
        }
      }
    } catch (error) {
      void logEvent({ level: 'ERROR', category: 'WEBHOOK', source: 'inbox', merchantId, message: `Inbox event not stored: ${(error as Error).message}`,
        context: { platform: e.platform, account: e.account_id, type: e.type } })
    }
  }
  return json(req, { ok: true, events: events.length, stored })
}

// ------------------------------------------------------------------ staff
async function connectPage(admin: SupabaseClient, app: AppSecrets, actor: string, pageToken: string, withInstagram: boolean, comments: boolean) {
  const g = new InboxGraph(pageToken, app.app_secret)
  let page: { id: string; name: string; picture?: { data?: { url?: string } }; instagram_business_account?: { id: string; username?: string; profile_picture_url?: string } }
  try {
    page = await g.get('me', { fields: 'id,name,picture{url},instagram_business_account{id,username,profile_picture_url}' })
  } catch (e) {
    throw metaError(e)
  }
  if (!page.id) throw new HttpError(422, 'Paste a Page access token (from the Page, not your personal account).', 'META_REJECTED')
  const warnings: string[] = []
  // The Page sends its messages, echoes, read receipts and comments to this app's webhook.
  await g.post(`${page.id}/subscribed_apps`, {}, {
    subscribed_fields: ['messages', 'message_echoes', 'message_reads', 'message_deliveries', 'messaging_postbacks', ...(comments ? ['feed'] : [])].join(','),
  }).catch((e) => warnings.push(`Could not subscribe the Page to the app's webhooks: ${(e as Error).message}`))

  const saved = []
  const fb = await rpc<Channel>(admin, 'inbox_channel_save', {
    p: { platform: 'FACEBOOK', external_id: page.id, name: page.name, avatar_url: page.picture?.data?.url, receive_comments: comments, status: 'OK', token_hint: hint(pageToken) },
    p_actor: actor,
  })
  await rpc(admin, 'integration_secret_store', { p_key: channelKey(fb.id), p_value: { access_token: pageToken }, p_hint: hint(pageToken), p_actor: actor })
  saved.push(fb)

  const ig = page.instagram_business_account
  if (withInstagram && ig?.id) {
    const row = await rpc<Channel>(admin, 'inbox_channel_save', {
      p: { platform: 'INSTAGRAM', external_id: ig.id, name: ig.username ? `@${ig.username}` : page.name, username: ig.username,
        avatar_url: ig.profile_picture_url, page_id: page.id, receive_comments: comments, status: 'OK', token_hint: hint(pageToken) },
      p_actor: actor,
    })
    await rpc(admin, 'integration_secret_store', { p_key: channelKey(row.id), p_value: { access_token: pageToken }, p_hint: hint(pageToken), p_actor: actor })
    saved.push(row)
  } else if (withInstagram) {
    warnings.push('No Instagram professional account is linked to this Page. Link it in Meta Business Settings, then connect again.')
  }
  return { channels: saved, warnings }
}

async function connectWhatsApp(admin: SupabaseClient, app: AppSecrets, actor: string, phoneId: string, wabaId: string, waToken: string) {
  const g = new InboxGraph(waToken, app.app_secret)
  let phone: { id: string; display_phone_number?: string; verified_name?: string }
  try {
    phone = await g.get(phoneId, { fields: 'id,display_phone_number,verified_name' })
  } catch (e) {
    throw metaError(e)
  }
  const warnings: string[] = []
  await g.post(`${wabaId}/subscribed_apps`, {}).catch((e) => warnings.push(`Could not subscribe the WhatsApp account to the app: ${(e as Error).message}`))
  const row = await rpc<Channel>(admin, 'inbox_channel_save', {
    p: { platform: 'WHATSAPP', external_id: phoneId, waba_id: wabaId, name: phone.verified_name ?? phone.display_phone_number ?? 'WhatsApp',
      display_phone: phone.display_phone_number, status: 'OK', token_hint: hint(waToken) },
    p_actor: actor,
  })
  await rpc(admin, 'integration_secret_store', { p_key: channelKey(row.id), p_value: { access_token: waToken }, p_hint: hint(waToken), p_actor: actor })
  return { channels: [row], warnings }
}

export default (
  handle(async (req) => {
    const url = new URL(req.url)
    const merchant = url.searchParams.get('m')
    if (merchant || req.method === 'GET') {
      if (!merchant || !UUID.test(merchant)) throw new HttpError(400, 'Unknown store', 'MERCHANT_REQUIRED')
      return webhook(req, merchant.toLowerCase())
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')

    const input = parse(schema, await readJson(req, MAX_FILE_BASE64 + 64 * 1024))
    const permission = input.action === 'send' ? 'inbox.reply' : input.action === 'config' || input.action === 'media' ? 'inbox.view' : 'inbox.manage'
    const staff = await requireStaff(req, permission)
    const admin = staff.admin
    const canManage = staff.role === 'OWNER' || staff.permissions.includes('inbox.manage')
    const app = await secret<AppSecrets>(admin, APP_KEY)

    switch (input.action) {
      case 'config':
        return json(req, {
          merchant_id: staff.merchantId, app_id: app.app_id ?? null, has_app_secret: !!app.app_secret,
          verify_token: canManage ? app.verify_token ?? null : null,
        })

      case 'save_app': {
        const next: AppSecrets = { app_id: input.app_id, app_secret: input.app_secret ?? app.app_secret, verify_token: app.verify_token ?? randomToken() }
        if (!next.app_secret) throw new HttpError(422, 'Paste the App Secret', 'VALIDATION')
        await rpc(admin, 'integration_secret_store', { p_key: APP_KEY, p_value: next, p_hint: hint(next.app_secret), p_actor: staff.user.id })
        return json(req, { ok: true, app_id: next.app_id, verify_token: next.verify_token })
      }

      case 'connect_page':
        if (!app.app_secret) throw new HttpError(422, 'Save your Meta app (App ID and App Secret) first', 'VALIDATION')
        return json(req, { ok: true, ...(await connectPage(admin, app, staff.user.id, input.page_token, input.instagram, input.comments)) })

      case 'connect_whatsapp':
        if (!app.app_secret) throw new HttpError(422, 'Save your Meta app (App ID and App Secret) first', 'VALIDATION')
        return json(req, { ok: true, ...(await connectWhatsApp(admin, app, staff.user.id, input.phone_number_id, input.waba_id, input.token)) })

      case 'channel': {
        const [c] = await rpc<Channel[]>(admin, 'inbox_channels_for', { p_id: input.id })
        if (!c) throw new HttpError(404, 'Channel not found', 'NOT_FOUND')
        await rpc(admin, 'inbox_channel_save', { p: { ...c, receive_comments: input.receive_comments }, p_actor: staff.user.id })
        return json(req, { ok: true })
      }

      case 'disconnect': {
        const [c] = await rpc<Channel[]>(admin, 'inbox_channels_for', { p_id: input.id })
        if (!c) throw new HttpError(404, 'Channel not found', 'NOT_FOUND')
        await rpc(admin, 'integration_secret_clear', { p_key: channelKey(c.id), p_actor: staff.user.id })
        await rpc(admin, 'inbox_channel_status', { p_id: c.id, p_status: 'DISCONNECTED', p_error: null })
        return json(req, { ok: true })
      }

      case 'media': {
        const [c] = await rpc<Channel[]>(admin, 'inbox_channels_for', { p_id: input.channel_id })
        if (!c || c.platform !== 'WHATSAPP') throw new HttpError(404, 'Channel not found', 'NOT_FOUND')
        const t = (await secret<{ access_token?: string }>(admin, channelKey(c.id))).access_token
        if (!t) throw new HttpError(422, 'This channel is disconnected', 'NOT_CONNECTED')
        const g = new InboxGraph(t, app.app_secret)
        try {
          const meta = await g.get<{ url: string; mime_type?: string; file_size?: number }>(input.media_id)
          if ((meta.file_size ?? 0) > 10 * 1024 * 1024) throw new HttpError(413, 'This file is larger than 10 MB; open it in WhatsApp', 'PAYLOAD_TOO_LARGE')
          const { bytes, mime } = await g.download(meta.url)
          return json(req, { mime: meta.mime_type ?? mime, data: base64(bytes) }, 200, { 'Cache-Control': 'private, max-age=3600' })
        } catch (e) {
          if (e instanceof HttpError) throw e
          throw metaError(e)
        }
      }

      case 'send': {
        if (!input.text?.trim() && !input.file && !input.image_url) throw new HttpError(422, 'Write a message or attach something', 'VALIDATION')
        const ctx = await rpc<{
          kind: 'MESSAGE' | 'COMMENT'; thread_key: string; customer_external_id: string | null; last_customer_message_at: string | null
          channel: { id: string; platform: Channel['platform']; external_id: string; page_id: string | null; status: string }
        }>(admin, 'inbox_send_context', { p_conversation: input.conversation_id })
        if (ctx.channel.status === 'DISCONNECTED') throw new HttpError(422, 'This channel is disconnected. Connect it again under Messaging → Channels.', 'NOT_CONNECTED')
        const t = (await secret<{ access_token?: string }>(admin, channelKey(ctx.channel.id))).access_token
        if (!t) throw new HttpError(422, 'This channel has no access token. Connect it again under Messaging → Channels.', 'NOT_CONNECTED')

        // WhatsApp answers a message by its id; comments answer the comment itself.
        let replyExternal: string | undefined
        if (input.reply_to_id) {
          const { data } = await admin.from('inbox_messages').select('external_id').eq('id', input.reply_to_id).eq('conversation_id', input.conversation_id).eq('merchant_id', staff.merchantId).maybeSingle()
          replyExternal = data?.external_id ?? undefined
        }
        const to = ctx.kind === 'COMMENT' ? (replyExternal ?? ctx.thread_key) : ctx.thread_key
        const g = new InboxGraph(t, app.app_secret)
        const outgoing = {
          conversation_id: input.conversation_id, body: input.text?.trim() || null, reply_to_id: input.reply_to_id ?? null,
          attachments: input.file ? [{ type: attachmentType(input.file.mime), name: input.file.name, mime: input.file.mime }]
            : input.image_url ? [{ type: 'image', url: input.image_url }] : [],
        }
        try {
          const sent = await sendMessage(g, {
            platform: ctx.channel.platform, account_id: ctx.channel.external_id, page_id: ctx.channel.page_id, kind: ctx.kind, to,
            inside_window: insideReplyWindow(ctx.last_customer_message_at),
          }, { text: input.text, file: input.file as OutgoingFile | undefined, image_url: input.image_url, reply_to_external_id: replyExternal, private_reply: input.private_reply })
          const r = await rpc<{ message_id: string | null }>(admin, 'inbox_record_outgoing', {
            p: { ...outgoing, external_id: sent.external_id, attachments: sent.attachments.length ? sent.attachments : outgoing.attachments },
            p_actor: staff.user.id,
          })
          return json(req, { ok: true, message_id: r.message_id })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          await rpc(admin, 'inbox_record_outgoing', { p: { ...outgoing, error: message }, p_actor: staff.user.id }).catch(() => undefined)
          if (e instanceof MetaApiError && e.tokenInvalid) {
            await rpc(admin, 'inbox_channel_status', { p_id: ctx.channel.id, p_status: 'FAILED', p_error: message }).catch(() => undefined)
          }
          throw metaError(e)
        }
      }
    }
  })
)
