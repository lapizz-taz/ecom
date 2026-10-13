// Courier merchant-panel lookups: the merchant's OWN logins to Steadfast,
// Pathao, RedX and Carrybee, used to read each courier's customer
// success / fraud-check page for a phone number. This is a second source for
// the delivery-success check, next to the platform's BD Courier connection.
//
// The couriers expose no official API for this, so we sign in to each merchant
// panel the same way the merchant's browser would and read the same numbers the
// merchant sees on the panel's own fraud page. Nothing here is logged, and the
// passwords never leave the server (they come from Vault via courier_panel_get).
//
// Ported from the Laravel package Fraud-Checker-BD-Courier (azmolla), adapted to
// fetch, with session reuse (one login per ~50 min) to avoid courier lockouts.
import { bdMobile, type CourierHistorySummary, type CourierLine } from './courier-history.ts'
import type { FraudCheckInput, FraudProvider, FraudProviderResult } from './types.ts'

type FetchFn = typeof fetch

export const COURIER_PANEL_PROVIDERS = ['steadfast', 'pathao', 'redx', 'carrybee'] as const
export type CourierPanelProviderId = (typeof COURIER_PANEL_PROVIDERS)[number]

export const COURIER_PANEL_LABELS: Record<CourierPanelProviderId, string> = {
  steadfast: 'Steadfast', pathao: 'Pathao', redx: 'RedX', carrybee: 'Carrybee',
}

/** The identifier field each courier logs in with (shown masked as the hint). */
export const COURIER_PANEL_LOGIN_FIELD: Record<CourierPanelProviderId, 'email' | 'phone' | 'user'> = {
  steadfast: 'email', pathao: 'email', redx: 'phone', carrybee: 'phone',
}

export type PanelLogin = { id?: string; email?: string; phone?: string; user?: string; password?: string }
/** One login or several per courier (several are rotated to spread the load, and tried in turn if one fails). */
export type CourierPanelCreds = Partial<Record<CourierPanelProviderId, PanelLogin | PanelLogin[]>>

/** A login has an identifier and a password. */
export function completeLogin(login: PanelLogin | undefined | null): login is PanelLogin {
  return !!login && !!String(login.password ?? '').trim() && !!String(login.email ?? login.phone ?? login.user ?? '').trim()
}

/** The complete logins saved for one courier, oldest first (a single saved login counts as one). */
export function panelAccounts(creds: CourierPanelCreds | null | undefined, provider: CourierPanelProviderId): PanelLogin[] {
  const v = creds?.[provider]
  return (Array.isArray(v) ? v : v ? [v] : []).filter(completeLogin)
}

// Round-robin position per courier, so each lookup starts on the next account.
const rotation = new Map<string, number>()

/**
 * Where the courier sign-ins actually run. The couriers' sites (behind
 * Cloudflare) refuse requests from Cloudflare Workers, so the Worker hands
 * lookups and login tests to the courier-relay function on Supabase, which
 * reads the logins from Vault itself. Unset (Supabase, tests): run here.
 */
export interface PanelRelay {
  lookup(phone: string): Promise<CourierHistorySummary>
  test(provider: CourierPanelProviderId, login: PanelLogin, samplePhone: string): Promise<{ ok: boolean; message: string }>
}
let relay: PanelRelay | null = null
export function setPanelRelay(r: PanelRelay | null): void {
  relay = r
}
const isStandIn = (f?: FetchFn) => !!f && f !== globalThis.fetch

/** One courier's answer. `ok:false` carries a reason; it never throws out. */
interface PanelStat {
  ok: boolean
  success: number
  cancel: number
  total: number
  success_ratio?: number | null
  /** The courier gives only its own rate and a volume band, not parcel counts (Steadfast's fraud page now). */
  rate_only?: boolean
  parcel_range?: string | null
  /** Fraud reports other merchants filed on the number, as the courier counts them. */
  reports?: number
  error?: string
}

// ---- session cache: tokens/cookies kept in memory only, never in KV ----------
interface Session { value: string; exp: number }
export interface SessionStore {
  get(key: string): Session | undefined
  set(key: string, value: string, ttlMs: number): void
  drop(key: string): void
}
const memory = new Map<string, Session>()
const defaultStore: SessionStore = {
  get(key) {
    const s = memory.get(key)
    if (s && s.exp > Date.now()) return s
    if (s) memory.delete(key)
    return undefined
  },
  set(key, value, ttlMs) { memory.set(key, { value, exp: Date.now() + ttlMs }) },
  drop(key) { memory.delete(key) },
}

