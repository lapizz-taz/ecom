import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asService, asSystem, asUser, closePool, expectError, inTx, one, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff, orderPayload } from '../support/fixtures'

afterAll(closePool)

async function chat(db: Db) {
  await asService(db)
  const ch = await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
    [JSON.stringify({ platform: 'FACEBOOK', external_id: '1234567890', name: 'Isolation Page' })])
  return value<{ conversation_id: string; message_id: string }>(db, `select public.inbox_ingest($1::jsonb)`, [JSON.stringify({
    channel_id: ch.id, thread_key: 'psid-mod', customer: { external_id: 'psid-mod', name: 'Nadia' },
    message: { external_id: 'mod-1', body: 'I want the black belt' },
  })])
}

describe('Moderator role', () => {
  it('exists in every store, new stores included, with messaging and order creation only', () =>
    inTx(async (db) => {
      await asSystem(db)
      const perms = await value<string[]>(db, `select array_agg(p.code order by p.code) from public.roles r
        join public.role_permissions rp on rp.role_id = r.id join public.permissions p on p.id = rp.permission_id where r.code = 'MODERATOR'`)
      expect(perms).toEqual(['inbox.reply', 'inbox.view', 'orders.create'])

      await asSystem(db, null)
      const id = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
      await asSystem(db, id)
      await db.query(`select public._merchant_seed_defaults($1)`, [id])
      expect(await value<string>(db, `select name from public.roles where merchant_id = $1 and code = 'MODERATOR'`, [id])).toBe('Moderator')
      expect(await value<string[]>(db, `select array_agg(p.code order by p.code) from public.role_permissions rp join public.roles r on r.id = rp.role_id
        join public.permissions p on p.id = rp.permission_id where r.merchant_id = $1 and r.code = 'MODERATOR'`, [id])).toEqual(['inbox.reply', 'inbox.view', 'orders.create'])
    }))

  it('reads and answers chats, and creates an order from one with its source', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1750, stock: 5 })
      const c = await chat(db)
      const mod = await createStaff(db, 'MODERATOR')
      await asUser(db, mod)
      const list = await value<{ items: Array<{ id: string }> }>(db, `select public.inbox_list('{}')`)
      expect(list.items.map((i) => i.id)).toContain(c.conversation_id)
      const t = await value<{ conversation: { id: string } }>(db, `select public.inbox_thread($1)`, [c.conversation_id])
      expect(t.conversation.id).toBe(c.conversation_id)
      await db.query(`select public.inbox_update($1, $2::jsonb)`, [c.conversation_id, JSON.stringify({ labels: ['Order'], customer_phone: '01711000123' })])
      await db.query(`select public.inbox_note_add($1, 'Asked for the black one')`, [c.conversation_id])

      // The products to pick (no costs), a quote, and the order.
      expect(await value<Array<{ variant_id: string; unit_cost: unknown }>>(db, `select public.order_catalog(p_variant_ids => array[$1]::uuid[])`, [p.variantIds[0]]))
        .toEqual([expect.objectContaining({ variant_id: p.variantIds[0], unit_cost: null })])
      await expectError(db, `select unit_cost from public.order_items limit 1`, [], /permission denied/)
      const payload = orderPayload({ items: [{ variantId: p.variantIds[0], quantity: 1 }], phone: '01711000123', name: 'Nadia' })
      const quote = await value<{ total: string | number }>(db, `select public.admin_quote_order($1::jsonb, 'Dhaka')`, [JSON.stringify(payload.items)])
      expect(Number(quote.total)).toBeGreaterThan(0)
      const order = await value<{ id: string; order_number: string }>(db, `select to_jsonb(public.admin_create_order($1, false))`, [JSON.stringify(payload)])
      expect(order.order_number).toBeTruthy()
      expect(await value(db, `select (public.admin_set_order_source($1, 'MESSENGER')).source`, [order.id])).toBe('Messenger')
      await db.query(`select public.inbox_update($1, $2::jsonb)`, [c.conversation_id, JSON.stringify({ linked_order_id: order.id })])
      await asSystem(db)
      expect(await value(db, `select linked_order_id from public.inbox_conversations where id = $1`, [c.conversation_id])).toBe(order.id)
    }))

  it('sees no orders, customers, sales, stock or settings, and changes no order', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 900, stock: 10 })
      const other = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asService(db)
      await db.query(`insert into public.customers (full_name, phone) values ('Rahim', '01711000999')`)
      const mod = await createStaff(db, 'MODERATOR')
      await asUser(db, mod)
      expect(await value<number>(db, `select count(*)::int from public.orders`)).toBe(0)
      expect(await value<number>(db, `select count(*)::int from public.customers`)).toBe(0)
      expect(await value<number>(db, `select count(*)::int from public.finance_transactions`)).toBe(0)
      await expectError(db, `select public.dashboard_command_center(current_date - 7, current_date)`, [], /PERMISSION_DENIED|dashboard/)
      await expectError(db, `select public.order_cost_summary($1)`, [other.id], /visible to finance|PERMISSION_DENIED/)
      // Someone else's order: no source change, no status change.
      await expectError(db, `select public.admin_set_order_source($1, 'MESSENGER')`, [other.id], /PERMISSION_DENIED|permission/i)
      await expectError(db, `select public.transition_order_status($1, 'CONFIRMED')`, [other.id], /PERMISSION_DENIED|permission/i)
      // ...and no linking someone else's order to a chat (that would show it there).
      const c = await chat(db)
      await asUser(db, mod)
      await expectError(db, `select public.inbox_update($1, $2::jsonb)`, [c.conversation_id, JSON.stringify({ linked_order_id: other.id })], /PERMISSION_DENIED|permission/i)
      // Messaging setup stays with managers.
      await expectError(db, `select public.inbox_saved_reply_save('{"title":"Hi","body":"Hello"}')`, [], /permission/i)
      await expectError(db, `select * from public.inbox_channels`, [], /permission/i)
    }))

  it('other roles keep their access; setting a source still needs orders.update for anyone else', () =>
    inTx(async (db) => {
      await asSystem(db)
      const call = await value<string[]>(db, `select array_agg(p.code order by p.code) from public.roles r
        join public.role_permissions rp on rp.role_id = r.id join public.permissions p on p.id = rp.permission_id where r.code = 'CALL'`)
      expect(call).toEqual(['inbox.reply', 'inbox.view', 'orders.status', 'orders.update', 'orders.view', 'pbx.call'])
      const p = await createProduct(db, { price: 900, stock: 10 })
      const o = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      expect(await value(db, `select (public.admin_set_order_source($1, 'MESSENGER')).source`, [o.id])).toBe('Messenger')
      await asUser(db, await createStaff(db, 'VIEWER'))
      await expectError(db, `select public.admin_set_order_source($1, 'MESSENGER')`, [o.id], /PERMISSION_DENIED|permission/i)
    }))

  it('picks products for an order without their cost or stock count; the product tables stay closed', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 900, cost: 400, stock: 7 })
      const name = await value<string>(db, `select name from public.products where id = $1`, [p.productId])
      await asUser(db, await createStaff(db, 'MODERATOR'))
      expect(await value<number>(db, `select count(*)::int from public.products`)).toBe(0)
      expect(await value<number>(db, `select count(*)::int from public.product_variants`)).toBe(0)
      const byId = await value<Array<Record<string, unknown>>>(db, `select public.order_catalog(null, $1::uuid[])`, [p.variantIds])
      expect(byId).toHaveLength(1)
      expect(byId[0]).toMatchObject({ variant_id: p.variantIds[0], product_name: name, unit_price: 900, unit_cost: null, available: null, in_stock: true })
      const byName = await value<Array<Record<string, unknown>>>(db, `select public.order_catalog($1)`, [name])
      expect(byName.map((v) => v.variant_id)).toEqual(p.variantIds)
      expect(JSON.stringify(byName)).not.toContain('400')

      // Staff who may see costs and stock get both.
      await asUser(db, await createStaff(db, 'OWNER'))
      const own = await value<Array<Record<string, unknown>>>(db, `select public.order_catalog(null, $1::uuid[])`, [p.variantIds])
      expect(own[0]).toMatchObject({ unit_cost: 400, available: 7, in_stock: true })

      // Someone who neither creates orders, answers chats nor works with products gets nothing.
      await asSystem(db)
      await db.query(`insert into public.roles (merchant_id, code, name) values ($1, 'NOTHING', 'Nothing')`, [MERCHANT_1])
      await asUser(db, await createStaff(db, 'NOTHING'))
      await expectError(db, `select public.order_catalog('a')`, [], /PERMISSION_DENIED/)
    }))
})
