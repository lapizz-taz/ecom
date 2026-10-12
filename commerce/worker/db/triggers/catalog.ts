// Business triggers of products and stock.
import { asOwner, bool, type Json } from '../rpc/helpers.ts'
import type { Q } from '../q.ts'
import type { TriggerImpl } from '../writer.ts'

/** public.channel_job_enqueue: one open job per channel, kind and record; repeats merge into it. */
export function channelJobEnqueue(q: Q, channelId: string, kind: string, refId: string, payload: Json = {}, delaySeconds = 0): string {
  const next = new Date(Date.parse(q.now) + Math.max(delaySeconds, 0) * 1000).toISOString()
  const open = q.one<{ id: string; status: string; payload: Json; next_attempt_at: string }>(
    "SELECT id, status, payload, next_attempt_at FROM channel_sync_jobs WHERE channel_id = ? AND kind = ? AND ref_id = ? AND status IN ('PENDING', 'RUNNING')",
    [channelId, kind, refId], 'channel_sync_jobs')
  if (!open) return String(q.insert('channel_sync_jobs', { channel_id: channelId, kind, ref_id: refId, payload, next_attempt_at: next })[0][0])
  q.update('channel_sync_jobs', {
    payload: { ...open.payload, ...payload, ...(open.status === 'RUNNING' ? { rerun: true } : {}) },
    next_attempt_at: open.next_attempt_at < next ? open.next_attempt_at : next,
  }, { keys: [[open.id]] })
  return open.id
}

export const catalogTriggers: Record<string, TriggerImpl> = {
  // AFTER INSERT ON product_variants: every variant has a stock row.
  ensure_inventory_row: {
    after({ env, new: row }) {
      const q = asOwner(env)
      if (!q.exists('SELECT 1 FROM inventory WHERE variant_id = ?', [row!.id as string])) {
        q.insert('inventory', { variant_id: row!.id, product_id: row!.product_id })
      }
    },
  },
  // AFTER UPDATE OF on_hand, reserved ON inventory: connected stores get the new available count.
  _inventory_channel_trigger: {
    after({ env, new: row, old }) {
      if (row!.available === old!.available) return
      const q = asOwner(env)
      const mapped = q.rows<{ channel_id: string; variant_id: string; settings: Json }>(
        `SELECT m.channel_id, m.variant_id, c.settings FROM sales_channel_variants m JOIN sales_channels c ON c.id = m.channel_id
          WHERE m.variant_id = ? AND m.inventory_item_id IS NOT NULL AND c.status = 'CONNECTED'`, [row!.variant_id as string], 'sales_channels')
      for (const m of mapped) {
        if (!(bool(m.settings.inventory_sync) ?? false) || !m.settings.location_id) continue
        q.update('sales_channel_variants', { sync_status: 'PENDING' }, {
          sql: "channel_id = ? AND variant_id = ? AND sync_status IN ('OK', 'NEW', 'FAILED')", params: [m.channel_id, m.variant_id],
        })
        channelJobEnqueue(q, m.channel_id, 'INVENTORY', m.variant_id)
      }
    },
  },
}
