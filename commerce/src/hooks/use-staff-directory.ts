import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { StaffMember } from '@/types/domain'

/** id → name map for "created by" and assignee columns. */
export function useStaffDirectory() {
  const query = useQuery({
    queryKey: ['staff-directory'],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('staff_directory')
      if (error) throw error
      return (data as unknown as StaffMember[] | null) ?? []
    },
  })
  const byId = new Map((query.data ?? []).map((s) => [s.id, s]))
  return { staff: query.data ?? [], nameOf: (id: string | null | undefined) => (id ? byId.get(id)?.full_name ?? 'Staff' : 'System') }
}
