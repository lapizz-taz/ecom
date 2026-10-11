import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

const MERCHANT_1 = '00000000-0000-4000-8000-000000000001'

async function founder(db: Db) {
  await asSystem(db, null)
  const id = randomUUID()
  const email = `founder-${id.slice(0, 8)}@shop.example`
  await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{"full_name": "Nadia Rahman"}')`, [id, email])
  return { id, email }
}

const signUp = (over: Record<string, unknown> = {}) => JSON.stringify({
  business_name: 'Nadia Crafts', full_name: 'Nadia Rahman', phone: '01712345678', plan_code: 'GROWTH', ...over,
})

const setDomains = (db: Db, v: Record<string, unknown>) =>
  db.query(`update public.platform_settings set value = $1 where key = 'store_domains'`, [JSON.stringify(v)])

describe('store addresses', () => {
  it('gives an online store a store name at sign-up, and none when the business sells elsewhere', () =>
    inTx(async (db) => {
      const a = await founder(db)
      await asUser(db, a.id, a.email, null)
      const shop = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`, [signUp({ online_store: true, store_slug: 'nadia-crafts-bd' })])
      await asSystem(db, null)
      expect(await value(db, `select slug from public.merchants where id = $1`, [shop.merchant_id])).toBe('nadia-crafts-bd')

      const b = await founder(db)
      await asUser(db, b.id, b.email, null)
      const elsewhere = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`, [signUp({ business_name: 'Facebook Only', online_store: false })])
      await asSystem(db, null)
      expect(await value(db, `select slug from public.merchants where id = $1`, [elsewhere.merchant_id])).toBeNull()
      expect(await value(db, `select value ->> 'mode' from public.settings where merchant_id = $1 and key = 'storefront'`, [elsewhere.merchant_id])).toBe('OFF')

      // A taken or reserved name is refused before anything is created.
      const c = await founder(db)
      await asUser(db, c.id, c.email, null)
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp({ store_slug: 'nadia-crafts-bd' })], /store address: This store name is taken/)
      await expectError(db, `select public.merchant_self_onboard($1)`, [signUp({ store_slug: 'admin' })], /reserved/)
    }))

  it('checks and suggests store names for anyone, without showing other data', () =>
    inTx(async (db) => {
      await asAnon(db, null)
      expect(await value(db, `select public.store_slug_check('www') ->> 'available'`)).toBe('false')
      expect(await value(db, `select public.store_slug_check('Bad Name') ->> 'available'`)).toBe('false')
      const free = await value<Record<string, any>>(db, `select public.store_slug_check('a-brand-new-shop')`)
      expect(free).toMatchObject({ available: true, reason: null })
      expect(await value<string>(db, `select public.store_slug_suggest('দোকান')`)).toMatch(/^my-shop(-\d+)?$/)
      expect(await value<string>(db, `select public.store_slug_suggest('Café & Co.')`)).toMatch(/^caf-co(-\d+)?$/)
    }))

  it('turning the online store on gives a store name; the resolver only serves stores that are on', () =>
    inTx(async (db) => {
      await asSystem(db, MERCHANT_1)
      await db.query(`update public.merchants set slug = null where id = $1`, [MERCHANT_1])
      await db.query(`update public.settings set value = value || '{"mode":"OFF"}' where merchant_id = $1 and key = 'storefront'`, [MERCHANT_1])
      expect(await value(db, `select slug from public.merchants where id = $1`, [MERCHANT_1])).toBeNull()
      await db.query(`update public.settings set value = value || '{"mode":"OWN"}' where merchant_id = $1 and key = 'storefront'`, [MERCHANT_1])
      const slug = await value<string>(db, `select slug from public.merchants where id = $1`, [MERCHANT_1])
      expect(slug).toMatch(/^[a-z0-9-]+$/)

      await asAnon(db, null)
      expect(await value<Record<string, any>>(db, `select public.storefront_resolve_slug($1)`, [slug])).toMatchObject({ kind: 'store', merchant_id: MERCHANT_1 })
      expect(await value<Record<string, any>>(db, `select public.storefront_resolve_slug('no-such-store')`)).toEqual({ kind: 'missing' })

      await asSystem(db, MERCHANT_1)
      await db.query(`update public.settings set value = value || '{"mode":"SHOPIFY"}' where merchant_id = $1 and key = 'storefront'`, [MERCHANT_1])
      await asAnon(db, null)
      expect(await value<Record<string, any>>(db, `select public.storefront_resolve_slug($1)`, [slug])).toEqual({ kind: 'missing' })
    }))

  it('serves subdomains under the platform domain, and the main address shows the website once switched', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      await db.query(`update public.merchants set slug = 'isolation' where id = $1`, [MERCHANT_1])
      await setDomains(db, { root_domain: 'fullfilio.com', main_site: 'store' })
      await asAnon(db, null)
      expect(await value<Record<string, any>>(db, `select public.storefront_resolve('isolation.fullfilio.com')`)).toMatchObject({ kind: 'store', merchant_id: MERCHANT_1 })
      expect(await value<Record<string, any>>(db, `select public.storefront_resolve('nobody.fullfilio.com')`)).toEqual({ kind: 'missing' })
      // Before the switch, the platform address still shows the default store.
      expect(await value<Record<string, any>>(db, `select public.storefront_resolve('fullfilio.com')`)).toMatchObject({ kind: 'store' })

      await asSystem(db, null)
      await setDomains(db, { root_domain: 'fullfilio.com', main_site: 'marketing' })
      await asAnon(db, null)
      expect(await value(db, `select public.storefront_resolve('fullfilio.com')`)).toEqual({ kind: 'platform' })
      expect(await value(db, `select public.storefront_resolve('www.fullfilio.com')`)).toEqual({ kind: 'platform' })
      expect(await value(db, `select public.storefront_resolve('app.vercel.app')`)).toEqual({ kind: 'platform' })
      expect(await value<Record<string, any>>(db, `select public.storefront_resolve('isolation.fullfilio.com')`)).toMatchObject({ kind: 'store' })
    }))

  it('a new business answers the online-store question on the dashboard', () =>
    inTx(async (db) => {
      const a = await founder(db)
      await asUser(db, a.id, a.email, null)
      const shop = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`, [signUp({ online_store: false })])
      await asUser(db, a.id, a.email, shop.merchant_id)
      expect(await value(db, `select public.merchant_store_address()`)).toMatchObject({ mode: 'OFF', slug: null, asked: false })

      // Yes, under a chosen name.
      expect(await value(db, `select public.admin_online_store_answer(true, 'Nadia-Shop')`)).toMatchObject({ mode: 'OWN', slug: 'nadia-shop', asked: true })
      await asAnon(db, null)
      expect(await value<Record<string, any>>(db, `select public.storefront_resolve_slug('nadia-shop')`)).toMatchObject({ kind: 'store', merchant_id: shop.merchant_id })

      // A taken name changes nothing: the store stays off and the question stays open.
      const b = await founder(db)
      await asUser(db, b.id, b.email, null)
      const other = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`, [signUp({ business_name: 'Other Shop', online_store: false })])
      await asUser(db, b.id, b.email, other.merchant_id)
      await expectError(db, `select public.admin_online_store_answer(true, 'nadia-shop')`, [], /taken/)
      expect(await value(db, `select public.merchant_store_address()`)).toMatchObject({ mode: 'OFF', slug: null, asked: false })

      // No: nothing is published, and the question is not asked again.
      expect(await value(db, `select public.admin_online_store_answer(false)`)).toMatchObject({ mode: 'OFF', slug: null, asked: true })

      // Staff without settings.manage cannot answer.
      const clerk = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, clerk)
      await expectError(db, `select public.admin_online_store_answer(true, 'clerk-shop')`, [], /settings\.manage/)
    }))

  it('only platform staff who edit settings change the platform domain; owners rename their own store', () =>
    inTx(async (db) => {
      const viewer = await createPlatformStaff(db, 'VIEWER')
      await asUser(db, viewer, 'viewer@platform.example', null)
      await expectError(db, `select public.platform_store_domains_save($1, 'test')`, [JSON.stringify({ root_domain: 'fullfilio.com' })], /PERMISSION_DENIED|permission/i)
      const boss = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asUser(db, boss, 'boss@platform.example', null)
      await expectError(db, `select public.platform_store_domains_save($1, 'test')`, [JSON.stringify({ root_domain: 'https://bad/' })], /enter a domain/)
      expect(await value(db, `select public.platform_store_domains_save($1, 'test')`, [JSON.stringify({ root_domain: 'Fullfilio.com' })]))
        .toEqual({ root_domain: 'fullfilio.com', main_site: 'marketing' })

      const clerk = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, clerk)
      await expectError(db, `select public.admin_set_store_slug('my-new-name')`, [], /settings\.manage/)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await db.query(`select public.admin_set_store_slug('isolation-shop')`)
      expect(await value(db, `select public.merchant_store_address() ->> 'subdomain'`)).toBe('isolation-shop.fullfilio.com')
      await expectError(db, `select public.admin_set_store_slug('api')`, [], /reserved/)
    }))
})
