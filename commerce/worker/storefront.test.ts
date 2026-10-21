import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adCookies, forgetSites, injectHead, isPlatformHost, type PageSeo, storefrontFile, storefrontPage, type StorefrontEnv } from './storefront.ts'

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Shop everyday essentials. Cash on delivery available." />
    <title>Store</title>
  </head>
  <body><div id="root"></div></body>
</html>`

const MERCHANT = '6ef2d31d-737c-4017-b71e-5013b7a4ecce'
const assets = { fetch: vi.fn(async (req: Request) => new Response(new URL(req.url).pathname === '/' ? SHELL : `asset ${new URL(req.url).pathname}`, { headers: { 'Content-Type': 'text/html', 'X-Fullfilio': 'store' } })) }
const env = (extra: Partial<StorefrontEnv> = {}): StorefrontEnv =>
  ({ ASSETS: assets as unknown as Fetcher, SUPABASE_URL: 'https://db.example.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_test', PLATFORM_URL: 'https://fullfilio.com', ...extra }) as StorefrontEnv

const SEO: PageSeo = {
  status: 200, path: '/product/linen-shirt', type: 'product', lang: 'en-BD', title: 'Linen Shirt | Isolation',
  description: 'Breathable linen "shirt" <b>', canonical: 'https://atheron.shop/product/linen-shirt', robots: 'index,follow',
  og: { type: 'product', title: 'Linen Shirt | Isolation', image: '/files/x.jpg', url: 'https://atheron.shop/product/linen-shirt' },
  twitter: { card: 'summary_large_image' },
  jsonld: [{ '@type': 'Product', name: 'Bad </script><script>alert(1)</script>' }],
}

/** The database as the Worker sees it: one call per function, answers given per test. */
function database(answers: Record<string, unknown | ((body: unknown, headers: Headers) => unknown)>) {
  const calls: Array<{ fn: string; body: unknown; merchant: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const fn = url.split('/rpc/')[1]
    const headers = new Headers(init?.headers)
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ fn, body, merchant: headers.get('x-merchant-id') })
    const answer = answers[fn]
    if (answer === undefined) return new Response('{"message":"no"}', { status: 500 })
    const value = typeof answer === 'function' ? (answer as (b: unknown, h: Headers) => unknown)(body, headers) : answer
    return Response.json(value)
  }))
  return calls
}

beforeEach(() => forgetSites())
afterEach(() => {
  vi.unstubAllGlobals()
  assets.fetch.mockClear()
})

const page = (url: string, e = env()) => storefrontPage(new Request(url), new URL(url), e)
const store = { kind: 'store', merchant_id: MERCHANT, name: 'Isolation', slug: 'atheron', redirect_to: null }

describe('store pages from the Worker', () => {
  it("puts the store's settings and this page's head in the page", async () => {
    const calls = database({ storefront_resolve: store, storefront_page: { config: { merchant_id: MERCHANT, store: { name: 'Isolation' } }, seo: SEO } })
    const res = await page('https://atheron.shop/product/linen-shirt')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<title>Linen Shirt | Isolation</title>')
    expect(html).not.toContain('Shop everyday essentials')
    expect(html).toContain('<html lang="en-BD">')
    expect(html).toContain('<meta name="description" content="Breathable linen &quot;shirt&quot; &lt;b&gt;" data-ff-seo>')
    expect(html).toContain('<link rel="canonical" href="https://atheron.shop/product/linen-shirt" data-ff-seo>')
    expect(html).toContain('<meta property="og:image" content="https://atheron.shop/files/x.jpg" data-ff-seo>')
    expect(html).toContain('application/ld+json')
    // No way out of the script element from data.
    expect(html).not.toContain('</script><script>alert(1)')
    const boot = JSON.parse(/<script type="application\/json" id="ff-boot">([\s\S]*?)<\/script>/.exec(html)![1])
    expect(boot).toMatchObject({ host: 'atheron.shop', site: { merchant_id: MERCHANT }, config: { store: { name: 'Isolation' } } })
    // The page is asked for this store only.
    expect(calls.map((c) => [c.fn, c.merchant])).toEqual([['storefront_resolve', null], ['storefront_page', MERCHANT], ['storefront_ad_tracking', MERCHANT]])
    expect(calls[0].body).toEqual({ p_host: 'atheron.shop' })
  })

  it("a store's redirect never sends visitors to another site (//host, /\\host)", async () => {
    for (const to of ['//evil.example/x', '/\\evil.example/x']) {
      forgetSites()
      database({ storefront_resolve: store, storefront_page: { config: {}, seo: { status: 301, redirect: to } } })
      const res = await page('https://atheron.shop/product/old-name')
      expect(res.status, to).not.toBe(301)
      expect(res.headers.get('Location'), to).toBeNull()
    }
  })

  it('old addresses and secondary domains answer 301; a missing page 404 with noindex', async () => {
    database({ storefront_resolve: store, storefront_page: { config: {}, seo: { status: 301, redirect: '/product/new-name' } } })
    let res = await page('https://atheron.shop/product/old-name?ref=ig')
    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe('/product/new-name?ref=ig')

    forgetSites()
    database({ storefront_resolve: { ...store, redirect_to: 'atheron.shop' } })
    res = await page('https://www.atheron.shop/shop?x=1')
    expect(res.headers.get('Location')).toBe('https://atheron.shop/shop?x=1')

    forgetSites()
    database({ storefront_resolve: store, storefront_page: { config: {}, seo: { status: 404, robots: 'noindex,follow', title: 'Page not found | Isolation' } } })
    res = await page('https://atheron.shop/product/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, follow')
  })

  it('when the database does not answer, the plain page is served (the app loads the store itself)', async () => {
    database({})
    const res = await page('https://atheron.shop/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<div id="root">')
    expect(html).not.toContain('ff-boot')
  })

  it('a store page that loaded the store but not its page data still names the store (no stand-in)', async () => {
    database({ storefront_resolve: store })
    const html = await (await page('https://atheron.shop/')).text()
    const boot = JSON.parse(/id="ff-boot">([\s\S]*?)<\/script>/.exec(html)![1])
    expect(boot).toMatchObject({ site: { merchant_id: MERCHANT }, config: null })
  })

  it('a removed store answers 404; admin pages and the website are not indexed', async () => {
    database({ storefront_resolve: { kind: 'missing' } })
    const res = await page('https://closed.shop/')
    expect(res.status).toBe(404)
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex')

    database({})
    const admin = await page('https://fullfilio.com/admin/orders')
    expect(admin.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    const home = await page('https://fullfilio.com/')
    expect(home.headers.get('X-Robots-Tag')).toBeNull()
    expect(isPlatformHost('www.fullfilio.com', env())).toBe(true)
    expect(isPlatformHost('atheron.shop', env())).toBe(false)
  })

  it('the theme editor preview gets the plain app page: never the website, never a 404', async () => {
    database({})
    for (const path of ['/', '/shop', '/product/linen-shirt', '/collection/belts', '/cart']) {
      const res = await page(`https://fullfilio.com${path}?theme_preview=1`)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('<div id="root"></div>')
      expect(html).not.toContain('data-prerendered')
      expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
  })

  it('robots.txt and sitemap.xml are per store', async () => {
    database({
      storefront_resolve: store,
      storefront_robots: { indexable: true, sitemap: true, base: 'https://atheron.shop' },
      storefront_sitemap: { enabled: true, base: 'https://atheron.shop', urls: [{ path: '/', lastmod: '2026-10-20T10:00:00Z' }, { path: '/product/a&b', lastmod: null }] },
    })
    const robots = await (await storefrontFile(new Request('https://atheron.shop/robots.txt'), new URL('https://atheron.shop/robots.txt'), env())).text()
    expect(robots).toContain('Disallow: /checkout')
    expect(robots).toContain('Disallow: /account')
    expect(robots).toContain('Allow: /')
    expect(robots).toContain('Sitemap: https://atheron.shop/sitemap.xml')
    expect(robots).not.toMatch(/^Disallow: \/$/m)
    const map = await storefrontFile(new Request('https://atheron.shop/sitemap.xml'), new URL('https://atheron.shop/sitemap.xml'), env())
    expect(map.headers.get('Content-Type')).toContain('application/xml')
    const body = await map.text()
    expect(body).toContain('<loc>https://atheron.shop/</loc><lastmod>2026-10-20</lastmod>')
    expect(body).toContain('<loc>https://atheron.shop/product/a&amp;b</loc>')

    forgetSites()
    database({ storefront_resolve: store, storefront_robots: { indexable: false, sitemap: true, base: null } })
    const closed = await (await storefrontFile(new Request('https://atheron.shop/robots.txt'), new URL('https://atheron.shop/robots.txt'), env())).text()
    expect(closed).toBe('User-agent: *\nDisallow: /\n')

    const platform = await (await storefrontFile(new Request('https://fullfilio.com/robots.txt'), new URL('https://fullfilio.com/robots.txt'), env())).text()
    expect(platform).toContain('Disallow: /admin')
    expect(platform).toContain('Sitemap: https://fullfilio.com/sitemap.xml')
  })

  it("the website's pages name Fullfilio and its social pages; store pages never do", async () => {
    database({})
    const home = await (await storefrontPage(new Request('https://fullfilio.com/'), new URL('https://fullfilio.com/'), env())).text()
    const ld = [...home.matchAll(/<script type="application\/ld\+json" data-ff-seo>(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]))
    const nodes = ld[0]['@graph'] as Array<Record<string, unknown>>
    expect(nodes.find((n) => n['@type'] === 'Organization')).toMatchObject({ name: 'Fullfilio', url: 'https://fullfilio.com/',
      sameAs: ['https://www.facebook.com/fullfilio/', 'https://www.instagram.com/fullfiliohq/'] })
    expect(nodes.some((n) => n['@type'] === 'WebSite')).toBe(true)
    database({ storefront_resolve: { kind: 'store', merchant_id: MERCHANT, name: 'Isolation' }, storefront_page: { config: {}, seo: SEO } })
    const store = await (await storefrontPage(new Request('https://atheron.shop/'), new URL('https://atheron.shop/'), env())).text()
    expect(store).not.toContain('fullfiliohq')
  })

  it("a store's own address keeps browsers on HTTPS, like the website", async () => {
    database({ storefront_resolve: { kind: 'store', merchant_id: MERCHANT, name: 'Isolation' }, storefront_page: { config: {}, seo: SEO } })
    const store = await storefrontPage(new Request('https://atheron.shop/'), new URL('https://atheron.shop/'), env())
    expect(store.headers.get('Strict-Transport-Security')).toBe('max-age=31536000')
    const account = await storefrontPage(new Request('https://atheron.shop/account'), new URL('https://atheron.shop/account'), env())
    expect(account.headers.get('Strict-Transport-Security')).toBe('max-age=31536000')
  })

  it('the head is written safely whatever the store typed', () => {
    const html = injectHead(SHELL, { host: 'a.shop', origin: 'https://a.shop', site: { kind: 'store', merchant_id: MERCHANT },
      seo: { status: 200, title: '</title><script>x</script>', robots: 'noindex,follow', canonical: '/shop' } })
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>')
    expect(html).toContain('<link rel="canonical" href="https://a.shop/shop" data-ff-seo>')
    expect(html).toContain('<meta name="robots" content="noindex,follow" data-ff-seo>')
  })
})

