import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, type Db, expectError, inTx, num, value } from '../support/db'
import { createProduct, createStaff, placeOrder } from '../support/fixtures'

// Call tracking (3 Nov 2026): taps on Call, every call status and every approval, with who did it;
// read only by the Owner and Admins (calls.view).
afterAll(closePool)

type History = { taps: number; statuses: number; not_reached: number; events: Array<{ kind: string; status: string | null; status_label: string | null; actor_name: string | null }> }
type Report = {
  staff: Array<{ user_id: string; taps: number; orders_called: number; statuses: number; not_reached: number; approved: number; closed: number; without_call: number }>
  without_call: Array<{ order_id: string; outcome: string }>
  never_called: { count: number; items: Array<{ order_id: string }> }
  automatic_approvals: number
}

async function order(db: Db, phone: string) {
  const p = await createProduct(db, { price: 500, stock: 10 })
  return placeOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
}

describe('call tracking', () => {
  it('records taps, every call status and approvals with who did it; only Owner and Admins read it', () =>
    inTx(async (db) => {
      const called = await order(db, '01711000601')
      const skipped = await order(db, '01711000602')
      const waiting = await order(db, '01711000603')
      // Old enough to count as "still waiting and never called".
      await asSystem(db)
      await db.query(`update public.orders set created_at = now() - interval '3 hours' where id = $1`, [waiting.id])

      const agent = await createStaff(db, 'ORDER_MANAGER')
      const admin = await createStaff(db, 'ADMIN')
      const moderator = await createStaff(db, 'MODERATOR')

      // The agent taps Call (a double tap counts once), gets no answer twice, then approves.
      await asUser(db, agent)
      await db.query(`select public.order_call_tap($1, 'order')`, [called.id])
      await db.query(`select public.order_call_tap($1, 'order')`, [called.id])
      await db.query(`select public.set_web_order_status($1, 'NO_RESPONSE', null, null)`, [[called.id]])
      await db.query(`select public.set_web_order_status($1, 'NO_RESPONSE', null, null)`, [[called.id]])
      const ok = await value<{ approved: number; failed: Array<{ error: string }> }>(db, `select public.approve_orders($1)`, [[called.id]])
      expect(ok.failed).toEqual([])
      // The other one is cancelled without anyone tapping Call.
      await db.query(`select public.set_web_order_status($1, 'CANCELLED', 'Customer cancelled', null)`, [[skipped.id]])

      // Employees cannot read any of it.
      await expectError(db, `select public.order_call_history($1)`, [called.id], /permission|PERMISSION_DENIED/i)
      await expectError(db, `select public.calls_report('{}'::jsonb)`, [], /permission|PERMISSION_DENIED/i)
      await asUser(db, moderator)
      await expectError(db, `select public.calls_report('{}'::jsonb)`, [], /permission|PERMISSION_DENIED/i)
      await expectError(db, `select count(*) from public.order_call_events`, [], /permission denied/i)

      // The Admin sees the whole story.
      await asUser(db, admin)
      const h = await value<History>(db, `select public.order_call_history($1)`, [called.id])
      expect(h).toMatchObject({ taps: 1, statuses: 2, not_reached: 2 })
      expect(h.events.map((e) => e.kind)).toEqual(['TAP', 'STATUS', 'STATUS', 'APPROVED'])
      expect(h.events[1]).toMatchObject({ status: 'NO_RESPONSE', status_label: 'No response' })
      expect(h.events.map((e) => e.actor_name)).toEqual(['Test ORDER_MANAGER', 'Test ORDER_MANAGER', 'Test ORDER_MANAGER', 'Test ORDER_MANAGER'])

      const from = new Date(Date.now() - 86_400_000).toISOString()
      const r = await value<Report>(db, `select public.calls_report($1::jsonb)`, [JSON.stringify({ from })])
      const a = r.staff.find((s) => s.user_id === agent)!
      expect(a).toMatchObject({ taps: 1, orders_called: 1, statuses: 3, not_reached: 2, approved: 1, closed: 1, without_call: 1 })
      expect(r.without_call).toEqual([expect.objectContaining({ order_id: skipped.id, outcome: 'Cancelled' })])
      expect(r.never_called.items.map((i) => i.order_id)).toContain(waiting.id)
      expect(r.never_called.items.map((i) => i.order_id)).not.toContain(called.id)
      expect(num(r.never_called.count)).toBeGreaterThanOrEqual(1)
    }))
})
