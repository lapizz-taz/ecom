// The security controls added to the Postgres migrations after the first snapshot are
// enforced by the Cloudflare database too (security audit run 3).
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { identityFor } from './identity.ts'
import { callRpc } from './rpc/index.ts'
import { asUser, createMerchant, createStaff, freshDatabase, MERCHANT_1, rest } from './testing.ts'

function anOrder(sql: ReturnType<typeof freshDatabase>) {
  const cust = randomUUID()
  sql.run('INSERT INTO customers (id, merchant_id, full_name, phone) VALUES (?, ?, ?, ?)', [cust, MERCHANT_1, 'Cust', '01700000000'])
  sql.run(
    'INSERT INTO orders (id, merchant_id, order_number, customer_id, customer_name, customer_phone, shipping_address, shipping_district, cost_total, total_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [randomUUID(), MERCHANT_1, 'A-1001', cust, 'Cust', '01700000000', 'addr', 'Dhaka', 123.45, 200],
  )
}

describe('Cloudflare database: controls from later migrations', () => {
  it('a store\'s staff cannot read another store\'s access mode', () => {
    const sql = freshDatabase()
    const victim = createMerchant(sql, 'Victim Store')
    sql.run("UPDATE merchants SET status = 'SUSPENDED' WHERE id = ?", [victim])
    const ctx = asUser(sql, createStaff(sql, 'OWNER'))
    const own = callRpc(sql, ctx, 'merchant_access_mode', {})
    expect(callRpc(sql, ctx, 'merchant_access_mode', { p_merchant: victim })).toBe(own)
  })

  it('order cost is hidden from staff through the API, as in Postgres (column privileges)', () => {
    const sql = freshDatabase()
    anOrder(sql)
    const ctx = asUser(sql, createStaff(sql, 'OWNER'))
    const cost = rest(sql, ctx, 'GET', 'orders?select=order_number,cost_total')
    expect(cost.status).toBe(403)
    expect(rest(sql, ctx, 'GET', 'orders?select=*').status).toBe(403)
    expect(rest(sql, ctx, 'GET', 'orders?select=order_number&cost_total=gt.0').status).toBe(403)
    const ok = rest(sql, ctx, 'GET', 'orders?select=order_number,total_amount')
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual([{ order_number: 'A-1001', total_amount: 200 }])
  })

  it('a token of a signed-out session reaches no account', () => {
    const sql = freshDatabase()
    const staff = createStaff(sql, 'OWNER')
    const session = randomUUID()
    const caller = { role: 'authenticated' as const, userId: staff, sessionId: session }
    expect(identityFor(sql, caller).uid).toBe(staff)
    sql.run('DELETE FROM sessions WHERE id = ?', [session]) // sign-out
    expect(identityFor(sql, caller).uid).toBeNull()
  })
})
