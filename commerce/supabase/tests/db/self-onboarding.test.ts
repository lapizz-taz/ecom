import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

async function newPerson(db: Db, confirmed = true) {
  await asSystem(db, null)
  const id = randomUUID()
  const email = `founder-${id.slice(0, 8)}@shop.example`
  await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, $3, '{"full_name": "Nadia Rahman"}')`,
    [id, email, confirmed ? new Date().toISOString() : null])
  return { id, email }
}

const signUp = (over: Record<string, unknown> = {}) => JSON.stringify({
  business_name: 'Nadia Crafts', full_name: 'Nadia Rahman', phone: '+880 1712-345678', business_type: 'Handicrafts',
  website: 'nadiacrafts.com.bd', sells_on: ['FACEBOOK', 'WOOCOMMERCE'], orders_per_month: '100-500', plan_code: 'GROWTH', ...over,
})

describe('self sign-up', () => {
  it('keeps the WhatsApp number for the support group: the mobile by default, +880 written short, nonsense refused', () =>
    inTx(async (db) => {
      const whatsappOf = async (over: Record<string, unknown>) => {
        const me = await newPerson(db)
        await asUser(db, me.id, me.email, null)
        const r = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`, [signUp(over)])
        await asSystem(db, null)
        return value<string>(db, `select onboarding ->> 'whatsapp' from public.merchants where id = $1`, [r.merchant_id])
      }
      expect(await whatsappOf({})).toBe('01712345678')
      expect(await whatsappOf({ whatsapp: '+880 1811-223344' })).toBe('01811223344')
      expect(await whatsappOf({ whatsapp: '+971 50 123 4567' })).toBe('+971501234567')
      const me = await newPerson(db)
      await asUser(db, me.id, me.email, null)
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp({ whatsapp: '12345' })], /WhatsApp number/)
    }))

  it('shows the public plans to anyone, never private ones', () =>
    inTx(async (db) => {
      await asAnon(db, null)
      const o = await value<Record<string, any>>(db, `select public.public_signup_options()`)
      expect(o.enabled).toBe(true)
      const codes = o.plans.map((p: { code: string }) => p.code)
      expect(codes).toEqual(expect.arrayContaining(['STARTER', 'GROWTH', 'PRO']))
      expect(codes).not.toContain('FOUNDER')
      expect(o.plans[0]).toHaveProperty('trial_days')
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp()], /permission denied/)
    }))

  it('opens the business once a person confirms their e-mail: owner, defaults and the plan trial', () =>
    inTx(async (db) => {
      const unconfirmed = await newPerson(db, false)
      await asUser(db, unconfirmed.id, unconfirmed.email, null)
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp()], /confirm your e-mail/)

      const me = await newPerson(db)
      await asUser(db, me.id, me.email, null)
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp({ phone: '12345' })], /mobile number/)
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp({ business_name: ' ' })], /business name/)
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp({ plan_code: 'FOUNDER' })], /choose one of the plans/)
      const r = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`, [signUp()])
      expect(r).toMatchObject({ plan: 'GROWTH', status: 'TRIALING' })

      await asSystem(db, null)
      const m = await value<Record<string, any>>(db, `select to_jsonb(m) from public.merchants m where id = $1`, [r.merchant_id])
      expect(m).toMatchObject({ name: 'Nadia Crafts', status: 'ONBOARDING', owner_email: me.email, phone: '01712345678', business_type: 'Handicrafts' })
      expect(m.onboarding).toMatchObject({ self_signup: true, sells_on: ['FACEBOOK', 'WOOCOMMERCE'] })
      expect(await value(db, `select r.code from public.profiles p join public.roles r on r.id = p.role_id where p.id = $1`, [me.id])).toBe('OWNER')
      expect(await value<number>(db, `select count(*)::int from public.settings where merchant_id = $1`, [r.merchant_id])).toBeGreaterThan(5)
      expect(await value(db, `select value ->> 'name' from public.settings where merchant_id = $1 and key = 'store'`, [r.merchant_id])).toBe('Nadia Crafts')
      const sub = await value<Record<string, any>>(db, `select jsonb_build_object('plan', p.code, 'status', s.status, 'trial', s.trial_ends_at > now() + interval '13 days')
        from public.subscriptions s join public.plans p on p.id = s.plan_id where s.merchant_id = $1 and s.ended_at is null`, [r.merchant_id])
      expect(sub).toEqual({ plan: 'GROWTH', status: 'TRIALING', trial: true })
      expect(await value<number>(db, `select count(*)::int from public.platform_audit_logs where action = 'merchant.self_signup' and merchant_id = $1`, [r.merchant_id])).toBe(1)

      // Signed in, they reach their own business.
      await asUser(db, me.id, me.email, r.merchant_id)
      expect(await value<Record<string, any>>(db, `select public.get_my_access()`)).toMatchObject({ merchant_id: r.merchant_id, role: 'OWNER' })

      // A second submit opens nothing new.
      await asUser(db, me.id, me.email, null)
      expect(await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`, [signUp({ business_name: 'Second shop' })]))
        .toMatchObject({ merchant_id: r.merchant_id, already: true })
      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.merchants where created_by = $1`, [me.id])).toBe(1)
    }))

  it('is closed to platform staff, existing staff keep their business, and the Super Admin can close it', () =>
    inTx(async (db) => {
      const staffId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asSystem(db, null)
      await db.query(`update auth.users set email_confirmed_at = now() where id = $1`, [staffId])
      await asUser(db, staffId, 'staff@platform.example', null)
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp()], /platform staff/)

      const agent = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, agent)
      expect(await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`, [signUp()])).toMatchObject({ already: true })

      await asSystem(db, null)
      await db.query(`update public.platform_settings set value = '{"enabled": false}' where key = 'signup'`)
      const me = await newPerson(db)
      await asUser(db, me.id, me.email, null)
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp()], /sign-ups are closed/)
      await asAnon(db, null)
      expect((await value<Record<string, any>>(db, `select public.public_signup_options()`)).enabled).toBe(false)
    }))
})
