import { invokeFunction } from '@/lib/functions'
import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { VariantSearchRow } from '@/services/catalog'

export type InboxPlatform = 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP'
export type ConversationStatus = 'OPEN' | 'FOLLOW_UP' | 'DONE'

export interface InboxChannel {
  id: string; platform: InboxPlatform; name: string; username: string | null; avatar_url: string | null
  display_phone: string | null; status: 'OK' | 'FAILED' | 'DISCONNECTED'; status_error: string | null
  receive_comments: boolean; token_hint: string | null; last_event_at: string | null; created_at: string
}
export interface InboxOverview {
  channels: InboxChannel[]
  counts: { open: number; follow_up: number; done: number; unread: number; awaiting: number; mine: number; unassigned: number; starred: number }
  comments?: { awaiting: number; unread: number }
  labels: string[]
}
export interface ConversationRow {
  id: string; channel_id: string; platform: InboxPlatform; channel_name: string; kind: 'MESSAGE' | 'COMMENT'
  customer_name: string | null; customer_avatar: string | null; customer_phone: string | null
  status: ConversationStatus; starred: boolean; labels: string[]; assigned_to: string | null; assigned_name: string | null
  unread_count: number; last_message_at: string | null; last_message_preview: string | null; last_message_direction: 'IN' | 'OUT' | null
  linked_order_id: string | null; post_title: string | null
  customer_id: string | null; has_order: boolean; awaiting_since: string | null; last_customer_message_at: string | null
  auto_follow_up_at: string | null; remind_at: string | null; no_reply_needed: boolean
}
export interface Attachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location' | 'product' | 'other'
  url?: string; media_id?: string; mime?: string; name?: string; caption?: string; lat?: number; lng?: number
}
export interface InboxMessage {
  id: string; direction: 'IN' | 'OUT'; external_id: string | null; body: string | null; attachments: Attachment[]
  reply_to: { id: string; body: string; direction: 'IN' | 'OUT' } | null
  sender_name: string | null; status: 'RECEIVED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'; error: string | null; created_at: string
  hidden: boolean; liked: boolean; removed_at: string | null; filtered: string | null
  auto_kind: 'AUTO_REPLY' | 'FOLLOW_UP' | null; private_reply: boolean
}
export interface PostDetail {
  id: string; channel_id: string; external_id: string; caption: string | null; image_url: string | null; permalink: string | null
  media_type: string | null; is_ad: boolean; posted_at: string | null; likes: number | null; shares: number | null; comments: number | null
  fetch_error: string | null
}
export interface HistoryEntry {
  id: string; kind: 'AUTO_REPLY' | 'FOLLOW_UP' | 'MODERATION' | 'COMMENT_ACTION'
  status: 'SENT' | 'FAILED' | 'SKIPPED' | 'DONE' | 'SCHEDULED' | 'CANCELLED'; detail: string | null; rule_name: string | null; actor_name: string | null; created_at: string
}
export interface InboxThread {
  conversation: ConversationRow & {
    thread_key: string; customer_external_id: string | null; customer_address: string | null; customer_id: string | null
    post: { id: string; url?: string; title?: string; type?: string } | null; pinned_message_id: string | null
    channel_avatar: string | null; channel_status: string; last_customer_message_at: string | null; created_at: string
    post_external_id: string | null; auto_follow_up_text: string | null; follow_up_by_name: string | null; remind_note: string | null
  }
  messages: InboxMessage[]
  has_more: boolean
  pinned: { id: string; body: string; created_at: string } | null
  notes: Array<{ id: string; body: string; created_at: string; created_by_name: string | null }>
  customer: {
    id: string; full_name: string; phone: string; email: string | null; address: string | null; area: string | null; district: string | null
    segment: string | null; status: string | null; risk_level: string | null; tags: string[] | null
    total_orders: number; delivered_orders: number; cancelled_orders: number; returned_orders: number; total_spent: number; last_order_at: string | null
  } | null
  orders: Array<{ id: string; order_number: string; status: string; total_amount: number; created_at: string; items: number; linked: boolean }>
  other_conversations: Array<{ id: string; platform: InboxPlatform; kind: string; status: ConversationStatus; last_message_at: string | null; last_message_preview: string | null }>
  post_detail: PostDetail | null
  history: HistoryEntry[]
}
export interface InboxFilters {
  status?: ConversationStatus | ''; platform?: InboxPlatform | ''; kind?: 'MESSAGE' | 'COMMENT' | ''
  unread?: boolean; starred?: boolean; assigned?: 'me' | 'none' | ''; label?: string; q?: string; limit?: number; offset?: number
  awaiting?: boolean; has_order?: boolean; tagged?: boolean; sort?: 'recent' | 'oldest' | 'waiting' | ''
}

