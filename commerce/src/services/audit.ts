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

export const SYSTEM_LOG_CATEGORIES = ['FUNCTION', 'WEBHOOK', 'PAYMENT', 'COURIER', 'SMS', 'META', 'FRAUD', 'AUTH', 'JOB', 'FRONTEND', 'OTHER'] as const

export async function listSystemLogs(f: { level?: string; category?: string; status?: string; page: number; pageSize: number }) {
  let query = supabase.from('system_logs').select('*', { count: 'exact' }).order('last_seen_at', { ascending: false })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.level) query = query.eq('level', f.level)
  if (f.category) query = query.eq('category', f.category)
  if (f.status === 'open') query = query.is('resolved_at', null)
  if (f.status === 'resolved') query = query.not('resolved_at', 'is', null)
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type SystemLogRow = Awaited<ReturnType<typeof listSystemLogs>>['items'][number]

export async function openSystemProblems(): Promise<number> {
  const { count, error } = await supabase.from('system_logs').select('id', { count: 'exact', head: true })
    .is('resolved_at', null).eq('level', 'ERROR')
  if (error) throw error
  return count ?? 0
}

export async function resolveSystemLogs(ids: number[]) {
  const { data, error } = await supabase.rpc('admin_resolve_system_logs', { p_ids: ids })
  if (error) throw error
  return data as number
}
