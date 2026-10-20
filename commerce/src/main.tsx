import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { hasRememberedSite, isPreviewFrame, markUnreachable, resolveSite, type SiteInfo } from '@/lib/merchant'
import { initMonitoring, reportError } from '@/lib/monitoring'
import { restorePageTitle } from '@/lib/page-title'
import { supabase } from '@/lib/supabase'
import './index.css'

restorePageTitle()
void initMonitoring()

// What this address shows: the Fullfilio website, a store, or a missing store.
// A remembered answer starts the page at once; a first visit waits for it so
// the catalog never loads without a store. The theme editor's preview frame
// shows the signed-in staff's own store, whatever its mode.
const lookup = async (host: string, slug: string | null, preview: boolean): Promise<SiteInfo | null> => {
  const { data, error } = preview
    ? await supabase.rpc('storefront_resolve_preview')
    : slug
      ? await supabase.rpc('storefront_resolve_slug', { p_slug: slug })
      : await supabase.rpc('storefront_resolve', { p_host: host })
  if (error) throw error
  const found = (data as unknown as SiteInfo | null) ?? null
  // A secondary custom domain opens the same page on the primary one (staff pages stay put).
  if (found?.redirect_to && found.redirect_to !== location.hostname && !location.pathname.startsWith('/admin')) {
    // Do not carry the URL fragment across hosts: an auth link's token can sit in
    // the fragment, and the destination is a different (merchant) host.
    location.replace(`https://${found.redirect_to}${location.pathname}${location.search}`)
  }
  return found
}
// One more try after a short wait: a dropped connection should not cost the visit.
const site = resolveSite((host, slug, preview) => lookup(host, slug, preview)
  .catch(() => new Promise<void>((done) => setTimeout(done, 800)).then(() => lookup(host, slug, preview))))
  .catch((error) => {
    reportError(error, { where: 'storefront_resolve' })
    // The editor says why its preview is empty rather than showing the platform's website in it.
    if (isPreviewFrame()) {
      window.parent.postMessage({ type: 'theme-preview-error', message: (error as Error)?.message ?? String(error) }, window.location.origin)
      return { kind: 'missing' } as SiteInfo
    }
    // Never a guess (the platform's website on a store's domain, or the other way round):
    // without a remembered answer the page says the site could not be reached, with a retry.
    return hasRememberedSite() ? ({ kind: 'platform' } as SiteInfo) : markUnreachable()
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
