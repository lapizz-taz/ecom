import { asJson, fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import { platformRpc } from '@/services/platform'

// Multi warehouse / branch stock. The store's total stock is unchanged; each
// branch other than the central one keeps its own count, and the central
// branch holds the rest (see 20261116000500_branches.sql).

export type BranchKind = 'STORE' | 'WAREHOUSE'
export interface Branch {
  id: string; name: string; code: string | null; kind: BranchKind; is_central: boolean; address: string | null; phone: string | null
  manager_id: string | null; manager: string | null; is_active: boolean; units: number; skus: number | null
  staff: Array<{ id: string; name: string }>; open_orders: number
}
export interface BranchesOverview {
  enabled: boolean
  stats: { total: number; stores: number; warehouses: number; central: string | null }
  branches: Branch[]
}
export interface BranchStockRow { variant_id: string; product: string; variant: string | null; sku: string | null; total: number; reserved: number; branches: Record<string, number> | null }
export interface BranchReportRow { branch_id: string; name: string; kind: BranchKind; is_central: boolean; orders: number; sales: number; delivered: number; returned: number; units: number }

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never)
  if (error) throw error
  return fromJson<T>(data as never)
}

export const branchesOverview = () => call<BranchesOverview>('branches_overview')
export const enableBranches = (on: boolean) => call<BranchesOverview>('branches_enable', { p_on: on })
export const saveBranch = (b: Partial<Pick<Branch, 'id' | 'name' | 'code' | 'kind' | 'address' | 'phone' | 'manager_id' | 'is_active'>>) =>
  call<Branch>('branch_save', { p: asJson(b) })
export const setCentralBranch = (id: string) => call<void>('branch_set_central', { p_branch: id })
export const deleteBranch = (id: string) => call<void>('branch_delete', { p_branch: id })
export const setBranchStaff = (id: string, profileIds: string[]) => call<number>('branch_staff_set', { p_branch: id, p_profiles: profileIds })
export const branchStock = (q: string, limit: number, offset: number) =>
  call<{ total: number; items: BranchStockRow[] }>('branch_stock_list', { p_q: q || null, p_limit: limit, p_offset: offset })
export const setBranchStock = (branchId: string, items: Array<{ variant_id: string; on_hand: number }>) =>
  call<number>('branch_stock_set', { p_branch: branchId, p_items: asJson(items) })
export const transferStock = (from: string, to: string, items: Array<{ variant_id: string; quantity: number }>, note?: string) =>
  call<number>('branch_transfer', { p_from: from, p_to: to, p_items: asJson(items), p_note: note ?? null, p_kind: 'TRANSFER' })
export const setOrdersBranch = (orderIds: string[], branchId: string | null) => call<number>('orders_set_branch', { p_orders: orderIds, p_branch: branchId })
export const branchReport = (from: string, to: string) => call<BranchReportRow[]>('branch_report', { p_from: from, p_to: to })

export interface MerchantBranches { enabled: boolean; branches: Array<{ id: string; name: string; kind: BranchKind; is_central: boolean; is_active: boolean; staff: number }> }
export const merchantBranches = (merchantId: string) => platformRpc<MerchantBranches>('platform_merchant_branches', { p_merchant: merchantId })
