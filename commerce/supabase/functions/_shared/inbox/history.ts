// Old chats from Meta: a Page's Messenger or Instagram conversations, read with the Conversations API
// (pages_messaging / instagram_manage_messages, the Page's own token) so a store can bring back chats
// that are not in the inbox (connected later, or removed). Staff start it with a button; it never runs
// by itself. Messages keep Meta's ids, so chats already in the inbox are not doubled.
import type { InboxEvent } from './parse.ts'

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined)

/** Chats read per call (each with its latest messages), so one call stays well inside the Worker's limits. */
export const HISTORY_CHATS_PER_CALL = 5
/** The latest messages brought back per chat. */
export const HISTORY_MESSAGES_PER_CHAT = 25

export type HistoryMessage = NonNullable<InboxEvent['message']>
export interface HistoryChat {
  thread_key: string
  customer: { external_id: string; name?: string }
  updated_at: string | null
  /** Oldest first, the order they are saved in. */
  messages: HistoryMessage[]
}

export const historyFields = () =>
  `participants,updated_time,messages.limit(${HISTORY_MESSAGES_PER_CHAT}){id,created_time,from,message,sticker,attachments{mime_type,name,image_data,video_data,file_url}}`

function attachmentsOf(m: Json): HistoryMessage['attachments'] {
  const out: NonNullable<HistoryMessage['attachments']> = []
  const sticker = str(m.sticker)
  if (sticker) out.push({ type: 'sticker', url: sticker })
  for (const a of arr(obj(m.attachments).data)) {
    const x = obj(a)
    const mime = str(x.mime_type)
    const image = str(obj(x.image_data).url)
    const video = str(obj(x.video_data).url)
    const file = str(x.file_url)
    if (image) out.push({ type: 'image', url: image, mime })
    else if (video) out.push({ type: 'video', url: video, mime })
    else if (file) out.push({ type: mime?.startsWith('audio/') ? 'audio' : 'file', url: file, mime, name: str(x.name) })
  }
  return out
}

/**
 * One page of Meta's answer → chats with the customer and their messages. `own` are the store's ids
 * (the Page, and the Instagram account for Instagram): those messages are the store's own (OUT).
 * Chats last active before `since` end the import.
 */
export function parseHistory(body: unknown, own: string[], since: string | null): { chats: HistoryChat[]; after: string | null; done: boolean } {
  const b = obj(body)
  const mine = new Set(own.filter(Boolean))
  const chats: HistoryChat[] = []
  let done = false
  for (const c of arr(b.data)) {
    const conv = obj(c)
    const updated = str(conv.updated_time) ?? null
    if (since && updated && Date.parse(updated) < Date.parse(since)) { done = true; break }
    const people = arr(obj(conv.participants).data).map(obj)
    const customer = people.find((p) => str(p.id) && !mine.has(str(p.id)!))
    const id = customer && str(customer.id)
    if (!id) continue
    const name = str(customer!.name) ?? str(customer!.username)
    const messages: HistoryMessage[] = []
    for (const raw of arr(obj(conv.messages).data)) {
      const m = obj(raw)
      const from = str(obj(m.from).id)
      const body = str(m.message)
      const attachments = attachmentsOf(m)
      if (!str(m.id) || (!body && !attachments?.length)) continue
      messages.push({
        external_id: str(m.id), direction: from && mine.has(from) ? 'OUT' : 'IN', body, attachments,
        created_at: str(m.created_time) ? new Date(str(m.created_time)!).toISOString() : undefined,
      })
    }
    messages.reverse()
    if (messages.length) chats.push({ thread_key: id, customer: { external_id: id, ...(name ? { name } : {}) }, updated_at: updated, messages })
  }
  const paging = obj(b.paging)
  const after = !done && str(paging.next) ? str(obj(paging.cursors).after) ?? null : null
  return { chats, after, done: done || !after }
}