const rpc = async <T>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const { data, error } = await supabase.rpc(fn as never, args as never)
  if (error) throw error
  return fromJson<T>(data)
}

export const inboxOverview = () => rpc<InboxOverview>('inbox_overview')
export const inboxList = (f: InboxFilters) =>
  rpc<{ total: number; items: ConversationRow[] }>('inbox_list', { p: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined && v !== false)) })
export const inboxThread = (id: string, before?: string) => rpc<InboxThread>('inbox_thread', { p_id: id, p_before: before ?? null, p_limit: 60 })
export const inboxMarkRead = (id: string) => rpc<void>('inbox_mark_read', { p_id: id })
export const inboxUpdate = (id: string, patch: Partial<{
  status: ConversationStatus; assigned_to: string | null; starred: boolean; labels: string[]; pinned_message_id: string | null
  customer_name: string; customer_phone: string; customer_address: string; customer_id: string | null; linked_order_id: string | null; unread: boolean
}>) => rpc<void>('inbox_update', { p_id: id, p: patch })
export const inboxNoteAdd = (id: string, body: string) => rpc<string>('inbox_note_add', { p_id: id, p_body: body })
export const inboxNoteDelete = (id: string) => rpc<void>('inbox_note_delete', { p_id: id })
export const savedReplies = () => rpc<Array<{ id: string; title: string; body: string }>>('inbox_saved_replies')
export const saveSavedReply = (r: { id?: string; title: string; body: string }) => rpc<string>('inbox_saved_reply_save', { p: r })
export const deleteSavedReply = (id: string) => rpc<void>('inbox_saved_reply_delete', { p_id: id })
export const inboxUnread = () => rpc<{ messages: number; comments: number }>('inbox_unread_counts')
export const inboxBulk = (ids: string[], patch: Partial<{ status: ConversationStatus; read: boolean; no_reply_needed: boolean; assigned_to: string | null; add_label: string }>) =>
  rpc<number>('inbox_bulk', { p_ids: ids, p: patch })
/** An automatic message if the customer does not answer; null minutes cancels it. */
export const setFollowUp = (id: string, minutes: number | null, text?: string) => rpc<void>('inbox_follow_up_set', { p_id: id, p_minutes: minutes, p_text: text ?? null })
export const setReminder = (id: string, at: string | null, note?: string) => rpc<void>('inbox_reminder_set', { p_id: id, p_at: at, p_note: note ?? null })
export const orderMessage = (orderId: string, kind: 'STATUS' | 'INVOICE') => rpc<string>('inbox_order_message', { p_order: orderId, p_kind: kind })

