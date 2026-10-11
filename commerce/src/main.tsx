import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { hasRememberedSite, resolveSite, type SiteInfo } from '@/lib/merchant'
import { initMonitoring, reportError } from '@/lib/monitoring'
import { supabase } from '@/lib/supabase'
import './index.css'

void initMonitoring()

// What this address shows: the Fullfilio website, a store, or a missing store.
// A remembered answer starts the page at once; a first visit waits for it so
// the catalog never loads without a store.
const site = resolveSite(async (host, slug) => {
  const { data, error } = slug
    ? await supabase.rpc('storefront_resolve_slug', { p_slug: slug })
    : await supabase.rpc('storefront_resolve', { p_host: host })
  if (error) throw error
  const found = (data as unknown as SiteInfo | null) ?? null
  // A secondary custom domain opens the same page on the primary one (staff pages stay put).
  if (found?.redirect_to && found.redirect_to !== location.hostname && !location.pathname.startsWith('/admin')) {
    location.replace(`https://${found.redirect_to}${location.pathname}${location.search}${location.hash}`)
  }
  return found
}).catch((error) => {
  reportError(error, { where: 'storefront_resolve' })
  return { kind: 'platform' } as SiteInfo
})

async function start() {
  if (!hasRememberedSite()) await site
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
