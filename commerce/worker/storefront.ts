// Store pages, sitemap.xml and robots.txt, answered by the Worker for each request (the
// Fullfilio website's own pages and files: worker/site.ts).
//
// Every page used to be the same static index.html ("<title>Store</title>" and a generic
// description): the browser drew the built-in theme until the store's settings arrived, and
// search engines saw no store at all. Now, on a store's address, the Worker asks the database
// which store it is and what this page is (storefront_resolve, storefront_page) and puts both
// in the page: the store's settings, read by the app before its first paint, and the page's
// title, description, canonical address, robots rules, sharing tags and structured data. Old
// product / collection addresses and secondary domains answer 301. If the database does not
// answer in time, the plain page is served and the app loads the store itself, with its own
// loading and error states: never a stand-in store.
import { database, type DbEnv, INTERNAL_ORIGIN, usesCloudflareDb } from './db/gateway.ts'
import { isCanonicalHost, pageHead, prerendered, siteLlms, siteOrigin, siteRedirect, siteRobots, siteSitemap, withPage } from './site.ts'

export interface StorefrontEnv extends DbEnv {
  ASSETS: Fetcher
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
}

export interface Site { kind: 'store' | 'platform' | 'missing'; merchant_id?: string | null; name?: string; slug?: string | null; redirect_to?: string | null }

export interface PageSeo {
  status: number
  redirect?: string
  path?: string
  type?: string
  lang?: string
  title?: string | null
  description?: string | null
  canonical?: string | null
  robots?: string | null
  og?: Record<string, string>
  twitter?: Record<string, string>
  jsonld?: unknown[]
}

/** Admin, sign-up and Super Admin pages: never indexed, on any address. */
const PRIVATE = /^\/(admin|super-admin|start)(\/|$)/
/** Store pages that are personal or part of buying: crawlers are asked to stay out. */
const STORE_PRIVATE = ['/admin', '/cart', '/checkout', '/order-success', '/account', '/login', '/register', '/forgot-password', '/reset-password']
const FILE = /\.[a-z0-9]{1,8}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A page of the app (not a file, not the API). */
export function isPageRequest(req: Request, url: URL): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && (!FILE.test(url.pathname) || url.pathname.endsWith('.html'))
}

/** The platform's own names (fullfilio.com, www.…, the workers.dev preview): the website and admin. */
export function isPlatformHost(host: string, env: Pick<StorefrontEnv, 'PLATFORM_URL'>): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '')
  let platform = ''
  try { platform = env.PLATFORM_URL ? new URL(env.PLATFORM_URL).hostname.toLowerCase() : '' } catch { platform = '' }
  return h === platform || h === `www.${platform}` || h === `app.${platform}` || h.endsWith('.workers.dev') || h === 'localhost' || h === '127.0.0.1'
}

