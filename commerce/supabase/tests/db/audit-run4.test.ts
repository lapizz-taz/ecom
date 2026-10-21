// Security audit run 4: order costs from Super Edit, the inbox's customer link by phone, and the
// one-time setup fee on a plan change. Each case is the audit's reproduction, now refused.
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, MERCHANT_1, one, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

describe('Super Edit and order costs', () => {
  it('a role with Super Edit but no cost access does not get the order cost back; the owner does', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, cost: 400, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const owner = await createStaff(db, 'OWNER')
      const caller = await createStaff(db, 'CALL')
      await asUser(db, owner)
      await db.query(`insert into public.role_permissions (merchant_id, role_id, permission_id)
        select $1, (select id from public.roles where code = 'CALL'), (select id from public.permissions where code = 'orders.override')`, [MERCHANT_1])

      await asUser(db, caller)
      const r = await value<{ order: Record<string, unknown> }>(db, `select public.admin_override_order($1, '{}'::jsonb, null)`, [order.id])
      expect(r.order.id).toBe(order.id)
      expect('cost_total' in r.order).toBe(false)

      await asUser(db, owner)
      const o = await value<{ order: Record<string, unknown> }>(db, `select public.admin_override_order($1, '{}'::jsonb, null)`, [order.id])
      expect(Number(o.order.cost_total)).toBe(400)
    }))

  it('an order edit naming cost_total does not copy the cost into the audit log', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, cost: 400, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, await createStaff(db, 'ADMIN'))
      await db.query(`select public.admin_update_order($1, '{"cost_total": 0, "customer_note": "call first"}'::jsonb)`, [order.id])
      await asSystem(db, MERCHANT_1)
      const log = await one<{ before: Record<string, unknown>; after: Record<string, unknown> }>(db,
        `select old_values as before, new_values as after from public.audit_logs where action = 'order.edited' and entity_id = $1 order by created_at desc limit 1`, [order.id])
      expect(log.after.customer_note).toBe('call first')
      expect('cost_total' in log.before).toBe(false)
      expect('cost_total' in log.after).toBe(false)
    }))
})

describe('inbox customer link', () => {
  async function setup(db: Db) {
    await asSystem(db, MERCHANT_1)
    const roleId = await value<string>(db,
      `insert into public.roles (merchant_id, code, name, rank) values ($1, 'CHATONLY', 'Chat Only', 10) returning id`, [MERCHANT_1])
    await db.query(`insert into public.role_permissions (merchant_id, role_id, permission_id)
      select $1, $2, p.id from public.permissions p where p.code in ('inbox.view','inbox.reply')`, [MERCHANT_1, roleId])
    const agent = await createStaff(db, 'CHATONLY')
    const product = await createProduct(db, { price: 1000, stock: 5 })
    const order = await createOrder(db, { name: 'Dummy Shopper', phone: '01799888777', district: 'Dhaka', items: [{ variantId: product.variantIds[0], quantity: 1 }] })
    await asService(db, MERCHANT_1)
    const ch = (await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
      [JSON.stringify({ platform: 'FACEBOOK', external_id: '7777777004', name: 'Audit Page' })])).id
    const conv = (await value<{ conversation_id: string }>(db, `select public.inbox_ingest($1::jsonb)`,
      [JSON.stringify({ channel_id: ch, thread_key: 'psid-r4', customer: { external_id: 'psid-r4', name: 'Someone' }, message: { external_id: 'm_r4_1', body: 'hi' } })])).conversation_id
    return { agent, order, conv }
  }
  const linked = async (db: Db, conv: string) => {
    const t = await value<{ conversation: { customer_id: string | null } }>(db, `select public.inbox_thread($1)`, [conv])
    const item = (await value<{ items: Array<{ id: string; has_order: boolean }> }>(db, `select public.inbox_list('{}'::jsonb)`)).items.find((i) => i.id === conv)!
    return { customer: t.conversation.customer_id, hasOrder: item.has_order }
  }

  it('an agent without customers.view can save the phone but not learn who the customer is', () =>
    inTx(async (db) => {
      const { agent, conv } = await setup(db)
      await asUser(db, agent)
      await db.query(`select public.inbox_update($1, $2::jsonb)`, [conv, JSON.stringify({ customer_phone: '01799888777' })])
      expect(await linked(db, conv)).toEqual({ customer: null, hasOrder: false })
      expect(await value<string>(db, `select public.inbox_thread($1) -> 'conversation' ->> 'customer_phone'`, [conv])).toBe('01799888777')
      await expectError(db, `select public.inbox_update($1, $2::jsonb)`, [conv, JSON.stringify({ customer_id: '' })], /permission/i)
      await expectError(db, `select public.inbox_update($1, $2::jsonb)`, [conv, JSON.stringify({ customer_id: null })], /permission/i)
    }))

  it('staff who may see customers still get the chat linked by phone', () =>
    inTx(async (db) => {
      const { order, conv } = await setup(db)
      await asUser(db, await createStaff(db, 'ADMIN'))
      await db.query(`select public.inbox_update($1, $2::jsonb)`, [conv, JSON.stringify({ customer_phone: '01799888777' })])
      expect(await linked(db, conv)).toEqual({ customer: order.customer_id, hasOrder: true })
    }))
})

