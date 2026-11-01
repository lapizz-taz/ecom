// Web Push without a third party: each message is encrypted for the device (RFC 8291, aes128gcm)
// and signed with our VAPID key (RFC 8292), then posted to the browser's push service (Google,
// Apple, Mozilla or Microsoft). Only Web Crypto is used, so it runs on Workers, Deno and Node.

export interface PushDevice {
  endpoint: string
  /** The browser's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string
  /** The browser's 16-byte auth secret, base64url. */
  auth: string
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url: what browsers subscribe with. */
  public_key: string
  /** The matching private key as a JWK (kept in Vault). */
  private_jwk: JsonWebKey
}

export interface PushMessage {
  title: string
  body: string
  /** Where a tap on the notification opens (same site). */
  url: string
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag?: string
}

export interface SendOptions {
  /** Seconds the push service keeps the message for a device that is offline. */
  ttl?: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  /** Contact for the push service (RFC 8292 "sub"). */
  subject?: string
  fetchFn?: typeof fetch
}

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status: number; gone: boolean; error: string }

const enc = new TextEncoder()
const subtle = () => crypto.subtle

// ---------------------------------------------------------------- base64url

export function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// ---------------------------------------------------------------- keys

/** A new VAPID key pair (done once, by the push function, the first time it is needed). */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey) as ArrayBuffer)
  const jwk = await subtle().exportKey('jwk', pair.privateKey) as JsonWebKey
  return { public_key: toBase64Url(raw), private_jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } }
}

/** The JWK for a P-256 key from its uncompressed public point (and private scalar). */
function p256Jwk(publicKey: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('not an uncompressed P-256 public key')
  return {
    kty: 'EC', crv: 'P-256',
    x: toBase64Url(publicKey.slice(1, 33)), y: toBase64Url(publicKey.slice(33, 65)),
    ...(d ? { d: toBase64Url(d) } : {}),
  }
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle().sign('HMAC', k, data))
}

// ---------------------------------------------------------------- RFC 8291 (aes128gcm)

export interface EncryptOptions {
  /** For tests (RFC 8291 Appendix A): a fixed salt and sender key pair instead of fresh ones. */
  salt?: Uint8Array
  senderPublic?: Uint8Array
  senderPrivate?: Uint8Array
}

/** Encrypts a message for one device: the request body the push service gets, as aes128gcm. */
export async function encryptPayload(plaintext: Uint8Array, device: Pick<PushDevice, 'p256dh' | 'auth'>, options: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = fromBase64Url(device.p256dh)
  const authSecret = fromBase64Url(device.auth)
  if (uaPublic.length !== 65) throw new Error('the device key is not a P-256 public key')
  if (authSecret.length !== 16) throw new Error('the device auth secret is not 16 bytes')
  if (plaintext.length > 3993) throw new Error('the message is too long for one push')

  let asPublic: Uint8Array
  let asPrivateKey: CryptoKey
  if (options.senderPublic && options.senderPrivate) {
    asPublic = options.senderPublic
    asPrivateKey = await subtle().importKey('jwk', p256Jwk(asPublic, options.senderPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  } else {
    const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
    asPublic = new Uint8Array(await subtle().exportKey('raw', pair.publicKey) as ArrayBuffer)
    asPrivateKey = pair.privateKey
  }
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16))

  const uaKey = await subtle().importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  // (Workers' type names the field "$public"; at run time every platform takes "public".)
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0]
  const ecdhSecret = new Uint8Array(await subtle().deriveBits(ecdh, asPrivateKey, 256))

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0 || ua_public || as_public, 32)
  const prkKey = await hmac(authSecret, ecdhSecret)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = (await hmac(prkKey, concat(keyInfo, new Uint8Array([1])))).slice(0, 32)
  // CEK and nonce from HKDF(salt, IKM, ...)
  const prk = await hmac(salt, ikm)
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16)
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12)

  const aes = await subtle().importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  // One record: the message, then the last-record delimiter (0x02), no padding.
  const record = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, concat(plaintext, new Uint8Array([2]))))

  const header = new Uint8Array(16 + 4 + 1 + 65)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = 65
  header.set(asPublic, 21)
  return concat(header, record)
}

// ---------------------------------------------------------------- RFC 8292 (VAPID)

/** The Authorization header that proves the message comes from the holder of our VAPID key. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = toBase64Url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = toBase64Url(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const key = await subtle().importKey('jwk', { ...keys.private_jwk, key_ops: ['sign'], ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  // Web Crypto signs ECDSA as r || s (64 bytes), which is what ES256 wants.
  const signature = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)))
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${keys.public_key}`
}

// ---------------------------------------------------------------- sending

/** Sends one message to one device. A 404 or 410 means the device is gone for good. */
export async function sendPush(device: PushDevice, message: PushMessage, keys: VapidKeys, options: SendOptions = {}): Promise<SendResult> {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), device)
  const res = await (options.fetchFn ?? fetch)(device.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(device.endpoint, keys, options.subject ?? 'https://fullfilio.com'),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttl ?? 6 * 3600),
      Urgency: options.urgency ?? 'high',
    },
    body,
  })
  if (res.ok) return { ok: true, status: res.status }
  const text = (await res.text().catch(() => '')).slice(0, 300)
  return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, error: text || res.statusText || `HTTP ${res.status}` }
}
