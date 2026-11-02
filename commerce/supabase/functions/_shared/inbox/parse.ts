// Meta webhooks (Messenger, Instagram, WhatsApp Cloud API, Page feed and
// Instagram comments) turned into one shape the inbox stores. Pure: no I/O, so
// every payload Meta documents is covered by unit tests.

export type InboxPlatform = 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP'

export interface InboxAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location' | 'product' | 'other'
  url?: string
  /** WhatsApp media: fetched with the channel's token when shown. */
  media_id?: string
  mime?: string
  name?: string
  caption?: string
  lat?: number
  lng?: number
}

export interface InboxEvent {
  platform: InboxPlatform
  /** Page id, Instagram account id or WhatsApp phone number id the event is for. */
  account_id: string
  type: 'message' | 'status' | 'read'
  kind?: 'MESSAGE' | 'COMMENT'
  thread_key?: string
  customer?: { external_id?: string; name?: string; phone?: string; avatar?: string }
  post?: { id: string; url?: string; title?: string; type?: string }
  message?: {
    external_id?: string
    direction: 'IN' | 'OUT'
    body?: string
    attachments?: InboxAttachment[]
    reply_to_external_id?: string
    sender_name?: string
    created_at?: string
    /** WhatsApp: the payload of the quick-reply button the customer tapped (our Confirm / Cancel carry the order's token). */
    button_payload?: string
  }
  status?: { external_id: string; status: 'DELIVERED' | 'READ' | 'FAILED' | 'SENT'; error?: string }
  /** Messenger/Instagram read receipt: every message sent before this time was seen. */
  read_until?: string
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined)

/** Seconds or milliseconds since 1970, or an ISO string, as ISO. */
export function toIso(t: unknown): string | undefined {
  if (typeof t === 'number' || (typeof t === 'string' && /^\d+$/.test(t))) {
    const n = Number(t)
    return new Date(n < 1e12 ? n * 1000 : n).toISOString()
  }
  if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString()
  return undefined
}

function messengerAttachment(a: Json): InboxAttachment {
  const type = str(a.type)
  const payload = obj(a.payload)
  const url = str(payload.url)
  if (type === 'location') {
    const c = obj(payload.coordinates)
    return { type: 'location', lat: Number(c.lat), lng: Number(c.long), url }
  }
  if (payload.sticker_id) return { type: 'sticker', url }
  const known = ['image', 'video', 'audio', 'file'] as const
  return { type: (known as readonly string[]).includes(type ?? '') ? (type as InboxAttachment['type']) : 'other', url, name: str(payload.title) }
}

/** Messenger (object "page") and Instagram (object "instagram") messaging events. */
function fromMessaging(platform: 'FACEBOOK' | 'INSTAGRAM', entryId: string, m: Json): InboxEvent[] {
  const sender = str(obj(m.sender).id)
  const recipient = str(obj(m.recipient).id)
  const message = obj(m.message)
  if (m.read || m.delivery) {
    const read = obj(m.read)
    const delivery = obj(m.delivery)
    // Instagram read receipts name the message; Messenger sends a watermark time.
    if (read.mid) return [{ platform, account_id: entryId, type: 'status', status: { external_id: String(read.mid), status: 'READ' } }]
    if (read.watermark) return [{ platform, account_id: entryId, type: 'read', thread_key: sender, read_until: toIso(read.watermark) }]
    return arr(delivery.mids).map((mid) => ({ platform, account_id: entryId, type: 'status' as const, status: { external_id: String(mid), status: 'DELIVERED' as const } }))
  }
  if (!m.message || message.is_deleted) return []
  // An echo is a message the business sent (from here, Meta Business Suite or the phone app).
  const echo = message.is_echo === true
  const customer = echo ? recipient : sender
  if (!customer) return []
  const attachments = arr(message.attachments).map((a) => messengerAttachment(obj(a)))
  const replyTo = str(obj(message.reply_to).mid)
  return [{
    platform, account_id: entryId, type: 'message', kind: 'MESSAGE', thread_key: customer,
    customer: { external_id: customer },
    message: {
      external_id: str(message.mid), direction: echo ? 'OUT' : 'IN', body: str(message.text),
      attachments, reply_to_external_id: replyTo, created_at: toIso(m.timestamp),
    },
  }]
}

/** Facebook Page feed: comments on the Page's posts and ads. */
function fromFeed(pageId: string, value: Json): InboxEvent[] {
  if (value.item !== 'comment' || value.verb !== 'add') return []
  const commentId = str(value.comment_id)
  const postId = str(value.post_id)
  if (!commentId || !postId) return []
  const parent = str(value.parent_id)
  // Replies point at their top-level comment; the thread is that comment.
  const root = parent && parent !== postId ? parent : commentId
  const from = obj(value.from)
  const fromId = str(from.id)
  const photo = str(value.photo)
  return [{
    platform: 'FACEBOOK', account_id: pageId, type: 'message', kind: 'COMMENT', thread_key: root,
    customer: fromId === pageId ? undefined : { external_id: fromId, name: str(from.name) },
    post: { id: postId, url: `https://www.facebook.com/${postId}`, title: str(obj(value.post).message)?.slice(0, 120) },
    message: {
      external_id: commentId, direction: fromId === pageId ? 'OUT' : 'IN', body: str(value.message),
      attachments: photo ? [{ type: 'image', url: photo }] : [], reply_to_external_id: root !== commentId ? root : undefined,
      sender_name: str(from.name), created_at: toIso(value.created_time),
    },
  }]
}

