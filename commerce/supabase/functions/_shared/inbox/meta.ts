// Graph API calls the inbox makes: read a Page / Instagram account / WhatsApp
// number when it is connected, subscribe it to the app's webhooks, send
// messages and comment replies, and fetch WhatsApp media. Tokens go in the
// Authorization header, never in a URL; appsecret_proof is added when the
// store saved its app secret.
import { env } from '../env.ts'
import { MetaApiError } from '../meta/graph.ts'
import type { InboxAttachment } from './parse.ts'

type FetchFn = typeof fetch

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

export class InboxGraph {
  private readonly root: string
  constructor(private readonly token: string, private readonly appSecret = '', private readonly fetchFn: FetchFn = fetch) {
    const base = (env('META_GRAPH_URL') ?? 'https://graph.facebook.com').replace(/\/+$/, '')
    this.root = `${base}/${env('META_GRAPH_VERSION') ?? 'v23.0'}`
  }

  private async url(path: string, params: Record<string, string> = {}): Promise<URL> {
    const u = new URL(`${this.root}/${path.replace(/^\/+/, '')}`)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    if (this.appSecret) u.searchParams.set('appsecret_proof', await hmacHex(this.appSecret, this.token))
    return u
  }

  private async call<T>(url: URL, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchFn(url.toString(), {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let body: Record<string, unknown> | null = null
    try {
      body = JSON.parse(text)
    } catch {
      // not JSON
    }
    const err = body?.error as { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } | undefined
    if (!response.ok || err) {
      throw new MetaApiError(friendly(err?.code, err?.error_subcode, err?.error_user_msg || err?.message || `HTTP ${response.status}`), err?.code, err?.error_subcode, response.status)
    }
    return (body ?? {}) as T
  }

  get<T = Record<string, unknown>>(path: string, params: Record<string, string> = {}): Promise<T> {
    return this.url(path, params).then((u) => this.call<T>(u))
  }

  post<T = Record<string, unknown>>(path: string, body: Record<string, unknown>, params: Record<string, string> = {}): Promise<T> {
    return this.url(path, params).then((u) => this.call<T>(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
  }

  delete<T = Record<string, unknown>>(path: string, params: Record<string, string> = {}): Promise<T> {
    return this.url(path, params).then((u) => this.call<T>(u, { method: 'DELETE' }))
  }

  postForm<T = Record<string, unknown>>(path: string, form: FormData): Promise<T> {
    return this.url(path).then((u) => this.call<T>(u, { method: 'POST', body: form }))
  }

  /** A file the Graph API hands out by URL (WhatsApp media), with the same token. */
  async download(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const response = await this.fetchFn(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new MetaApiError(`Could not download the file (HTTP ${response.status})`, undefined, undefined, response.status)
    return { bytes: new Uint8Array(await response.arrayBuffer()), mime: response.headers.get('content-type') ?? 'application/octet-stream' }
  }
}

/** Meta's error codes in words staff can act on. */
export function friendly(code: number | undefined, subcode: number | undefined, message: string): string {
  if (code === 190) return 'The access token expired or was revoked. Reconnect this channel with a new token.'
  if (code === 10 && subcode === 2018278) return 'More than 24 hours have passed since the customer last wrote, so Meta does not allow a normal reply.'
  if (code === 10 || code === 200) return `Meta refused: ${message} (check the app's permissions and that the Page is subscribed).`
  if (code === 131047) return 'More than 24 hours have passed since the customer last wrote. WhatsApp only allows an approved template now.'
  if (code === 131026) return 'WhatsApp could not deliver to this number (not on WhatsApp, or an old app version).'
  if (code === 551) return 'This person is not available right now (they may have blocked the Page).'
  if (code === 4 || code === 613 || code === 80006) return 'Meta asked us to slow down. Try again in a minute.'
  return `Meta: ${message}`
}

export const hint = (token: string) => `••••${token.slice(-4)}`

export interface OutgoingFile { name: string; mime: string; data: string /* base64 */ }

export function attachmentType(mime: string): 'image' | 'video' | 'audio' | 'file' {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}

function blobOf(file: OutgoingFile): Blob {
  const bin = atob(file.data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: file.mime })
}

export interface SendTarget {
  platform: 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP'
  /** Page id (Messenger), Instagram account id, or WhatsApp phone number id. */
  account_id: string
  /** The Page that sends for an Instagram account. */
  page_id?: string | null
  kind: 'MESSAGE' | 'COMMENT'
  /** DMs: PSID / IGSID / WhatsApp number. Comments: the comment to answer. */
  to: string
  inside_window: boolean
}

export interface SendInput {
  text?: string
  file?: OutgoingFile
  image_url?: string
  /** WhatsApp: the message this answers. */
  reply_to_external_id?: string
  /** Comments: answer in the customer's inbox instead of under the post. */
  private_reply?: boolean
}

/** Sends one message; returns the platform's message id and what was attached. */
export async function sendMessage(g: InboxGraph, t: SendTarget, input: SendInput): Promise<{ external_id: string | null; attachments: InboxAttachment[] }> {
  const text = input.text?.trim()
  if (t.platform === 'WHATSAPP') {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: t.to,
      ...(input.reply_to_external_id ? { context: { message_id: input.reply_to_external_id } } : {}) }
    let attachments: InboxAttachment[] = []
    let payload: Record<string, unknown>
    if (input.file) {
      const form = new FormData()
      form.set('messaging_product', 'whatsapp')
      form.set('type', input.file.mime)
      form.set('file', blobOf(input.file), input.file.name)
      const media = await g.postForm<{ id: string }>(`${t.account_id}/media`, form)
      const type = attachmentType(input.file.mime)
      const kind = type === 'file' ? 'document' : type
      payload = { ...base, type: kind, [kind]: { id: media.id, ...(kind === 'document' ? { filename: input.file.name } : {}), ...(text && kind !== 'audio' ? { caption: text } : {}) } }
      attachments = [{ type, media_id: media.id, mime: input.file.mime, name: input.file.name }]
    } else if (input.image_url) {
      payload = { ...base, type: 'image', image: { link: input.image_url, ...(text ? { caption: text } : {}) } }
      attachments = [{ type: 'image', url: input.image_url }]
    } else {
      payload = { ...base, type: 'text', text: { body: text ?? '', preview_url: true } }
    }
    const r = await g.post<{ messages?: Array<{ id: string }> }>(`${t.account_id}/messages`, payload)
    return { external_id: r.messages?.[0]?.id ?? null, attachments }
  }

  // Comments answered under the post.
  if (t.kind === 'COMMENT' && !input.private_reply) {
    if (!text) throw new MetaApiError('Write a reply first; files cannot be posted as a comment reply.')
    const r = t.platform === 'FACEBOOK'
      ? await g.post<{ id?: string }>(`${t.to}/comments`, { message: text })
      : await g.post<{ id?: string }>(`${t.to}/replies`, { message: text })
    return { external_id: r.id ?? null, attachments: [] }
  }

  // Messenger and Instagram DMs (or a private reply to a comment).
  const sender = t.platform === 'INSTAGRAM' ? (t.page_id ?? t.account_id) : t.account_id
  const recipient = t.kind === 'COMMENT' ? { comment_id: t.to } : { id: t.to }
  const window = t.kind === 'COMMENT' || t.inside_window
    ? { messaging_type: 'RESPONSE' }
    : { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' }
  let attachments: InboxAttachment[] = []
  let message: Record<string, unknown>
  if (input.file) {
    const type = attachmentType(input.file.mime)
    const form = new FormData()
    form.set('message', JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }))
    if (t.platform === 'INSTAGRAM') form.set('platform', 'instagram')
    form.set('filedata', blobOf(input.file), input.file.name)
    const up = await g.postForm<{ attachment_id: string }>(`${sender}/message_attachments`, form)
    message = { attachment: { type, payload: { attachment_id: up.attachment_id } } }
    attachments = [{ type, mime: input.file.mime, name: input.file.name }]
  } else if (input.image_url) {
    message = { attachment: { type: 'image', payload: { url: input.image_url, is_reusable: true } } }
    attachments = [{ type: 'image', url: input.image_url }]
  } else {
    message = { text: text ?? '' }
  }
  const r = await g.post<{ message_id?: string }>(`${sender}/messages`, { recipient, ...window, message })
  // A file goes as its own message; a caption follows as text.
  if ((input.file || input.image_url) && text) {
    await g.post(`${sender}/messages`, { recipient, ...window, message: { text } })
  }
  return { external_id: r.message_id ?? null, attachments }
}

export type CommentOp = 'like' | 'unlike' | 'hide' | 'unhide' | 'delete'

/** Like, hide or delete a Facebook or Instagram comment (or the Page's own reply). */
export async function commentAction(g: InboxGraph, platform: 'FACEBOOK' | 'INSTAGRAM', commentId: string, op: CommentOp): Promise<void> {
  if (platform === 'INSTAGRAM') {
    if (op === 'like' || op === 'unlike') throw new MetaApiError('Instagram does not let apps like comments. Reply to it instead.')
    if (op === 'delete') await g.delete(commentId)
    else await g.post(commentId, {}, { hide: op === 'hide' ? 'true' : 'false' })
    return
  }
  if (op === 'like') await g.post(`${commentId}/likes`, {})
  else if (op === 'unlike') await g.delete(`${commentId}/likes`)
  else if (op === 'delete') await g.delete(commentId)
  else await g.post(commentId, { is_hidden: op === 'hide' })
}

export interface PostDetails {
  caption: string | null; image_url: string | null; permalink: string | null; media_type: string | null
  posted_at: string | null; likes: number | null; shares: number | null; comments: number | null; is_ad: boolean
}

type FbPost = {
  message?: string; full_picture?: string; permalink_url?: string; created_time?: string; status_type?: string
  shares?: { count?: number }; reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } }
  is_eligible_for_promotion?: boolean; promotion_status?: string
}
type IgMedia = {
  caption?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string
  like_count?: number; comments_count?: number; media_type?: string; media_product_type?: string
}

