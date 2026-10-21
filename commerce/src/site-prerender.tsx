// The Fullfilio website's pages as HTML, made at build time (scripts/prerender-site.mjs).
//
// The website is a single-page app: without this, a search engine or an AI crawler that does
// not run JavaScript sees an empty page. The Worker puts this HTML inside <div id="root"> on
// fullfilio.com (worker/site.ts); the app then starts and draws the same page over it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { Route, Routes, StaticRouter } from 'react-router'
import { SITE_PAGES, siteFile, siteFileMark } from '@/features/site/site-meta'
import BlogPostPage from '@/pages/marketing/blog-post'
import BlogPage from '@/pages/marketing/blog'
import ContactPage from '@/pages/marketing/contact'
import MarketingHome from '@/pages/marketing/home'
import LegalPage from '@/pages/marketing/legal'

const PAGES: Array<[string, ComponentType]> = [
  ['/', MarketingHome],
  ['/contact', ContactPage],
  ['/blog', BlogPage],
  ['/blog/:slug', BlogPostPage],
  ['/privacy', LegalPage],
  ['/terms', LegalPage],
  ['/data-deletion', LegalPage],
]

/** The page at path, as HTML (no data from the network: plans and other live parts show as loading). */
export function render(path: string): string {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  return renderToString(
    <QueryClientProvider client={client}>
      <StaticRouter location={path}>
        <Routes>
          {PAGES.map(([p, Page]) => <Route key={p} path={p} element={<Page />} />)}
        </Routes>
      </StaticRouter>
    </QueryClientProvider>,
  )
}

/** Every public page of the website. */
export const paths = (): string[] => SITE_PAGES.map((p) => p.path)

export { siteFile, siteFileMark }
