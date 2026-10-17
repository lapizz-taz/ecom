import { invokeFunction } from '@/lib/functions'
import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'

export type InboxPlatform = 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP'
export type ConversationStatus = 'OPEN' | 'FOLLOW_UP' | 'DONE'

export interface InboxChannel {
  id: string; platform: InboxPlatform; name: string; username: string | null; avatar_url: string | null
  display_phone: string | null; status: 'OK' | 'FAILED' | 'DISCONNECTED'; status_error: string | null
  receive_comments: boolean; token_hint: string | null; last_event_at: string | null; created_at: string
}
export interface InboxOverview {
  channels: InboxChannel[]
  counts: { open: number; follow_up: number; done: number; unread: number; mine: number; unassigned: number; starred: number }
  labels: string[]
}
export interface ConversationRow {
  id: string; channel_id: string; platform: InboxPlatform; channel_name: string; kind: 'MESSAGE' | 'COMMENT'
  customer_name: string | null; customer_avatar: string | null; customer_phone: string | null
  status: ConversationStatus; starred: boolean; labels: string[]; assigned_to: string | null; assigned_name: string | null
  unread_count: number; last_message_at: string | null; last_message_preview: string | null; last_message_direction: 'IN' | 'OUT' | null
  linked_order_id: string | null; post_title: string | null
}
export interface Attachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location' | 'product' | 'other'
  url?: string; media_id?: string; mime?: string; name?: string; caption?: string; lat?: number; lng?: number
}
export interface InboxMessage {
  id: string; direction: 'IN' | 'OUT'; external_id: string | null; body: string | null; attachments: Attachment[]
  reply_to: { id: string; body: string; direction: 'IN' | 'OUT' } | null
  sender_name: string | null; status: 'RECEIVED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'; error: string | null; created_at: string
}
export interface InboxThread {
  conversation: ConversationRow & {
    thread_key: string; customer_external_id: string | null; customer_address: string | null; customer_id: string | null
    post: { id: string; url?: string; title?: string; type?: string } | null; pinned_message_id: string | null
    channel_avatar: string | null; channel_status: string; last_customer_message_at: string | null; created_at: string
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
}
export interface InboxFilters {
  status?: ConversationStatus | ''; platform?: InboxPlatform | ''; kind?: 'MESSAGE' | 'COMMENT' | ''
  unread?: boolean; starred?: boolean; assigned?: 'me' | 'none' | ''; label?: string; q?: string; limit?: number; offset?: number
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
export const inboxUnread = () => rpc<number>('inbox_unread_count')

// ---- the inbox function (talks to Meta)
export interface OutgoingFile { name: string; mime: string; data: string }
export const sendInboxMessage = (input: {
  conversation_id: string; text?: string; file?: OutgoingFile; image_url?: string; reply_to_id?: string; private_reply?: boolean
}) => invokeFunction<{ ok: boolean; message_id: string | null }>('inbox', { action: 'send', ...input })
/** Whether stores can connect yet (Super Admin saved the Meta app) and whether WhatsApp sign-up is on. */
export const inboxConfig = () => invokeFunction<{ ready: boolean; whatsapp: boolean }>('inbox', { action: 'config' })

export type MetaConnectKind = 'PAGES' | 'WHATSAPP'
export interface MetaPageChoice {
  id: string; name: string; picture: string | null; connected: boolean
  instagram: { id: string; username: string | null; picture: string | null; connected: boolean } | null
}
export interface MetaNumberChoice { id: string; waba_id: string; display_phone: string | null; name: string | null; connected: boolean }
export type MetaFinish = { kind: 'PAGES'; pages: MetaPageChoice[] } | { kind: 'WHATSAPP'; numbers: MetaNumberChoice[] }

/** Meta's login address ("Continue with Facebook"); the browser goes there and comes back to /admin/inbox/meta-callback. */
export const metaConnectStart = (kind: MetaConnectKind) => invokeFunction<{ url: string }>('inbox', { action: 'oauth_start', kind })
/** The code Meta sent back → the Pages or WhatsApp numbers to choose from. */
export const metaConnectFinish = (code: string, state: string) => invokeFunction<MetaFinish>('inbox', { action: 'oauth_finish', code, state })
/** Connects what the owner picked. */
export const metaConnect = (input: {
  pages?: Array<{ id: string; facebook: boolean; instagram: boolean }>; comments?: boolean
  numbers?: Array<{ id: string; waba_id: string }>; pin?: string
}) => invokeFunction<{ ok: boolean; channels: InboxChannel[]; warnings: string[] }>('inbox', { action: 'oauth_connect', ...input })
export const setChannelComments = (id: string, receive_comments: boolean) => invokeFunction<{ ok: boolean }>('inbox', { action: 'channel', id, receive_comments })
export const disconnectChannel = (id: string) => invokeFunction<{ ok: boolean }>('inbox', { action: 'disconnect', id })
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
  let query = supabase.from('products')
    .select('id, name, slug, product_images(url, is_primary, position), product_variants(price, is_active)')
    .eq('status', 'ACTIVE').order('name').limit(12)
  const term = q.replace(/[%,()]/g, ' ').trim()
  if (term) query = query.ilike('name', `%${term}%`)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map((p) => {
    const images = [...((p.product_images ?? []) as Array<{ url: string; is_primary: boolean; position: number }>)]
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.position - b.position)
    const prices = ((p.product_variants ?? []) as Array<{ price: number; is_active: boolean }>).filter((v) => v.is_active).map((v) => Number(v.price))
    return { id: p.id, name: p.name, slug: p.slug, price: prices.length ? Math.min(...prices) : null, image: images[0]?.url ?? null }
  })
}

// ---- staff to assign
export async function inboxStaff(): Promise<Array<{ id: string; full_name: string | null }>> {
  const { data, error } = await supabase.from('profiles').select('id, full_name').eq('is_active', true).not('role_id', 'is', null).is('deleted_at', null).order('full_name')
  if (error) throw error
  return data ?? []
}
