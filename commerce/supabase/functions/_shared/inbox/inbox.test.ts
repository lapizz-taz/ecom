import { describe, expect, it, vi } from 'vitest'
import { InboxGraph, sendMessage } from './meta.ts'
import { insideReplyWindow, parseWebhook, toIso, validSignature } from './parse.ts'

describe('inbox webhooks: Messenger and Instagram', () => {
  it('reads a customer message with text, a photo and a reply', () => {
    const events = parseWebhook({
      object: 'page',
      entry: [{ id: 'PAGE1', time: 1, messaging: [{
        sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, timestamp: 1760000000000,
        message: { mid: 'm.1', text: 'price?', reply_to: { mid: 'm.0' }, attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }] },
      }] }],
    })
    expect(events).toEqual([expect.objectContaining({
      platform: 'FACEBOOK', account_id: 'PAGE1', type: 'message', kind: 'MESSAGE', thread_key: 'PSID1',
      message: expect.objectContaining({ external_id: 'm.1', direction: 'IN', body: 'price?', reply_to_external_id: 'm.0',
        attachments: [{ type: 'image', url: 'https://cdn/x.jpg', name: undefined }] }),
    })])
  })

  it('an echo (sent by the Page) belongs to the customer it was sent to', () => {
    const [e] = parseWebhook({ object: 'instagram', entry: [{ id: 'IG1', messaging: [{
      sender: { id: 'IG1' }, recipient: { id: 'IGSID9' }, timestamp: 1760000000,
      message: { mid: 'm.2', text: 'Thanks!', is_echo: true },
    }] }] })
    expect(e).toMatchObject({ platform: 'INSTAGRAM', thread_key: 'IGSID9', message: { direction: 'OUT', body: 'Thanks!' } })
  })

  it('delivery and read receipts', () => {
    const events = parseWebhook({ object: 'page', entry: [{ id: 'P', messaging: [
      { sender: { id: 'U' }, recipient: { id: 'P' }, delivery: { mids: ['a', 'b'] } },
      { sender: { id: 'U' }, recipient: { id: 'P' }, read: { watermark: 1760000000000 } },
    ] }] })
    expect(events.filter((e) => e.type === 'status').map((e) => e.status?.external_id)).toEqual(['a', 'b'])
    expect(events.find((e) => e.type === 'read')).toMatchObject({ thread_key: 'U', read_until: '2025-10-09T08:53:20.000Z' })
  })

  it('Page comments and replies thread under the top comment; the Page own reply is outgoing', () => {
    const feed = (value: Record<string, unknown>) => ({ object: 'page', entry: [{ id: 'PAGE', changes: [{ field: 'feed', value }] }] })
    const [top] = parseWebhook(feed({ item: 'comment', verb: 'add', comment_id: 'P_1_c1', post_id: 'P_1', parent_id: 'P_1', message: 'price?', from: { id: 'U1', name: 'Rina' }, created_time: 1760000000 }))
    const [reply] = parseWebhook(feed({ item: 'comment', verb: 'add', comment_id: 'P_1_c2', post_id: 'P_1', parent_id: 'P_1_c1', message: '৳580', from: { id: 'PAGE', name: 'Shop' } }))
    const [ignored] = parseWebhook(feed({ item: 'comment', verb: 'remove', comment_id: 'x', post_id: 'P_1' }))
    expect(top).toMatchObject({ kind: 'COMMENT', thread_key: 'P_1_c1', customer: { external_id: 'U1', name: 'Rina' }, message: { direction: 'IN' } })
    expect(reply).toMatchObject({ thread_key: 'P_1_c1', customer: undefined, message: { direction: 'OUT', reply_to_external_id: 'P_1_c1' } })
    expect(ignored).toBeUndefined()
  })

  it('Instagram comments on a Reel', () => {
    const [c] = parseWebhook({ object: 'instagram', entry: [{ id: 'IG1', changes: [{ field: 'comments',
      value: { id: 'c9', text: 'link?', from: { id: 'U5', username: 'sara' }, media: { id: 'M1', media_product_type: 'REELS' } } }] }] })
    expect(c).toMatchObject({ platform: 'INSTAGRAM', kind: 'COMMENT', thread_key: 'c9', post: { id: 'M1', type: 'REELS' }, customer: { name: 'sara' } })
  })
})

describe('inbox webhooks: WhatsApp', () => {
  it('reads text, voice notes and statuses with the customer name', () => {
    const events = parseWebhook({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '109', display_phone_number: '880170' },
      contacts: [{ wa_id: '8801711', profile: { name: 'Karim' } }],
      messages: [
        { from: '8801711', id: 'wamid.1', timestamp: '1760000000', type: 'text', text: { body: 'hi' } },
        { from: '8801711', id: 'wamid.2', timestamp: '1760000001', type: 'audio', audio: { id: '555', mime_type: 'audio/ogg' }, context: { id: 'wamid.0' } },
      ],
      statuses: [{ id: 'wamid.out', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'More than 24 hours' } }] }],
    } }] }] })
    expect(events[0]).toMatchObject({ platform: 'WHATSAPP', account_id: '109', thread_key: '8801711', customer: { name: 'Karim', phone: '8801711' }, message: { body: 'hi' } })
    expect(events[1].message).toMatchObject({ attachments: [{ type: 'audio', media_id: '555', mime: 'audio/ogg' }], reply_to_external_id: 'wamid.0' })
    expect(events[2]).toMatchObject({ type: 'status', status: { external_id: 'wamid.out', status: 'FAILED', error: 'More than 24 hours' } })
  })

  it('ignores what it does not know', () => {
    expect(parseWebhook({ object: 'user', entry: [{}] })).toEqual([])
    expect(parseWebhook(null)).toEqual([])
  })
})

