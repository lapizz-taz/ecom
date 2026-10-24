import { afterEach, describe, expect, it, vi } from 'vitest'
import { SITE_PAGES, siteFile, siteFileMark, siteMeta } from '../src/features/site/site-meta.ts'
import { storefrontFile, storefrontPage, type StorefrontEnv } from './storefront.ts'

// The Fullfilio website on fullfilio.com: one address per page, each with its own head and its
// HTML (worker/site.ts).

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Shop everyday essentials. Cash on delivery available." />
    <title>Store</title>
  </head>
  <body><div id="root"></div></body>
</html>`

/** Static files: the app page, and the pages made at build time (those given). */
function assets(built: Record<string, string> = {}) {
  return {
    fetch: vi.fn(async (req: Request) => {
      const path = new URL(req.url).pathname
      if (built[path] !== undefined) return new Response(built[path], { headers: { 'Content-Type': 'text/plain' } })
      // Like Workers Static Assets in single-page-app mode: any other path is the app page.
      return new Response(SHELL, { headers: { 'Content-Type': 'text/html' } })
    }),
  }
}
const env = (a = assets()): StorefrontEnv =>
  ({ ASSETS: a as unknown as Fetcher, SUPABASE_URL: 'https://db.example.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_test', PLATFORM_URL: 'https://fullfilio.com' }) as StorefrontEnv
const get = (url: string, e = env()) => storefrontPage(new Request(url), new URL(url), e)
const file = (url: string, e = env()) => storefrontFile(new Request(url), new URL(url), e)
const ldOf = (html: string) => [...html.matchAll(/<script type="application\/ld\+json" data-ff-seo>(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]))

afterEach(() => vi.unstubAllGlobals())

describe('the Fullfilio website pages', () => {
  it('every page has its own title, description and the page HTML inside the app root', async () => {
    const built = { [siteFile('/')]: `${siteFileMark('/')}\n<main><h1>The order system for online sellers in Bangladesh</h1></main>` }
    const res = await get('https://fullfilio.com/', env(assets(built)))
    expect(res.status).toBe(200)
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000')
    expect(res.headers.get('X-Robots-Tag')).toBeNull()
    const html = await res.text()
    expect(html).toContain('<title>Fullfilio | Order Management for COD Sellers in Bangladesh</title>')
    expect(html).not.toContain('Shop everyday essentials')
    expect(html).toContain('<link rel="canonical" href="https://fullfilio.com/" data-ff-seo>')
    expect(html).toContain('<meta property="og:image" content="https://fullfilio.com/media/fullfilio-og.png" data-ff-seo>')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" data-ff-seo>')
    expect(html).toContain('<div id="root" data-prerendered><main><h1>The order system for online sellers in Bangladesh</h1></main></div>')
    const types = (ldOf(html)[0]['@graph'] as Array<{ '@type': string }>).map((n) => n['@type'])
    expect(types).toEqual(expect.arrayContaining(['Organization', 'WebSite', 'SoftwareApplication', 'WebPage']))
  })

  it('a blog post is an article with a breadcrumb trail', async () => {
    const post = SITE_PAGES.find((p) => p.kind === 'post')!
    const html = await (await get(`https://fullfilio.com${post.path}`)).text()
    expect(html).toContain(`<title>${post.title.replace(/&/g, '&amp;')}</title>`)
    expect(html).toContain('<meta property="og:type" content="article" data-ff-seo>')
    const nodes = ldOf(html)[0]['@graph'] as Array<Record<string, unknown>>
    expect(nodes.find((n) => n['@type'] === 'BlogPosting')).toMatchObject({ headline: post.name, datePublished: post.published })
    const crumbs = nodes.find((n) => n['@type'] === 'BreadcrumbList') as { itemListElement: Array<{ name: string }> }
    expect(crumbs.itemListElement.map((c) => c.name)).toEqual(['Home', 'Blog', post.name])
  })

  it('never puts another file in the page (a missing build answers with the app page)', async () => {
    const html = await (await get('https://fullfilio.com/contact')).text()
    expect(html).toContain('<div id="root"></div>')
    const wrong = { [siteFile('/contact')]: `${siteFileMark('/blog')}\n<h1>Blog</h1>` }
    expect(await (await get('https://fullfilio.com/contact', env(assets(wrong)))).text()).toContain('<div id="root"></div>')
  })

  it('one address per page: www, trailing slashes and old addresses answer 301', async () => {
    const www = await get('https://www.fullfilio.com/blog?ref=x')
    expect(www.status).toBe(301)
    expect(www.headers.get('Location')).toBe('https://fullfilio.com/blog?ref=x')
    expect((await get('https://fullfilio.com/blog/')).headers.get('Location')).toBe('https://fullfilio.com/blog')
    expect((await get('https://fullfilio.com/login')).headers.get('Location')).toBe('https://fullfilio.com/admin/login')
    expect((await get('https://fullfilio.com/fullfilio')).headers.get('Location')).toBe('https://fullfilio.com/')
    expect((await file('https://www.fullfilio.com/sitemap.xml')).headers.get('Location')).toBe('https://fullfilio.com/sitemap.xml')
    // The app's own pages keep their address.
    expect((await get('https://fullfilio.com/admin/orders/')).status).toBe(200)
  })

  it('an address the website does not have is a real 404, kept out of search', async () => {
    const res = await get('https://fullfilio.com/no-such-page')
    expect(res.status).toBe(404)
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex')
    expect((await get('https://fullfilio.com/blog/no-such-post')).status).toBe(404)
    // The app's private pages are served, never indexed.
    const admin = await get('https://fullfilio.com/admin')
    expect(admin.status).toBe(200)
    expect(admin.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    // So is a customer's "confirm your order" page from an email.
    const confirm = await get(`https://fullfilio.com/order-confirm/00000000-0000-4000-8000-000000000001/${'a'.repeat(40)}`)
    expect(confirm.status).toBe(200)
    expect(confirm.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    const unsubscribe = await get(`https://fullfilio.com/unsubscribe/00000000-0000-4000-8000-000000000001/${'a'.repeat(40)}`)
    expect(unsubscribe.status).toBe(200)
    expect(unsubscribe.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  })

  it('previews and other names of the website stay out of the index and point at fullfilio.com', async () => {
    const res = await get('https://fullfilio.example.workers.dev/contact')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(await res.text()).toContain('<link rel="canonical" href="https://fullfilio.com/contact" data-ff-seo>')
  })

  it('sitemap.xml lists every public page (blog posts too); robots.txt and llms.txt point to them', async () => {
    const map = await (await file('https://fullfilio.com/sitemap.xml')).text()
    for (const p of SITE_PAGES) expect(map).toContain(`<loc>https://fullfilio.com${p.path}</loc>`)
    expect(map).not.toContain('/admin')
    const robots = await (await file('https://fullfilio.com/robots.txt')).text()
    expect(robots).toContain('Sitemap: https://fullfilio.com/sitemap.xml')
    expect(robots).toContain('Disallow: /admin')
    const llms = await file('https://fullfilio.com/llms.txt')
    expect(llms.headers.get('Content-Type')).toContain('text/markdown')
    const text = await llms.text()
    expect(text.startsWith('# Fullfilio')).toBe(true)
    expect(text).toContain('(https://fullfilio.com/blog)')
    // A store has no llms.txt of its own.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ kind: 'store', merchant_id: '6ef2d31d-737c-4017-b71e-5013b7a4ecce', name: 'Isolation' })))
    expect((await file('https://atheron.shop/llms.txt')).status).toBe(404)
  })
})

describe('what each page says about itself', () => {
  it('titles are unique and fit search results; descriptions say enough without being cut', () => {
    expect(new Set(SITE_PAGES.map((p) => p.title)).size).toBe(SITE_PAGES.length)
    expect(new Set(SITE_PAGES.map((p) => p.description)).size).toBe(SITE_PAGES.length)
    for (const p of SITE_PAGES) {
      expect(p.title.length, p.title).toBeLessThanOrEqual(60)
      expect(p.description.length, p.description).toBeGreaterThanOrEqual(70)
      expect(p.description.length, p.description).toBeLessThanOrEqual(165)
    }
  })

  it('a trailing slash is the same page; other addresses are not pages', () => {
    expect(siteMeta('/blog/')?.path).toBe('/blog')
    expect(siteMeta('/')?.kind).toBe('home')
    expect(siteMeta('/admin')).toBeNull()
  })
})
