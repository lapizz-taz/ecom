// The head of a Fullfilio website page: title, description, canonical address, robots rules,
// sharing tags and structured data (schema.org JSON-LD), from site-meta.ts. The Worker puts it
// in the page it sends (worker/site.ts); the app applies the same head after a click
// (site-chrome.tsx). Plain data only: the Worker imports it too.
import { POSTS } from './blog-posts'
import { SITE_IMAGE, SITE_NAME, SITE_ORIGIN, SITE_SOCIAL, SITE_TAGLINE, siteMeta, type SitePageMeta } from './site-meta'

/** Same shape as a store page's head (PageSeo in services/seo.ts and worker/storefront.ts). */
export interface SiteHead {
  status: number
  path: string
  type: string
  lang: string
  title: string
  description: string
  canonical: string
  robots: string
  og: Record<string, string>
  twitter: Record<string, string>
  jsonld: unknown[]
}

const ROBOTS = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'

/** The JSON-LD graph: who runs the site, the site, this page, its breadcrumb trail, and the post or product it is about. */
function graph(meta: SitePageMeta, origin: string): unknown {
  const url = `${origin}${meta.path === '/' ? '/' : meta.path}`
  const org = `${origin}/#organization`
  const site = `${origin}/#website`
  const image = `${origin}${SITE_IMAGE}`
  const nodes: Array<Record<string, unknown>> = [
    {
      '@type': 'Organization',
      '@id': org,
      name: SITE_NAME,
      url: `${origin}/`,
      logo: { '@type': 'ImageObject', url: `${origin}/icons/icon-512.png`, width: 512, height: 512 },
      description: SITE_TAGLINE,
      areaServed: { '@type': 'Country', name: 'Bangladesh' },
      sameAs: SITE_SOCIAL,
      contactPoint: { '@type': 'ContactPoint', contactType: 'customer support', url: `${origin}/contact`, availableLanguage: ['English', 'Bengali'] },
    },
    { '@type': 'WebSite', '@id': site, name: SITE_NAME, url: `${origin}/`, description: SITE_TAGLINE, publisher: { '@id': org }, inLanguage: 'en' },
  ]
  const pageType = meta.kind === 'contact' ? 'ContactPage' : meta.kind === 'blog' ? 'CollectionPage' : 'WebPage'
  const page: Record<string, unknown> = {
    '@type': pageType,
    '@id': `${url}#webpage`,
    url,
    name: meta.title,
    description: meta.description,
    isPartOf: { '@id': site },
    inLanguage: 'en',
    primaryImageOfPage: { '@type': 'ImageObject', url: image, width: 1200, height: 630 },
  }
  if (meta.modified) page.dateModified = meta.modified
  if (meta.path !== '/') {
    const trail: Array<[string, string]> = [['Home', `${origin}/`]]
    if (meta.kind === 'post') trail.push(['Blog', `${origin}/blog`])
    trail.push([meta.name, url])
    nodes.push({
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumb`,
      itemListElement: trail.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })),
    })
    page.breadcrumb = { '@id': `${url}#breadcrumb` }
  }
  if (meta.kind === 'home') {
    page.about = { '@id': `${origin}/#software` }
    nodes.push({
      '@type': 'SoftwareApplication',
      '@id': `${origin}/#software`,
      name: SITE_NAME,
      url: `${origin}/`,
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Order management',
      operatingSystem: 'Web',
      description: meta.description,
      image,
      publisher: { '@id': org },
      featureList: [
        'Order management for cash-on-delivery (COD) sellers',
        'Courier booking with Pathao, Steadfast, RedX and Carrybee',
        'Fraud check from customer delivery history',
        'Stock and inventory management',
        'Shopify and WooCommerce sync',
        'Online store with your own domain',
        'Profit and loss reports',
      ],
    })
  }
  if (meta.kind === 'blog') {
    page.mainEntity = {
      '@type': 'Blog',
      '@id': `${origin}/blog#blog`,
      name: 'Fullfilio Blog',
      publisher: { '@id': org },
      blogPost: POSTS.map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: `${origin}/blog/${p.slug}`, datePublished: p.date })),
    }
  }
  if (meta.kind === 'post') {
    const post = POSTS.find((p) => `/blog/${p.slug}` === meta.path)
    nodes.push({
      '@type': 'BlogPosting',
      '@id': `${url}#article`,
      headline: meta.name,
      description: meta.description,
      datePublished: meta.published,
      dateModified: meta.modified ?? meta.published,
      author: { '@id': org },
      publisher: { '@id': org },
      image,
      mainEntityOfPage: { '@id': `${url}#webpage` },
      isPartOf: { '@id': `${origin}/blog#blog` },
      inLanguage: 'en',
      ...(post ? { articleSection: post.tag, timeRequired: `PT${post.minutes}M` } : {}),
    })
  }
  nodes.push(page)
  return { '@context': 'https://schema.org', '@graph': nodes }
}

/** The head of the website page at path, or null when the website has no such page. */
export function siteHead(path: string, origin: string = SITE_ORIGIN): SiteHead | null {
  const meta = siteMeta(path)
  if (!meta) return null
  const url = `${origin}${meta.path === '/' ? '/' : meta.path}`
  const image = `${origin}${SITE_IMAGE}`
  const og: Record<string, string> = {
    type: meta.kind === 'post' ? 'article' : 'website',
    site_name: SITE_NAME,
    title: meta.title,
    description: meta.description,
    url,
    image,
    'image:width': '1200',
    'image:height': '630',
    'image:alt': `${SITE_NAME}: ${SITE_TAGLINE}`,
    locale: 'en_US',
  }
  return {
    status: 200,
    path: meta.path,
    type: meta.kind,
    lang: 'en',
    title: meta.title,
    description: meta.description,
    canonical: url,
    robots: ROBOTS,
    og,
    twitter: { card: 'summary_large_image', title: meta.title, description: meta.description, image },
    jsonld: [graph(meta, origin)],
  }
}
