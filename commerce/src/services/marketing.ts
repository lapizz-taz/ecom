import { supabase } from '@/lib/supabase'
import type { TablesInsert } from '@/types/database'

export async function campaignPerformance() {
  const { data, error } = await supabase.from('marketing_campaign_performance').select('*').order('spend', { ascending: false })
  if (error) throw error
  return data ?? []
}
export type CampaignPerformance = Awaited<ReturnType<typeof campaignPerformance>>[number]

export async function listCampaigns() {
  const { data, error } = await supabase.from('marketing_campaigns').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function saveCampaign(values: TablesInsert<'marketing_campaigns'> & { id?: string }) {
  const { id, ...rest } = values
  const { error } = id ? await supabase.from('marketing_campaigns').update(rest).eq('id', id) : await supabase.from('marketing_campaigns').insert(rest)
  if (error) throw error
}

export async function listSpend(campaignId?: string) {
  let query = supabase.from('marketing_spend').select('*, marketing_campaigns(name, platform)').order('spend_date', { ascending: false }).limit(200)
  if (campaignId) query = query.eq('campaign_id', campaignId)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}
export type SpendRow = Awaited<ReturnType<typeof listSpend>>[number]

/** Upsert by (campaign, date). Ad spend is posted to Advertising expenses automatically. */
export async function saveSpend(values: TablesInsert<'marketing_spend'>) {
  const { error } = await supabase.from('marketing_spend').upsert(values, { onConflict: 'campaign_id,spend_date' })
  if (error) throw error
}

export async function deleteSpend(id: string) {
  const { error } = await supabase.from('marketing_spend').delete().eq('id', id)
  if (error) throw error
}
