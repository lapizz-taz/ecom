import { supabase } from '@/lib/supabase'

export async function listAuditLogs(f: { action?: string; entityType?: string; actorId?: string; from?: string; to?: string; page: number; pageSize: number }) {
  let query = supabase.from('audit_logs').select('*', { count: 'exact' }).order('created_at', { ascending: false })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.action) query = query.ilike('action', `${f.action.replace(/[%,()]/g, '')}%`)
  if (f.entityType) query = query.eq('entity_type', f.entityType)
  if (f.actorId) query = query.eq('actor_id', f.actorId)
  if (f.from) query = query.gte('created_at', new Date(`${f.from}T00:00:00`).toISOString())
  if (f.to) query = query.lte('created_at', new Date(`${f.to}T23:59:59.999`).toISOString())
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type AuditRow = Awaited<ReturnType<typeof listAuditLogs>>['items'][number]
