// Super Admin → Income & Expenses: Fullfilio's own books. Manual entries, daily
// spend from Fullfilio's Meta ad accounts, and what merchants paid the platform
// (read from billing). Ad account tokens go to the platform-admin function and
// Vault; the panel only ever sees a masked hint.
import { invokeFunction } from '@/lib/functions'
import { platformRpc } from '@/services/platform'

export type FinanceType = 'INCOME' | 'EXPENSE'
export type EntrySource = 'MANUAL' | 'META_ADS' | 'BILLING'

export interface PlatformCategory {
  id: string; type: FinanceType; code: string; name: string; color: string; subcategories: string[]
  allow_manual: boolean; is_system: boolean; is_active: boolean
}
export interface PlatformLedger {
  total: number; count: number; usd_total: number | null
  categories: Array<{ id: string; code: string; name: string; color: string; manual: boolean; subcategories: string[]; total: number; count: number }>
  days: Array<{ date: string; total: number; cells: Record<string, { amount: number; count: number; usd: number | null }> }>
}
export interface PlatformEntry {
  id: string; txn_number: string; type: FinanceType; date: string; amount: number
  foreign_amount: number | null; foreign_currency: string | null; exchange_rate: number | null
  category: { id: string; name: string; code: string; color: string }
  sub_category: string | null; notes: string | null; reference: string | null; source: EntrySource
  merchant: string | null; editable: boolean; voided: boolean; created_by: string | null; created_at: string
}
export interface EntryFilters {
  type?: FinanceType; category_id?: string; sub_category?: string; source?: EntrySource; q?: string
  from: string; to: string; show_voided?: boolean; limit?: number; offset?: number
}
export interface PlatformOverview {
  income: number; expense: number; income_count: number; expense_count: number
  ads: number; ads_usd: number | null; merchant_income: number
  series: Array<{ date: string; income: number; expense: number }>
  by_category: Array<{ type: FinanceType; name: string; color: string; total: number }>
  by_month: Array<{ month: string; income: number; expense: number }>
  can_manage: boolean; can_create: boolean
}
export interface EntryInput {
  id?: string; type: FinanceType; category_id: string; amount?: number; txn_date: string; sub_category?: string | null
  notes?: string | null; reference?: string | null; foreign_amount?: number | null; foreign_currency?: string | null; exchange_rate?: number | null
}

export const platformCategories = () => platformRpc<PlatformCategory[]>('platform_finance_categories_list')
export const platformLedger = (type: FinanceType, from: string, to: string) =>
  platformRpc<PlatformLedger>('platform_finance_ledger', { p_type: type, p_from: from, p_to: to })
export const platformEntries = (f: EntryFilters) =>
  platformRpc<{ total: number; sum: number; items: PlatformEntry[] }>('platform_finance_entries', {
    p: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '')),
  })
export const platformOverview = (from: string, to: string) => platformRpc<PlatformOverview>('platform_finance_overview', { p_from: from, p_to: to })
export const saveEntry = (input: EntryInput) => platformRpc<{ id: string; txn_number: string }>('platform_finance_entry_save', { p: input })
export const deleteEntry = (id: string, reason: string) => platformRpc('platform_finance_entry_void', { p_id: id, p_reason: reason })
export const saveCategory = (p: Partial<Pick<PlatformCategory, 'id' | 'type' | 'name' | 'color' | 'subcategories' | 'is_active'>>) =>
  platformRpc<PlatformCategory>('platform_finance_category_save', { p })

// --- Fullfilio's Meta ad accounts -------------------------------------------------------
export interface PlatformAdAccount {
  id: string; platform: 'META'; name: string; ad_account_id: string; app_id: string | null; usd_rate: number; is_active: boolean
  account_name: string | null; currency: string | null; timezone: string | null; token_hint: string | null; has_app_secret: boolean
  token_expires_at: string | null
  status: 'NEW' | 'OK' | 'FAILED' | 'TOKEN_INVALID' | 'NO_ACCESS' | 'RATE_LIMITED' | 'DISCONNECTED'
  last_error: string | null; last_sync_at: string | null; last_sync_since: string | null; last_sync_until: string | null
  created_at: string; spend_30d: number; spend_30d_foreign: number | null; days: number
}
export interface AdAccountInput {
  id?: string; name: string; ad_account_id: string; app_id?: string; app_secret?: string; access_token?: string; usd_rate: number; is_active: boolean
}
export interface SpendSync { id: string; name: string; ok: boolean; since: string; until: string; days?: number; amount?: number; error?: string }

export const platformAdAccounts = () => platformRpc<{ accounts: PlatformAdAccount[]; can_manage: boolean }>('platform_ad_accounts_list')
export const testAdAccount = (input: Omit<AdAccountInput, 'name' | 'usd_rate' | 'is_active'>) =>
  invokeFunction<{ ok: boolean; account: { id: string; name: string; currency: string; timezone: string | null; status: number | null }; warnings: string[] }>(
    'platform-admin', { action: 'ad_account_test', ...input })
export const saveAdAccount = (input: AdAccountInput) =>
  invokeFunction<{ ok: boolean; account: PlatformAdAccount; warnings: string[]; sync: SpendSync | null }>('platform-admin', { action: 'ad_account_save', ...input })
export const disconnectAdAccount = (id: string) => invokeFunction<{ ok: boolean }>('platform-admin', { action: 'ad_account_disconnect', id })
export const syncAdAccounts = (input: { id?: string; days?: number; since?: string; until?: string } = {}) =>
  invokeFunction<{ ok: boolean; accounts: SpendSync[]; amount: number }>('platform-admin', { action: 'ad_account_sync', ...input })
