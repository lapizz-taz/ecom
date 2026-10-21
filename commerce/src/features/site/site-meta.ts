// What each public page of the Fullfilio website says about itself: tab title, meta description,
// social sharing and structured data. One list, used by the app (the tab title and tags after a
// click), by the build (pages made as HTML, src/site-prerender.tsx) and by the Worker (the page's
// head, sitemap.xml and llms.txt on fullfilio.com, worker/site.ts). Plain data only: the Worker
// imports it too.
//
// Title parts are separated with " | ". Titles stay within about 60 characters and descriptions within about 155, which is what search
// results show.
import { POSTS } from './blog-posts'

export const SITE_NAME = 'Fullfilio'
export const SITE_ORIGIN = 'https://fullfilio.com'
/** The picture shown when a page is shared (1200 × 630). */
export const SITE_IMAGE = '/media/fullfilio-og.png'
export const SITE_TAGLINE = 'Order management for cash-on-delivery sellers in Bangladesh'
export const SITE_SOCIAL = ['https://www.facebook.com/fullfilio/', 'https://www.instagram.com/fullfiliohq/']

export interface SitePageMeta {
  path: string
  title: string
  description: string
  /** The page's own heading, for the breadcrumb trail and structured data. */
  name: string
  kind: 'home' | 'page' | 'blog' | 'post' | 'contact' | 'legal'
  /** Posts: when written. */
  published?: string
  /** Last real change, for sitemap.xml. */
  modified?: string
}

const LEGAL_UPDATED = '2026-10-17'

const POST_PAGES: SitePageMeta[] = POSTS.map((p) => ({
  path: `/blog/${p.slug}`,
  title: `${p.title} | Fullfilio`.length <= 60 ? `${p.title} | Fullfilio` : p.title,
  description: p.excerpt,
  name: p.title,
  kind: 'post',
  published: p.date,
  modified: p.date,
}))

export const SITE_PAGES: SitePageMeta[] = [
  {
    path: '/',
    title: 'Fullfilio | Order Management for COD Sellers in Bangladesh',
    description: 'Orders, courier booking, fraud checks, stock and profit in one place. Built for cash-on-delivery online sellers in Bangladesh. Works with Shopify and WooCommerce.',
    name: 'Fullfilio',
    kind: 'home',
  },
  {
    path: '/blog',
    title: 'Fullfilio Blog | Guides for COD Sellers in Bangladesh',
    description: 'Practical guides for online sellers in Bangladesh: stop fake COD orders, book couriers in bulk, handle returns (RTS) and sync Shopify or WooCommerce.',
    name: 'Blog',
    kind: 'blog',
    modified: POSTS[0]?.date,
  },
  ...POST_PAGES,
  {
    path: '/contact',
    title: 'Contact Fullfilio | Plans, Setup and Support',
    description: 'Questions about plans, moving from another tool, or connecting Shopify or WooCommerce? Send the Fullfilio team a message and a person replies by e-mail or phone.',
    name: 'Contact',
    kind: 'contact',
  },
  {
    path: '/privacy',
    title: 'Privacy Policy | Fullfilio',
    description: 'What information Fullfilio handles for online stores in Bangladesh and their customers, why, how Facebook, Instagram and WhatsApp data is used, and your choices.',
    name: 'Privacy policy',
    kind: 'legal',
    modified: LEGAL_UPDATED,
  },
  {
    path: '/terms',
    title: 'Terms of Service | Fullfilio',
    description: 'The terms for every business that uses Fullfilio: your data, connected services, payment, acceptable use, availability and closing your account.',
    name: 'Terms of service',
    kind: 'legal',
    modified: LEGAL_UPDATED,
  },
  {
    path: '/data-deletion',
    title: 'Data Deletion Instructions | Fullfilio',
    description: 'How to remove the information Fullfilio holds, including Facebook, Instagram and WhatsApp data: disconnect, remove the app, or ask us to delete it within 30 days.',
    name: 'Data deletion instructions',
    kind: 'legal',
    modified: LEGAL_UPDATED,
  },
]

/** The page at path ("/blog/x/" and "/blog/x" are the same page), or null when the website has none. */
export function siteMeta(path: string): SitePageMeta | null {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  return SITE_PAGES.find((m) => m.path === p) ?? null
}

/** Where the build keeps the page's HTML (scripts/prerender-site.mjs), read by the Worker: "/_site/blog--x.txt". */
export const siteFile = (path: string): string => `/_site/${path === '/' ? 'index' : path.replace(/^\/+/, '').replace(/\//g, '--')}.txt`
/** The first line of that file: the Worker uses the page only when it names this path. */
export const siteFileMark = (path: string): string => `<!--ff-site:${path}-->`
