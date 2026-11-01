// Push notifications for new orders (migration 20261213000100_push_notifications).
//   key       signed-in staff: the public VAPID key a browser subscribes with (made the first time)
//   test      signed-in staff: a test notification to their own devices (or one of them)
//   dispatch  pg_cron (x-cron-secret), every 15 seconds while orders wait: sends and records
import type { SupabaseClient } from '@supabase/supabase-js'
import { isCronRequest } from '../_shared/cron.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { adminClient, forEachMerchant, requireStaff, rpc } from '../_shared/supabase.ts'
import { generateVapidKeys, type PushDevice, type PushMessage, sendPush, type VapidKeys } from '../_shared/web-push.ts'

export interface ClaimedOrder {
  id: string
  number: string
  customer: string
  total: number | string
  created_by: string | null
  source: string
  channel: string | null
}

interface ClaimedDevice extends PushDevice {
  id: string
  user_id: string
}

const SOURCES: Record<string, string> = { STOREFRONT: 'Online store', ADMIN: 'Added by staff', IMPORT: 'Imported', API: 'Website' }

export function money(value: number | string): string {
  return `৳${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/** "New order 1051" for one order, "3 new orders" for a burst (an import, several at once). */
export function newOrderMessage(orders: ClaimedOrder[]): PushMessage {
  if (orders.length === 1) {
    const [o] = orders
    const via = o.channel === 'SHOPIFY' ? 'Shopify' : o.channel === 'WOOCOMMERCE' ? 'WooCommerce' : SOURCES[o.source] ?? null
    return { title: `New order ${o.number}`, body: [o.customer, money(o.total), via].filter(Boolean).join(' · '), url: `/admin/orders/${o.id}`, tag: `order-${o.id}`, orders: [o.id] }
  }
  const total = orders.reduce((sum, o) => sum + Number(o.total || 0), 0)
  const shown = orders.slice(0, 3).map((o) => o.number).join(', ')
  const more = orders.length > 3 ? ` and ${orders.length - 3} more` : ''
  return { title: `${orders.length} new orders`, body: `${shown}${more} · ${money(total)} in all`, url: '/admin/orders/web', tag: 'new-orders', orders: orders.slice(0, 50).map((o) => o.id) }
}

/** Our VAPID key pair from Vault, made and stored the first time (the first one stored wins). */
export async function vapidKeys(system: SupabaseClient = adminClient()): Promise<VapidKeys> {
  const stored = await rpc<VapidKeys | null>(system, 'platform_push_keys', {})
  if (stored) return stored
  const made = await generateVapidKeys()
  const kept = await rpc<VapidKeys | null>(system, 'platform_push_keys', { p_new: made })
  if (!kept) throw new HttpError(500, 'Push notification keys could not be saved', 'PUSH_KEYS')
  return kept
}

type Send = typeof sendPush

/** Sends one business's waiting new orders to its devices and records what happened. */
export async function drain(admin: SupabaseClient, send: Send = sendPush, keysFor: () => Promise<VapidKeys> = () => vapidKeys()) {
  const claim = await rpc<{ orders: ClaimedOrder[]; devices: ClaimedDevice[] }>(admin, 'push_claim', { p_limit: 200 })
  if (!claim.orders.length || !claim.devices.length) return { orders: claim.orders.length, sent: 0, gone: 0, failed: 0 }
  const keys = await keysFor()
  const sent: string[] = []
  const gone: string[] = []
  const failed: string[] = []
  for (const device of claim.devices) {
    // Nobody is told about the order they made themselves.
    const orders = claim.orders.filter((o) => o.created_by !== device.user_id)
    if (!orders.length) continue
    try {
      const result = await send(device, newOrderMessage(orders), keys)
      if (result.ok) sent.push(device.id)
      else (result.gone ? gone : failed).push(device.id)
      if (!result.ok && !result.gone) {
        void logEvent({ level: 'WARN', category: 'OTHER', source: 'push', message: `A push service refused a new-order notification (${result.status}): ${result.error}`,
          context: { device: device.id, status: result.status } })
      }
    } catch (error) {
      failed.push(device.id)
      void logEvent({ level: 'WARN', category: 'OTHER', source: 'push', message: 'A new-order notification could not be sent', error, context: { device: device.id } })
    }
  }
  await rpc(admin, 'push_done', { p_sent: sent, p_gone: gone, p_failed: failed })
  return { orders: claim.orders.length, sent: sent.length, gone: gone.length, failed: failed.length }
}

export default handle(async (req) => {
  const body = await readJson<{ action?: string; endpoint?: string }>(req)
  switch (body.action) {
    case 'key': {
      await requireStaff(req, 'orders.view', { read: true })
      return json(req, { public_key: (await vapidKeys()).public_key })
    }
    case 'test': {
      const staff = await requireStaff(req, 'orders.view', { read: true })
      let query = staff.admin.from('push_subscriptions').select('id, endpoint, p256dh, auth')
        .eq('merchant_id', staff.merchantId).eq('user_id', staff.user.id)
      if (body.endpoint) query = query.eq('endpoint', body.endpoint)
      const { data, error } = await query
      if (error) throw new HttpError(500, error.message, 'PUSH_DEVICES')
      if (!data?.length) throw new HttpError(404, 'Turn on notifications on this device first', 'NOT_SUBSCRIBED')
      const keys = await vapidKeys()
      const message: PushMessage = { title: 'Notifications are on', body: 'New orders will show up here, even when Fullfilio is closed.', url: '/admin/orders/web', tag: 'push-test' }
      const sent: string[] = []
      const gone: string[] = []
      const failed: string[] = []
      for (const device of data as Array<PushDevice & { id: string }>) {
        const result = await sendPush(device, message, keys).catch((e: Error) => ({ ok: false as const, status: 0, gone: false, error: e.message }))
        if (result.ok) sent.push(device.id)
        else (result.gone ? gone : failed).push(device.id)
      }
      await rpc(staff.admin, 'push_done', { p_sent: sent, p_gone: gone, p_failed: failed })
      return json(req, { sent: sent.length, gone: gone.length, failed: failed.length })
    }
    case 'dispatch': {
      if (!(await isCronRequest(req, adminClient()))) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED')
      return json(req, await forEachMerchant('push', (admin) => drain(admin)))
    }
    default:
      throw new HttpError(400, 'Unknown action', 'UNKNOWN_ACTION')
  }
})
