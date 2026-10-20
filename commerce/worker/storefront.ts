// Store pages, sitemap.xml and robots.txt, answered by the Worker for each request.
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
  tags.push(`<script type="application/json" id="ff-boot">${scriptJson({ host: opts.host, site: opts.site, config: opts.config ?? null, seo: seo ?? null })}</script>`)
  return out.replace(/<\/head>/i, `    ${tags.join('\n    ')}\n  </head>`)
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
  if (isPlatformHost(host, env)) {
    const res = await env.ASSETS.fetch(req)
    // Admin and sign-up pages, and stores opened by path (their own address is the canonical one).
    if (PRIVATE.test(url.pathname) || url.pathname.startsWith('/s/')) {
      const headers = new Headers(res.headers)
      headers.set('X-Robots-Tag', 'noindex, nofollow')
      return new Response(res.body, { status: res.status, headers })
    }
    return res
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
    return withHeaders(res, await res.text(), 200, { 'X-Robots-Tag': 'noindex, nofollow' })
  }

  let page: { config?: unknown; seo?: PageSeo | null } | null = null
  try {
    page = await rpc<{ config?: unknown; seo?: PageSeo | null }>(env, 'storefront_page', { p_path: url.pathname }, site.merchant_id)
  } catch {
    page = null
  }
  const seo = page?.seo ?? null
  if (seo?.status === 301 && seo.redirect && seo.redirect.startsWith('/')) return redirect(`${seo.redirect}${url.search}`)
  const res = await shell()
  const html = injectHead(await res.text(), { host, origin: url.origin, site, config: page?.config, seo })
  const extra: Record<string, string> = {}
  if (seo?.robots?.startsWith('noindex')) extra['X-Robots-Tag'] = seo.robots.replace(',', ', ')
  return withHeaders(res, req.method === 'HEAD' ? null : html, seo?.status === 404 ? 404 : 200, extra)
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const text = (body: string, status = 200, type = 'text/plain; charset=utf-8', maxAge = 300) =>
  new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${maxAge}` } })

/** The platform's own robots.txt: the website is public; admin, sign-up and path stores are not. */
function platformRobots(origin: string): string {
  return ['User-agent: *', 'Disallow: /admin', 'Disallow: /start', 'Disallow: /super-admin', 'Disallow: /s/', 'Allow: /', '',
    `Sitemap: ${origin}/sitemap.xml`, ''].join('\n')
}

const PLATFORM_PAGES = ['/', '/contact', '/blog', '/privacy', '/terms', '/data-deletion']

/** robots.txt and sitemap.xml, per address. */
export async function storefrontFile(_req: Request, url: URL, env: StorefrontEnv): Promise<Response> {
  const host = url.host.toLowerCase()
  const isRobots = url.pathname === '/robots.txt'
  if (isPlatformHost(host, env)) {
    if (isRobots) return text(platformRobots(url.origin))
    return text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      PLATFORM_PAGES.map((p) => `  <url><loc>${xml(url.origin + p)}</loc></url>`).join('\n')}\n</urlset>\n`, 200, 'application/xml; charset=utf-8', 3600)
  }
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