/** Instagram comments (and replies) on posts, Reels and ads. */
function fromInstagramComment(accountId: string, value: Json): InboxEvent[] {
  const id = str(value.id)
  if (!id) return []
  const parent = str(value.parent_id)
  const root = parent ?? id
  const from = obj(value.from)
  const fromId = str(from.id)
  const media = obj(value.media)
  const mine = fromId === accountId
  return [{
    platform: 'INSTAGRAM', account_id: accountId, type: 'message', kind: 'COMMENT', thread_key: root,
    customer: mine ? undefined : { external_id: fromId, name: str(from.username) },
    post: str(media.id) ? { id: String(media.id), type: str(media.media_product_type) } : undefined,
    message: {
      external_id: id, direction: mine ? 'OUT' : 'IN', body: str(value.text),
      reply_to_external_id: parent, sender_name: str(from.username), created_at: toIso(value.timestamp) ?? new Date().toISOString(),
    },
  }]
}

const WA_MEDIA = ['image', 'video', 'audio', 'document', 'sticker'] as const

function whatsappMessage(m: Json): { body?: string; attachments: InboxAttachment[]; button_payload?: string } {
  const type = str(m.type)
  if (type === 'text') return { body: str(obj(m.text).body), attachments: [] }
  if ((WA_MEDIA as readonly string[]).includes(type ?? '')) {
    const media = obj(m[type!])
    return {
      body: str(media.caption),
      attachments: [{
        type: type === 'document' ? 'file' : type === 'sticker' ? 'sticker' : (type as 'image' | 'video' | 'audio'),
        media_id: str(media.id), mime: str(media.mime_type), name: str(media.filename),
      }],
    }
  }
  if (type === 'location') {
    const l = obj(m.location)
    return { body: str(l.name) ?? str(l.address), attachments: [{ type: 'location', lat: Number(l.latitude), lng: Number(l.longitude) }] }
  }
  if (type === 'button') return { body: str(obj(m.button).text), attachments: [], button_payload: str(obj(m.button).payload) }
  if (type === 'interactive') {
    const i = obj(m.interactive)
    return { body: str(obj(i.button_reply).title) ?? str(obj(i.list_reply).title), attachments: [], button_payload: str(obj(i.button_reply).id) }
  }
  if (type === 'reaction') return { body: str(obj(m.reaction).emoji), attachments: [] }
  return { body: `[${type ?? 'message'}]`, attachments: [] }
}

/** WhatsApp Cloud API: messages from customers and the status of what was sent. */
function fromWhatsApp(value: Json): InboxEvent[] {
  const meta = obj(value.metadata)
  const phoneId = str(meta.phone_number_id)
  if (!phoneId) return []
  const names = new Map(arr(value.contacts).map((c) => [str(obj(c).wa_id), str(obj(obj(c).profile).name)]))
  const out: InboxEvent[] = []
  for (const raw of arr(value.messages)) {
    const m = obj(raw)
    const from = str(m.from)
    if (!from) continue
    const { body, attachments, button_payload } = whatsappMessage(m)
    out.push({
      platform: 'WHATSAPP', account_id: phoneId, type: 'message', kind: 'MESSAGE', thread_key: from,
      customer: { external_id: from, phone: from, name: names.get(from) },
      message: {
        external_id: str(m.id), direction: 'IN', body, attachments,
        reply_to_external_id: str(obj(m.context).id), created_at: toIso(m.timestamp),
        ...(button_payload ? { button_payload } : {}),
      },
    })
  }
  for (const raw of arr(value.statuses)) {
    const s = obj(raw)
    const id = str(s.id)
    const status = ({ delivered: 'DELIVERED', read: 'READ', failed: 'FAILED', sent: 'SENT' } as const)[String(s.status) as 'delivered']
    if (!id || !status) continue
    const err = obj(arr(s.errors)[0])
    out.push({ platform: 'WHATSAPP', account_id: phoneId, type: 'status',
      status: { external_id: id, status, error: str(obj(err.error_data).details) ?? str(err.title) ?? str(err.message) } })
  }
  return out
}

/** Every inbox event in one webhook delivery. */
export function parseWebhook(body: unknown): InboxEvent[] {
  const root = obj(body)
  const object = str(root.object)
  const out: InboxEvent[] = []
  for (const rawEntry of arr(root.entry)) {
    const entry = obj(rawEntry)
    const id = str(entry.id) ?? ''
    if (object === 'page' || object === 'instagram') {
      const platform = object === 'page' ? 'FACEBOOK' : 'INSTAGRAM'
      for (const m of arr(entry.messaging)) out.push(...fromMessaging(platform, id, obj(m)))
      for (const c of arr(entry.changes)) {
        const change = obj(c)
        if (object === 'page' && change.field === 'feed') out.push(...fromFeed(id, obj(change.value)))
        if (object === 'instagram' && (change.field === 'comments' || change.field === 'live_comments')) out.push(...fromInstagramComment(id, obj(change.value)))
      }
    } else if (object === 'whatsapp_business_account') {
      for (const c of arr(entry.changes)) {
        const change = obj(c)
        if (change.field === 'messages') out.push(...fromWhatsApp(obj(change.value)))
      }
    }
  }
  return out
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Meta signs every delivery with the app secret (X-Hub-Signature-256: sha256=<hex>). */
export async function validSignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith('sha256=') || !appSecret) return false
  const expected = await hmacHex(appSecret, rawBody)
  const given = header.slice(7).toLowerCase()
  if (given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

/** Messenger and Instagram allow a normal reply for 24 hours after the customer's last message. */
export function insideReplyWindow(lastCustomerMessageAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastCustomerMessageAt) return false
  return now - Date.parse(lastCustomerMessageAt) < 24 * 3600_000
}