// ---- comments
export type CommentState = 'all' | 'awaiting' | 'replied' | 'no_reply' | 'unread' | 'liked' | 'hidden' | 'deleted' | 'filtered'
export interface CommentFilters { platform?: InboxPlatform | ''; state?: CommentState; q?: string }
export interface CommentPost {
  channel_id: string; post_id: string | null; platform: InboxPlatform; channel_name: string; caption: string | null; image_url: string | null
  permalink: string | null; posted_at: string | null; is_ad: boolean; media_type: string | null; likes: number | null; shares: number | null
  meta_comments: number | null; matching: number; awaiting: number; total: number; latest: string | null; last_at: string | null
}
export interface CommentItem {
  id: string; channel_id: string; platform: InboxPlatform; channel_name: string; post_id: string | null; post_caption: string | null; post_image: string | null
  customer_name: string | null; customer_avatar: string | null; customer_external_id: string | null; status: ConversationStatus; no_reply_needed: boolean
  unread_count: number; awaiting_since: string | null; labels: string[]; assigned_to: string | null; assigned_name: string | null; last_message_at: string | null
  comment: { id: string | null; external_id: string | null; body: string | null; attachments: Attachment[]; sender_name: string | null; created_at: string | null
    hidden: boolean | null; liked: boolean | null; removed_at: string | null; filtered: string | null }
  replies: number; replied: boolean
  last_reply: { body: string; direction: 'IN' | 'OUT'; sender_name: string | null; created_at: string; auto_kind: string | null; private_reply: boolean; status: string } | null
}
const clean = (p: object) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v !== undefined && v !== false))
export const commentsOverview = (f: CommentFilters) =>
  rpc<{ counts: { all: number; awaiting: number; unread: number; matching: number }; posts: CommentPost[] }>('inbox_comments_overview', { p: clean(f) })
export const commentsList = (f: CommentFilters & { channel_id?: string; post_id?: string | null; limit?: number; offset?: number }) =>
  rpc<{ total: number; items: CommentItem[] }>('inbox_comments', { p: Object.fromEntries(Object.entries(f).filter(([k, v]) => (k === 'post_id' ? v !== undefined : v !== '' && v !== undefined && v !== false))) })
export type CommentOp = 'like' | 'unlike' | 'hide' | 'unhide' | 'delete'
export const commentAction = (message_id: string, op: CommentOp) => invokeFunction<{ ok: boolean }>('inbox', { action: 'comment_action', message_id, op })
export const refreshPost = (channel_id: string, post_id: string) => invokeFunction<{ ok: boolean }>('inbox', { action: 'post_refresh', channel_id, post_id })

// ---- auto replies
export interface AutoReplyRule {
  id: string; name: string; enabled: boolean; is_default: boolean; applies_to: 'MESSAGE' | 'COMMENT' | 'BOTH'; keywords: string[]
  match: 'CONTAINS' | 'EXACT'; channel_ids: string[]; post_ids: string[]; reply_text: string | null; private_text: string | null
  like_comment: boolean; once_per_customer: boolean; sent_count: number; last_sent_at: string | null; sort_order: number; created_at: string
}
export interface InboxAutomation {
  settings: {
    auto_reply_channels: string[]; moderation_channels: string[]
    moderation: { enabled: boolean; hide_phone: boolean; hide_links: boolean; keywords: string[] }
    follow_up: { enabled: boolean; after_minutes: number; text?: string | null; default_text: string }
  }
  rules: AutoReplyRule[]
  channels: Array<{ id: string; platform: InboxPlatform; name: string; status: string; receive_comments: boolean; auto_reply: boolean; moderation: boolean }>
  limit: number
  stats: { sent_today: number; sent_7d: number; follow_ups_7d: number; hidden_7d: number; failed_7d: number }
}
export type AutoReplyInput = Partial<Omit<AutoReplyRule, 'sent_count' | 'last_sent_at' | 'created_at'>> & { name: string }
export const inboxAutomation = () => rpc<InboxAutomation>('inbox_automation')
export const saveInboxSettings = (p: Partial<{
  auto_reply_channels: string[]; moderation_channels: string[]; moderation: InboxAutomation['settings']['moderation']
  follow_up: { enabled: boolean; after_minutes: number; text?: string | null }
}>) => rpc<void>('inbox_settings_save', { p })
export const saveAutoReply = (r: AutoReplyInput) => rpc<string>('inbox_auto_reply_save', { p: r })
export const toggleAutoReply = (id: string, enabled: boolean) => rpc<void>('inbox_auto_reply_toggle', { p_id: id, p_enabled: enabled })
export const deleteAutoReply = (id: string) => rpc<void>('inbox_auto_reply_delete', { p_id: id })
export const tryAutoReply = (text: string, kind: 'MESSAGE' | 'COMMENT', channel: string | null, first: boolean) =>
  rpc<{ moderation: { reason: string; active: boolean } | null; rule: { id: string; name: string; reply_text: string | null; private_text: string | null; default: boolean } | null; running: boolean }>(
    'inbox_auto_reply_try', { p_text: text, p_kind: kind, p_channel: channel, p_first: first })
