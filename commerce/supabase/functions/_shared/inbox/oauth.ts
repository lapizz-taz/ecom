// "Continue with Facebook" for the messaging inbox, on Fullfilio's own Meta app.
//
// A store owner is sent to Meta's login dialog (Facebook Login for Business,
// with the configuration Super Admin saved), approves, and comes back to
// /admin/inbox/meta-callback with a code. The inbox function swaps the code for
// a token, lists the Pages (with their Instagram accounts) or WhatsApp numbers
// the owner granted, and connects the ones they pick.
//
// The state sent through Meta is signed with the app secret and names the store
// and the person who started, so a code can only be used by them, for a while.
import { env } from '../env.ts'
import { MetaApiError } from '../meta/graph.ts'
import { InboxGraph } from './meta.ts'

type FetchFn = typeof fetch

/** Platform credentials for the shared Meta app (Super Admin → Other Integrations). */
export const META_INBOX_APP_KEY = 'meta.inbox_app'
export interface MetaInboxApp {
  app_id?: string
  app_secret?: string
  /** Facebook Login for Business configuration: Pages and Instagram. */
  login_config_id?: string
  /** WhatsApp Embedded Signup configuration. */
  whatsapp_config_id?: string
  /** What Meta must send back when the webhook address is verified. */
  verify_token?: string
}

export type OAuthKind = 'PAGES' | 'WHATSAPP'
export interface OAuthState { m: string; u: string; k: OAuthKind; exp: number; n: string }

const graphVersion = () => env('META_GRAPH_VERSION') ?? 'v23.0'
const graphRoot = () => `${(env('META_GRAPH_URL') ?? 'https://graph.facebook.com').replace(/\/+$/, '')}/${graphVersion()}`

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))))
}

/** A state good for 15 minutes, for this store and this person only. */
export async function signState(secret: string, s: Omit<OAuthState, 'exp' | 'n'>, now = Date.now()): Promise<string> {
  const body: OAuthState = { ...s, exp: Math.floor(now / 1000) + 15 * 60, n: b64url(crypto.getRandomValues(new Uint8Array(9))) }
  const payload = b64url(new TextEncoder().encode(JSON.stringify(body)))
  return `${payload}.${await hmac(secret, payload)}`
}

/** The state Meta sent back, if it is genuine and still fresh; otherwise null. */
export async function readState(secret: string, state: string, now = Date.now()): Promise<OAuthState | null> {
  const [payload, sig] = state.split('.')
  if (!payload || !sig || state.length > 2000) return null
  const expected = await hmac(secret, payload)
  if (expected.length !== sig.length) return null
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  if (diff !== 0) return null
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as OAuthState
    if (typeof s.exp !== 'number' || s.exp * 1000 < now) return null
    if (s.k !== 'PAGES' && s.k !== 'WHATSAPP') return null
    return s
  } catch {
    return null
  }
}

