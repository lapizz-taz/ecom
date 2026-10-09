import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, inTx, num, one, value, type Db } from '../support/db'
import { advanceOrder, createProduct, createStaff, inventory, orderPayload, setSetting, type OrderInput } from '../support/fixtures'

afterAll(closePool)

type Placed = { id: string; order_number: string; merged: boolean }

/** Storefront checkout exactly like the checkout function. */
async function checkout(db: Db, input: OrderInput, extra: Record<string, unknown> = {}): Promise<Placed> {
  await asService(db)
  const check = await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [
    JSON.stringify({ phone: input.phone ?? '01711000001', provider: 'internal', provider_counts: {} })])
  const placed = await value<Placed>(db, `select public.place_storefront_order($1, $2)`, [JSON.stringify({ ...orderPayload(input), ...extra }), check.id])
  await asSystem(db)
  return placed
}

/** Moves an order back in time (as if placed earlier). */
const ago = (db: Db, id: string, minutes: number) =>
  db.query(`update public.orders set created_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes])

const row = (db: Db, id: string) => value<Record<string, any>>(db, `select to_jsonb(o) from public.orders o where id = $1`, [id])

async function setup(db: Db) {
  await setSetting(db, 'fraud', { enabled: false })
  const belt = await createProduct(db, { name: 'Black Belt', price: 500, stock: 20 })
  const cap = await createProduct(db, { name: 'Cap', price: 300, stock: 20 })
  return { belt: belt.variantIds[0], cap: cap.variantIds[0] }
}

describe('smart automatic merging', () => {
  it('merges a repeat order hours apart into the first one: quantities combined, stock reserved once, one delivery charge', () =>
    inTx(async (db) => {
      const v = await setup(db)
      const phone = '01712345601'
      const a = await checkout(db, { phone, items: [{ variantId: v.belt, quantity: 1 }] })
      await ago(db, a.id, 60) // an hour earlier
      const before = await inventory(db, v.belt)
      // Different format of the same number, different address in the same district.
      const b = await checkout(db, { phone: '+880 1712-345601', items: [{ variantId: v.belt, quantity: 2 }, { variantId: v.cap, quantity: 1 }] },
        { shipping: { address: 'Flat 5B, Road 9, Mirpur', district: 'Dhaka' } })

      expect(b.merged).toBe(true)
      expect(b.id).toBe(a.id) // the customer is shown the first order
      const items = await db.query<{ variant_id: string; quantity: number }>(`select variant_id, quantity from public.order_items where order_id = $1 order by created_at`, [a.id])
      expect(items.rows).toEqual([{ variant_id: v.belt, quantity: 3 }, { variant_id: v.cap, quantity: 1 }])
      // Stock: the second order's 2 belts are reserved once (not twice, not lost).
      const after = await inventory(db, v.belt)
      expect(before.reserved + 2).toBe(after.reserved)

      const primary = await row(db, a.id)
      expect(num(primary.subtotal)).toBe(1800)
      expect(num(primary.total_amount)).toBe(num(primary.subtotal) + num(primary.delivery_charge) - num(primary.delivery_discount))
      expect(primary.merged_count).toBe(1)
      expect(primary.customer_note).toContain('gave another address')

      // The merged order is kept, cancelled as merged, its messages skipped.
      const merged = await db.query<{ id: string; status: string; merged_into: string; review_status: string }>(
        `select id, status, merged_into, review_status from public.orders where merged_into = $1`, [a.id])
      expect(merged.rows).toHaveLength(1)
      expect(merged.rows[0]).toMatchObject({ status: 'CANCELLED', merged_into: a.id, review_status: 'DUPLICATE' })
      expect(num(await value(db, `select count(*) from public.notification_logs where order_id = $1 and status = 'QUEUED'`, [merged.rows[0].id]))).toBe(0)
      expect(num(await value(db, `select count(*) from public.stock_reservations where order_id = $1 and status = 'ACTIVE'`, [merged.rows[0].id]))).toBe(0)

      // A checkout retry with the same key returns the merged order, nothing new.
      const key = await value<string>(db, `select idempotency_key from public.orders where id = $1`, [merged.rows[0].id])
      if (key) {
        const again = await checkout(db, { phone, items: [{ variantId: v.belt, quantity: 2 }] }, { idempotency_key: key })
        expect(again.id).toBe(a.id)
        expect(num(await value(db, `select count(*) from public.orders where customer_phone = $1`, [phone]))).toBe(2)
      }

      // Staff see the merge on the order page.
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const info = await value<Record<string, any>>(db, `select public.order_merge_info($1)`, [merged.rows[0].id])
      expect(info.primary.id).toBe(a.id)
      expect(info.is_primary).toBe(false)
      expect(info.merges).toHaveLength(1)
      expect(info.merges[0].source.id).toBe(merged.rows[0].id)
    }))

  it('takes the better call status: Processing beats Good but no response', () =>
    inTx(async (db) => {
      const v = await setup(db)
      const phone = '01712345602'
      const a = await checkout(db, { phone, items: [{ variantId: v.cap, quantity: 1 }] })
      await db.query(`update public.orders set review_status = 'GOOD_NO_RESPONSE' where id = $1`, [a.id])
      await ago(db, a.id, 120)
      await checkout(db, { phone, items: [{ variantId: v.belt, quantity: 1 }] })
      const p = await row(db, a.id)
      expect(p.review_status).toBe('PROCESSING')
      const m = await value<Record<string, any>>(db, `select to_jsonb(m) from public.order_merges m where order_id = $1 and kind = 'AUTO' and source_order_id is not null`, [a.id])
      expect(m).toMatchObject({ target_review_before: 'GOOD_NO_RESPONSE', source_review_status: 'PROCESSING', target_review_after: 'PROCESSING' })
    }))

  it('follows the configured window, and leaves other districts, paid or approved orders alone', () =>
    inTx(async (db) => {
      const v = await setup(db)
      // 12 hours apart: merged with the default 12 h window …
      const a = await checkout(db, { phone: '01712345603', items: [{ variantId: v.cap, quantity: 1 }] })
      await ago(db, a.id, 11 * 60)
      expect((await checkout(db, { phone: '01712345603', items: [{ variantId: v.cap, quantity: 1 }] })).merged).toBe(true)
      // … but not with a 1 h window.
      await setSetting(db, 'orders', { auto_merge_window_hours: 1 })
      const b = await checkout(db, { phone: '01712345604', items: [{ variantId: v.cap, quantity: 1 }] })
      await ago(db, b.id, 120)
      const b2 = await checkout(db, { phone: '01712345604', items: [{ variantId: v.cap, quantity: 1 }] })
      expect(b2.merged).toBe(false)
      expect((await row(db, b2.id)).duplicate_status).toBe('SUSPECTED')
      await setSetting(db, 'orders', { auto_merge_window_hours: 12 })

      // Another district: flagged, not merged.
      const c = await checkout(db, { phone: '01712345605', items: [{ variantId: v.cap, quantity: 1 }] })
      const c2 = await checkout(db, { phone: '01712345605', district: 'Chattogram', items: [{ variantId: v.cap, quantity: 1 }] },
        { idempotency_key: `k-${Date.now()}-c2` })
      expect(c2.id).not.toBe(c.id)
      expect(c2.merged).toBe(false)

      // Already approved: the new web order is flagged "already in Approved Orders".
      const d = await checkout(db, { phone: '01712345606', items: [{ variantId: v.cap, quantity: 1 }] })
      await advanceOrder(db, d.id, ['CONFIRMED', 'PROCESSING'])
      const d2 = await checkout(db, { phone: '01712345606', items: [{ variantId: v.cap, quantity: 1 }] })
      expect(d2.merged).toBe(false)
      const flagged = await row(db, d2.id)
      expect(flagged).toMatchObject({ duplicate_status: 'SUSPECTED', duplicate_of: d.id, duplicate_reason: 'APPROVED' })
      expect((await row(db, d.id)).merged_count).toBe(0) // the approved order is untouched

      // Switched off: nothing merges.
      await setSetting(db, 'orders', { auto_merge_web_enabled: false })
      const e = await checkout(db, { phone: '01712345607', items: [{ variantId: v.cap, quantity: 1 }] })
      await ago(db, e.id, 30)
      expect((await checkout(db, { phone: '01712345607', items: [{ variantId: v.cap, quantity: 1 }] })).merged).toBe(false)
    }))

  it('the scan merges orders already waiting, once, and staff orders join too', () =>
    inTx(async (db) => {
      const v = await setup(db)
      await setSetting(db, 'orders', { auto_merge_web_enabled: false })
      const a = await checkout(db, { phone: '01712345608', items: [{ variantId: v.cap, quantity: 1 }] })
      await ago(db, a.id, 90)
      const b = await checkout(db, { phone: '01712345608', items: [{ variantId: v.belt, quantity: 1 }] })
      expect(b.id).not.toBe(a.id)
      await setSetting(db, 'orders', { auto_merge_web_enabled: true })
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      expect(await value(db, `select public.admin_auto_merge_scan()`)).toEqual({ merged: 1 })
      expect(await value(db, `select public.admin_auto_merge_scan()`)).toEqual({ merged: 0 })
      await asSystem(db)
      expect((await row(db, b.id)).merged_into).toBe(a.id)

      // A staff-entered order for the same customer joins the waiting one.
      await asUser(db, owner)
      const staffOrder = await value<Record<string, any>>(db, `select to_jsonb(public.admin_create_order($1, false))`,
        [JSON.stringify(orderPayload({ phone: '01712345608', items: [{ variantId: v.cap, quantity: 2 }] }))])
      expect(staffOrder.id).toBe(a.id)
      await asSystem(db)
      expect(num(await value(db, `select quantity from public.order_items where order_id = $1 and variant_id = $2`, [a.id, v.cap]))).toBe(3)
    }))
})
