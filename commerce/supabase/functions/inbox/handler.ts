// Messaging inbox: Facebook Messenger, Instagram DMs, WhatsApp, and Facebook /
// Instagram post and ad comments, on Fullfilio's own Meta app ("Continue with
// Facebook"; Super Admin keeps the app's credentials).
//
// Staff (POST, signed in):
//   config         whether stores can connect yet (app saved, WhatsApp signup on)   inbox.view
//   oauth_start    the Meta login address for Pages + Instagram, or WhatsApp       inbox.manage
//   oauth_finish   the code Meta sent back → the Pages / numbers to pick from       inbox.manage
//   oauth_connect  connect the picked Pages, Instagram accounts or numbers         inbox.manage
//   channel        turn comments on/off for a channel                              inbox.manage
//   disconnect     forget a channel's token (conversations stay)                   inbox.manage
//   send           reply in a conversation (text, file, product image)            inbox.reply
//   media          a WhatsApp photo / voice note / file for the inbox              inbox.view
//
// Meta (no sign-in), one address for every store: /inbox
//   GET   webhook verification (hub.verify_token must match the app's token)
//   POST  events signed with the app secret (X-Hub-Signature-256); each event
//         goes to the store its Page, Instagram account or number belongs to.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { attachmentType, hint, InboxGraph, type OutgoingFile, sendMessage } from '../_shared/inbox/meta.ts'
import {
  exchangeCode, type GrantedNumber, type GrantedPage, grantedNumbers, grantedPages, loginUrl, META_INBOX_APP_KEY,
  type MetaInboxApp, type OAuthKind, pageFields, readState, signState,
} from '../_shared/inbox/oauth.ts'
import { type InboxEvent, insideReplyWindow, parseWebhook, validSignature } from '../_shared/inbox/parse.ts'
import { MetaApiError } from '../_shared/meta/graph.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { appBase } from '../_shared/storefront.ts'
import { adminClient, merchantFor, requireStaff, rpc } from '../_shared/supabase.ts'

const channelKey = (id: string) => `inbox.channel.${id.replace(/-/g, '')}`
/** The token from a Facebook sign-in, kept for 30 minutes while the owner picks what to connect. */
const PENDING_KEY = 'inbox.oauth'
const PENDING_MINUTES = 30
/** 10 MB of file, as base64 in the request. */
const MAX_FILE_BASE64 = 14 * 1024 * 1024

interface Pending { kind: OAuthKind; token: string; user: string; expires_at: string }
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

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('config') }),
  z.object({ action: z.literal('oauth_start'), kind: z.enum(['PAGES', 'WHATSAPP']) }),
  z.object({ action: z.literal('oauth_finish'), code: z.string().trim().min(10).max(2000), state: z.string().trim().min(10).max(2000) }),
  z.object({
    action: z.literal('oauth_connect'),
    pages: z.array(z.object({ id: digits, facebook: z.boolean().default(true), instagram: z.boolean().default(true) })).max(50).default([]),
    comments: z.boolean().default(true),
    numbers: z.array(z.object({ id: digits, waba_id: digits })).max(20).default([]),
    pin: z.string().trim().regex(/^[0-9]{6}$/, 'The PIN is 6 digits').optional(),
  }),
  z.object({ action: z.literal('channel'), id: z.string().uuid(), receive_comments: z.boolean() }),
  z.object({ action: z.literal('disconnect'), id: z.string().uuid() }),
  z.object({ action: z.literal('remove'), id: z.string().uuid() }),
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

/** The shared Meta app (Super Admin → Other Integrations → Meta app). */
async function metaApp(): Promise<MetaInboxApp> {
  const { data, error } = await adminClient().rpc('platform_secret_get', { p_key: META_INBOX_APP_KEY })
  if (error) throw new Error(`Could not read the Meta app settings: ${error.message}`)
  return (data ?? {}) as MetaInboxApp
}
const appReady = (app: MetaInboxApp) => !!(app.app_id && app.app_secret && app.login_config_id)

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const metaError = (e: unknown) => new HttpError(422, e instanceof Error ? e.message : String(e), 'META_REJECTED')
const redirectUri = (req: Request) => `${appBase(req)}/admin/inbox/meta-callback`

// ------------------------------------------------------------------ webhook
interface StoreContext { admin: SupabaseClient; channels: Map<string, Channel | null>; tokens: Map<string, string> }

