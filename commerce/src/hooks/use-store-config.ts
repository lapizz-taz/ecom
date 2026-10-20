import { useQuery } from '@tanstack/react-query'
import { configureCurrency } from '@/lib/format'
import { currentMerchantId, pageBoot } from '@/lib/merchant'
import { getStoreConfig } from '@/services/storefront'
import type { StoreConfig } from '@/types/domain'

const applyCurrency = (config: StoreConfig) =>
  configureCurrency({ symbol: config.store.currency_symbol, code: config.store.currency, locale: config.store.locale })

// The store's settings the Worker put in this page (read for this very request), used as the
// first answer so the store is drawn at once; only for the store this address belongs to.
const boot = pageBoot()
const booted = boot?.config && typeof boot.config === 'object' ? (boot.config as StoreConfig) : undefined
if (booted?.store) applyCurrency(booted)

export function useStoreConfig() {
  const merchant = currentMerchantId()
  return useQuery({
    // Per merchant: the login page loads the storefront's config, and staff of another business sign in from it.
    queryKey: ['store-config', merchant],
    staleTime: 10 * 60_000,
    initialData: booted && merchant === boot?.site.merchant_id ? booted : undefined,
    queryFn: async () => {
      const config = await getStoreConfig()
      applyCurrency(config)
      return config
    },
  })
}
