import { useQuery } from '@tanstack/react-query'
import { configureCurrency } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import type { StoreConfig } from '@/types/domain'

export function useStoreConfig() {
  return useQuery({
    queryKey: ['store-config'],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('storefront_config')
      if (error) throw error
      const config = data as unknown as StoreConfig
      configureCurrency({ symbol: config.store.currency_symbol, code: config.store.currency, locale: config.store.locale })
      return config
    },
  })
}