export interface ActivityItem {
  id: string; kind: HistoryEntry['kind']; status: HistoryEntry['status']; detail: string | null; created_at: string; rule_name: string | null; actor_name: string | null
  conversation_id: string | null; customer_name: string | null; conversation_kind: 'MESSAGE' | 'COMMENT' | null; platform: InboxPlatform | null; message: string | null
}
export const inboxActivity = (p: { kind?: string; status?: string; limit?: number; offset?: number }) =>
  rpc<{ total: number; items: ActivityItem[] }>('inbox_activity', { p: clean(p) })

// ---- the inbox function (talks to Meta)
export interface OutgoingFile { name: string; mime: string; data: string }
export const sendInboxMessage = (input: {
  conversation_id: string; text?: string; file?: OutgoingFile; image_url?: string; reply_to_id?: string; private_reply?: boolean; private_text?: string
}) => invokeFunction<{ ok: boolean; message_id: string | null }>('inbox', { action: 'send', ...input })
/** Whether stores can connect yet (Super Admin saved the Meta app) and whether WhatsApp sign-up is on. */
export const inboxConfig = () => invokeFunction<{ ready: boolean; business?: boolean; whatsapp: boolean }>('inbox', { action: 'config' })

/** PAGES: "Connect with Page access"; BUSINESS: "Connect using Business" (a business portfolio's Pages). */
export type MetaConnectKind = 'PAGES' | 'BUSINESS' | 'WHATSAPP'
export interface MetaPageChoice {
  id: string; name: string; picture: string | null; connected: boolean
  instagram: { id: string; username: string | null; picture: string | null; connected: boolean } | null
}
export interface MetaNumberChoice { id: string; waba_id: string; display_phone: string | null; name: string | null; connected: boolean }
export type MetaFinish = { kind: 'PAGES' | 'BUSINESS'; pages: MetaPageChoice[] } | { kind: 'WHATSAPP'; coexist?: boolean; numbers: MetaNumberChoice[] }

/** Meta's login address ("Continue with Facebook"); the browser goes there and comes back to /admin/inbox/meta-callback. */
/** coexist: keep the WhatsApp number working in the WhatsApp Business app as well. */
export const metaConnectStart = (kind: MetaConnectKind, popup = false, coexist = false) =>
  invokeFunction<{ url: string }>('inbox', { action: 'oauth_start', kind, popup, coexist })
/** The code Meta sent back → the Pages or WhatsApp numbers to choose from. */
export const metaConnectFinish = (code: string, state: string) => invokeFunction<MetaFinish>('inbox', { action: 'oauth_finish', code, state })
/** Connects what the owner picked. */
export const metaConnect = (input: {
  pages?: Array<{ id: string; facebook: boolean; instagram: boolean }>; comments?: boolean
  numbers?: Array<{ id: string; waba_id: string }>; pin?: string
}) => invokeFunction<{ ok: boolean; channels: InboxChannel[]; warnings: string[] }>('inbox', { action: 'oauth_connect', ...input })
export const setChannelComments = (id: string, receive_comments: boolean) => invokeFunction<{ ok: boolean }>('inbox', { action: 'channel', id, receive_comments })
export const disconnectChannel = (id: string) => invokeFunction<{ ok: boolean }>('inbox', { action: 'disconnect', id })
/** A WhatsApp number connected with its IDs and an access token from Meta (API Setup or a system user). */
export const connectWhatsAppManually = (input: { waba_id: string; phone_number_id: string; token: string }) =>
  invokeFunction<{ ok: boolean; channels: InboxChannel[]; warnings: string[] }>('inbox', { action: 'whatsapp_manual', ...input })