describe('setup fee and plan changes', () => {
  const OFFER = { enabled: true, trial_days: 0, first_price: 99, first_periods: 1, setup_fee: 1000 }

  async function signUp(db: Db) {
    await asSystem(db, null)
    await db.query(`update public.platform_settings set value = value || '{"method": "online_payment"}' where key = 'onboarding'`)
    await db.query(`update public.platform_settings set value = jsonb_set(value, '{bkash,enabled}', 'true') where key = 'billing_gateways'`)
    await db.query(`insert into public.platform_settings (key, value) values ('signup_offer', '{}') on conflict (key) do nothing`)
    await db.query(`update public.platform_settings set value = value || $1::jsonb where key = 'signup_offer'`, [JSON.stringify(OFFER)])
    const id = randomUUID()
    const email = `r4-${id.slice(0, 8)}@shop.example`
    await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{"full_name": "Dummy Owner"}')`, [id, email])
    await asUser(db, id, email, null)
    const r = await value<{ merchant_id: string }>(db, `select public.merchant_self_onboard($1)`,
      [JSON.stringify({ business_name: 'Dummy Shop', full_name: 'Dummy Owner', phone: '01712345678', plan_code: 'GROWTH' })])
    const m = { id, email, merchant: r.merchant_id }
    // The offer's first invoice is paid, then the offer period ends: the renewal carries the fee.
    const first = await openRenewal(db, m.merchant)
    await pay(db, m.merchant, first.id, Number(first.total))
    await asSystem(db, null)
    await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                    where merchant_id = $1 and ended_at is null`, [m.merchant])
    await db.query(`select public.billing_run()`)
    return m
  }
  const openRenewal = async (db: Db, merchant: string) => {
    await asSystem(db, null)
    return value<{ id: string; total: number; lines: Array<{ kind: string; amount: number }> }>(db, `select to_jsonb(i) from public.billing_invoices i
      where merchant_id = $1 and kind = 'SUBSCRIPTION' and status = 'OPEN' order by created_at desc, period_start desc limit 1`, [merchant])
  }
  async function pay(db: Db, merchant: string, invoice: string, amount: number) {
    await asService(db, merchant)
    const p = await value<{ reference: string }>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [invoice])
    return value<string>(db, `select public.billing_gateway_confirm($1, 'bkash', $2, $3, true, '{}') ->> 'status'`, [p.reference, `TXN-${randomUUID().slice(0, 8)}`, amount])
  }

  it('past due on its own plan, a business pays the open renewal: it cannot re-buy the plan without the fee', () =>
    inTx(async (db) => {
      const m = await signUp(db)
      const renewal = await openRenewal(db, m.merchant)
      expect(renewal.lines.map((l) => l.kind)).toContain('setup_fee')
      await asUser(db, m.id, m.email, m.merchant)
      await expectError(db, `select public.billing_choose_plan('GROWTH')`, [], /pay the open renewal invoice/)
    }))

  it('a different plan while the fee is pending carries the fee; the plan keeps its own price afterwards', () =>
    inTx(async (db) => {
      const m = await signUp(db)
      await asSystem(db, null)
      const other = await one<{ code: string; price: number }>(db,
        `select code, price from public.plans where status = 'ACTIVE' and is_public and price > 0 and code <> 'GROWTH' order by price desc limit 1`)
      await asUser(db, m.id, m.email, m.merchant)
      const pc = await value<{ id: string; total: number }>(db, `select public.billing_choose_plan($1)`, [other.code])
      expect(Number(pc.total)).toBe(Number(other.price) + 1000)
      expect(await pay(db, m.merchant, pc.id, Number(pc.total))).toBe('succeeded')
      await asSystem(db, null)
      const s = await one<{ status: string; price: number }>(db, `select status, price from public.subscriptions where merchant_id = $1 and ended_at is null`, [m.merchant])
      expect(s.status).toBe('ACTIVE')
      expect(Number(s.price)).toBe(Number(other.price))
      const paid = await value<Array<{ kind: string }[]>>(db, `select jsonb_agg(lines) from public.billing_invoices where merchant_id = $1 and status = 'PAID'`, [m.merchant])
      expect(paid.filter((lines) => lines.some((l) => l.kind === 'setup_fee'))).toHaveLength(1)
      // The fee is charged once: the next renewal is the plan alone.
      await db.query(`update public.subscriptions set current_period_end = now() - interval '1 minute' where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      const next = await openRenewal(db, m.merchant)
      expect(next.lines.map((l) => l.kind)).not.toContain('setup_fee')
    }))
})

describe('store phone pattern', () => {
  it('refuses patterns that backtrack badly without nesting an unbounded group in an unbounded one', () =>
    inTx(async (db) => {
      await asSystem(db, MERCHANT_1)
      const save = (pattern: string) => db.query(`insert into public.settings (key, value) values ('store', jsonb_build_object('phone_pattern', $1::text))
        on conflict (merchant_id, key) do update set value = public.settings.value || excluded.value`, [pattern])
      for (const p of ['^((\\d*){10}){10}x$', `^${'\\d*'.repeat(50)}x$`, '^\\d*\\d*\\d*\\d*x$']) {
        await db.query('savepoint p')
        await expect(save(p)).rejects.toThrow(/nested repetition/)
        await db.query('rollback to savepoint p')
      }
      await save('^(?:01|8801)[3-9]\\d{8}$')
      expect(await value(db, `select public.setting_text('store', array['phone_pattern'], '')`)).toBe('^(?:01|8801)[3-9]\\d{8}$')
    }))
})
