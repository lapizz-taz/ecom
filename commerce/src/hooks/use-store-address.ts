import { useQuery } from '@tanstack/react-query'
import { getStoreAddress, storePublicUrl, storeSitePath } from '@/services/website'

/** The signed-in business's store address (null url when its online store is off). */
export function useStoreAddress() {
  const q = useQuery({ queryKey: ['store-address'], queryFn: getStoreAddress, staleTime: 5 * 60_000 })
  return { ...q, url: storePublicUrl(q.data), path: storeSitePath(q.data) }
}
