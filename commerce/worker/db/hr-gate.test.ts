// The HRM work gate on the Cloudflare database, as in Postgres (security audit run 4): with "Require
// check-in to work" on, a staffer who has not checked in (or is on a break) cannot change orders,
// products or stock, through functions or through row security; viewing still works.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { callRpc } from './rpc/index.ts'
import { asUser, createStaff, freshDatabase, MERCHANT_1, rest } from './testing.ts'

function errorOf(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return (e as Error).message }
}

describe('HRM work gate', () => {
  it('not checked in: no changes; checked in: changes; on a break: none again', () => {
    const sql = freshDatabase()
    const owner = createStaff(sql, 'OWNER')
    const staff = createStaff(sql, 'ADMIN')
    const productId = randomUUID()
    sql.run('INSERT INTO products (id, merchant_id, name, slug, price) VALUES (?, ?, ?, ?, ?)', [productId, MERCHANT_1, 'Dummy', `dummy-${productId.slice(0, 6)}`, 100])
    expect(asUser(sql, staff).hasPermission('orders.update')).toBe(true)

    callRpc(sql, asUser(sql, owner), 'hr_settings_save', { p: { require_check_in: true } })
    expect(asUser(sql, staff).hasPermission('orders.update')).toBe(false)
    expect(asUser(sql, staff).hasPermission('orders.view')).toBe(true)
    expect(asUser(sql, owner).hasPermission('orders.update')).toBe(true)
    expect(errorOf(() => callRpc(sql, asUser(sql, staff), 'admin_update_order', { p_order_id: randomUUID(), p_changes: {} }))).toMatch(/CHECK_IN_REQUIRED/)
    rest(sql, asUser(sql, staff), 'PATCH', `products?id=eq.${productId}`, { body: { name: 'Changed' } })
    expect(sql.all('SELECT name FROM products WHERE id = ?', [productId])[0].name).toBe('Dummy')

    callRpc(sql, asUser(sql, staff), 'hr_check_in', { p_note: null })
    expect(asUser(sql, staff).hasPermission('orders.update')).toBe(true)
    expect(errorOf(() => callRpc(sql, asUser(sql, staff), 'admin_update_order', { p_order_id: randomUUID(), p_changes: {} }))).toMatch(/NOT_FOUND/)

    callRpc(sql, asUser(sql, staff), 'hr_break_start', {})
    expect(asUser(sql, staff).hasPermission('orders.update')).toBe(false)
    expect(errorOf(() => callRpc(sql, asUser(sql, staff), 'admin_update_order', { p_order_id: randomUUID(), p_changes: {} }))).toMatch(/ON_BREAK/)
  })
})
