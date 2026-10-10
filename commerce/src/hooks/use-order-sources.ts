import { useQuery } from '@tanstack/react-query'
import { listOrderSources } from '@/services/orders'

/** Active order sources for pickers, as { value, label }. */
export function useOrderSources() {
  const q = useQuery({ queryKey: ['order-sources'], queryFn: () => listOrderSources(), staleTime: 5 * 60_000 })
  return (q.data ?? []).map((s) => ({ value: s.code, label: s.label }))
}