describe('first-party ad cookies', () => {
  const env = { PLATFORM_URL: 'https://fullfilio.com' }
  const req = (cookie = '') => new Request('https://www.atheron.shop/', { headers: cookie ? { cookie } : {} })
  it('creates _fbp, keeps it for 90 days on the whole site, and refreshes the visitor id', () => {
    const out = adCookies(req('ff_vid=abcdef123456'), new URL('https://www.atheron.shop/'), env, true, 1_760_000_000_000, () => 0.5)
    expect(out).toEqual([
      'ff_vid=abcdef123456; Path=/; Max-Age=31536000; SameSite=Lax; Secure; Domain=atheron.shop',
      '_fbp=fb.1.1760000000000.5500000000; Path=/; Max-Age=7776000; SameSite=Lax; Secure; Domain=atheron.shop',
    ])
  })
  it('turns an ad click (fbclid) into _fbc and keeps an existing _fbp', () => {
    const out = adCookies(req('_fbp=fb.1.1700000000000.1234567890'), new URL('https://atheron.shop/p/x?fbclid=IwAR123abc'), env, true, 1_760_000_000_000)
    expect(out[0]).toContain('_fbp=fb.1.1700000000000.1234567890;')
    expect(out[1]).toBe('_fbc=fb.1.1760000000000.IwAR123abc; Path=/; Max-Age=7776000; SameSite=Lax; Secure; Domain=atheron.shop')
  })
  it('sets no Meta cookies when the store does not track with Meta, and none for the whole platform domain', () => {
    expect(adCookies(req(), new URL('https://atheron.shop/'), env, false)).toEqual([])
    const sub = adCookies(req(), new URL('https://isolation.fullfilio.com/'), env, true)
    expect(sub[0]).not.toContain('Domain=')
    expect(adCookies(req(), new URL('https://shop.example.com.bd/'), env, true)[0]).toContain('Domain=example.com.bd')
  })
})