async function webhook(req: Request): Promise<Response> {
  const app = await metaApp()
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
    // Meta signs with the app secret saved in Super Admin: a mismatch means the two differ.
    void logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'inbox', message: 'Meta webhook refused: the signature does not match the saved App Secret',
      context: { bytes: raw.length, has_secret: !!app.app_secret } })
    throw new HttpError(401, 'Bad signature', 'BAD_SIGNATURE')
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'Not JSON', 'INVALID_JSON')
  }

  const events = parseWebhook(body)
  // One webhook for every store: each Page / Instagram account / number belongs to one store.
  const owners = new Map<string, string | null>()
  const stores = new Map<string, StoreContext>()
  const storeFor = async (e: InboxEvent): Promise<{ merchantId: string; ctx: StoreContext } | null> => {
    const k = `${e.platform}:${e.account_id}`
    if (!owners.has(k)) owners.set(k, await merchantFor('inbox_account', k))
    const merchantId = owners.get(k)
    if (!merchantId) return null
    if (!stores.has(merchantId)) stores.set(merchantId, { admin: adminClient(merchantId), channels: new Map(), tokens: new Map() })
    return { merchantId, ctx: stores.get(merchantId)! }
  }
  const channelFor = async (ctx: StoreContext, e: InboxEvent): Promise<Channel | null> => {
    const k = `${e.platform}:${e.account_id}`
    if (!ctx.channels.has(k)) {
      const rows = await rpc<Channel[]>(ctx.admin, 'inbox_channels_for', { p_id: null, p_platform: e.platform, p_external_id: e.account_id })
      ctx.channels.set(k, rows.find((c) => c.status !== 'DISCONNECTED') ?? null)
    }
    return ctx.channels.get(k) ?? null
  }
  const tokenFor = async (ctx: StoreContext, c: Channel): Promise<string> => {
    if (!ctx.tokens.has(c.id)) ctx.tokens.set(c.id, (await secret<{ access_token?: string }>(ctx.admin, channelKey(c.id))).access_token ?? '')
    return ctx.tokens.get(c.id)!
  }

  let stored = 0
  const skipped = { no_store: 0, no_channel: 0 }
  for (const e of events) {
    let merchantId: string | null = null
    try {
      const store = await storeFor(e)
      if (!store) { skipped.no_store++; continue }
      merchantId = store.merchantId
      const { admin } = store.ctx
      const channel = await channelFor(store.ctx, e)
      if (!channel) { skipped.no_channel++; continue }
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
        const t = await tokenFor(store.ctx, channel)
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
  // One line per delivery, so "messages are not arriving" can be told apart from "Meta sends nothing".
  const root = body && typeof body === 'object' ? body as { object?: unknown; entry?: Array<{ id?: unknown }> } : {}
  void logEvent({ level: 'INFO', category: 'WEBHOOK', source: 'inbox', message: `Meta webhook: ${events.length} event(s), ${stored} stored`,
    context: { object: root.object ?? null, accounts: (root.entry ?? []).slice(0, 5).map((x) => String(x?.id ?? '')), types: [...new Set(events.map((e) => e.type))], ...skipped } })
  return json(req, { ok: true, events: events.length, stored })
}

// ------------------------------------------------------------------ staff
interface Connected { channels: Channel[]; warnings: string[] }

/** Saves a channel and its token; a Page already connected to another store becomes a warning. */
async function saveChannel(admin: SupabaseClient, actor: string, row: Record<string, unknown>, token: string, out: Connected) {
  try {
    const saved = await rpc<Channel>(admin, 'inbox_channel_save', { p: { ...row, status: 'OK', status_error: null, token_hint: hint(token) }, p_actor: actor })
    await rpc(admin, 'integration_secret_store', { p_key: channelKey(saved.id), p_value: { access_token: token }, p_hint: hint(token), p_actor: actor })
    out.channels.push(saved)
  } catch (e) {
    out.warnings.push((e as Error).message.replace(/^[A-Z_]+: /, ''))
  }
}

/** A Page (and its Instagram account): subscribe it to the app's webhooks, then save. */
async function connectPage(admin: SupabaseClient, appSecret: string, actor: string, page: GrantedPage, facebook: boolean, instagram: boolean, comments: boolean, out: Connected) {
  const g = new InboxGraph(page.token, appSecret)
  try {
    await g.post(`${page.id}/subscribed_apps`, {}, { subscribed_fields: pageFields(comments) })
  } catch (e) {
    out.warnings.push(`${page.name}: Meta did not let Fullfilio receive this Page's messages (${(e as Error).message}). Connect it again; if it keeps failing, check the Page's permissions in Meta Business Settings.`)
    return
  }
  if (facebook) {
    await saveChannel(admin, actor, { platform: 'FACEBOOK', external_id: page.id, name: page.name, avatar_url: page.picture, receive_comments: comments }, page.token, out)
  }
  if (instagram && page.instagram) {
    const ig = page.instagram
    await saveChannel(admin, actor, {
      platform: 'INSTAGRAM', external_id: ig.id, name: ig.username ? `@${ig.username}` : page.name, username: ig.username,
      avatar_url: ig.picture, page_id: page.id, receive_comments: comments,
    }, page.token, out)
  } else if (instagram) {
    out.warnings.push(`${page.name}: no Instagram professional account is linked to this Page. Link it in Meta Business Settings, then connect again.`)
  }
}

/** A WhatsApp number from Embedded Signup: subscribe its account, register the number, save. */
async function connectNumber(admin: SupabaseClient, appSecret: string, actor: string, number: GrantedNumber, token: string, pin: string | undefined, out: Connected) {
  const g = new InboxGraph(token, appSecret)
  const label = number.name ?? number.display_phone ?? number.id
  try {
    await g.post(`${number.waba_id}/subscribed_apps`, {})
  } catch (e) {
    out.warnings.push(`${label}: Meta did not let Fullfilio receive this number's messages (${(e as Error).message}).`)
    return
  }
  if (pin) {
    await g.post(`${number.id}/register`, { messaging_product: 'whatsapp', pin })
      .catch((e) => out.warnings.push(`${label}: the number could not be registered for the Cloud API (${(e as Error).message}). If it already has a two-step PIN, connect again with that PIN.`))
  }
  await saveChannel(admin, actor, {
    platform: 'WHATSAPP', external_id: number.id, waba_id: number.waba_id, name: label, display_phone: number.display_phone,
  }, token, out)
}

async function pendingToken(admin: SupabaseClient, user: string): Promise<Pending> {
  const p = await secret<Partial<Pending>>(admin, PENDING_KEY)
  if (!p.token || p.user !== user || !p.expires_at || new Date(p.expires_at).getTime() < Date.now()) {
    throw new HttpError(422, 'Your Facebook sign-in has expired. Choose "Continue with Facebook" again.', 'OAUTH_EXPIRED')
  }
  return p as Pending
}

export default (
  handle(async (req) => {
    // Meta: verification (GET) and signed events (POST with a signature header).
    if (req.method === 'GET' || req.headers.has('x-hub-signature-256')) return webhook(req)
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')

    const input = parse(schema, await readJson(req, MAX_FILE_BASE64 + 64 * 1024))
    const permission = input.action === 'send' ? 'inbox.reply' : input.action === 'config' || input.action === 'media' ? 'inbox.view' : 'inbox.manage'
    const staff = await requireStaff(req, permission)
    const admin = staff.admin
    const app = await metaApp()
    const appSecret = app.app_secret ?? ''

    switch (input.action) {
      case 'config':
        return json(req, { ready: appReady(app), whatsapp: appReady(app) && !!app.whatsapp_config_id })

      case 'oauth_start': {
        if (!appReady(app)) throw new HttpError(422, 'Connecting with Facebook is not switched on yet. Ask Fullfilio support.', 'NOT_CONFIGURED')
        if (input.kind === 'WHATSAPP' && !app.whatsapp_config_id) {
          throw new HttpError(422, 'WhatsApp connection opens once Meta approves Fullfilio as a WhatsApp Tech Provider.', 'NOT_CONFIGURED')
        }
        const state = await signState(appSecret, { m: staff.merchantId, u: staff.user.id, k: input.kind })
        return json(req, { url: loginUrl(app, input.kind, redirectUri(req), state) })
      }

      case 'oauth_finish': {
        if (!appReady(app)) throw new HttpError(422, 'Connecting with Facebook is not switched on yet.', 'NOT_CONFIGURED')
        const state = await readState(appSecret, input.state)
        if (!state || state.m !== staff.merchantId || state.u !== staff.user.id) {
          throw new HttpError(400, 'This Facebook sign-in has expired or was started by someone else. Start again from Messaging → Channels.', 'OAUTH_STATE')
        }
        let token: string
        try {
          token = await exchangeCode(app, input.code, redirectUri(req), state.k === 'PAGES')
        } catch (e) {
          throw metaError(e)
        }
        await rpc(admin, 'integration_secret_store', {
          p_key: PENDING_KEY, p_value: { kind: state.k, token, user: staff.user.id, expires_at: new Date(Date.now() + PENDING_MINUTES * 60_000).toISOString() },
          p_hint: hint(token), p_actor: staff.user.id,
        })
        const mine = await rpc<Channel[]>(admin, 'inbox_channels_for', { p_id: null, p_platform: null, p_external_id: null })
        const active = new Set(mine.filter((c) => c.status !== 'DISCONNECTED').map((c) => `${c.platform}:${c.external_id}`))
        try {
          if (state.k === 'PAGES') {
            const pages = await grantedPages(token, appSecret)
            return json(req, {
              kind: state.k,
              pages: pages.map((p) => ({
                id: p.id, name: p.name, picture: p.picture, connected: active.has(`FACEBOOK:${p.id}`),
                instagram: p.instagram ? { ...p.instagram, connected: active.has(`INSTAGRAM:${p.instagram.id}`) } : null,
              })),
            })
          }
          const numbers = await grantedNumbers(app, token)
          return json(req, { kind: state.k, numbers: numbers.map((n) => ({ ...n, connected: active.has(`WHATSAPP:${n.id}`) })) })
        } catch (e) {
          throw metaError(e)
        }
      }

      case 'oauth_connect': {
        const pending = await pendingToken(admin, staff.user.id)
        const out: Connected = { channels: [], warnings: [] }
        try {
          if (pending.kind === 'PAGES') {
            const granted = new Map((await grantedPages(pending.token, appSecret)).map((p) => [p.id, p]))
            for (const pick of input.pages) {
              const page = granted.get(pick.id)
              if (!page) { out.warnings.push(`Page ${pick.id} was not shared with Fullfilio during sign-in.`); continue }
              await connectPage(admin, appSecret, staff.user.id, page, pick.facebook, pick.instagram, input.comments, out)
            }
          } else {
            const granted = new Map((await grantedNumbers(app, pending.token)).map((n) => [n.id, n]))
            for (const pick of input.numbers) {
              const number = granted.get(pick.id)
              if (!number) { out.warnings.push(`Number ${pick.id} was not shared with Fullfilio during sign-up.`); continue }
              await connectNumber(admin, appSecret, staff.user.id, number, pending.token, input.pin, out)
            }
          }
        } catch (e) {
          if (e instanceof HttpError) throw e
          throw metaError(e)
        }
        await rpc(admin, 'integration_secret_clear', { p_key: PENDING_KEY, p_actor: staff.user.id }).catch(() => undefined)
        return json(req, { ok: true, ...out })
      }

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

      case 'remove': {
        const [c] = await rpc<Channel[]>(admin, 'inbox_channels_for', { p_id: input.id })
        if (!c) throw new HttpError(404, 'Channel not found', 'NOT_FOUND')
        // Stop Meta sending this Page's events, unless the store's other channel (its Facebook
        // Page or Instagram account) still uses the same Page. Best effort: the token may be gone.
        const pageOf = (x: Channel) => (x.platform === 'FACEBOOK' ? x.external_id : x.platform === 'INSTAGRAM' ? x.page_id : null)
        const page = pageOf(c)
        if (page) {
          const others = await rpc<Channel[]>(admin, 'inbox_channels_for', {})
          const shared = others.some((o) => o.id !== c.id && o.status !== 'DISCONNECTED' && pageOf(o) === page)
          const t = shared ? '' : (await secret<{ access_token?: string }>(admin, channelKey(c.id))).access_token ?? ''
          if (t) await new InboxGraph(t, appSecret).delete(`${page}/subscribed_apps`).catch(() => null)
        }
        await rpc(admin, 'integration_secret_clear', { p_key: channelKey(c.id), p_actor: staff.user.id })
        const out = await rpc<{ removed: boolean; conversations: number }>(admin, 'inbox_channel_remove', { p_id: c.id, p_actor: staff.user.id })
        return json(req, out)
      }

      case 'media': {
        const [c] = await rpc<Channel[]>(admin, 'inbox_channels_for', { p_id: input.channel_id })
        if (!c || c.platform !== 'WHATSAPP') throw new HttpError(404, 'Channel not found', 'NOT_FOUND')
        const t = (await secret<{ access_token?: string }>(admin, channelKey(c.id))).access_token
        if (!t) throw new HttpError(422, 'This channel is disconnected', 'NOT_CONNECTED')
        const g = new InboxGraph(t, appSecret)
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
        const g = new InboxGraph(t, appSecret)
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
