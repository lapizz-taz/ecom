// VoiceDrive PBX helpers shared by the voicedrive edge function and its tests.

export interface IceServer { urls: string | string[]; username?: string; credential?: string }

export interface VoiceDriveSettings {
  sip_domain?: string | null
  wss_url?: string | null
  stun_urls?: string[]
  turn_urls?: string[]
  turn_ttl_seconds?: number
}

const enc = new TextEncoder()

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** A random password for one softphone session (never stored, only its digest). */
export function randomPassword(bytes = 24): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))))
}

/** Compares two strings in time that doesn't depend on where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

/**
 * Time-limited TURN credentials in the coturn "REST API" format
 * (use-auth-secret): username = "<unix expiry>:<user>", password =
 * base64(HMAC-SHA1(secret, username)). coturn checks both without a database.
 */
export async function turnCredentials(secret: string, user: string, ttlSeconds: number, nowMs = Date.now()): Promise<{ username: string; credential: string; expiresAt: number }> {
  const expiresAt = Math.floor(nowMs / 1000) + Math.max(60, Math.floor(ttlSeconds))
  const username = `${expiresAt}:${user}`
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const credential = toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(username))))
  return { username, credential, expiresAt }
}

/** STUN servers from settings plus, when a TURN secret is set, TURN with fresh credentials. */
export async function iceServers(settings: VoiceDriveSettings, turnSecret: string | null, user: string, nowMs = Date.now()): Promise<IceServer[]> {
  const servers: IceServer[] = []
  const stun = (settings.stun_urls ?? []).filter((u) => /^stuns?:/.test(u))
  if (stun.length) servers.push({ urls: stun })
  const turn = (settings.turn_urls ?? []).filter((u) => /^turns?:/.test(u))
  if (turn.length && turnSecret) {
    const c = await turnCredentials(turnSecret, user, settings.turn_ttl_seconds ?? 3600, nowMs)
    servers.push({ urls: turn, username: c.username, credential: c.credential })
  }
  return servers
}

