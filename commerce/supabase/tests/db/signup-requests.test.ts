import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff } from '../support/fixtures'

afterAll(closePool)

const asStaff = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)
const request = (over: Record<string, unknown> = {}) => JSON.stringify({
  business_name: 'Nadia Crafts', full_name: 'Nadia Rahman', phone: '01712345678', email: 'nadia@shop.example',
  business_type: 'Fashion', sells_on: ['Facebook', 'Website'], orders_per_month: '100-500', plan_code: 'GROWTH', ...over,
})

async function openWhatsapp(db: Db, staff: string) {
  await asStaff(db, staff)
  await value(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({ method: 'online_payment', whatsapp_number: '+880 1811-000000', reminder_days: [3] })])
  return value<Record<string, any>>(db, `select public.platform_setting_save('signup', $1, 'open WhatsApp sign-up')`, [JSON.stringify({ enabled: true, whatsapp: { enabled: true } })])
}

describe('sign-up switches', () => {
  it('shows each way on the public page only when it is switched on, and needs the official number for WhatsApp', () =>
    inTx(async (db) => {
      const staff = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asAnon(db)
      expect(await value(db, `select public.public_signup_options() -> 'whatsapp_signup' ->> 'enabled'`)).toBe('false')

      await asStaff(db, staff)
      await value(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({ method: 'online_payment', whatsapp_number: '', reminder_days: [3] })])
      await expectError(db, `select public.platform_setting_save('signup', $1)`, [JSON.stringify({ whatsapp: { enabled: true } })], /official WhatsApp number/)

      const saved = await openWhatsapp(db, staff)
      expect(saved).toMatchObject({ enabled: true, whatsapp: { enabled: true } })
      await asAnon(db)
      expect(await value(db, `select public.public_signup_options()`)).toMatchObject({ enabled: true, whatsapp_signup: { enabled: true, number: '8801811000000' } })

      // Normal sign-up off, WhatsApp on: the page offers only WhatsApp, and self-onboarding is refused on the server.
      await asStaff(db, staff)
      await value(db, `select public.platform_setting_save('signup', $1, 'WhatsApp only')`, [JSON.stringify({ enabled: false })])
      await asAnon(db)
      expect(await value(db, `select public.public_signup_options()`)).toMatchObject({ enabled: false, whatsapp_signup: { enabled: true } })
      await asSystem(db, null)
      const person = '00000000-0000-4000-8000-00000000a701'
      await db.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'walkin@shop.example', now())`, [person])
      await asUser(db, person, 'walkin@shop.example', null)
      await expectError(db, `select public.merchant_self_onboard($1)`, [request()], /paused|closed|not open/i)
    }))

  it('lets only staff who edit settings change the switches', () =>
    inTx(async (db) => {
      const viewer = await createPlatformStaff(db, 'VIEWER')
      await asStaff(db, viewer)
      await expectError(db, `select public.platform_setting_save('signup', $1)`, [JSON.stringify({ enabled: false })], /PERMISSION_DENIED|permission/i)
      await asAnon(db)
      await expectError(db, `select public.platform_signup_settings_save($1)`, [JSON.stringify({ enabled: false })], /permission denied/)
    }))
})

describe('sign-up by WhatsApp', () => {
  it('keeps the details as a request and returns the message, without creating a login or a business', () =>
    inTx(async (db) => {
      const staff = await createPlatformStaff(db, 'SUPER_ADMIN')
      await openWhatsapp(db, staff)
      await asSystem(db, null)
      const before = await value<number>(db, `select (select count(*) from auth.users)::int + (select count(*) from public.merchants)::int`)

      await asAnon(db)
      const r = await value<Record<string, any>>(db, `select public.public_signup_request($1)`, [request()])
      expect(r.whatsapp_number).toBe('8801811000000')
      expect(r.message).toContain('Business: Nadia Crafts')
      expect(r.message).toContain('Mobile: 01712345678')
      expect(r.message).toContain('Sells on: Facebook, Website')
      expect(r.message).toContain(`Request: ${r.reference}`)

      await asSystem(db, null)
      expect(await value<number>(db, `select (select count(*) from auth.users)::int + (select count(*) from public.merchants)::int`)).toBe(before)

      // The same mobile again is a new request; the first one is never overwritten.
      await asAnon(db)
      const again = await value<Record<string, any>>(db, `select public.public_signup_request($1)`, [request({ business_name: 'Nadia Crafts BD' })])
      expect(again.id).not.toBe(r.id)
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.signup_requests`)).toBe(2)
      expect(await value(db, `select business_name from public.signup_requests where id = $1`, [r.id])).toBe('Nadia Crafts')

      // Platform staff were told.
      expect(await value(db, `select count(*)::int from public.platform_notifications where user_id = $1 and kind = 'signup.request'`, [staff])).toBe(2)
    }))

  it('checks the details and refuses when WhatsApp sign-up is off', () =>
    inTx(async (db) => {
      await asAnon(db)
      await expectError(db, `select public.public_signup_request($1)`, [request()], /not open/)
      const staff = await createPlatformStaff(db, 'SUPER_ADMIN')
      await openWhatsapp(db, staff)
      await asAnon(db)
      await expectError(db, `select public.public_signup_request($1)`, [request({ phone: '12345' })], /mobile number/)
      await expectError(db, `select public.public_signup_request($1)`, [request({ business_name: '' })], /business name/)
      await expectError(db, `select public.public_signup_request($1)`, [request({ email: 'not-an-email' })], /e-mail/)
    }))

  it('stops a flood of requests', () =>
    inTx(async (db) => {
      const staff = await createPlatformStaff(db, 'SUPER_ADMIN')
      await openWhatsapp(db, staff)
      await asSystem(db, null)
      await db.query(`insert into public.signup_requests (business_name, full_name, phone, message)
        select 'Shop ' || g, 'Person', '0171' || lpad(g::text, 7, '0'), 'x' from generate_series(1, 200) g`)
      await asAnon(db)
      await expectError(db, `select public.public_signup_request($1)`, [request({ phone: '01999999999' })], /RATE_LIMITED/)
    }))

  it('shows requests only to platform staff, who mark them and link the business opened', () =>
    inTx(async (db) => {
      const staff = await createPlatformStaff(db, 'SUPER_ADMIN')
      await openWhatsapp(db, staff)
      await asAnon(db)
      const r = await value<Record<string, any>>(db, `select public.public_signup_request($1)`, [request()])
      await expectError(db, `select * from public.signup_requests`, [], /permission denied/)
      await expectError(db, `select public.platform_signup_requests()`, [], /permission denied/)

      const support = await createPlatformStaff(db, 'SUPPORT_AGENT')
      await asStaff(db, support)
      expect(await value<any[]>(db, `select public.platform_signup_requests()`)).toHaveLength(1)
      await expectError(db, `select public.platform_signup_request_update($1, 'CONTACTED')`, [r.id], /PERMISSION_DENIED|permission/i)

      await asStaff(db, staff)
      expect(await value(db, `select public.platform_signup_request_update($1, 'CONTACTED', null, 'Called back') ->> 'status'`, [r.id])).toBe('CONTACTED')
      await expectError(db, `select public.platform_signup_request_update($1, 'CONVERTED')`, [r.id], /choose the business/)
      await asSystem(db, null)
      const merchant = await value<string>(db, `select id from public.merchants order by created_at limit 1`)
      await asStaff(db, staff)
      const done = await value<Record<string, any>>(db, `select public.platform_signup_request_update($1, 'CONVERTED', $2)`, [r.id, merchant])
      expect(done).toMatchObject({ status: 'CONVERTED', merchant_id: merchant, note: 'Called back' })
      expect((await value<any[]>(db, `select public.platform_signup_requests('CONVERTED')`))[0]).toMatchObject({ id: r.id, reference: r.reference })
    }))
})
