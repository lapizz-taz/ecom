// The Fullfilio website on its own address (fullfilio.com): what search engines and AI crawlers get.
//
// Each public page is sent with its own head (title, description, canonical address, sharing
// tags and structured data, src/features/site/site-head.ts) and with the page itself as HTML
// inside <div id="root"> (made at build time, scripts/prerender-site.mjs), so a crawler that
// does not run JavaScript reads the same headings and text a visitor sees. www and old
// addresses answer 301 to the one canonical address; an address the website does not have
// answers 404. sitemap.xml, robots.txt and llms.txt list the public pages.
import { siteHead, type SiteHead } from '../src/features/site/site-head.ts'
import { SITE_NAME, SITE_PAGES, SITE_TAGLINE, siteFile, siteFileMark } from '../src/features/site/site-meta.ts'

interface SiteEnv {
  ASSETS: Fetcher
  PLATFORM_URL?: string
}

/** The website's one address, from PLATFORM_URL ("https://fullfilio.com"). */
export function siteOrigin(env: Pick<SiteEnv, 'PLATFORM_URL'>, url: URL): string {
  try {
    if (env.PLATFORM_URL) return new URL(env.PLATFORM_URL).origin
  } catch { /* the request's own origin below */ }
  return url.origin
}

const platformHostname = (env: Pick<SiteEnv, 'PLATFORM_URL'>) => {
  try { return env.PLATFORM_URL ? new URL(env.PLATFORM_URL).hostname.toLowerCase() : '' } catch { return '' }
}

/** Addresses that moved: answered 301 so links and search results land on the page itself. */
const MOVED: Record<string, string> = { '/fullfilio': '/', '/login': '/admin/login', '/index.html': '/' }

/**
 * A 301 to the canonical address of this request, or null when it is already there:
 * www.fullfilio.com → fullfilio.com, "/blog/" → "/blog", and the moved addresses above.
 */
export function siteRedirect(req: Request, url: URL, env: Pick<SiteEnv, 'PLATFORM_URL'>): Response | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  const platform = platformHostname(env)
  const host = url.hostname.toLowerCase()
  let path = url.pathname
  if (MOVED[path]) path = MOVED[path]
  // Only public website pages lose a trailing slash (the app's own pages are left as they are).
  else if (path.length > 1 && path.endsWith('/') && SITE_PAGES.some((p) => p.path === path.replace(/\/+$/, ''))) path = path.replace(/\/+$/, '')
  const toApex = !!platform && host === `www.${platform}`
  if (!toApex && path === url.pathname) return null
  const origin = toApex ? siteOrigin(env, url) : url.origin
  return new Response(null, { status: 301, headers: { Location: `${origin}${path}${url.search}`, 'Cache-Control': 'public, max-age=3600' } })
}

/** The address search engines should index: only the website's own (not www, app. or a preview). */
export function isCanonicalHost(url: URL, env: Pick<SiteEnv, 'PLATFORM_URL'>): boolean {
  return url.hostname.toLowerCase() === platformHostname(env)
}

/** The page's head, or null when the website has no page at this address. */
export function pageHead(url: URL, env: Pick<SiteEnv, 'PLATFORM_URL'>): SiteHead | null {
  return siteHead(url.pathname, siteOrigin(env, url))
}

/** The page's HTML made at build time, or null (not built, or another file came back). */
export async function prerendered(env: Pick<SiteEnv, 'ASSETS'>, url: URL, path: string): Promise<string | null> {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(siteFile(path), url)))
    if (!res.ok) return null
    const body = await res.text()
    const mark = siteFileMark(path)
    return body.startsWith(mark) ? body.slice(mark.length).replace(/^\n/, '') : null
  } catch {
    return null
  }
}

/** The app page with the website page's HTML inside its root element. */
export function withPage(html: string, page: string | null): string {
  if (!page) return html
  return html.replace(/<div id="root"><\/div>/, () => `<div id="root" data-prerendered>${page}</div>`)
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** sitemap.xml: every public page, with the date it last changed where known. */
export function siteSitemap(origin: string): string {
  const urls = SITE_PAGES.map((p) => `  <url><loc>${xml(origin + p.path)}</loc>${p.modified ? `<lastmod>${p.modified}</lastmod>` : ''}</url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}

/** robots.txt: the website is public (search engines and AI assistants alike); the app's private pages are not. */
export function siteRobots(origin: string): string {
  return ['User-agent: *', 'Disallow: /admin', 'Disallow: /start', 'Disallow: /super-admin', 'Disallow: /s/', 'Disallow: /_site/', 'Allow: /', '',
    `Sitemap: ${origin}/sitemap.xml`, ''].join('\n')
}

/** llms.txt (llmstxt.org): what Fullfilio is and where its pages are, for AI assistants. */
export function siteLlms(origin: string): string {
  const line = (path: string) => {
    const p = SITE_PAGES.find((m) => m.path === path)
    return p ? `- [${p.name === SITE_NAME ? 'Home' : p.name}](${origin}${p.path}): ${p.description}` : ''
  }
  const posts = SITE_PAGES.filter((p) => p.kind === 'post').map((p) => line(p.path))
  return [
    `# ${SITE_NAME}`,
    '',
    `> ${SITE_TAGLINE}.`,
    '',
    'Fullfilio is web software for online sellers in Bangladesh who take cash-on-delivery (COD) orders. It handles orders, courier booking',
    '(Pathao, Steadfast, RedX, Carrybee), fraud checks from customer delivery history, stock, returns (RTS), and profit reports, and it works',
    'alongside Shopify and WooCommerce stores or with its own online store on the seller\'s domain.',
    '',
    '## Pages',
    '',
    line('/'), line('/contact'), line('/blog'),
    '',
    '## Guides',
    '',
    ...posts,
    '',
    '## Policies',
    '',
    line('/privacy'), line('/terms'), line('/data-deletion'),
    '',
  ].join('\n')
}
