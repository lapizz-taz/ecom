import { useQuery } from '@tanstack/react-query'
import { configureCurrency } from '@/lib/format'
import { currentMerchantId } from '@/lib/merchant'
import { getStoreConfig } from '@/services/storefront'

export function useStoreConfig() {
  return useQuery({
    // Per merchant: the login page loads the storefront's config, and staff of another business sign in from it.
    queryKey: ['store-config', currentMerchantId()],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const config = await getStoreConfig()
      configureCurrency({ symbol: config.store.currency_symbol, code: config.store.currency, locale: config.store.locale })
      return config
    },
  })
}