/** Takes the channel off the store for good, with its conversations. */
export const removeChannel = (id: string) => invokeFunction<{ removed: boolean; conversations: number }>('inbox', { action: 'remove', id })
export const whatsappMedia = (channel_id: string, media_id: string) => invokeFunction<{ mime: string; data: string }>('inbox', { action: 'media', channel_id, media_id })

/** A file as base64 for the inbox function (10 MB at most). */
export async function fileForSending(file: Blob, name: string): Promise<OutgoingFile> {
  if (file.size > 10 * 1024 * 1024) throw new Error('Files can be 10 MB at most')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { name, mime: file.type || 'application/octet-stream', data: btoa(bin) }
}

// ---- products to send in a chat
export interface ChatProduct { id: string; name: string; slug: string; price: number | null; image: string | null }
export async function chatProducts(q: string): Promise<ChatProduct[]> {
  // The same cost-free catalog as the order form (anyone who answers chats may use it).
  const { data, error } = await supabase.rpc('order_catalog', { p_search: q.trim() || undefined, p_limit: 50 })
  if (error) throw error
  const byProduct = new Map<string, ChatProduct>()
  for (const v of (data ?? []) as unknown as VariantSearchRow[]) {
    if (v.product_status !== 'ACTIVE') continue
    const p = byProduct.get(v.product_id)
    const price = v.unit_price === null ? null : Number(v.unit_price)
    if (!p) byProduct.set(v.product_id, { id: v.product_id, name: v.product_name, slug: v.product_slug, price, image: v.image_url })
    else if (price !== null && (p.price === null || price < p.price)) p.price = price
  }
  return [...byProduct.values()].slice(0, 12)
}

// ---- staff to assign
export async function inboxStaff(): Promise<Array<{ id: string; full_name: string | null }>> {
  const { data, error } = await supabase.from('profiles').select('id, full_name').eq('is_active', true).not('role_id', 'is', null).is('deleted_at', null).order('full_name')
  if (error) throw error
  return data ?? []
}

// ---- linking a chat to an order or a customer
export async function findOrdersToLink(q: string): Promise<Array<{ id: string; order_number: string; status: string; total_amount: number; customer_name: string }>> {
  const term = q.replace(/[%,()]/g, ' ').trim()
  if (term.length < 2) return []
  const { data, error } = await supabase.from('orders').select('id, order_number, status, total_amount, customer_name')
    .or(`order_number.ilike.%${term}%,customer_phone.ilike.%${term.replace(/\D/g, '') || term}%`).order('created_at', { ascending: false }).limit(8)
  if (error) throw error
  return (data ?? []).map((o) => ({ ...o, total_amount: Number(o.total_amount) }))
}
export async function findCustomersToLink(q: string): Promise<Array<{ id: string; full_name: string; phone: string; total_orders: number }>> {
  const term = q.replace(/[%,()]/g, ' ').trim()
  if (term.length < 2) return []
  const { data, error } = await supabase.from('customers').select('id, full_name, phone, total_orders')
    .or(`full_name.ilike.%${term}%,phone.ilike.%${term.replace(/\D/g, '') || term}%`).order('last_order_at', { ascending: false, nullsFirst: false }).limit(8)
  if (error) throw error
  return data ?? []
}
