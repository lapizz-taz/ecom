import type { Enums } from '@/types/database'

/** Order events an SMS automation can react to. */
export type SmsEvent = Exclude<Enums<'notification_event'>, 'ADVANCE_RECEIVED'>

/** One condition of an SMS automation ("total ≥ 1000", "district in …"). */
export type ConditionField = 'payment_method' | 'total' | 'district' | 'source' | 'first_order' | 'courier'
export interface Condition {
  field: ConditionField
  op: 'in' | 'not_in' | 'gte' | 'lte' | 'eq'
  value: string[] | number | boolean
}
