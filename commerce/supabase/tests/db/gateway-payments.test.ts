import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff, setSetting, transition } from '../support/fixtures'

afterAll(closePool)

/** An order waiting for a ৳55 advance, as the checkout leaves it. */
async function advanceOrder(db: Db, phone: string) {
  const p = await createProduct(db, { price: 600, stock: 5 })
  const order = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  await asSystem(db)
  await db.query(`update public.orders set advance_required = 55, advance_type = 'FIXED' where id = $1`, [order.id])
  await transition(db, order.id, 'ADVANCE_REQUIRED')
  return order
}

async function start(db: Db, orderNumber: string, phone: string, provider = 'bkash') {
  await asService(db)
  return one<{ id: string; reference: string; amount: string }>(db,
    `select id, reference, amount from public.start_order_payment($1, $2, 'ADVANCE', $3, 'BKASH')`, [orderNumber, phone, provider])
}

describe('gateway payments', () => {
  it('remembers every attempt and finds the payment from any of them', () =>
    inTx(async (db) => {
      const order = await advanceOrder(db, '01711000601')
      const payment = await start(db, order.order_number, '01711000601')
      expect(num(payment.amount)).toBe(55)
      await db.query(`select public.attach_gateway_session($1, 'https://bkash/pay/A', 'TR-A', '{"bkash_payment_id":"TR-A"}')`, [payment.id])
      // The customer comes back and tries again: same payment, new bKash session.
      expect((await start(db, order.order_number, '01711000601')).id).toBe(payment.id)
      await db.query(`select public.attach_gateway_session($1, 'https://bkash/pay/B', 'TR-B')`, [payment.id])
      expect(await value(db, `select (public.find_gateway_payment('bkash', 'TR-A')).id`)).toBe(payment.id)
      expect(await value(db, `select (public.find_gateway_payment('bkash', 'TR-B')).id`)).toBe(payment.id)
      expect(await value(db, `select (public.find_gateway_payment('bkash', 'TR-X')).id`)).toBeNull()
      expect(await value(db, `select jsonb_array_length(metadata -> 'sessions') from public.payments where id = $1`, [payment.id])).toBe(2)
    }))

  it('records a confirmed payment even after another attempt was cancelled, and approves the order', () =>
    inTx(async (db) => {
      const order = await advanceOrder(db, '01711000602')
      const payment = await start(db, order.order_number, '01711000602')
      const confirm = (event: string, ok: boolean, amount: number | null) => value<{ status: string }>(db,
        `select public.confirm_payment($1, 'bkash', $2, $3, $4, 'test', '{}'::jsonb, $5)`,
        [payment.reference, ok ? 'TRX-1' : null, amount, event, ok])
      expect((await confirm('bkash:TR-B:cancel', false, null)).status).toBe('failed')
      expect((await confirm('bkash:trx:TRX-1', true, 55)).status).toBe('succeeded')
      // The same confirmation again changes nothing.
      expect((await confirm('bkash:trx:TRX-1', true, 55)).status).toBe('duplicate_event')
      await asSystem(db)
      expect(await one(db, `select status from public.payments where id = $1`, [payment.id])).toEqual({ status: 'SUCCEEDED' })
      const o = await one<Record<string, string>>(db, `select status, amount_paid, payment_status from public.orders where id = $1`, [order.id])
      expect(o.status).toBe('CONFIRMED')
      expect(num(o.amount_paid)).toBe(55)
      expect(await value(db, `select channel::text from public.order_payments where payment_id = $1`, [payment.id])).toBe('BKASH')
    }))

  it('holds a short payment for review instead of approving the order', () =>
    inTx(async (db) => {
      const order = await advanceOrder(db, '01711000603')
      const payment = await start(db, order.order_number, '01711000603')
      expect((await value<{ status: string }>(db,
        `select public.confirm_payment($1, 'bkash', 'TRX-2', 5, 'bkash:trx:TRX-2', 'test', '{}'::jsonb, true)`, [payment.reference])).status)
        .toBe('amount_mismatch')
      await asSystem(db)
      expect(await value(db, `select status::text from public.orders where id = $1`, [order.id])).toBe('ADVANCE_REQUIRED')
    }))

  it('lists only old pending gateway attempts for the reconcile job', () =>
    inTx(async (db) => {
      const order = await advanceOrder(db, '01711000604')
      const payment = await start(db, order.order_number, '01711000604')
      await db.query(`select public.attach_gateway_session($1, null, 'TR-OLD')`, [payment.id])
      expect(await value(db, `select count(*)::int from public.gateway_payments_to_reconcile() where id = $1`, [payment.id])).toBe(0)
      await asSystem(db)
      await db.query(`update public.payments set created_at = now() - interval '10 minutes' where id = $1`, [payment.id])
      await asService(db)
      expect(await one(db, `select sessions, age_minutes >= 10 as old from public.gateway_payments_to_reconcile() where id = $1`, [payment.id]))
        .toEqual({ sessions: ['TR-OLD'], old: true })
    }))

  it('offers bKash at checkout only once it is connected', () =>
    inTx(async (db) => {
      const providers = async () => {
        await asAnon(db)
        return (await value<{ payments: { providers: Array<{ code: string }> } }>(db, `select public.storefront_config()`))
          .payments.providers.map((p) => p.code)
      }
      await asService(db)
      await db.query(`select public.payment_set_provider('bkash', true, true)`)
      expect(await providers()).not.toContain('bkash')
      await asSystem(db)
      await db.query(`insert into public.integration_credentials(key, hint, connected_at) values ('payments.bkash', 'App key ••••1234', now())`)
      expect(await providers()).toContain('bkash')
      expect((await providers())[0]).toBe('bkash')
      await setSetting(db, 'payments', {})
      await asService(db)
      await db.query(`select public.payment_set_provider('bkash', false)`)
      expect(await providers()).not.toContain('bkash')
    }))

  it('shares the bKash token through Vault, never in a table', () =>
    inTx(async (db) => {
      await asService(db)
      expect(await value(db, `select public.gateway_token_get('bkash')`)).toBeNull()
      await db.query(`select public.gateway_token_put('bkash', '{"id":"abc","token":"tok-1","expiresAt":1}')`)
      await db.query(`select public.gateway_token_put('bkash', '{"id":"abc","token":"tok-2","expiresAt":2}')`)
      expect(await value(db, `select public.gateway_token_get('bkash')`)).toEqual({ id: 'abc', token: 'tok-2', expiresAt: 2 })
      await asSystem(db)
      expect(await value(db, `select count(*)::int from vault.secrets where name = 'gateway-token:bkash'`)).toBe(1)
      expect(await value(db, `select count(*)::int from public.integration_credentials where key like '%token%'`)).toBe(0)
      await asService(db)
      await expectError(db, `select public.gateway_token_put('../x', '{}')`, [], /bad gateway token/)
    }))

  it('keeps the gateway plumbing away from browsers', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await expectError(db, `select public.payment_set_provider('bkash', true)`, [], /permission denied/)
      await expectError(db, `select public.find_gateway_payment('bkash', 'x')`, [], /permission denied/)
      await expectError(db, `select public.gateway_token_get('bkash')`, [], /permission denied/)
      await asAnon(db)
      await expectError(db, `select public.gateway_payments_to_reconcile()`, [], /permission denied/)
    }))
})
