import { useQuery } from '@tanstack/react-query'
import { staffDirectory } from '@/services/users'

/** id → name map for "created by" and assignee columns. */
export function useStaffDirectory() {
  const query = useQuery({
    queryKey: ['staff-directory'],
    staleTime: 10 * 60_000,
    queryFn: staffDirectory,
  })
  const byId = new Map((query.data ?? []).map((s) => [s.id, s]))
  return { staff: query.data ?? [], nameOf: (id: string | null | undefined) => (id ? byId.get(id)?.full_name ?? 'Staff' : 'System') }
}