describe('inbox: signature and reply window', () => {
  it('accepts only bodies signed with the app secret', async () => {
    const body = '{"object":"page"}'
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('s3cret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, '0')).join('')
    expect(await validSignature(body, `sha256=${sig}`, 's3cret')).toBe(true)
    expect(await validSignature(body + ' ', `sha256=${sig}`, 's3cret')).toBe(false)
    expect(await validSignature(body, `sha256=${sig}`, 'other')).toBe(false)
    expect(await validSignature(body, null, 's3cret')).toBe(false)
  })

  it('24-hour window and timestamps', () => {
    const now = Date.parse('2026-10-16T12:00:00Z')
    expect(insideReplyWindow('2026-10-16T00:00:00Z', now)).toBe(true)
    expect(insideReplyWindow('2026-10-15T11:00:00Z', now)).toBe(false)
    expect(insideReplyWindow(null, now)).toBe(false)
    expect(toIso(1760000000)).toBe(toIso(1760000000000))
  })
})

describe('inbox: sending', () => {
  const graph = (reply: Record<string, unknown> = {}) => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(reply), { status: 200 }))
    return { g: new InboxGraph('TOKEN', '', fetchFn as unknown as typeof fetch), fetchFn }
  }
  const call = (fetchFn: ReturnType<typeof graph>['fetchFn'], i = 0) => ({
    url: String(fetchFn.mock.calls[i][0]), body: JSON.parse(String(fetchFn.mock.calls[i][1]?.body ?? '{}')),
    auth: (fetchFn.mock.calls[i][1]?.headers as Record<string, string>).Authorization,
  })

  it('Messenger reply inside 24 hours; tagged as a human agent after', async () => {
    const { g, fetchFn } = graph({ message_id: 'm.out' })
    const r = await sendMessage(g, { platform: 'FACEBOOK', account_id: 'PAGE', kind: 'MESSAGE', to: 'PSID', inside_window: true }, { text: 'hello' })
    expect(r.external_id).toBe('m.out')
    expect(call(fetchFn)).toMatchObject({ body: { recipient: { id: 'PSID' }, messaging_type: 'RESPONSE', message: { text: 'hello' } }, auth: 'Bearer TOKEN' })
    expect(call(fetchFn).url).toContain('/PAGE/messages')
    expect(call(fetchFn).url).not.toContain('TOKEN')
    await sendMessage(g, { platform: 'FACEBOOK', account_id: 'PAGE', kind: 'MESSAGE', to: 'PSID', inside_window: false }, { text: 'late' })
    expect(call(fetchFn, 1).body).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' })
  })

  it('Instagram is sent through its Page; comments are answered under the comment or privately', async () => {
    const { g, fetchFn } = graph({ id: 'c.out', message_id: 'm.x' })
    await sendMessage(g, { platform: 'INSTAGRAM', account_id: 'IG', page_id: 'PAGE', kind: 'MESSAGE', to: 'IGSID', inside_window: true }, { text: 'hi' })
    expect(call(fetchFn).url).toContain('/PAGE/messages')
    await sendMessage(g, { platform: 'INSTAGRAM', account_id: 'IG', page_id: 'PAGE', kind: 'COMMENT', to: 'c9', inside_window: false }, { text: 'DM sent' })
    expect(call(fetchFn, 1).url).toContain('/c9/replies')
    await sendMessage(g, { platform: 'FACEBOOK', account_id: 'PAGE', kind: 'COMMENT', to: 'P_1_c1', inside_window: false }, { text: 'check inbox' })
    expect(call(fetchFn, 2).url).toContain('/P_1_c1/comments')
    await sendMessage(g, { platform: 'FACEBOOK', account_id: 'PAGE', kind: 'COMMENT', to: 'P_1_c1', inside_window: false }, { text: 'price ৳580', private_reply: true })
    expect(call(fetchFn, 3).body).toMatchObject({ recipient: { comment_id: 'P_1_c1' }, messaging_type: 'RESPONSE' })
  })

  it('WhatsApp text replies quote the message; product photos go by link', async () => {
    const { g, fetchFn } = graph({ messages: [{ id: 'wamid.out' }] })
    const r = await sendMessage(g, { platform: 'WHATSAPP', account_id: '109', kind: 'MESSAGE', to: '8801711', inside_window: true },
      { text: 'ok', reply_to_external_id: 'wamid.1' })
    expect(r.external_id).toBe('wamid.out')
    expect(call(fetchFn).body).toMatchObject({ messaging_product: 'whatsapp', to: '8801711', type: 'text', context: { message_id: 'wamid.1' } })
    await sendMessage(g, { platform: 'WHATSAPP', account_id: '109', kind: 'MESSAGE', to: '8801711', inside_window: true },
      { text: 'Ring ৳299', image_url: 'https://shop/ring.jpg' })
    expect(call(fetchFn, 1).body).toMatchObject({ type: 'image', image: { link: 'https://shop/ring.jpg', caption: 'Ring ৳299' } })
  })

  it('Meta errors come back in plain words', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { code: 10, error_subcode: 2018278, message: 'outside window' } }), { status: 400 }))
    const g = new InboxGraph('T', '', fetchFn as unknown as typeof fetch)
    await expect(sendMessage(g, { platform: 'FACEBOOK', account_id: 'P', kind: 'MESSAGE', to: 'U', inside_window: true }, { text: 'x' }))
      .rejects.toThrow(/24 hours/)
  })
})