/** The caption, picture, link and counts of the post or ad a comment is on. */
export async function fetchPost(g: InboxGraph, platform: 'FACEBOOK' | 'INSTAGRAM', postId: string): Promise<PostDetails> {
  if (platform === 'INSTAGRAM') {
    const m = await g.get<IgMedia>(postId, { fields: 'caption,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,media_type,media_product_type' })
    return {
      caption: m.caption ?? null, image_url: m.media_type === 'VIDEO' ? (m.thumbnail_url ?? null) : (m.media_url ?? m.thumbnail_url ?? null),
      permalink: m.permalink ?? null, media_type: m.media_product_type === 'REELS' ? 'REELS' : (m.media_type ?? null), posted_at: m.timestamp ?? null,
      likes: m.like_count ?? null, shares: null, comments: m.comments_count ?? null, is_ad: m.media_product_type === 'AD',
    }
  }
  const p = await g.get<FbPost>(postId, {
    fields: 'message,full_picture,permalink_url,created_time,status_type,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
  })
  return {
    caption: p.message ?? null, image_url: p.full_picture ?? null, permalink: p.permalink_url ?? null, media_type: p.status_type ?? null,
    posted_at: p.created_time ?? null, likes: p.reactions?.summary?.total_count ?? null, shares: p.shares?.count ?? null,
    comments: p.comments?.summary?.total_count ?? null, is_ad: false,
  }
}
