import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { hasRememberedStorefront, resolveStorefrontMerchant, type StorefrontMerchant } from '@/lib/merchant'
import { initMonitoring, reportError } from '@/lib/monitoring'
import { supabase } from '@/lib/supabase'
import './index.css'

void initMonitoring()

// Which store this address shows. A remembered answer starts the page at once;
// a first visit waits for it so the catalog never loads without a store.
const storefront = resolveStorefrontMerchant(async (host) => {
  const { data, error } = await supabase.rpc('storefront_resolve', { p_host: host })
  if (error) throw error
  return (data as unknown as StorefrontMerchant | null) ?? null
}).catch((error) => {
  reportError(error, { where: 'storefront_resolve' })
  return null
})

async function start() {
  if (!hasRememberedStorefront()) await storefront
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
