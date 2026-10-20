// Super Admin → Domains: every store's custom domains. The list is checked by the database
// (merchants.view, assigned stores only); Check again and Remove go through the domains function,
// which asks merchants.manage for that store and records the action in the audit log.
import { invokeFunction } from '@/lib/functions'
import { platformRpc } from '@/services/platform'
import type { StoreDomain } from '@/services/website'

export type DomainBucket = 'LIVE' | 'WAITING' | 'ISSUES' | 'MANUAL' | 'REMOVED'

export interface PlatformDomain extends StoreDomain {
  merchant_id: string
  bucket: DomainBucket
  /** Errors and warnings in the last check. */
  issues: number
  removed_at: string | null
  /** The employee may check or remove this store's domains. */
  can_manage: boolean
  merchant: { id: string; name: string; number: number; status: string; slug: string | null }
}

export interface PlatformDomains {
  domains: PlatformDomain[]
  counts: Record<'ALL' | DomainBucket, number>
  /** Stores with at least one domain. */
  stores: number
  can_manage: boolean
}

export const listPlatformDomains = (search: string, bucket: string) =>
  platformRpc<PlatformDomains>('platform_store_domains_list', { p_search: search || null, p_bucket: bucket || null })

export const platformCheckDomain = (merchantId: string, domain: string) =>
  invokeFunction<{ domain: StoreDomain | null }>('domains', { action: 'platform_check', merchant_id: merchantId, domain })

export const platformRemoveDomain = (merchantId: string, domain: string, reason: string) =>
  invokeFunction<{ ok: boolean }>('domains', { action: 'platform_remove', merchant_id: merchantId, domain, reason })
