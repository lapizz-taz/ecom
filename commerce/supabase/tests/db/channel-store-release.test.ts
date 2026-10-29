import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, closePool, expectError, inTx, MERCHANT_1, value, type Db } from '../support/db'
import { sellOn } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

// A store connects to one business at a time, and only a live connection holds it. Before, a
// connection that another business had disconnected kept the store address for good: the next
// business got "You do not have permission to do that" (Atheron, 29 Oct 2026).

const SHOP = 'har-test-7i.myshopify.com'
const TAKEN = /DUPLICATE: This Shopify store is connected to another Fullfilio business/

/** A second business on the same plan as the first, so Shopify is in its plan too. */
async function otherBusiness(db: Db): Promise<string> {
  const id = await createMerchant(db)
  await asSystem(db, id)
  await db.query(`insert into public.subscriptions (merchant_id, plan_id, status, price, currency, billing_interval, current_period_end)
    select $1, plan_id, status, price, currency, billing_interval, current_period_end from public.subscriptions
    where merchant_id = $2 and ended_at is null order by created_at desc limit 1`, [id, MERCHANT_1])
  return id
}

async function upsert(db: Db, merchant: string, domain = SHOP): Promise<string> {
  await sellOn(db, 'SHOPIFY', merchant)
  await asService(db, merchant)
  return value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: domain, auth_mode: 'OAUTH' })])
}

async function setStatus(db: Db, merchant: string, id: string, status: string): Promise<void> {
  await asService(db, merchant)
  await db.query(`select public.channel_update($1, $2, null)`, [id, JSON.stringify({ status })])
}

const rows = async (db: Db) => {
  await asSystem(db, null)
  return value<{ merchant_id: string; status: string }[]>(db,
    `select coalesce(jsonb_agg(jsonb_build_object('merchant_id', merchant_id, 'status', status) order by created_at), '[]') from public.sales_channels where lower(shop_domain) = $1`, [SHOP])
}

describe('sales channels: one live connection per store', () => {
  it('a store disconnected by one business can be connected by another', () =>
    inTx(async (db) => {
      const other = await otherBusiness(db)
      const a = await upsert(db, MERCHANT_1)
      await setStatus(db, MERCHANT_1, a, 'CONNECTED')

      // Connected to the first business: the second is told so (it used to say "no permission").
      await sellOn(db, 'SHOPIFY', other)
      await asService(db, other)
      await expectError(db, `select public.channel_upsert($1, null)`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: SHOP.toUpperCase(), auth_mode: 'OAUTH' })], TAKEN)

      // Once the first business disconnects, the second gets its own connection; the first one's row stays as it was.
      await setStatus(db, MERCHANT_1, a, 'DISCONNECTED')
      const b = await upsert(db, other)
      expect(b).not.toBe(a)
      await setStatus(db, other, b, 'CONNECTED')
      expect(await rows(db)).toEqual([{ merchant_id: MERCHANT_1, status: 'DISCONNECTED' }, { merchant_id: other, status: 'CONNECTED' }])

      // Now the first business is the one refused, whether it saves the store again or turns its old row back on.
      await sellOn(db, 'SHOPIFY', MERCHANT_1)
      await asService(db, MERCHANT_1)
      await expectError(db, `select public.channel_upsert($1, null)`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: SHOP, auth_mode: 'OAUTH' })], TAKEN)
      await expectError(db, `select public.channel_update($1, '{"status":"CONNECTED"}', null)`, [a], TAKEN)
      expect(await rows(db)).toEqual([{ merchant_id: MERCHANT_1, status: 'DISCONNECTED' }, { merchant_id: other, status: 'CONNECTED' }])
    }))

  it('an unfinished connection (keys never proven) does not hold the store', () =>
    inTx(async (db) => {
      const other = await otherBusiness(db)
      // Another business types this store's address with keys that never work: it stays PENDING.
      const squat = await upsert(db, other)
      // The store's real owner connects it all the same.
      const mine = await upsert(db, MERCHANT_1)
      await setStatus(db, MERCHANT_1, mine, 'CONNECTED')
      // The unfinished one cannot take it over afterwards.
      await asService(db, other)
      await expectError(db, `select public.channel_update($1, '{"status":"CONNECTED"}', null)`, [squat], TAKEN)
    }))

  it('connecting again reuses the business\'s own connection', () =>
    inTx(async (db) => {
      const a = await upsert(db, MERCHANT_1)
      await setStatus(db, MERCHANT_1, a, 'CONNECTED')
      await setStatus(db, MERCHANT_1, a, 'DISCONNECTED')
      expect(await upsert(db, MERCHANT_1, SHOP.toUpperCase())).toBe(a)
      expect(await rows(db)).toEqual([{ merchant_id: MERCHANT_1, status: 'PENDING' }])
    }))
})
