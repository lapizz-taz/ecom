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
//   send           reply in a conversation (text, file, product image); comments
//                  can be answered in public, in private or both at once         inbox.reply
//   comment_action like, hide or delete a comment                                 inbox.reply
//   post_refresh   read a post's caption, picture and counts again                inbox.view
//   media          a WhatsApp photo / voice note / file for the inbox              inbox.view
//
// Scheduled (x-cron-secret): automation_cron sends the follow-ups that are due.
// New customer messages are hidden (moderation) or answered (auto replies) as
// they arrive, by what inbox_automation_plan decides.
//
// Meta (no sign-in), one address for every store: /inbox
//   GET   webhook verification (hub.verify_token must match the app's token)
//   POST  events signed with the app secret (X-Hub-Signature-256); each event
//         goes to the store its Page, Instagram account or number belongs to.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { isCronRequest } from '../_shared/cron.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { attachmentType, commentAction, type CommentOp, fetchPost, hint, InboxGraph, type OutgoingFile, type PostDetails, sendMessage } from '../_shared/inbox/meta.ts'
import {
  exchangeCode, type GrantedNumber, type GrantedPage, grantedNumbers, grantedPages, loginUrl, META_INBOX_APP_KEY,
  type MetaInboxApp, type OAuthKind, pageFields, readState, signState,
} from '../_shared/inbox/oauth.ts'
import { type InboxEvent, insideReplyWindow, parseWebhook, validSignature } from '../_shared/inbox/parse.ts'
import { MetaApiError } from '../_shared/meta/graph.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { appBase } from '../_shared/storefront.ts'
import { adminClient, forEachMerchant, merchantFor, requireStaff, rpc } from '../_shared/supabase.ts'

const channelKey = (id: string) => `inbox.channel.${id.replace(/-/g, '')}`
/** The token from a Facebook sign-in, kept for 30 minutes while the owner picks what to connect. */
const PENDING_KEY = 'inbox.oauth'
const PENDING_MINUTES = 30
/** 10 MB of file, as base64 in the request. */
const MAX_FILE_BASE64 = 14 * 1024 * 1024

interface Pending { kind: OAuthKind; token: string; user: string; expires_at: string; coexist?: boolean }
interface Channel {
  id: string; platform: 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP'; external_id: string; page_id: string | null
  name: string; status: string; receive_comments: boolean
}
interface SendContext {
  kind: 'MESSAGE' | 'COMMENT'; thread_key: string; customer_external_id: string | null; last_customer_message_at: string | null
  channel: { id: string; platform: Channel['platform']; external_id: string; page_id: string | null; status: string }
}
interface AutomationPlan {
  moderate?: { hide: boolean; reason: string }
  replies?: Array<{ rule_id: string; name: string; reply_text: string | null; private_text: string | null; like: boolean }>
}
/** Messages older than this (a webhook retried late, or history synced in) are never answered by themselves. */
const AUTOMATION_MAX_AGE_MS = 30 * 60_000

const file = z.object({
  name: z.string().trim().min(1).max(200),
  mime: z.string().trim().regex(/^[a-z]+\/[a-z0-9.+-]+(;.*)?$/i).max(100),
  data: z.string().min(1).max(MAX_FILE_BASE64),
})
const digits = z.string().trim().regex(/^[0-9]{3,40}$/, 'Use the number shown in Meta')

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('config') }),
  z.object({ action: z.literal('oauth_start'), kind: z.enum(['PAGES', 'BUSINESS', 'WHATSAPP']), popup: z.boolean().optional(), coexist: z.boolean().optional() }),
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
  // A WhatsApp number connected with its IDs and a token from Meta (API Setup or a system user),
  // for numbers that cannot go through Embedded Signup yet, such as Meta's test number.
  z.object({ action: z.literal('whatsapp_manual'), waba_id: digits, phone_number_id: digits, token: z.string().trim().min(20).max(2000) }),
  z.object({
    action: z.literal('send'), conversation_id: z.string().uuid(), text: z.string().max(4000).optional(),
    file: file.optional(), image_url: z.string().url().max(1000).optional(), reply_to_id: z.string().uuid().optional(),
    private_reply: z.boolean().optional(),
    // Comments: also (or only) message the person privately.
    private_text: z.string().max(4000).optional(),
  }),
  z.object({ action: z.literal('comment_action'), message_id: z.string().uuid(), op: z.enum(['like', 'unlike', 'hide', 'unhide', 'delete']) }),
  z.object({ action: z.literal('post_refresh'), channel_id: z.string().uuid(), post_id: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal('media'), channel_id: z.string().uuid(), media_id: digits }),
])

