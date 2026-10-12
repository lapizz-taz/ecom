import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { batcher } from '@/lib/batch'
import { supabase } from '@/lib/supabase'

type Table = 'orders' | 'production_orders' | 'inventory' | 'finance_transactions'

/**
 * Invalidates queries when a table changes. Realtime is used only for tables
 * where live updates matter (see migration 1000). RLS still applies: users
 * receive changes only for rows they may read. Changes are coalesced: a burst of row events
 * (bulk actions, syncs) refetches once.
 */
export function useRealtimeInvalidate(table: Table, queryKeys: unknown[][], enabled = true) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const changes = batcher<true>(() => {
      for (const key of queryKeys) void queryClient.invalidateQueries({ queryKey: key })
    })
    const channel = supabase
      .channel(`rt-${table}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, () => changes.push(true))
      .subscribe()
    return () => {
      changes.cancel()
      void supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, enabled, queryClient, JSON.stringify(queryKeys)])
}
