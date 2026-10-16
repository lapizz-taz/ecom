import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

/** A business that signed up on GROWTH with a trial, signed in as its owner. */
async function owner(db: Db) {
  await asSystem(db, null)
  await db.query(`update public.platform_settings set value = value || '{"method":"online_payment"}'::jsonb where key = 'onboarding'`)
  await db.query(`update public.platform_settings set value = jsonb_set(value, '{bkash,enabled}', 'true') where key = 'billing_gateways'`)
  const id = randomUUID()
  const email = `owner-${id.slice(0, 8)}@shop.example`
  await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{"full_name": "Nadia Rahman"}')`, [id, email])
  await asUser(db, id, email, null)
  const r = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`,
    [JSON.stringify({ business_name: 'Nadia Crafts', full_name: 'Nadia Rahman', phone: '01712345678', plan_code: 'GROWTH' })])
  await asUser(db, id, email, r.merchant_id)
  return { id, email, merchant: r.merchant_id as string }
}
const sub = async (db: Db, merchant: string) => {
  await asSystem(db, null)
  return value<Record<string, any>>(db, `select jsonb_build_object('plan', p.code, 'status', s.status, 'price', s.price,
      'days', round(extract(epoch from s.current_period_end - s.current_period_start) / 86400))
    from public.subscriptions s join public.plans p on p.id = s.plan_id where s.merchant_id = $1 and s.ended_at is null`, [merchant])
}

describe('choosing a plan in Plan & Billing', () => {
  it('lists the plans, and changes the plan only once the gateway confirms the payment', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      const other = await value<string>(db, `select code from public.plans where status = 'ACTIVE' and is_public and price > 0 and code <> 'GROWTH' order by price desc limit 1`)
      const price = Number(await value(db, `select price from public.plans where code = $1`, [other]))
      const m = await owner(db)

      const options = await value<Record<string, any>>(db, `select public.billing_plan_options()`)
      expect(options.current).toMatchObject({ code: 'GROWTH', status: 'TRIALING' })
      expect(options.plans.map((p: { code: string }) => p.code)).toContain(other)
      await expectError(db, `select public.billing_choose_plan('GROWTH')`, [], /already on the/)
      await expectError(db, `select public.billing_choose_plan('NOPE')`, [], /not available/)

      const inv = await value<Record<string, any>>(db, `select public.billing_choose_plan($1)`, [other])
      expect(inv).toMatchObject({ applied: false, status: 'OPEN' })
      expect(Number(inv.total)).toBe(price)
      // Nothing changes before the payment.
      expect(await sub(db, m.merchant)).toMatchObject({ plan: 'GROWTH', status: 'TRIALING' })
      await asUser(db, m.id, m.email, m.merchant)
      expect((await value<Record<string, any>>(db, `select public.billing_plan_options()`)).pending).toMatchObject({ invoice_id: inv.id, plan: other })

      // Choosing again replaces the waiting invoice.
      const again = await value<Record<string, any>>(db, `select public.billing_choose_plan($1)`, [other])
      await asSystem(db, null)
      expect(await value(db, `select status from public.billing_invoices where id = $1`, [inv.id])).toBe('VOID')

      // The browser cannot confirm a payment; the gateway's confirmation of the full amount can.
      await asService(db, m.merchant)
      const pay = await value<{ reference: string }>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [again.id])
      await asUser(db, m.id, m.email, m.merchant)
      await expectError(db, `select public.billing_gateway_confirm($1, 'bkash', 'TXN-PC-1', $2, true, '{}')`, [pay.reference, price], /permission denied|PERMISSION_DENIED/)
      expect(await sub(db, m.merchant)).toMatchObject({ plan: 'GROWTH' })
      await asService(db, m.merchant)
      expect(await value(db, `select public.billing_gateway_confirm($1, 'bkash', 'TXN-PC-2', $2, true, '{}') ->> 'status'`, [pay.reference, price])).toBe('succeeded')
      // A duplicate callback changes nothing more.
      await value(db, `select public.billing_gateway_confirm($1, 'bkash', 'TXN-PC-2', $2, true, '{}')`, [pay.reference, price])

      const after = await sub(db, m.merchant)
      expect(after).toMatchObject({ plan: other, status: 'ACTIVE' })
      expect(Number(after.price)).toBe(price)
      expect(Number(after.days)).toBeGreaterThanOrEqual(28)
      expect(await value(db, `select count(*)::int from public.subscription_events e join public.subscriptions s on s.id = e.subscription_id
        where s.merchant_id = $1 and e.event = 'plan.changed'`, [m.merchant])).toBe(1)
    }))

  it('only the owner or settings managers can change the plan', () =>
    inTx(async (db) => {
      const m = await owner(db)
      const viewer = await createStaff(db, 'VIEWER', `v-${randomUUID().slice(0, 6)}@shop.example`, m.merchant)
      await asUser(db, viewer, 'viewer@shop.example', m.merchant)
      await expectError(db, `select public.billing_choose_plan('GROWTH')`, [], /only the owner/)
    }))
})