/** A short, stable, non-reversible key for a login, so sessions don't cross merchants. */
async function sessionKey(provider: string, login: PanelLogin): Promise<string> {
  const id = String(login.email ?? login.phone ?? login.user ?? '') + '|' + String(login.password ?? '')
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
  return provider + ':' + Array.prototype.map.call(new Uint8Array(buf).slice(0, 8), (b: number) => b.toString(16).padStart(2, '0')).join('')
}

const text = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim())
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}
const ratio = (success: number, total: number): number | null => (total > 0 ? Math.round((success / total) * 10000) / 100 : null)
/** A percentage however it is written (92.5, "92.5%"); null when missing or out of range. */
const percent = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[%,\s]/g, ''))
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null
}
/** What a courier's error answer says, from whichever field it uses (message, error, errors, detail). */
export function answerDetail(body: unknown): string {
  const say = (v: unknown, depth = 0): string => {
    if (typeof v === 'string') return v
    if (depth > 2 || !v || typeof v !== 'object') return ''
    if (Array.isArray(v)) return v.map((x) => say(x, depth + 1)).filter(Boolean).join('; ')
    const o = v as Record<string, unknown>
    return say(o.message ?? Object.values(o)[0], depth + 1)
  }
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  return text(say(b.message) || say(b.error) || say(b.errors) || say(b.detail) || say(b.msg) || say(b.reason) || say(b.title)).slice(0, 160)
}

/**
 * What an error answer actually says, for the message shown in Super Admin: its message
 * field; else its short fields ("status: failed, code: E12"); else the page title or text.
 * Long digit runs (phone numbers, account numbers) are left out.
 */
export async function explainAnswer(res: Response): Promise<string> {
  return explainText(await res.text().catch(() => ''))
}
function explainText(raw: string): string {
  if (!raw.trim()) return 'empty answer'
  let said = ''
  try {
    const body = JSON.parse(raw) as unknown
    said = answerDetail(body)
    if (!said && body && typeof body === 'object' && !Array.isArray(body)) {
      const parts = Object.entries(body as Record<string, unknown>)
        .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 40)
        .slice(0, 4).map(([k, v]) => `${k}: ${v}`)
      said = parts.length ? parts.join(', ') : `fields: ${Object.keys(body).slice(0, 6).join(', ') || 'none'}`
    }
  } catch {
    said = /<title[^>]*>([^<]{1,80})/i.exec(raw)?.[1] ?? raw.replace(/<[^>]+>/g, ' ')
  }
  return said.replace(/\+?\d[\d\s-]{7,}\d/g, '…').replace(/\s+/g, ' ').trim().slice(0, 140)
}

