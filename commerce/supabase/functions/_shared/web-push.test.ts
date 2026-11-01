import { describe, expect, it } from 'vitest'
import { encryptPayload, fromBase64Url, generateVapidKeys, sendPush, toBase64Url, vapidAuthorization } from './web-push.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const subtle = globalThis.crypto.subtle

// RFC 8291 Appendix A: the worked example every Web Push implementation is checked against.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  result: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', k, data))
}

/** The browser's side, written from the RFC on its own: reads what encryptPayload wrote. */
async function decrypt(body: Uint8Array, uaPublicB64: string, uaPrivateB64: string, authB64: string): Promise<string> {
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen)
  const record = body.slice(21 + idlen)
  expect(rs).toBe(4096)
  const uaPublic = fromBase64Url(uaPublicB64)
  const jwk = { kty: 'EC', crv: 'P-256', x: toBase64Url(uaPublic.slice(1, 33)), y: toBase64Url(uaPublic.slice(33)), d: uaPrivateB64 }
  const uaKey = await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKey, 256))
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic, 1])
  const ikm = (await hmac(await hmac(fromBase64Url(authB64), secret), info)).slice(0, 32)
  const prk = await hmac(salt, ikm)
  const cek = (await hmac(prk, new Uint8Array([...enc.encode('Content-Encoding: aes128gcm\0'), 1]))).slice(0, 16)
  const nonce = (await hmac(prk, new Uint8Array([...enc.encode('Content-Encoding: nonce\0'), 1]))).slice(0, 12)
  const aes = await subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt'])
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, record))
  expect(plain[plain.length - 1]).toBe(2)
  return dec.decode(plain.slice(0, -1))
}

async function browserKeys() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
  const jwk = await subtle.exportKey('jwk', pair.privateKey)
  return { p256dh: toBase64Url(raw), priv: jwk.d!, auth: toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16))) }
}

describe('message encryption (RFC 8291)', () => {
  it('matches the RFC\'s worked example byte for byte', async () => {
    const body = await encryptPayload(enc.encode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
      salt: fromBase64Url(RFC.salt), senderPublic: fromBase64Url(RFC.asPublic), senderPrivate: fromBase64Url(RFC.asPrivate),
    })
    expect(toBase64Url(body)).toBe(RFC.result)
    expect(await decrypt(body, RFC.uaPublic, RFC.uaPrivate, RFC.auth)).toBe(RFC.plaintext)
  })

  it('uses a new key and salt for every message, and the device can read each one', async () => {
    const device = await browserKeys()
    const text = JSON.stringify({ title: 'New order 1051', body: 'Test Order · ৳379.9', url: '/admin/orders/x' })
    const a = await encryptPayload(enc.encode(text), device)
    const b = await encryptPayload(enc.encode(text), device)
    expect(toBase64Url(a.slice(0, 16))).not.toBe(toBase64Url(b.slice(0, 16)))
    expect(await decrypt(a, device.p256dh, device.priv, device.auth)).toBe(text)
    expect(await decrypt(b, device.p256dh, device.priv, device.auth)).toBe(text)
  })

  it('refuses broken device keys and over-long messages', async () => {
    const device = await browserKeys()
    await expect(encryptPayload(enc.encode('x'), { p256dh: 'AAAA', auth: device.auth })).rejects.toThrow(/P-256/)
    await expect(encryptPayload(enc.encode('x'), { p256dh: device.p256dh, auth: 'AAAA' })).rejects.toThrow(/16 bytes/)
    await expect(encryptPayload(new Uint8Array(4000), device)).rejects.toThrow(/too long/)
  })
})

describe('VAPID (RFC 8292)', () => {
  it('signs a token the push service can check with our public key', async () => {
    const keys = await generateVapidKeys()
    expect(fromBase64Url(keys.public_key)).toHaveLength(65)
    const now = Date.UTC(2026, 10, 1, 12)
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://fullfilio.com', now)
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
    expect(m).not.toBeNull()
    const [, h, c, sig, k] = m!
    expect(JSON.parse(dec.decode(fromBase64Url(h)))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(dec.decode(fromBase64Url(c)))).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://fullfilio.com' })
    expect(k).toBe(keys.public_key)
    const pub = await subtle.importKey('raw', fromBase64Url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromBase64Url(sig), enc.encode(`${h}.${c}`))).toBe(true)
    // The private key never leaves as part of the header.
    expect(header).not.toContain(keys.private_jwk.d!)
  })
})

describe('sending', () => {
  it('posts the encrypted message with the headers push services require', async () => {
    const keys = await generateVapidKeys()
    const device = await browserKeys()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
    const message = { title: 'New order 1051', body: 'Test Order · ৳379.9', url: '/admin/orders/1', tag: 'new-orders' }
    const result = await sendPush({ endpoint: 'https://web.push.apple.com/QGuQyavXutnMH', ...device }, message, keys, { fetchFn })
    expect(result).toEqual({ ok: true, status: 201 })
    const { url, init } = calls[0]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://web.push.apple.com/QGuQyavXutnMH')
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.TTL).toBe(String(6 * 3600))
    expect(headers.Urgency).toBe('high')
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=/)
    expect(JSON.parse(await decrypt(init.body as Uint8Array, device.p256dh, device.priv, device.auth))).toEqual(message)
  })

  it('says when a device is gone for good', async () => {
    const keys = await generateVapidKeys()
    const device = await browserKeys()
    const reply = (status: number) => (async () => new Response('push subscription has unsubscribed or expired', { status })) as unknown as typeof fetch
    const msg = { title: 't', body: 'b', url: '/admin' }
    expect(await sendPush({ endpoint: 'https://fcm.googleapis.com/x', ...device }, msg, keys, { fetchFn: reply(410) })).toMatchObject({ ok: false, gone: true, status: 410 })
    expect(await sendPush({ endpoint: 'https://fcm.googleapis.com/x', ...device }, msg, keys, { fetchFn: reply(404) })).toMatchObject({ ok: false, gone: true })
    expect(await sendPush({ endpoint: 'https://fcm.googleapis.com/x', ...device }, msg, keys, { fetchFn: reply(429) })).toMatchObject({ ok: false, gone: false, status: 429 })
  })
})
