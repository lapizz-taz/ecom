// Live updates on the Cloudflare database send what Supabase Realtime sends: the rows a
// subscriber may read, with the columns they may read.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { liveRow } from './live-row.ts'
import type { Sql } from './sql.ts'
import { asUser, createMerchant, createStaff, freshDatabase, MERCHANT_1 } from './testing.ts'

function anOrder(sql: Sql): string {
  const customer = randomUUID()
  const id = randomUUID()
  sql.run('INSERT INTO customers (id, merchant_id, full_name, phone) VALUES (?, ?, ?, ?)', [customer, MERCHANT_1, 'Karim Mia', '01700000000'])
  sql.run(
    'INSERT INTO orders (id, merchant_id, order_number, customer_id, customer_name, customer_phone, shipping_address, shipping_district, cost_total, total_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, MERCHANT_1, 'W10501', customer, 'Karim Mia', '01700000000', 'House 7, Road 3', 'Dhaka', 400, 1330],
  )
  return id
}

describe('live updates on the Cloudflare database', () => {
  it('send staff a new order with the columns they may read; its cost stays hidden', () => {
    const sql = freshDatabase()
    const id = anOrder(sql)
    const owner = asUser(sql, createStaff(sql, 'OWNER'))
    const row = liveRow(sql, owner, 'orders', `select=*&id=eq.${id}`)
    expect(row).toMatchObject({ id, order_number: 'W10501', customer_name: 'Karim Mia', total_amount: 1330 })
    expect(row).not.toHaveProperty('cost_total')
  })

  it('send nothing about another business\'s order', () => {
    const sql = freshDatabase()
    const id = anOrder(sql)
    const otherOwner = asUser(sql, createStaff(sql, 'OWNER', createMerchant(sql)))
    expect(liveRow(sql, otherOwner, 'orders', `select=*&id=eq.${id}`)).toBeNull()
  })
})