const OP_LABEL: Record<CommentOp, string> = { like: 'Liked', unlike: 'Like removed', hide: 'Hidden', unhide: 'Shown again', delete: 'Deleted' }
const OP_FLAGS: Record<CommentOp, Record<string, boolean>> = {
  like: { liked: true }, unlike: { liked: false }, hide: { hidden: true }, unhide: { hidden: false }, delete: { removed: true },
}

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

// ------------------------------------------------------------------ automation
/** Sends one message nobody typed (an auto reply or a follow-up) and records it either way. */
async function autoSend(admin: SupabaseClient, appSecret: string, token: string | null, a: {
  conversation_id: string; text: string; private_reply?: boolean; auto: 'AUTO_REPLY' | 'FOLLOW_UP'; rule_id?: string | null; message_id?: string | null
}): Promise<boolean> {
  const ctx = await rpc<SendContext>(admin, 'inbox_send_context', { p_conversation: a.conversation_id })
  const log = (status: string, detail: string | null) => rpc(admin, 'inbox_automation_record', {
    p: { kind: a.auto, status, rule_id: a.rule_id ?? null, conversation_id: a.conversation_id, message_id: a.message_id ?? null, detail },
  })
  const inside = insideReplyWindow(ctx.last_customer_message_at)
  // An automatic message may not use the human-agent tag: outside 24 hours it waits for the customer.
  if (ctx.kind === 'MESSAGE' && !inside) {
    await log('SKIPPED', 'More than 24 hours since the customer wrote: Meta does not allow it')
    return false
  }
  const t = token ?? (ctx.channel.status === 'DISCONNECTED' ? '' : (await secret<{ access_token?: string }>(admin, channelKey(ctx.channel.id))).access_token ?? '')
  if (!t) {
    await log('FAILED', 'The channel is disconnected')
    return false
  }
  const outgoing = { conversation_id: a.conversation_id, body: a.text, attachments: [], auto_kind: a.auto, private_reply: !!a.private_reply }
  try {
    const sent = await sendMessage(new InboxGraph(t, appSecret), {
      platform: ctx.channel.platform, account_id: ctx.channel.external_id, page_id: ctx.channel.page_id, kind: ctx.kind, to: ctx.thread_key, inside_window: inside,
    }, { text: a.text, private_reply: a.private_reply })
    await rpc(admin, 'inbox_record_outgoing', { p: { ...outgoing, external_id: sent.external_id }, p_actor: null })
    await log('SENT', ctx.kind === 'COMMENT' ? (a.private_reply ? 'Private message' : 'Public reply') : null)
    return true
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await rpc(admin, 'inbox_record_outgoing', { p: { ...outgoing, error: message }, p_actor: null }).catch(() => undefined)
    await log('FAILED', message).catch(() => undefined)
    return false
  }
}