/** Cookie jar: collects Set-Cookie across requests and rebuilds the Cookie header. */
class Jar {
  private jar = new Map<string, string>()
  absorb(res: Response): void {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''].filter(Boolean)
    for (const line of list) {
      const pair = line.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
  header(): string { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') }
}

async function timedFetch(fetchFn: FetchFn, url: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchFn(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// A whole browser identity: the couriers' panels sit behind firewalls that treat a cut-short one as a bot.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

export interface PanelDeps { fetchFn?: FetchFn; store?: SessionStore; timeoutMs?: number; /** Wait before one retry of a firewall check (tests: 0). */ retryPauseMs?: number }

// ------------------------------- Steadfast -----------------------------------
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(2).find((v) => v !== undefined)
const decodeHtml = (v: string) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

/**
 * The sign-in form on a page, whatever its shape: Steadfast has served a Laravel
 * form (email + hidden _token) and a newer "Merchant sign-in" page (email or phone,
 * CSRF token in a meta tag). Returns where to post and the fields to send.
 */
export function readLoginForm(html: string, pageUrl: string): { action: string; fields: Record<string, string>; idField: string; passwordField: string } | null {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0])
  const form = forms.find((f) => /type\s*=\s*["']?password/i.test(f))
  const meta = /<meta[^>]+name\s*=\s*["']csrf-token["'][^>]*>/i.exec(html)?.[0]
  const csrf = meta ? attr(meta, 'content') : undefined
  const loose = /<input\b[^>]*name\s*=\s*["']_token["'][^>]*>/i.exec(html)?.[0]
  const looseToken = loose ? attr(loose, 'value') : undefined
  if (!form && !csrf && !looseToken) return null
  const fields: Record<string, string> = {}
  let idField = '', passwordField = 'password'
  for (const input of form?.match(/<input\b[^>]*>/gi) ?? []) {
    const name = attr(input, 'name')
    if (!name) continue
    const type = (attr(input, 'type') ?? 'text').toLowerCase()
    if (type === 'hidden') fields[name] = decodeHtml(attr(input, 'value') ?? '')
    else if (type === 'password') passwordField = name
    else if (!idField && ['email', 'text', 'tel'].includes(type)) idField = name
  }
  if (!fields._token && (looseToken ?? csrf)) fields._token = decodeHtml((looseToken ?? csrf)!)
  const action = form ? attr(/<form\b[^>]*>/i.exec(form)![0], 'action') : undefined
  return { action: new URL(action ? decodeHtml(action) : '/login', pageUrl).toString(), fields, idField: idField || 'email', passwordField }
}

const isChallenge = (html: string) => /challenge-platform|cf-chl|Just a moment|Attention Required/i.test(html)

/** Why a page is not a sign-in form, in a few words, for the error shown to Super Admin. */
function describePage(status: number, html: string): string {
  if (isChallenge(html)) return 'its firewall asked for a browser check — try again in a minute'
  const title = /<title[^>]*>([^<]{0,80})/i.exec(html)?.[1]?.trim()
  return `no sign-in form on the page (HTTP ${status}${title ? `, "${title}"` : ''})`
}

/** A volume band as one short label: "100+", "51–100". */
function bandLabel(band: unknown, range: unknown): string | null {
  if (range && typeof range === 'object' && !Array.isArray(range)) {
    const r = range as Record<string, unknown>
    const lo = r.min ?? r.from ?? r.low, hi = r.max ?? r.to ?? r.high
    if (lo !== undefined && lo !== null && hi !== undefined && hi !== null) return `${lo}–${hi}`
    if (lo !== undefined && lo !== null) return `${lo}+`
  }
  if (Array.isArray(range) && range.length) return range.length > 1 && range[1] !== null && range[1] !== undefined ? `${range[0]}–${range[1]}` : `${range[0]}+`
  for (const v of [range, band]) {
    if (typeof v === 'string' || typeof v === 'number') {
      const label = String(v).trim().replace(/\s*-\s*/, '–')
      if (label) return label.slice(0, 20)
    }
  }
  return null
}
const reportCount = (v: unknown): number => {
  if (Array.isArray(v)) return v.length
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return o.count !== undefined || o.total !== undefined ? num(o.count ?? o.total) : Object.keys(o).length
  }
  return num(v)
}

/**
 * The fraud page's answer. Steadfast used to give delivered / cancelled counts; it now
 * gives its own rates and a volume band instead (delivery_ratio, cancellation_ratio,
 * volume_band / volume_range, fraud_reports). Counts are used when present; otherwise
 * the result is rate-only — no parcel counts are made up.
 */
export function parseSteadfast(body: unknown): PanelStat {
  const top = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const scopes = [top, top.data, top.result, top.summary].filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
  const pick = (...keys: string[]) => {
    for (const o of scopes) for (const k of keys) if (k in o) return o[k]
    return undefined
  }
  const reports = reportCount(pick('total_reports', 'fraud_reports', 'reports', 'frauds'))
  const delivered = pick('total_delivered', 'delivered', 'total_delivery', 'success')
  const cancelled = pick('total_cancelled', 'cancelled', 'total_cancel', 'cancel')
  if (delivered !== undefined || cancelled !== undefined) {
    const success = num(delivered), cancel = num(cancelled)
    const total = success + cancel
    return { ok: true, success, cancel, total, success_ratio: ratio(success, total), ...(reports ? { reports } : {}) }
  }
  const rawDelivery = pick('delivery_ratio', 'success_ratio', 'delivery_rate')
  const rawCancel = pick('cancellation_ratio', 'cancel_ratio', 'cancellation_rate')
  if (rawDelivery !== undefined || rawCancel !== undefined) {
    let rate = percent(rawDelivery), cancelRate = percent(rawCancel)
    // Written as fractions (0.92 / 0.08) rather than percentages.
    if (rate !== null && cancelRate !== null && rate <= 1 && cancelRate <= 1 && rate + cancelRate > 0 && Math.abs(rate + cancelRate - 1) <= 0.05) {
      rate = Math.round(rate * 10000) / 100
      cancelRate = Math.round(cancelRate * 10000) / 100
    }
    if (rate === null && cancelRate !== null) rate = Math.round((100 - cancelRate) * 100) / 100
    const band = bandLabel(pick('volume_band', 'parcel_band'), pick('volume_range', 'parcel_range'))
    // Steadfast writes "none" (or a 0 band) for a number it has never carried.
    const none = !rate && !cancelRate && (!band || /^(0|none)(\W|$)/i.test(band))
    if (none) return { ok: true, success: 0, cancel: 0, total: 0, success_ratio: null, ...(reports ? { reports } : {}) }
    return { ok: true, success: 0, cancel: 0, total: 0, success_ratio: rate, rate_only: true, parcel_range: band, ...(reports ? { reports } : {}) }
  }
  const keys = Object.keys(top).slice(0, 6).join(', ')
  const message = typeof top.message === 'string' ? `: ${top.message.slice(0, 120)}` : keys ? ` (fields: ${keys})` : ''
  return { ok: false, success: 0, cancel: 0, total: 0, error: `Steadfast's fraud page gave an unexpected answer${message}` }
}

async function steadfast(login: PanelLogin, phone: string, d: Required<PanelDeps>): Promise<PanelStat> {
  const email = text(login.email ?? login.phone), password = text(login.password)
  if (!email || !password) return { ok: false, success: 0, cancel: 0, total: 0, error: 'No Steadfast login saved' }
  const key = await sessionKey('steadfast', login)
  const base = 'https://steadfast.com.bd'
  const fail = (error: string): PanelStat => ({ ok: false, success: 0, cancel: 0, total: 0, error })
  // A signed-out session is redirected to the login page instead of answering JSON.
  const read = async (cookie: string): Promise<Response> =>
    timedFetch(d.fetchFn, `${base}/user/frauds/check/${phone}`, {
      redirect: 'manual', headers: { Cookie: cookie, Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA },
    }, d.timeoutMs)
  const answered = (res: Response) => res.ok && (res.headers.get('content-type') ?? '').includes('json')

  const cached = d.store.get(key)
  if (cached) {
    const res = await read(cached.value)
    if (answered(res)) return parseSteadfast(await res.json().catch(() => null))
    d.store.drop(key) // session expired; sign in again
  }

  const jar = new Jar()
  const loadLogin = async () => {
    const page = await timedFetch(d.fetchFn, `${base}/login`, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' } }, d.timeoutMs)
    jar.absorb(page)
    return { page, html: await page.text().catch(() => '') }
  }
  let { page, html } = await loadLogin()
  // Steadfast's firewall sometimes asks for a browser check; it often lets the next request through.
  if (isChallenge(html)) {
    await new Promise((r) => setTimeout(r, d.retryPauseMs))
    ;({ page, html } = await loadLogin())
  }
  const form = readLoginForm(html, page.url || `${base}/login`)
  if (!form) return fail(`Steadfast sign-in: ${describePage(page.status, html)}`)
  const body = new URLSearchParams({ ...form.fields, [form.idField]: email, [form.passwordField]: password })
  // Laravel also accepts the XSRF-TOKEN cookie as a header.
  const xsrf = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/.exec(jar.header())?.[1]
  const loginRes = await timedFetch(d.fetchFn, form.action, {
    method: 'POST', redirect: 'manual',
    headers: {
      Cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml', Origin: base, Referer: `${base}/login`,
      ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}),
    },
    body: body.toString(),
  }, d.timeoutMs)
  jar.absorb(loginRes)
  // A wrong login is sent back to the login page; a good one goes on to the panel.
  const back = loginRes.headers.get('location') ?? ''
  const toLogin = /\/login\/?$/.test(back ? new URL(back, base).pathname : '')
  if (loginRes.status === 419) return fail('Steadfast refused the sign-in (session expired) — try again')
  if (loginRes.status === 422 || toLogin) return fail('Steadfast rejected the email or password')
  if (!(loginRes.ok || (loginRes.status >= 300 && loginRes.status < 400))) return fail(`Steadfast sign-in answered HTTP ${loginRes.status}`)
  const cookie = jar.header()
  const res = await read(cookie)
  if (res.status >= 300 && res.status < 400) return fail('Steadfast rejected the email or password')
  if (!answered(res)) return fail(`Steadfast's fraud page answered HTTP ${res.status}${res.ok ? ' with a web page instead of data' : ''}`)
  const stat = parseSteadfast(await res.json().catch(() => null))
  if (stat.ok) d.store.set(key, cookie, 10 * 60_000)
  return stat
}

// -------------------------------- Pathao -------------------------------------
async function pathao(login: PanelLogin, phone: string, d: Required<PanelDeps>): Promise<PanelStat> {
  const username = text(login.email), password = text(login.password)
  if (!username || !password) return { ok: false, success: 0, cancel: 0, total: 0, error: 'No Pathao login saved' }
  const key = await sessionKey('pathao', login)
  const read = async (token: string): Promise<Response> =>
    timedFetch(d.fetchFn, 'https://merchant.pathao.com/api/v1/user/success', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': UA },
      body: JSON.stringify({ phone }),
    }, d.timeoutMs)

  let token = d.store.get(key)?.value
  if (!token) {
    const res = await timedFetch(d.fetchFn, 'https://merchant.pathao.com/api/v1/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ username, password }),
    }, d.timeoutMs)
    if (!res.ok) return { ok: false, success: 0, cancel: 0, total: 0, error: res.status === 422 || res.status === 401 ? 'Pathao rejected the email or password' : `Pathao login HTTP ${res.status}` }
    token = text((await res.json().catch(() => ({})) as Record<string, unknown>).access_token)
    if (!token) return { ok: false, success: 0, cancel: 0, total: 0, error: 'Pathao gave no access token' }
    d.store.set(key, token, 50 * 60_000)
  }
  let res = await read(token)
  if (res.status === 401) { d.store.drop(key); return pathao(login, phone, d) }
  if (!res.ok) {
    const why = await explainAnswer(res)
    return { ok: false, success: 0, cancel: 0, total: 0, error: `Pathao answered HTTP ${res.status}: ${why}` }
  }
  const c = ((await res.json().catch(() => ({})) as { data?: { customer?: Record<string, unknown> } }).data?.customer) ?? {}
  const success = num(c.successful_delivery), total = num(c.total_delivery), cancel = Math.max(0, total - success)
  return { ok: true, success, cancel, total, success_ratio: ratio(success, total) }
}

// --------------------------------- RedX --------------------------------------
async function redx(login: PanelLogin, phone: string, d: Required<PanelDeps>): Promise<PanelStat> {
  const loginPhone = bdMobile(login.phone ?? ''), password = text(login.password)
  if (!loginPhone || !password) return { ok: false, success: 0, cancel: 0, total: 0, error: 'No RedX login saved' }
  const key = await sessionKey('redx', login)
  // RedX's own web panel sends these; its API answers requests without them differently.
  const site = { Origin: 'https://redx.com.bd', Referer: 'https://redx.com.bd/', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
  const read = async (token: string, number = `88${phone}`): Promise<Response> =>
    timedFetch(d.fetchFn, `https://redx.com.bd/api/redx_se/admin/parcel/customer-success-return-rate?phoneNumber=${encodeURIComponent(number)}`, {
      headers: { ...site, Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    }, d.timeoutMs)

  let token = d.store.get(key)?.value
  if (!token) {
    const res = await timedFetch(d.fetchFn, 'https://api.redx.com.bd/v4/auth/login', {
      method: 'POST', headers: { ...site, 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
      body: JSON.stringify({ phone: `88${loginPhone}`, password }),
    }, d.timeoutMs)
    if (!res.ok) return { ok: false, success: 0, cancel: 0, total: 0, error: res.status === 401 || res.status === 422 ? 'RedX rejected the phone or password' : `RedX login HTTP ${res.status}` }
    token = text(((await res.json().catch(() => ({})) as { data?: { accessToken?: unknown } }).data ?? {}).accessToken)
    if (!token) return { ok: false, success: 0, cancel: 0, total: 0, error: 'RedX gave no access token' }
    d.store.set(key, token, 50 * 60_000)
  }
  let res = await read(token)
  if (res.status === 401) { d.store.drop(key); return redx(login, phone, d) }
  type Body = { isError?: unknown; data?: Record<string, unknown> | null }
  const take = async (r: Response) => {
    const raw = await r.text().catch(() => '')
    let body: Body | null = null
    try { body = JSON.parse(raw) as Body } catch { body = null }
    return { raw, body }
  }
  // RedX can send HTTP 400 with a body that says it is not an error ({ code: 200, isError: false, … }):
  // that body is the answer. A real refusal is tried again with the other ways of writing the number.
  const answered = (r: Response, body: Body | null) => r.ok || body?.isError === false
  let got = await take(res)
  for (const other of [phone, `+88${phone}`]) {
    if (answered(res, got.body) || res.status !== 400) break
    res = await read(token, other)
    got = await take(res)
  }
  if (res.status === 429) return { ok: false, success: 0, cancel: 0, total: 0, error: 'RedX rate limit — try again in a minute' }
  if (!answered(res, got.body)) return { ok: false, success: 0, cancel: 0, total: 0, error: `RedX answered HTTP ${res.status}: ${explainText(got.raw)}` }
  const data = got.body?.data ?? {}
  const success = num(data.deliveredParcels), total = num(data.totalParcels), cancel = Math.max(0, total - success)
  return { ok: true, success, cancel, total, success_ratio: ratio(success, total) }
}

// -------------------------------- Carrybee -----------------------------------
const NO_HISTORY: PanelStat = { ok: true, success: 0, cancel: 0, total: 0, success_ratio: null }

/**
 * Carrybee's record of a number. Its merchant panel reads /customers/+8801XXXXXXXXX
 * (404 = it has never carried the number); the older /fraud-check/01XXXXXXXXX address is
 * tried if that fails another way. Returns null when the session is no longer accepted.
 */
async function carrybeeLookup(auth: string, phone: string, d: Required<PanelDeps>): Promise<PanelStat | null> {
  const { token, business } = JSON.parse(auth) as { token: string; business: string }
  const base = `https://api-merchant.carrybee.com/api/v2/businesses/${encodeURIComponent(business)}`
  const get = (path: string) => timedFetch(d.fetchFn, `${base}/${path}`, {
    headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      Origin: 'https://merchant.carrybee.com', Referer: 'https://merchant.carrybee.com/', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9',
    },
  }, d.timeoutMs)
  const res = await get(`customers/${encodeURIComponent(`+88${phone}`)}`)
  if (res.status === 401 || res.status === 403) { await res.body?.cancel().catch(() => undefined); return null }
  if (res.ok) return parseCarrybee(await res.json().catch(() => null))
  const why = await explainAnswer(res)
  // A missing route is not "no history": only a 404 about the customer counts as that.
  if (res.status === 404 && !/route|cannot get|endpoint/i.test(why)) return NO_HISTORY
  const old = await get(`fraud-check/${encodeURIComponent(phone)}`)
  if (old.ok) return parseCarrybee(await old.json().catch(() => null))
  await old.body?.cancel().catch(() => undefined)
  if (/no (order|data|record|parcel|customer)|not found/i.test(why)) return NO_HISTORY
  return { ok: false, success: 0, cancel: 0, total: 0, error: `Carrybee answered HTTP ${res.status}: ${why}` }
}

async function carrybee(login: PanelLogin, phone: string, d: Required<PanelDeps>): Promise<PanelStat> {
  const loginPhone = text(login.phone), password = text(login.password)
  if (!loginPhone || !password) return { ok: false, success: 0, cancel: 0, total: 0, error: 'No Carrybee login saved' }
  const key = await sessionKey('carrybee', login)
  // Carrybee's tokens look like "1234|abc…", so the session is kept as JSON, not joined with "|".
  const cached = d.store.get(key)?.value
  if (cached) {
    const stat = await carrybeeLookup(cached, phone, d)
    if (stat) return stat
    d.store.drop(key) // session expired; sign in again
  }
  const jar = new Jar()
  const headers = { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://merchant.carrybee.com/login' }
  const csrfRes = await timedFetch(d.fetchFn, 'https://merchant.carrybee.com/api/auth/csrf', { headers: { ...headers } }, d.timeoutMs)
  jar.absorb(csrfRes)
  const csrfToken = text((await csrfRes.json().catch(() => ({})) as Record<string, unknown>).csrfToken)
  if (!csrfToken) return { ok: false, success: 0, cancel: 0, total: 0, error: 'Carrybee login page did not load' }
  const phonePrefixed = loginPhone.startsWith('+88') ? loginPhone : '+88' + loginPhone.replace(/^(\+?88)?/, '')
  const form = new URLSearchParams({ phone: phonePrefixed, password, csrfToken, callbackUrl: 'https://merchant.carrybee.com/login' })
  const loginRes = await timedFetch(d.fetchFn, 'https://merchant.carrybee.com/api/auth/callback/login?', {
    method: 'POST', redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() }, body: form.toString(),
  }, d.timeoutMs)
  jar.absorb(loginRes)
  const sessionRes = await timedFetch(d.fetchFn, 'https://merchant.carrybee.com/api/auth/session', { headers: { ...headers, Cookie: jar.header() } }, d.timeoutMs)
  const session = (await sessionRes.json().catch(() => ({}))) as {
    accessToken?: unknown; access_token?: unknown
    user?: { accessToken?: unknown; selectedBusinessId?: unknown; businessId?: unknown; business_id?: unknown; merchantBusinesses?: { businessId?: unknown }[] }
  }
  const accessToken = text(session.accessToken ?? session.access_token ?? session.user?.accessToken)
  const businessId = text(session.user?.selectedBusinessId ?? session.user?.businessId ?? session.user?.business_id ?? session.user?.merchantBusinesses?.[0]?.businessId)
  if (!accessToken) return { ok: false, success: 0, cancel: 0, total: 0, error: 'Carrybee rejected the phone or password' }
  if (!businessId) return { ok: false, success: 0, cancel: 0, total: 0, error: 'Carrybee signed in, but the account has no business selected — open the Carrybee panel once and pick the business' }
  const auth = JSON.stringify({ token: accessToken, business: businessId })
  const stat = await carrybeeLookup(auth, phone, d)
  if (!stat) return { ok: false, success: 0, cancel: 0, total: 0, error: 'Carrybee signed in, but refused the new session for the lookup (HTTP 401)' }
  d.store.set(key, auth, 50 * 60_000) // the sign-in itself worked
  return stat
}
function parseCarrybee(body: unknown): PanelStat {
  const top = (body ?? {}) as { data?: Record<string, unknown> | null; error?: unknown }
  // A 200 can still carry an error (as the reference client checks).
  if (top.error && top.error !== false) return { ok: false, success: 0, cancel: 0, total: 0, error: `Carrybee: ${answerDetail(top) || 'the lookup failed'}` }
  if (!top.data || typeof top.data !== 'object') {
    const keys = Object.keys(top).slice(0, 6).join(', ')
    return { ok: false, success: 0, cancel: 0, total: 0, error: `Carrybee gave an unexpected answer${keys ? ` (fields: ${keys})` : ''}` }
  }
  const data = top.data
  const total = num(data.total_order), cancel = Math.min(num(data.cancelled_order), total), success = Math.max(0, total - cancel)
  let r = typeof data.success_rate === 'number' ? data.success_rate : Number(data.success_rate)
  if (!Number.isFinite(r) || (total > 0 && !data.success_rate)) r = ratio(success, total) ?? 0
  const reports = num(data.fraud_count)
  return { ok: true, success, cancel, total, success_ratio: total > 0 ? Math.round(r * 100) / 100 : null, ...(reports ? { reports } : {}) }
}

const RUNNERS: Record<CourierPanelProviderId, (login: PanelLogin, phone: string, d: Required<PanelDeps>) => Promise<PanelStat>> = {
  steadfast, pathao, redx, carrybee,
}

function deps(d: PanelDeps): Required<PanelDeps> {
  return { fetchFn: d.fetchFn ?? fetch, store: d.store ?? defaultStore, timeoutMs: d.timeoutMs ?? 12_000, retryPauseMs: d.retryPauseMs ?? 1_500 }
}

/** Check a login works (and that the fraud page answers), without saving anything. */
export async function testPanelLogin(provider: CourierPanelProviderId, login: PanelLogin, samplePhone: string, d: PanelDeps = {}): Promise<{ ok: boolean; message: string }> {
  const phone = bdMobile(samplePhone)
  if (!phone) return { ok: false, message: 'Enter a Bangladeshi mobile number to test with' }
  if (relay && !isStandIn(d.fetchFn)) {
    // The relay being unreachable or refusing us is a failed test with its reason, never a crash.
    return relay.test(provider, login, phone).catch((error) => ({ ok: false, message: redact(String((error as Error).message ?? error), login) }))
  }
  const dd = deps(d)
  dd.store.drop(await sessionKey(provider, login)) // always a fresh sign-in for a test
  try {
    const r = await RUNNERS[provider](login, phone, dd)
    const label = COURIER_PANEL_LABELS[provider]
    if (!r.ok) return { ok: false, message: redact(r.error ?? `${label} did not answer`, login) }
    const reports = r.reports ? `, ${r.reports} fraud report${r.reports === 1 ? '' : 's'}` : ''
    if (r.rate_only) {
      return { ok: true, message: `${label}: signed in — ${r.success_ratio}% delivered${r.parcel_range ? `, volume ${r.parcel_range}` : ''}${reports} for ${phone} (rate only, no parcel counts)` }
    }
    if (!r.total) {
      return { ok: true, message: `${label}: signed in — no parcels on record for ${phone}${reports}. To be sure the lookup reads real data, test once with a number that has ${label} parcels.` }
    }
    return { ok: true, message: `${label}: signed in — ${r.success} of ${r.total} parcel${r.total === 1 ? '' : 's'} delivered for ${phone}${reports}` }
  } catch (error) {
    return { ok: false, message: redact(String((error as Error).message ?? error), login) }
  }
}

function redact(message: string, login: PanelLogin): string {
  let out = message
  for (const v of [login.password, login.email, login.phone, login.user]) {
    if (v && v.length > 2) out = out.split(v).join('[hidden]')
  }
  return out.slice(0, 200)
}

/**
 * Fraud provider: runs every connected courier panel in parallel and merges
 * them into one CourierHistorySummary. One courier failing never fails the
 * whole check — it shows as a notice on that courier's line.
 */
export class CourierPanelProvider implements FraudProvider {
  readonly name = 'courier_panel'
  private readonly d: Required<PanelDeps>
  /** A stand-in fetch was handed in (tests): always run here, never through the relay. */
  private readonly injected: boolean

  constructor(private readonly creds: CourierPanelCreds, deps_: PanelDeps = {}) {
    this.d = deps(deps_)
    this.injected = isStandIn(deps_.fetchFn)
  }

  get connected(): CourierPanelProviderId[] {
    return COURIER_PANEL_PROVIDERS.filter((p) => panelAccounts(this.creds, p).length > 0)
  }

  /**
   * One courier, across its accounts: start on the next account in turn (so
   * the load is spread), and if that account is refused, limited or fails,
   * try the others before giving up.
   */
  private async runCourier(id: CourierPanelProviderId, mobile: string): Promise<PanelStat> {
    const accounts = panelAccounts(this.creds, id)
    const start = (rotation.get(id) ?? 0) % accounts.length
    rotation.set(id, start + 1)
    const errors: string[] = []
    for (let i = 0; i < accounts.length; i++) {
      const login = accounts[(start + i) % accounts.length]
      try {
        const r = await RUNNERS[id](login, mobile, this.d)
        if (r.ok) return r
        errors.push(r.error ?? 'failed')
      } catch (error) {
        errors.push(redact(String((error as Error).message ?? error), login))
      }
    }
    const error = accounts.length > 1 ? `All ${accounts.length} ${COURIER_PANEL_LABELS[id]} accounts failed: ${errors[errors.length - 1]}` : errors[0]
    return { ok: false, success: 0, cancel: 0, total: 0, error }
  }

  async lookup(phone: string): Promise<CourierHistorySummary> {
    const mobile = bdMobile(phone)
    if (!mobile) throw new Error('Not a Bangladeshi mobile number')
    const ids = this.connected
    if (!ids.length) throw new Error('No courier panel logins are connected')
    if (relay && !this.injected) return relay.lookup(mobile)
    const results = await Promise.all(ids.map(async (id) => [id, await this.runCourier(id, mobile)] as const))

    const couriers: CourierLine[] = results.map(([id, r]) => ({
      courier: id,
      name: COURIER_PANEL_LABELS[id],
      orders: r.total,
      cancelled: Math.min(r.cancel, r.total),
      delivered: r.ok ? Math.max(0, r.total - Math.min(r.cancel, r.total)) : 0,
      success_ratio: r.ok ? r.success_ratio ?? null : null,
      notice: r.ok ? null : r.error ?? 'Could not check',
      source: 'sign_in',
      ...(r.ok && r.rate_only ? { rate_only: true, parcel_range: r.parcel_range ?? null } : {}),
      ...(r.ok && r.reports ? { fraud_reports: r.reports } : {}),
    }))
    const good = results.filter(([, r]) => r.ok)
    const total = good.reduce((s, [, r]) => s + r.total, 0)
    const cancelled = good.reduce((s, [, r]) => s + Math.min(r.cancel, r.total), 0)
    const delivered = total - cancelled
    const anyOk = good.length > 0
    if (!anyOk) throw new Error(results.map(([id, r]) => `${COURIER_PANEL_LABELS[id]}: ${r.error}`).join('; '))
    // A courier that reports only a rate and a band ("100+") still proves that much history.
    const rateOnly = good.filter(([, r]) => r.rate_only && r.success_ratio !== null && r.success_ratio !== undefined)
    const floor = total + rateOnly.reduce((s, [, r]) => s + (Number(/(\d+)/.exec(r.parcel_range ?? '')?.[1]) || 0), 0)
    // With no parcel counts at all, the couriers' own rates are the only evidence: use their average.
    const ownRate = total === 0 && rateOnly.length
      ? Math.round((rateOnly.reduce((s, [, r]) => s + (r.success_ratio as number), 0) / rateOnly.length) * 100) / 100
      : null
    return {
      couriers: couriers.sort((a, b) => b.orders - a.orders),
      total, delivered, cancelled,
      success_ratio: ownRate ?? ratio(delivered, total),
      ratio_source: ownRate !== null ? 'provider' : 'counts',
      name_on_record: null,
      parcel_floor: floor,
    }
  }

  async checkCustomer(input: FraudCheckInput): Promise<FraudProviderResult> {
    try {
      const summary = await this.lookup(input.phone)
      return {
        provider: this.name,
        ok: true,
        counts: { total: summary.total, delivered: summary.delivered, returned: summary.cancelled },
        courierScore: summary.ratio_source === 'provider' && summary.success_ratio !== null ? summary.success_ratio : undefined,
        parcelFloor: summary.parcel_floor,
        raw: summary,
      }
    } catch (error) {
      return { provider: this.name, ok: false, counts: {}, error: (error as Error).message }
    }
  }
}
