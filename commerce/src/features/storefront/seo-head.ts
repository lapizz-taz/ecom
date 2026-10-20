import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { pageBoot } from '@/lib/merchant'
import { getPageSeo, type PageSeo } from '@/services/seo'
import { isThemePreview } from './theme'

// The head of a store page (title, description, robots, canonical address, sharing tags and
// structured data) as the visitor moves around the store. The first page's head comes from
// the Worker (worker/storefront.ts); later pages ask the database for the same answer
// (storefront_seo, services/seo.ts), and the tags are replaced, never added twice (data-ff-seo).

const clean = (path: string) => path.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1') || '/'
const absolute = (link: string | null | undefined) => (link ? (/^https?:\/\//.test(link) ? link : `${location.origin}${link.startsWith('/') ? '' : '/'}${link}`) : null)

/** Puts a page's SEO in the document head (replacing the previous page's tags). */
export function applySeo(seo: PageSeo): void {
  if (seo.title) document.title = seo.title
  if (seo.lang) document.documentElement.lang = seo.lang
  document.head.querySelectorAll('[data-ff-seo], meta[name="description"]').forEach((el) => el.remove())
  const add = (tag: string, attrs: Record<string, string>, text?: string) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    el.setAttribute('data-ff-seo', '')
    if (text !== undefined) el.textContent = text
    document.head.appendChild(el)
  }
  if (seo.description) add('meta', { name: 'description', content: seo.description })
  if (seo.robots) add('meta', { name: 'robots', content: seo.robots })
  const canonical = absolute(seo.canonical)
  if (canonical && seo.status === 200) add('link', { rel: 'canonical', href: canonical })
  for (const [k, v] of Object.entries(seo.og ?? {})) {
    const value = k === 'image' || k === 'url' ? absolute(v) : v
    if (value) add('meta', { property: `og:${k}`, content: value })
  }
  for (const [k, v] of Object.entries(seo.twitter ?? {})) if (v) add('meta', { name: `twitter:${k}`, content: v })
  for (const ld of seo.jsonld ?? []) if (ld) add('script', { type: 'application/ld+json' }, JSON.stringify(ld))
}

/** Keeps the store page's head in step with the page shown (not in the theme editor's preview). */
export function useStoreSeo(): void {
  const location = useLocation()
  const navigate = useNavigate()
  const path = clean(location.pathname)
  const preview = isThemePreview()
  const boot = pageBoot()
  const booted = boot?.seo && (boot.seo as PageSeo).path === path ? (boot.seo as PageSeo) : undefined
  const { data } = useQuery({
    queryKey: ['storefront-seo', path],
    queryFn: () => getPageSeo(path),
    enabled: !preview,
    staleTime: 60_000,
    initialData: booted,
    retry: 1,
  })
  useEffect(() => {
    if (!data || preview) return
    // An old product / collection address: on to the new one.
    if (data.status === 301 && data.redirect?.startsWith('/')) {
      navigate(`${data.redirect}${location.search}`, { replace: true })
      return
    }
    applySeo(data)
  }, [data, preview, navigate, location.search])
}