/** Meta's login dialog for this kind of connection. */
export function loginUrl(app: MetaInboxApp, kind: OAuthKind, redirectUri: string, state: string): string {
  const configId = kind === 'WHATSAPP' ? app.whatsapp_config_id : app.login_config_id
  const u = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`)
  u.searchParams.set('client_id', app.app_id ?? '')
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('state', state)
  u.searchParams.set('config_id', configId ?? '')
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('override_default_response_type', 'true')
  if (kind === 'WHATSAPP') u.searchParams.set('extras', JSON.stringify({ setup: {}, featureType: '', sessionInfoVersion: '3' }))
  return u.toString()
}

async function getJson<T>(url: URL, fetchFn: FetchFn): Promise<T> {
  const response = await fetchFn(url.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  const err = body.error as { message?: string; code?: number; error_subcode?: number } | undefined
  if (!response.ok || err) throw new MetaApiError(err?.message ?? `HTTP ${response.status}`, err?.code, err?.error_subcode, response.status)
  return body as T
}

/**
 * The code from the login dialog → an access token. For Pages it is then made
 * long-lived, so the Page tokens taken from it never expire. WhatsApp's
 * Embedded Signup already returns a lasting business token.
 */
export async function exchangeCode(app: MetaInboxApp, code: string, redirectUri: string, longLived: boolean, fetchFn: FetchFn = fetch): Promise<string> {
  const u = new URL(`${graphRoot()}/oauth/access_token`)
  u.searchParams.set('client_id', app.app_id ?? '')
  u.searchParams.set('client_secret', app.app_secret ?? '')
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('code', code)
  const short = await getJson<{ access_token?: string }>(u, fetchFn)
  if (!short.access_token) throw new MetaApiError('Meta did not return an access token')
  if (!longLived) return short.access_token
  const l = new URL(`${graphRoot()}/oauth/access_token`)
  l.searchParams.set('grant_type', 'fb_exchange_token')
  l.searchParams.set('client_id', app.app_id ?? '')
  l.searchParams.set('client_secret', app.app_secret ?? '')
  l.searchParams.set('fb_exchange_token', short.access_token)
  const long = await getJson<{ access_token?: string }>(l, fetchFn)
  return long.access_token ?? short.access_token
}

export interface GrantedPage {
  id: string
  name: string
  picture: string | null
  token: string
  instagram: { id: string; username: string | null; picture: string | null } | null
}

/** Pages the person granted, with each Page's token and linked Instagram account. */
export async function grantedPages(userToken: string, appSecret: string, fetchFn: FetchFn = fetch): Promise<GrantedPage[]> {
  const g = new InboxGraph(userToken, appSecret, fetchFn)
  type Row = { id: string; name: string; access_token?: string; picture?: { data?: { url?: string } }; instagram_business_account?: { id: string; username?: string; profile_picture_url?: string } }
  const pages: GrantedPage[] = []
  let after: string | undefined
  for (let i = 0; i < 10; i++) {
    const r = await g.get<{ data?: Row[]; paging?: { cursors?: { after?: string }; next?: string } }>('me/accounts', {
      fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}', limit: '100', ...(after ? { after } : {}),
    })
    for (const p of r.data ?? []) {
      if (!p.access_token) continue
      const ig = p.instagram_business_account
      pages.push({
        id: p.id, name: p.name, picture: p.picture?.data?.url ?? null, token: p.access_token,
        instagram: ig?.id ? { id: ig.id, username: ig.username ?? null, picture: ig.profile_picture_url ?? null } : null,
      })
    }
    after = r.paging?.next ? r.paging.cursors?.after : undefined
    if (!after) break
  }
  return pages
}

export interface GrantedNumber { id: string; waba_id: string; display_phone: string | null; name: string | null }

/** WhatsApp numbers in the WhatsApp Business Accounts shared during Embedded Signup. */
export async function grantedNumbers(app: MetaInboxApp, businessToken: string, fetchFn: FetchFn = fetch): Promise<GrantedNumber[]> {
  // Which accounts were shared: the token's granular scopes (asked with the app token).
  const appToken = new InboxGraph(`${app.app_id}|${app.app_secret}`, '', fetchFn)
  const debug = await appToken.get<{ data?: { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> } }>('debug_token', { input_token: businessToken })
  const wabas = new Set<string>()
  for (const s of debug.data?.granular_scopes ?? []) {
    if (s.scope === 'whatsapp_business_management' || s.scope === 'whatsapp_business_messaging') for (const id of s.target_ids ?? []) wabas.add(id)
  }
  const g = new InboxGraph(businessToken, app.app_secret ?? '', fetchFn)
  const numbers: GrantedNumber[] = []
  for (const waba of wabas) {
    const r = await g.get<{ data?: Array<{ id: string; display_phone_number?: string; verified_name?: string }> }>(`${waba}/phone_numbers`, {
      fields: 'id,display_phone_number,verified_name',
    })
    for (const n of r.data ?? []) numbers.push({ id: n.id, waba_id: waba, display_phone: n.display_phone_number ?? null, name: n.verified_name ?? null })
  }
  return numbers
}

/** Page events this app needs: messages, echoes, receipts, postbacks and (optionally) comments. */
export const pageFields = (comments: boolean) =>
  ['messages', 'message_echoes', 'message_reads', 'message_deliveries', 'messaging_postbacks', ...(comments ? ['feed'] : [])].join(',')