/** Calls a database function as a visitor (the publishable key), for one store when given. */
export async function rpc<T>(env: StorefrontEnv, fn: string, args: Record<string, unknown>, merchant?: string | null, timeoutMs = 2500): Promise<T> {
  const key = env.SUPABASE_ANON_KEY ?? ''
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (key) {
    headers.apikey = key
    // Older (JWT) keys also go as the bearer token; new publishable keys only as apikey.
    if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`
  }
  if (merchant) headers['x-merchant-id'] = merchant
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(args), signal: ctl.signal }
    const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '')
    if (!usesCloudflareDb(env) && !base) throw new Error('SUPABASE_URL is not set')
    const res = usesCloudflareDb(env)
      ? await database(new Request(`${INTERNAL_ORIGIN}/rest/v1/rpc/${fn}`, init), env)
      : await fetch(`${base}/rest/v1/rpc/${fn}`, init)
    if (!res.ok) throw new Error(`${fn} answered ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

// What each address is, kept a minute per Worker instance (domains rarely move; a page load
// should not wait for the same answer twice).
const sites = new Map<string, { at: number; site: Site }>()
const SITE_TTL = 60_000

export function forgetSites() {
  sites.clear()
}

async function siteFor(env: StorefrontEnv, host: string): Promise<Site> {
  const hit = sites.get(host)
  if (hit && Date.now() - hit.at < SITE_TTL) return hit.site
  const found = await rpc<Site | null>(env, 'storefront_resolve', { p_host: host })
  const site: Site = found && found.kind ? found : { kind: 'platform' }
  if (site.kind === 'store' && !(site.merchant_id && UUID.test(site.merchant_id))) site.kind = 'missing'
  if (sites.size > 500) sites.clear()
  sites.set(host, { at: Date.now(), site })
  return site
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** JSON safe inside <script>: no "</script>", no line separators. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)
const absolute = (link: string | null | undefined, origin: string) => (link ? (/^https?:\/\//.test(link) ? link : `${origin}${link.startsWith('/') ? '' : '/'}${link}`) : null)

/**
 * The page with this store's head: title, description, robots, canonical, sharing tags and
 * structured data (each marked data-ff-seo, so the app can replace them as the visitor moves
 * around), and the store's settings for the app's first paint (#ff-boot, read as data).
 */
export function injectHead(html: string, opts: { host: string; origin: string; site: Site; config?: unknown; seo?: PageSeo | null }): string {
  const { seo } = opts
  const tags: string[] = []
  let out = html
  if (seo?.title) out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${attr(seo.title)}</title>`)
  if (seo?.lang) out = out.replace(/<html([^>]*?)\blang="[^"]*"/i, `<html$1lang="${attr(seo.lang)}"`)
  if (seo) {
    // The shell's generic description is not this store's.
    out = out.replace(/\s*<meta\s+name="description"[^>]*>/i, '')
    if (seo.description) tags.push(`<meta name="description" content="${attr(seo.description)}" data-ff-seo>`)
    if (seo.robots) tags.push(`<meta name="robots" content="${attr(seo.robots)}" data-ff-seo>`)
    const canonical = absolute(seo.canonical, opts.origin)
    if (canonical && seo.status === 200) tags.push(`<link rel="canonical" href="${attr(canonical)}" data-ff-seo>`)
    for (const [k, v] of Object.entries(seo.og ?? {})) {
      const value = k === 'image' || k === 'url' ? absolute(v, opts.origin) : v
      if (value) tags.push(`<meta property="og:${attr(k)}" content="${attr(value)}" data-ff-seo>`)
    }
    for (const [k, v] of Object.entries(seo.twitter ?? {})) {
      if (v) tags.push(`<meta name="twitter:${attr(k)}" content="${attr(v)}" data-ff-seo>`)
    }
    for (const ld of seo.jsonld ?? []) {
      if (ld) tags.push(`<script type="application/ld+json" data-ff-seo>${scriptJson(ld)}</script>`)
    }
  }
  // The store's own browser-tab icon (theme builder → Header → Favicon) instead of the app's.
  const favicon = storeFavicon(opts.config)
  if (favicon) {
    out = out.replace(/\s*<link\s+rel="(?:icon|apple-touch-icon)"[^>]*>/gi, '')
    tags.push(`<link rel="icon" href="${attr(favicon)}">`, `<link rel="apple-touch-icon" href="${attr(favicon)}">`)
  }
  tags.push(`<script type="application/json" id="ff-boot">${scriptJson({ host: opts.host, site: opts.site, config: opts.config ?? null, seo: seo ?? null })}</script>`)
  return out.replace(/<\/head>/i, `    ${tags.join('\n    ')}\n  </head>`)
}

/** The favicon in a store's settings (storefront.theme.favicon_url): a file of ours or an https link, else none. */
function storeFavicon(config: unknown): string | null {
  const theme = (config as { storefront?: { theme?: { favicon_url?: unknown } } } | null)?.storefront?.theme
  const url = typeof theme?.favicon_url === 'string' ? theme.favicon_url.trim() : ''
  return /^(https:\/\/[^\s"'<>]+|\/files\/[^\s"'<>]+)$/.test(url) ? url : null
}

// --- first-party ad cookies (the "cookie keeper") ------------------------------------------------
// The store's own server sets and refreshes Meta's _fbp / _fbc cookies and the store's visitor id on
// every page, so they live their full time (browsers cut cookies written by scripts to 7 days or
// less) and a click from an ad (fbclid) is kept even when the pixel is blocked. Only for stores that
// turned Meta tracking on; the values are the formats Meta's own pixel writes.

const FBP = /^fb\.\d\.\d{10,13}\.\d{1,25}$/
const FBC = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_.-]{4,550}$/
const FBCLID = /^[A-Za-z0-9_.-]{4,500}$/
const VID = /^[A-Za-z0-9_-]{8,64}$/
const AD_COOKIE_DAYS = 90
const adOn = new Map<string, { at: number; meta: boolean }>()

/** Whether the store tracks with a Meta pixel (cached a minute per store). */
async function metaTracking(env: StorefrontEnv, merchant: string): Promise<boolean> {
  const hit = adOn.get(merchant)
  if (hit && Date.now() - hit.at < 60_000) return hit.meta
  let meta = false
  try {
    const c = await rpc<{ enabled?: boolean; meta_pixel?: string | null } | null>(env, 'storefront_ad_tracking', {}, merchant, 1500)
    meta = Boolean(c?.enabled && c.meta_pixel)
  } catch {
    return hit?.meta ?? false
  }
  adOn.set(merchant, { at: Date.now(), meta })
  return meta
}

function cookieJar(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!(k in out)) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()) } catch { /* skip */ }
    }
  }
  return out
}

/** The site the cookies belong to (atheron.shop for www.atheron.shop; host-only on a platform address). */
function cookieDomain(host: string, env: Pick<StorefrontEnv, 'PLATFORM_URL'>): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, '')
  let platform = ''
  try { platform = env.PLATFORM_URL ? new URL(env.PLATFORM_URL).hostname.toLowerCase() : '' } catch { platform = '' }
  if (!h.includes('.') || /^[\d.]+$/.test(h) || (platform && h.endsWith(`.${platform}`))) return null
  const labels = h.split('.')
  const two = labels.slice(-2).join('.')
  return /^(com|co|net|org|gov|edu|ac)\.[a-z]{2}$/.test(two) && labels.length >= 3 ? labels.slice(-3).join('.') : two
}

/** Set-Cookie values for one store page: _fbp / _fbc when Meta tracking is on, and the visitor id. */
export function adCookies(req: Request, url: URL, env: Pick<StorefrontEnv, 'PLATFORM_URL'>, meta: boolean, now = Date.now(), rand = Math.random): string[] {
  const jar = cookieJar(req)
  const domain = cookieDomain(url.host, env)
  const attrs = (days: number) => `Path=/; Max-Age=${days * 86_400}; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}${domain ? `; Domain=${domain}` : ''}`
  const out: string[] = []
  if (VID.test(jar.ff_vid ?? '')) out.push(`ff_vid=${jar.ff_vid}; ${attrs(365)}`)
  if (!meta) return out
  const fbp = FBP.test(jar._fbp ?? '') ? jar._fbp : `fb.1.${now}.${1_000_000_000 + Math.floor(rand() * 9_000_000_000)}`
  out.push(`_fbp=${fbp}; ${attrs(AD_COOKIE_DAYS)}`)
  const fbclid = url.searchParams.get('fbclid') ?? ''
  const fbc = FBCLID.test(fbclid) && (jar._fbc ?? '').split('.').slice(3).join('.') !== fbclid
    ? `fb.1.${now}.${fbclid}`
    : FBC.test(jar._fbc ?? '') ? jar._fbc : null
  if (fbc) out.push(`_fbc=${fbc}; ${attrs(AD_COOKIE_DAYS)}`)
  return out
}

function withHeaders(res: Response, body: string | null, status: number, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  headers.delete('etag')
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Cache-Control', 'no-cache')
  for (const [k, v] of Object.entries(extra)) headers.set(k, v)
  return new Response(body, { status, headers })
}

const redirect = (to: string, status = 301) => new Response(null, { status, headers: { Location: to, 'Cache-Control': 'public, max-age=300' } })

/** A page request: on a store's address, the page with the store's own head; elsewhere the app as it is. */
export async function storefrontPage(req: Request, url: URL, env: StorefrontEnv): Promise<Response> {
  const host = url.host.toLowerCase()
  const shell = () => env.ASSETS.fetch(new Request(new URL('/', url), req))
  // Pages over HTTPS (the website and every store's own address) ask browsers to keep using HTTPS.
  const security: Record<string, string> = url.protocol === 'https:' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}
  if (isPlatformHost(host, env)) {
    // The Fullfilio website (worker/site.ts): one address per page, its own head and its HTML.
    const moved = siteRedirect(req, url, env)
    if (moved) return moved
    // The theme editor's preview frame (?theme_preview=1) shows the signed-in staff's own store,
    // resolved in the browser: the plain app page, never the website's HTML (which would show
    // fullfilio.com until the store loads), and a 200 for every store page it opens.
    if (url.searchParams.has('theme_preview')) {
      const res = await shell()
      return withHeaders(res, req.method === 'HEAD' ? null : await res.text(), res.ok ? 200 : res.status,
        { ...security, 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' })
    }
    // Admin and sign-up pages, and stores opened by path (their own address is the canonical one).
    if (PRIVATE.test(url.pathname) || url.pathname.startsWith('/s/')) {
      const res = await env.ASSETS.fetch(req)
      const headers = new Headers(res.headers)
      headers.set('X-Robots-Tag', 'noindex, nofollow')
      for (const [k, v] of Object.entries(security)) headers.set(k, v)
      return new Response(res.body, { status: res.status, headers })
    }
    const res = await shell()
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return res
    const head = pageHead(url, env)
    // An address the website does not have: the app's "not found" page, with a real 404.
    if (!head) return withHeaders(res, req.method === 'HEAD' ? null : await res.text(), 404, { ...security, 'X-Robots-Tag': 'noindex' })
    const html = withPage(injectHead(await res.text(), { host, origin: url.origin, site: { kind: 'platform' }, seo: head }), await prerendered(env, url, head.path))
    // Previews and other names of the website point search engines at fullfilio.com (canonical) and stay out of the index.
    const extra = isCanonicalHost(url, env) ? security : { ...security, 'X-Robots-Tag': 'noindex' }
    return withHeaders(res, req.method === 'HEAD' ? null : html, 200, extra)
  }

  let site: Site
  try {
    site = await siteFor(env, host)
  } catch {
    // The database did not answer: the app resolves the address itself (and says so if it cannot).
    return shell()
  }
  if (site.kind === 'missing') {
    const res = await shell()
    return withHeaders(res, await res.text(), 404, { 'X-Robots-Tag': 'noindex' })
  }
  if (site.kind !== 'store') return env.ASSETS.fetch(req)
  // A secondary domain sends visitors (and search engines) to the primary one.
  if (site.redirect_to && site.redirect_to !== url.hostname && !PRIVATE.test(url.pathname)) {
    return redirect(`https://${site.redirect_to}${url.pathname}${url.search}`)
  }
  if (PRIVATE.test(url.pathname)) {
    const res = await shell()
    return withHeaders(res, await res.text(), 200, { ...security, 'X-Robots-Tag': 'noindex, nofollow' })
  }

  type PageInfo = { config?: unknown; seo?: PageSeo | null }
  const [page, meta] = await Promise.all([
    rpc<PageInfo>(env, 'storefront_page', { p_path: url.pathname }, site.merchant_id).catch((): PageInfo | null => null),
    metaTracking(env, site.merchant_id ?? ''),
  ])
  const seo = page?.seo ?? null
  // Only a path on this store: never //host or /\host, which browsers read as another site.
  if (seo?.status === 301 && seo.redirect && /^\/(?![/\\])/.test(seo.redirect)) return redirect(`${seo.redirect}${url.search}`)
  const res = await shell()
  const html = injectHead(await res.text(), { host, origin: url.origin, site, config: page?.config, seo })
  const extra: Record<string, string> = { ...security }
  if (seo?.robots?.startsWith('noindex')) extra['X-Robots-Tag'] = seo.robots.replace(',', ', ')
  const out = withHeaders(res, req.method === 'HEAD' ? null : html, seo?.status === 404 ? 404 : 200, extra)
  for (const c of adCookies(req, url, env, meta)) out.headers.append('Set-Cookie', c)
  return out
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const text = (body: string, status = 200, type = 'text/plain; charset=utf-8', maxAge = 300) =>
  new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${maxAge}` } })

/** robots.txt, sitemap.xml and llms.txt, per address. */
export async function storefrontFile(req: Request, url: URL, env: StorefrontEnv): Promise<Response> {
  const host = url.host.toLowerCase()
  const isRobots = url.pathname === '/robots.txt'
  if (isPlatformHost(host, env)) {
    const moved = siteRedirect(req, url, env)
    if (moved) return moved
    const origin = siteOrigin(env, url)
    if (isRobots) return text(siteRobots(origin))
    if (url.pathname === '/llms.txt') return text(siteLlms(origin), 200, 'text/markdown; charset=utf-8', 3600)
    return text(siteSitemap(origin), 200, 'application/xml; charset=utf-8', 3600)
  }
  // llms.txt is the website's; a store has none.
  if (url.pathname === '/llms.txt') return text('Not found', 404)
  let site: Site
  try {
    site = await siteFor(env, host)
  } catch {
    return text('Temporarily unavailable', 503, 'text/plain; charset=utf-8', 0)
  }
  if (site.kind !== 'store') {
    return isRobots ? text('User-agent: *\nDisallow: /\n') : text('Not found', 404)
  }
  if (isRobots) {
    const r = await rpc<{ indexable: boolean; sitemap: boolean; base: string | null }>(env, 'storefront_robots', {}, site.merchant_id).catch(() => null)
    const base = r?.base ?? url.origin
    if (r && !r.indexable) return text('User-agent: *\nDisallow: /\n')
    const lines = ['User-agent: *', ...STORE_PRIVATE.map((p) => `Disallow: ${p}`), 'Disallow: /*?theme_preview', 'Allow: /']
    if (!r || r.sitemap) lines.push('', `Sitemap: ${base}/sitemap.xml`)
    return text(`${lines.join('\n')}\n`)
  }
  let map: { enabled: boolean; base: string | null; urls: Array<{ path: string; lastmod?: string | null }> }
  try {
    map = await rpc(env, 'storefront_sitemap', {}, site.merchant_id, 8000)
  } catch {
    return text('Temporarily unavailable', 503, 'text/plain; charset=utf-8', 0)
  }
  if (!map.enabled) return text('This store has no sitemap.', 404)
  const base = map.base ?? url.origin
  const body = map.urls.map((u) => `  <url><loc>${xml(base + u.path)}</loc>${u.lastmod ? `<lastmod>${xml(String(u.lastmod).slice(0, 10))}</lastmod>` : ''}</url>`)
  return text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body.join('\n')}\n</urlset>\n`,
    200, 'application/xml; charset=utf-8', 300)
}
