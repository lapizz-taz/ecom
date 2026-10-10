import { createHash } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value } from '../support/db'
import { createProduct, createStaff, orderPayload } from '../support/fixtures'

afterAll(closePool)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('website API keys', () => {
  it('shows the key once, stores only its hash, and can be turned off', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.admin_site_key_create('Shop', 'SECRET', '{}')`, [], /PERMISSION_DENIED/)
      await asUser(db, owner)
      await expectError(db, `select public.admin_site_key_create('Shop', 'PUBLISHABLE', '{}')`, [], /needs the website address/)
      await expectError(db, `select public.admin_site_key_create('Shop', 'PUBLISHABLE', '{"shop.com/path"}')`, [], /https:\/\/shop.com/)
      const made = await value<{ id: string; key: string; prefix: string }>(db,
        `select public.admin_site_key_create('My Next.js shop', 'PUBLISHABLE', '{"https://Shop.example.com/"}')`)
      expect(made.key).toMatch(/^pk_live_[0-9a-f]{48}$/)

      // Only the hash is stored; the list never contains the key.
      await asSystem(db)
      const row = await value<Record<string, any>>(db, `select to_jsonb(k) from public.site_api_keys k where id = $1`, [made.id])
      expect(row.key_hash).toBe(sha(made.key))
      expect(JSON.stringify(row)).not.toContain(made.key)
      expect(row.allowed_origins).toEqual(['https://shop.example.com'])
      await asUser(db, owner)
      expect(JSON.stringify(await value(db, `select public.admin_site_keys()`))).not.toContain(made.key)

      await asService(db)
      expect(await value(db, `select public.site_api_key_check($1)`, [sha(made.key)])).toMatchObject({ name: 'My Next.js shop', kind: 'PUBLISHABLE' })
      expect(await value(db, `select public.site_api_key_check($1)`, [sha('pk_live_wrong')])).toBeNull()
      await asUser(db, owner)
      await db.query(`select public.admin_site_key_revoke($1)`, [made.id])
      await asService(db)
      expect(await value(db, `select public.site_api_key_check($1)`, [sha(made.key)])).toBeNull()
    }))

  it('orders placed with a key go through checkout even while the hosted store is off, tagged with the site', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const made = await value<{ id: string; key: string }>(db, `select public.admin_site_key_create('Custom shop', 'SECRET', '{}')`)
      await db.query(`select public.admin_set_store_mode('OFF', null)`)

      await asService(db)
      const payload = { ...orderPayload({ items: [{ variantId: p.variantIds[0], quantity: 1 }], phone: '01711000444' }), idempotency_key: `site-${made.id}` }
      // The hosted store itself is closed…
      await expectError(db, `select public.place_storefront_order($1, null)`, [JSON.stringify(payload)], /ORDER_BLOCKED/)
      // …but the website's own checkout works, with the same pricing and stock.
      const order = await value<Record<string, any>>(db, `select public.site_api_place_order($1, $2, null)`, [made.id, JSON.stringify(payload)])
      expect(order.order_number).toBeTruthy()
      await asSystem(db)
      expect(await value<string[]>(db, `select tags from public.orders where id = $1`, [order.id])).toContain('site:Custom shop')
      expect(await value<number>(db, `select reserved from public.inventory where variant_id = $1`, [p.variantIds[0]])).toBe(1)
      // The flag does not leak to later statements in the same transaction.
      await asService(db)
      await expectError(db, `select public.place_storefront_order($1, null)`, [JSON.stringify({ ...payload, idempotency_key: 'other-key-1234' })], /ORDER_BLOCKED/)

      // A turned-off key cannot place orders.
      await asUser(db, owner)
      await db.query(`select public.admin_site_key_revoke($1)`, [made.id])
      await asService(db)
      await expectError(db, `select public.site_api_place_order($1, $2, null)`, [made.id, JSON.stringify({ ...payload, idempotency_key: 'third-key-12345' })], /turned off/)
    }))
})

describe('custom domains', () => {
  it('records what Vercel reports; staff only read', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asService(db)
      await expectError(db, `select public.store_domain_save('Not a domain', '{}')`, [], /check constraint|violates/)
      const d = await value<Record<string, any>>(db, `select public.store_domain_save('shop.example.com', $1, $2)`,
        [JSON.stringify({ status: 'VERIFYING', records: [{ type: 'CNAME', name: 'shop', value: 'cname.vercel-dns.com' }] }), owner])
      expect(d).toMatchObject({ domain: 'shop.example.com', status: 'VERIFYING' })
      await db.query(`select public.store_domain_save('shop.example.com', '{"status":"ACTIVE","records":[]}')`)
      await asUser(db, owner)
      expect(await value(db, `select public.store_domains_list()`)).toEqual([expect.objectContaining({ domain: 'shop.example.com', status: 'ACTIVE' })])
      await expectError(db, `select public.store_domain_save('x.example.com', '{}')`, [], /PERMISSION_DENIED|permission denied/)
    }))
})
