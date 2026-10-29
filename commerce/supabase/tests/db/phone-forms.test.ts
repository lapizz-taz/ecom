import { afterAll, describe, expect, it } from 'vitest'
import { normalizePhone } from '../../functions/_shared/phone.ts'
import { asService, asSystem, closePool, inTx, value, type Db } from '../support/db'
import { createProduct, sellOn } from '../support/fixtures'

afterAll(closePool)

// [as typed, as cleaned]: the database and supabase/functions/_shared/phone.ts agree on every row.
const CASES: Array<[string | null, string | null]> = [
  // Accepted before, and cleaned exactly as before.
  ['01712278464', '01712278464'],
  ['+880 1712-278464', '01712278464'],
  ['8801712278464', '01712278464'],
  ['008801712278464', '01712278464'],
  ['01712 278 464', '01712278464'],
  ['(+880) 1712 278464', '01712278464'],
  ['Mobile: 01712278464 (bKash)', '01712278464'],
  // Repaired now.
  ['1712278464', '01712278464'], // the 0 left off (Atheron #1052)
  ['+88 1712278464', '01712278464'],
  ['+880 01712278464', '01712278464'], // an extra 0 after the country code
  ['0088 01712278464', '01712278464'],
  ['+88 01712278464', '01712278464'],
  ['০১৭১২২৭৮৪৬৪', '01712278464'], // Bangla digits
  ['+৮৮০ ১৭১২-২৭৮৪৬৪', '01712278464'],
  ['01712-278464 / 01812-000000', '01712278464'], // two numbers: the first one
  ['01712278464, 01812000000', '01712278464'],
  ['+8801712278464 or +8801812000000', '01712278464'],
  // Still refused: the digits stay, so the error shows what was typed.
  ['12345', '12345'],
  ['01212278464', '01212278464'], // no such operator
  ['017122784', '017122784'],
  ['', null],
  [null, null],
]

type Result = { status: string; order_id?: string; error?: string }

async function channel(db: Db): Promise<string> {
  const p = await createProduct(db, { price: 1500, stock: 10 })
  await sellOn(db, 'SHOPIFY')
  await asService(db)
  const c = await value<string>(db, `select (public.channel_upsert($1, null)).id`,
    [JSON.stringify({ platform: 'SHOPIFY', shop_domain: 'phones.myshopify.com', auth_mode: 'TOKEN' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED' where id = $1`, [c])
  await db.query(`insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, sync_status)
    values ($1, 'v-1', 'p-1', $2, 'OK')`, [c, p.variantIds[0]])
  return c
}

async function ingest(db: Db, c: string, ext: string, phone: string): Promise<Result> {
  await asService(db)
  return value<Result>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [c, JSON.stringify({
    external_id: ext, number: `#${ext}`, cancelled: false, created_at: new Date().toISOString(),
    customer: { name: 'Alif Islam', phone, email: null },
    shipping: { address: 'House 4, Road 7, Dhanmondi', city: 'Dhaka', state: null, postal_code: '1205', district_hint: 'Dhaka' },
    lines: [{ external_variant_id: 'v-1', external_product_id: 'p-1', sku: null, title: 'Watch', variant_title: null, quantity: 1, unit_price: 1500, image_url: null }],
    shipping_price: 0, discount_total: 0, total: 1500, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
    fulfillment_status: 'UNFULFILLED',
  })])
}

describe('phone numbers as people type them', () => {
  it('cleans every form the same way in the database, the browser and the backend functions', () =>
    inTx(async (db) => {
      for (const [typed, cleaned] of CASES) {
        expect(await value(db, `select public.normalize_phone($1)`, [typed]), String(typed)).toBe(cleaned)
        expect(normalizePhone(typed), String(typed)).toBe(cleaned ?? '')
      }
      // Quick SMS and chats: the same rules.
      expect(await value(db, `select public.sms_phone('১৭১২২৭৮৪৬৪')`)).toBe('8801712278464')
      expect(await value(db, `select public.sms_phone('+880 01712278464')`)).toBe('8801712278464')
      expect(await value(db, `select public.sms_phone('12345')`)).toBeNull()
      expect(await value(db, `select public._inbox_bd_phone('আমার নাম্বার ০১৭১২-২৭৮৪৬৪, ফোন দিয়েন')`)).toBe('01712278464')
    }))

  it('takes a store order whose phone is typed in any of these forms', () =>
    inTx(async (db) => {
      const c = await channel(db)
      for (const [i, phone] of ['1712278464', '+880 01712278464', '০১৭১২২৭৮৪৬৪', '01712-278464 / 01812-000000'].entries()) {
        const r = await ingest(db, c, `880${i}`, phone)
        expect(r.status, phone).toBe('IMPORTED')
        await asSystem(db)
        expect(await value(db, `select customer_phone from public.orders where id = $1`, [r.order_id])).toBe('01712278464')
      }
      // One customer for all four.
      expect(await value<number>(db, `select count(distinct customer_id)::int from public.orders where sales_channel_id = $1`, [c])).toBe(1)
      // A number that is not a mobile number still waits, with the reason.
      const bad = await ingest(db, c, '8809', '1712278')
      expect(bad.status).toBe('FAILED')
      expect(bad.error).toMatch(/"1712278" is not a valid Bangladesh mobile number/)
    }))
})
