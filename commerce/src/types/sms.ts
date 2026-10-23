import type { Enums } from '@/types/database'

/** Order (and cart) events an SMS automation can react to; the daily summary is the owner's email. */
export type SmsEvent = Exclude<Enums<'notification_event'>, 'ADVANCE_RECEIVED' | 'DAILY_SUMMARY'>

/** One condition of an SMS automation ("total ≥ 1000", "district in …"). */
export type ConditionField = 'payment_method' | 'total' | 'district' | 'source' | 'first_order' | 'courier'
export interface Condition {
  field: ConditionField
  op: 'in' | 'not_in' | 'gte' | 'lte' | 'eq'
  value: string[] | number | boolean
}
