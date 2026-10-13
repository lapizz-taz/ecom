// Super Admin → Live & Capacity: who is using Fullfilio right now and how much order
// traffic the system carries. Both are permission-checked in the database.
import { type MerchantRef, platformRpc } from '@/services/platform'

export interface LivePerson {
  user_id: string
  area: 'admin' | 'super-admin'
  path: string | null
  device: string | null
  last_seen_at: string
  online: boolean
  name: string | null
  email: string | null
  role: string | null
  merchant: MerchantRef | null
}
export interface LiveUsers {
  at: string
  online_now: number
  last_15_min: number
  last_24h: number
  stores_online: number
  people: LivePerson[]
  visitors: Array<{ merchant: MerchantRef; visitors: number }>
}
export interface Capacity {
  at: string
  orders: { last_hour: number; last_24h: number; last_7d: number; peak_minute_24h: number; peak_hour_7d: number }
  status_changes: { last_hour: number; last_24h: number }
  by_status: Record<string, number>
  stores_with_orders_24h: number
  database: { connections: number | null; max_connections: number | null; size_bytes: number | null }
}

export const liveUsers = () => platformRpc<LiveUsers>('platform_live_users')
export const capacity = () => platformRpc<Capacity>('platform_capacity')