/** Every minute while one is due: the follow-ups each store scheduled. */
async function automationCron(): Promise<Record<string, unknown>> {
  const app = await metaApp()
  const run = await forEachMerchant('inbox', async (admin) => {
    const due = await rpc<Array<{ conversation_id: string; text: string }>>(admin, 'inbox_follow_ups_claim', { p_limit: 50 })
    let sent = 0
    for (const d of due) {
      if (await autoSend(admin, app.app_secret ?? '', null, { conversation_id: d.conversation_id, text: d.text, auto: 'FOLLOW_UP' })) sent++
    }
    return { due: due.length, sent }
  })
  const sent = run.results.reduce((n, r) => n + (r.ok ? r.result.sent : 0), 0)
  return { ok: true, merchants: run.merchants, failed: run.failed, sent }
}

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

  // A post's caption and picture, read once per delivery when its first comment arrives.
  const posts = new Set<string>()
  const refreshPost = async (ctx: StoreContext, c: Channel, postId: string) => {
    const k = `${c.id}:${postId}`
    if (posts.has(k) || c.platform === 'WHATSAPP') return
    posts.add(k)
    const t = await tokenFor(ctx, c)
    if (!t) return
    let details: Partial<PostDetails> = {}
    let error: string | null = null
    try {
      details = await fetchPost(new InboxGraph(t, app.app_secret), c.platform, postId)
    } catch (err) {
      error = (err as Error).message
    }
    await rpc(ctx.admin, 'inbox_post_save', { p: { channel_id: c.id, external_id: postId, ...details, error } })
  }
  // Moderation and auto replies for a new customer message.
  const automate = async (ctx: StoreContext, c: Channel, e: InboxEvent, r: { conversation_id: string; message_id: string }) => {
    const plan = await rpc<AutomationPlan>(ctx.admin, 'inbox_automation_plan', { p_conversation: r.conversation_id, p_message: r.message_id })
    if (!plan.moderate?.hide && !plan.replies?.length) return
    const t = await tokenFor(ctx, c)
    const commentId = e.message?.external_id
    if (plan.moderate?.hide) {
      if (!commentId || c.platform === 'WHATSAPP') return
      const record = (status: string, detail: string) => rpc(ctx.admin, 'inbox_automation_record', {
        p: { kind: 'MODERATION', status, conversation_id: r.conversation_id, message_id: r.message_id, detail },
      })
      try {
        await commentAction(new InboxGraph(t, app.app_secret), c.platform, commentId, 'hide')
        await record('DONE', plan.moderate.reason)
      } catch (err) {
        await record('FAILED', `${plan.moderate.reason}: ${(err as Error).message}`)
      }
      return
    }
    for (const rule of plan.replies ?? []) {
      if (rule.like && commentId && c.platform === 'FACEBOOK') {
        await commentAction(new InboxGraph(t, app.app_secret), 'FACEBOOK', commentId, 'like')
          .then(() => rpc(ctx.admin, 'inbox_message_flags', { p_message: r.message_id, p: { liked: true, detail: `Liked by auto reply "${rule.name}"` }, p_actor: null }))
          .catch(() => undefined)
      }
      const base = { conversation_id: r.conversation_id, auto: 'AUTO_REPLY' as const, rule_id: rule.rule_id, message_id: r.message_id }
      if (rule.reply_text) await autoSend(ctx.admin, app.app_secret ?? '', t || null, { ...base, text: rule.reply_text })
      if (rule.private_text) await autoSend(ctx.admin, app.app_secret ?? '', t || null, { ...base, text: rule.private_text, private_reply: true })
    }
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
      const r = await rpc<{ conversation_id: string; message_id: string; needs_profile: boolean; needs_post: boolean; duplicate: boolean; direction: 'IN' | 'OUT' }>(admin, 'inbox_ingest', {
        p: { channel_id: channel.id, kind: e.kind ?? 'MESSAGE', thread_key: e.thread_key, customer: e.customer ?? {}, post: e.post ?? null, message: e.message },
      })
      if (!r.duplicate) stored++
      if (r.needs_post && e.post?.id) await refreshPost(store.ctx, channel, e.post.id).catch(() => undefined)
      const fresh = !e.message.created_at || Date.now() - Date.parse(e.message.created_at) < AUTOMATION_MAX_AGE_MS
      if (!r.duplicate && r.direction === 'IN' && fresh) {
        await automate(store.ctx, channel, e, r).catch((err) => void logEvent({ level: 'ERROR', category: 'WEBHOOK', source: 'inbox', merchantId,
          message: `Auto reply / moderation failed: ${(err as Error).message}`, context: { conversation_id: r.conversation_id } }))
      }
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
async function connectNumber(
  admin: SupabaseClient, appSecret: string, actor: string, number: GrantedNumber, token: string, pin: string | undefined, out: Connected, coexist = false,
) {
  const g = new InboxGraph(token, appSecret)
  const label = number.name ?? number.display_phone ?? number.id
  try {
    await g.post(`${number.waba_id}/subscribed_apps`, {})
  } catch (e) {
    out.warnings.push(`${label}: Meta did not let Fullfilio receive this number's messages (${(e as Error).message}).`)
    return
  }
  // A number kept on the WhatsApp Business app is already registered there; registering again would move it off the app.
  if (pin && !coexist) {
    await g.post(`${number.id}/register`, { messaging_product: 'whatsapp', pin })
      .catch((e) => out.warnings.push(`${label}: the number could not be registered for the Cloud API (${(e as Error).message}). If it already has a two-step PIN, connect again with that PIN.`))
  }
  await saveChannel(admin, actor, {
    platform: 'WHATSAPP', external_id: number.id, waba_id: number.waba_id, name: label, display_phone: number.display_phone,
  }, token, out)
  // Coexistence: ask Meta to share the app's contacts and chat history (allowed once, soon after sign-up).
  if (coexist) {
    for (const sync_type of ['smb_app_state_sync', 'history']) {
      await g.post(`${number.id}/smb_app_data`, { messaging_product: 'whatsapp', sync_type })
        .catch((e) => out.warnings.push(`${label}: chat history could not be requested (${(e as Error).message}). New messages still arrive.`))
    }
  }
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

    const body = await readJson(req, MAX_FILE_BASE64 + 64 * 1024)
    if ((body as { action?: unknown } | null)?.action === 'automation_cron') {
      if (!(await isCronRequest(req, adminClient()))) throw new HttpError(401, 'Only the scheduler may run this', 'UNAUTHORIZED')
      return json(req, await automationCron())
    }
    const input = parse(schema, body)
    const permission = input.action === 'send' || input.action === 'comment_action' ? 'inbox.reply'
      : input.action === 'config' || input.action === 'media' || input.action === 'post_refresh' ? 'inbox.view' : 'inbox.manage'
    const staff = await requireStaff(req, permission)
    const admin = staff.admin
    const app = await metaApp()
    const appSecret = app.app_secret ?? ''

    switch (input.action) {
      case 'config':
        return json(req, { ready: appReady(app), business: appReady(app) && !!app.business_config_id, whatsapp: appReady(app) && !!app.whatsapp_config_id })

      case 'oauth_start': {
        if (!appReady(app)) throw new HttpError(422, 'Connecting with Facebook is not switched on yet. Ask Fullfilio support.', 'NOT_CONFIGURED')
        if (input.kind === 'WHATSAPP' && !app.whatsapp_config_id) {
          throw new HttpError(422, 'WhatsApp connection opens once Meta approves Fullfilio as a WhatsApp Tech Provider.', 'NOT_CONFIGURED')
        }
        if (input.kind === 'BUSINESS' && !app.business_config_id) {
          throw new HttpError(422, 'Connecting with a business portfolio is not switched on yet. Use "Connect with Page access".', 'NOT_CONFIGURED')
        }
        const coexist = input.kind === 'WHATSAPP' && !!input.coexist
        const state = await signState(appSecret, {
          m: staff.merchantId, u: staff.user.id, k: input.kind, ...(input.popup ? { w: 1 as const } : {}), ...(coexist ? { c: 1 as const } : {}),
        })
        return json(req, { url: loginUrl(app, input.kind, redirectUri(req), state, coexist) })
      }

      case 'oauth_finish': {
        if (!appReady(app)) throw new HttpError(422, 'Connecting with Facebook is not switched on yet.', 'NOT_CONFIGURED')
        const state = await readState(appSecret, input.state)
        if (!state || state.m !== staff.merchantId || state.u !== staff.user.id) {
          throw new HttpError(400, 'This Facebook sign-in has expired or was started by someone else. Start again from Messaging → Channels.', 'OAUTH_STATE')
        }
        let token: string
        try {
          // A business (system-user) token from "Connect using Business" already lasts; only a person's is extended.
          token = await exchangeCode(app, input.code, redirectUri(req), state.k === 'PAGES')
        } catch (e) {
          throw metaError(e)
        }
        await rpc(admin, 'integration_secret_store', {
          p_key: PENDING_KEY,
          p_value: { kind: state.k, token, user: staff.user.id, coexist: state.c === 1, expires_at: new Date(Date.now() + PENDING_MINUTES * 60_000).toISOString() },
          p_hint: hint(token), p_actor: staff.user.id,
        })
        const mine = await rpc<Channel[]>(admin, 'inbox_channels_for', { p_id: null, p_platform: null, p_external_id: null })
        const active = new Set(mine.filter((c) => c.status !== 'DISCONNECTED').map((c) => `${c.platform}:${c.external_id}`))
        try {
          if (state.k !== 'WHATSAPP') {
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
          return json(req, { kind: state.k, coexist: state.c === 1, numbers: numbers.map((n) => ({ ...n, connected: active.has(`WHATSAPP:${n.id}`) })) })
        } catch (e) {
          throw metaError(e)
        }
      }

      case 'oauth_connect': {
        const pending = await pendingToken(admin, staff.user.id)
        const out: Connected = { channels: [], warnings: [] }
        try {
          if (pending.kind !== 'WHATSAPP') {
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
              await connectNumber(admin, appSecret, staff.user.id, number, pending.token, input.pin, out, !!pending.coexist)
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

      case 'whatsapp_manual': {
        if (!appSecret) throw new HttpError(422, 'Connecting with Facebook is not switched on yet. Ask Fullfilio support.', 'NOT_CONFIGURED')
        const g = new InboxGraph(input.token, appSecret)
        let numbers: Array<{ id: string; display_phone_number?: string; verified_name?: string }>
        try {
          numbers = (await g.get<{ data?: typeof numbers }>(`${input.waba_id}/phone_numbers`, { fields: 'id,display_phone_number,verified_name' })).data ?? []
        } catch (e) {
          throw metaError(e)
        }
        const n = numbers.find((x) => x.id === input.phone_number_id)
        if (!n) throw new HttpError(422, 'This phone number ID is not in that WhatsApp Business Account. Copy both IDs from Meta → WhatsApp → API Setup.', 'NOT_FOUND')
        const out: Connected = { channels: [], warnings: [] }
        await connectNumber(admin, appSecret, staff.user.id, { id: n.id, waba_id: input.waba_id, display_phone: n.display_phone_number ?? null, name: n.verified_name ?? null },
          input.token, undefined, out)
        if (!out.channels.length) throw new HttpError(422, out.warnings.join(' ') || 'Meta did not accept this number.', 'META_REJECTED')
        return json(req, { ok: true, ...out })
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

      case 'comment_action': {
        const { data: m } = await admin.from('inbox_messages').select('id, external_id, conversation_id')
          .eq('id', input.message_id).eq('merchant_id', staff.merchantId).maybeSingle()
        if (!m?.external_id) throw new HttpError(404, 'Comment not found', 'NOT_FOUND')
        const ctx = await rpc<SendContext>(admin, 'inbox_send_context', { p_conversation: m.conversation_id })
        if (ctx.kind !== 'COMMENT' || ctx.channel.platform === 'WHATSAPP') throw new HttpError(422, 'Only comments can be liked, hidden or deleted', 'VALIDATION')
        if (ctx.channel.status === 'DISCONNECTED') throw new HttpError(422, 'This channel is disconnected. Connect it again under Messaging → Channels.', 'NOT_CONNECTED')
        const t = (await secret<{ access_token?: string }>(admin, channelKey(ctx.channel.id))).access_token
        if (!t) throw new HttpError(422, 'This channel has no access token. Connect it again under Messaging → Channels.', 'NOT_CONNECTED')
        try {
          await commentAction(new InboxGraph(t, appSecret), ctx.channel.platform, m.external_id, input.op)
        } catch (e) {
          await rpc(admin, 'inbox_automation_record', { p: { kind: 'COMMENT_ACTION', status: 'FAILED', conversation_id: m.conversation_id, message_id: m.id,
            detail: `${OP_LABEL[input.op]}: ${e instanceof Error ? e.message : String(e)}`, actor: staff.user.id } }).catch(() => undefined)
          throw metaError(e)
        }
        await rpc(admin, 'inbox_message_flags', { p_message: m.id, p: { ...OP_FLAGS[input.op], detail: OP_LABEL[input.op] }, p_actor: staff.user.id })
        return json(req, { ok: true })
      }

      case 'post_refresh': {
        const [c] = await rpc<Channel[]>(admin, 'inbox_channels_for', { p_id: input.channel_id })
        if (!c || c.platform === 'WHATSAPP') throw new HttpError(404, 'Channel not found', 'NOT_FOUND')
        const t = (await secret<{ access_token?: string }>(admin, channelKey(c.id))).access_token
        if (!t) throw new HttpError(422, 'This channel is disconnected', 'NOT_CONNECTED')
        let details: PostDetails
        try {
          details = await fetchPost(new InboxGraph(t, appSecret), c.platform, input.post_id)
        } catch (e) {
          throw metaError(e)
        }
        await rpc(admin, 'inbox_post_save', { p: { channel_id: c.id, external_id: input.post_id, ...details } })
        return json(req, { ok: true, post: details })
      }

      case 'send': {
        const privateText = input.private_text?.trim()
        if (!input.text?.trim() && !input.file && !input.image_url && !privateText) throw new HttpError(422, 'Write a message or attach something', 'VALIDATION')
        const ctx = await rpc<SendContext>(admin, 'inbox_send_context', { p_conversation: input.conversation_id })
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
        // A comment answered "both": the public reply first, then the private message (which carries any file).
        const parts: Array<{ text?: string; file?: OutgoingFile; image_url?: string; private_reply?: boolean }> = ctx.kind === 'COMMENT' && privateText
          ? [...(input.text?.trim() ? [{ text: input.text }] : []), { text: privateText, file: input.file as OutgoingFile | undefined, image_url: input.image_url, private_reply: true }]
          : [{ text: input.text, file: input.file as OutgoingFile | undefined, image_url: input.image_url, private_reply: input.private_reply }]
        let messageId: string | null = null
        for (const part of parts) {
          const outgoing = {
            conversation_id: input.conversation_id, body: part.text?.trim() || null, reply_to_id: input.reply_to_id ?? null, private_reply: !!part.private_reply,
            attachments: part.file ? [{ type: attachmentType(part.file.mime), name: part.file.name, mime: part.file.mime }]
              : part.image_url ? [{ type: 'image', url: part.image_url }] : [],
          }
          try {
            const sent = await sendMessage(g, {
              platform: ctx.channel.platform, account_id: ctx.channel.external_id, page_id: ctx.channel.page_id, kind: ctx.kind, to,
              inside_window: insideReplyWindow(ctx.last_customer_message_at),
            }, { text: part.text, file: part.file, image_url: part.image_url, reply_to_external_id: replyExternal, private_reply: part.private_reply })
            const r = await rpc<{ message_id: string | null }>(admin, 'inbox_record_outgoing', {
              p: { ...outgoing, external_id: sent.external_id, attachments: sent.attachments.length ? sent.attachments : outgoing.attachments },
              p_actor: staff.user.id,
            })
            messageId = r.message_id
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            await rpc(admin, 'inbox_record_outgoing', { p: { ...outgoing, error: message }, p_actor: staff.user.id }).catch(() => undefined)
            if (e instanceof MetaApiError && e.tokenInvalid) {
              await rpc(admin, 'inbox_channel_status', { p_id: ctx.channel.id, p_status: 'FAILED', p_error: message }).catch(() => undefined)
            }
            throw metaError(e)
          }
        }
        return json(req, { ok: true, message_id: messageId })
      }
    }
  })
)
