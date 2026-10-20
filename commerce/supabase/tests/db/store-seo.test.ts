import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, type Db, expectError, inTx, MERCHANT_1, value } from '../support/db'
import { createOrder, createProduct, createStaff, transition } from '../support/fixtures'

afterAll(closePool)

// The store builder's draft / Publish, and the store's SEO (modes, overrides, redirects,
// page metadata, sitemap, audit).

type Json = Record<string, any>

async function owner(db: Db, merchant = MERCHANT_1) {
  const email = `owner-${randomUUID().slice(0, 8)}@example.com`
  const id = await createStaff(db, 'OWNER', email, merchant)
  return { id, email, as: () => asUser(db, id, email, merchant) }
}

async function otherStore(db: Db) {
  await asSystem(db, null)
  const m = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
  await asSystem(db, m)
  await db.query(`select public._merchant_seed_defaults($1)`, [m])
  return { m, staff: await owner(db, m) }
}

const seo = async (db: Db, path: string, merchant = MERCHANT_1) => {
  await asAnon(db, merchant)
  return value<Json>(db, `select public.storefront_seo($1)`, [path])
}
const slugOf = async (db: Db, id: string) => { await asSystem(db); return value<string>(db, `select slug from public.products where id = $1`, [id]) }
const storeName = async (db: Db) => { await asSystem(db); return value<string>(db, `select value ->> 'name' from public.settings where key = 'store'`) }

describe('store builder: draft and publish', () => {
  it('saving keeps the live store as it is; publishing puts only the theme and footer live', () =>
    inTx(async (db) => {
      const o = await owner(db)
      await o.as()
      const start = await value<Json>(db, `select public.storefront_draft_get()`)
      expect(start.draft).toBeNull()
      const theme = { ...(start.live.theme ?? {}), accent: '#1d4ed8', sections: [{ id: 'hero-1', type: 'hero', enabled: true, settings: { heading: 'Draft heading' } }] }
      const saved = await value<Json>(db, `select public.storefront_draft_save($1, null)`, [JSON.stringify({ theme, footer_text: '© Draft' })])
      expect(saved.draft_saved_at).toBeTruthy()

      // Not live yet.
      await asAnon(db)
      let config = await value<Json>(db, `select public.storefront_config()`)
      expect(config.merchant_id).toBe(MERCHANT_1)
      expect(config.storefront.theme?.accent).not.toBe('#1d4ed8')

      // Meanwhile the sales channel mode changes elsewhere: publishing must not undo it.
      await asSystem(db)
      await db.query(`update public.settings set value = value || '{"mode": "OWN", "redirect_url": null, "store_prompt_done": true}' where key = 'storefront'`)

      await o.as()
      const draft = await value<Json>(db, `select public.storefront_draft_get()`)
      expect(draft.draft.theme.accent).toBe('#1d4ed8')
      await value(db, `select public.storefront_publish($1)`, [draft.draft_saved_at])
      expect((await value<Json>(db, `select public.storefront_draft_get()`)).draft).toBeNull()

      await asAnon(db)
      config = await value<Json>(db, `select public.storefront_config()`)
      expect(config.storefront.theme.accent).toBe('#1d4ed8')
      expect(config.storefront.theme.sections[0].settings.heading).toBe('Draft heading')
      expect(config.storefront.footer_text).toBe('© Draft')
      expect(config.storefront.mode).toBe('OWN')
      expect(config.storefront.store_prompt_done).toBe(true)
      expect(config.storefront.published_at).toBeTruthy()
    }))

  it('a draft saved on top of a newer one is refused; script links and other keys are refused', () =>
    inTx(async (db) => {
      const a = await owner(db)
      const b = await owner(db)
      await a.as()
      const first = await value<Json>(db, `select public.storefront_draft_save($1, null)`, [JSON.stringify({ theme: { accent: '#000000' } })])
      await b.as()
      // B opened the editor before A's draft existed.
      await expectError(db, `select public.storefront_draft_save($1, null)`, [JSON.stringify({ theme: { accent: '#ffffff' } })], /CONFLICT/)
      await a.as()
      await value(db, `select public.storefront_draft_save($1, $2)`, [JSON.stringify({ theme: { accent: '#111111' } }), first.draft_saved_at])
      await expectError(db, `select public.storefront_draft_save($1, null)`,
        [JSON.stringify({ theme: { sections: [{ id: 'x', type: 'hero', settings: { button_link: ' javascript:alert(1)' } }] } })], /links must be web addresses/)
      await expectError(db, `select public.storefront_draft_save($1, null)`, [JSON.stringify({ mode: 'OFF' })], /only the theme/)
      await asAnon(db)
      await expectError(db, `select public.storefront_draft_get()`, [], /permission denied|PERMISSION_DENIED/)
      await expectError(db, `select public.storefront_publish(null)`, [], /permission denied|PERMISSION_DENIED/)
    }))

  it('saving other storefront settings never brings back an older theme', () =>
    inTx(async (db) => {
      const o = await owner(db)
      await o.as()
      // The Settings page opened earlier and still holds the old theme.
      const stale = await value<Json>(db, `select value from public.settings where key = 'storefront'`)
      await value(db, `select public.storefront_draft_save($1, null)`, [JSON.stringify({ theme: { accent: '#7c3aed' } })])
      await value(db, `select public.storefront_publish(null)`)
      await value(db, `select public.admin_update_setting('storefront', $1)`, [JSON.stringify({ ...stale, checkout_fields: { email: 'optional' } })])
      await asAnon(db)
      const live = (await value<Json>(db, `select public.storefront_config()`)).storefront
      expect(live.theme.accent).toBe('#7c3aed')
      expect(live.checkout_fields).toMatchObject({ email: 'optional' })
    }))

  it("another business's staff never see or publish this store's draft", () =>
    inTx(async (db) => {
      const a = await owner(db)
      await a.as()
      await value(db, `select public.storefront_draft_save($1, null)`, [JSON.stringify({ theme: { accent: '#222222' } })])
      const other = await otherStore(db)
      await other.staff.as()
      expect((await value<Json>(db, `select public.storefront_draft_get()`)).draft).toBeNull()
      await expectError(db, `select public.storefront_publish(null)`, [], /no saved draft/)
      // The setting cannot be written through the general settings screen either.
      await a.as()
      await expectError(db, `select public.admin_update_setting('storefront_draft', '{}')`, [], /own screen/)
    }))
})

describe('store SEO', () => {
  it('Hybrid (default): generated until the merchant writes a field; manual fields survive product updates', () =>
    inTx(async (db) => {
      const name = await storeName(db)
      const p = await createProduct(db, { name: 'Linen Shirt', price: 1290 })
      await asSystem(db)
      await db.query(`update public.products set description = '<p>Breathable <b>linen</b> shirt for hot days.</p>' where id = $1`, [p.productId])
      const slug = await slugOf(db, p.productId)
      let page = await seo(db, `/product/${slug}`)
      expect(page.status).toBe(200)
      expect(page.title).toBe(`Linen Shirt | ${name}`)
      expect(page.description).toBe('Breathable linen shirt for hot days.')
      expect(page.robots).toBe('index,follow')

      const o = await owner(db)
      await o.as()
      const saved = await value<Json>(db, `select public.seo_item_save('product', $1, $2)`, [p.productId, JSON.stringify({ title: 'Linen Shirt – Breathable Summer Wear' })])
      expect(saved).toMatchObject({ title: 'Linen Shirt – Breathable Summer Wear', title_source: 'manual', description_source: 'auto' })

      // An import (Shopify / WooCommerce) updates the product's name and description.
      await asSystem(db)
      await db.query(`update public.products set name = 'Linen Shirt Classic', description = 'Now in five colours.' where id = $1`, [p.productId])
      page = await seo(db, `/product/${slug}`)
      expect(page.title).toBe('Linen Shirt – Breathable Summer Wear')
      expect(page.description).toBe('Now in five colours.')

      // Back to generated for the title.
      await o.as()
      expect(await value<Json>(db, `select public.seo_item_save('product', $1, '{"title": null}')`, [p.productId])).toMatchObject({ title: `Linen Shirt Classic | ${name}`, title_source: 'auto' })
    }))

  it('Automatic ignores written fields (kept for later); Manual uses only written ones and the audit says what is missing', () =>
    inTx(async (db) => {
      const name = await storeName(db)
      const p = await createProduct(db, { name: 'Clay Mug', price: 450 })
      const slug = await slugOf(db, p.productId)
      const o = await owner(db)
      await o.as()
      await value(db, `select public.seo_item_save('product', $1, $2)`, [p.productId, JSON.stringify({ title: 'Handmade Clay Mug', description: 'A mug made by hand in Dhaka.' })])

      await value(db, `select public.seo_settings_save('{"mode": "automatic"}')`)
      let page = await seo(db, `/product/${slug}`)
      expect(page.title).toBe(`Clay Mug | ${name}`)

      await o.as()
      await value(db, `select public.seo_settings_save('{"mode": "manual"}')`)
      page = await seo(db, `/product/${slug}`)
      expect(page.title).toBe('Handmade Clay Mug')
      expect(page.description).toBe('A mug made by hand in Dhaka.')

      // A product with nothing written: the name as title, no description, and the audit flags it.
      const bare = await createProduct(db, { name: 'Plain Plate', price: 300 })
      const bareSlug = await slugOf(db, bare.productId)
      page = await seo(db, `/product/${bareSlug}`)
      expect(page.title).toBe(`Plain Plate | ${name}`)
      expect(page.description).toBeNull()
      await o.as()
      const audit = await value<Json>(db, `select public.seo_audit()`)
      const codes = audit.issues.filter((i: Json) => i.key === bare.productId).map((i: Json) => i.code)
      expect(codes).toEqual(expect.arrayContaining(['title_missing', 'description_missing']))
      expect(audit.health.score).toBeGreaterThanOrEqual(0)
      expect(audit.health.checks).toBeGreaterThan(0)

      // Hybrid again: the written fields are back.
      await value(db, `select public.seo_settings_save('{"mode": "hybrid"}')`)
      expect((await seo(db, `/product/${slug}`)).title).toBe('Handmade Clay Mug')
    }))

  it('a changed address keeps a redirect, without chains or loops', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { name: 'Cotton Tote', price: 600 })
      const first = await slugOf(db, p.productId)
      const o = await owner(db)
      await o.as()
      await value(db, `select public.seo_item_save('product', $1, '{"slug": "cotton-tote"}')`, [p.productId])
      expect(await seo(db, `/product/${first}`)).toMatchObject({ status: 301, redirect: '/product/cotton-tote' })
      expect((await seo(db, '/product/cotton-tote')).status).toBe(200)

      await o.as()
      await value(db, `select public.seo_item_save('product', $1, '{"slug": "canvas-tote"}')`, [p.productId])
      // The first address goes straight to the newest one.
      expect(await seo(db, `/product/${first}`)).toMatchObject({ status: 301, redirect: '/product/canvas-tote' })
      expect(await seo(db, '/product/cotton-tote')).toMatchObject({ status: 301, redirect: '/product/canvas-tote' })

      // Back to the first address: it is live again (no loop).
      await o.as()
      await value(db, `select public.seo_item_save('product', $1, $2)`, [p.productId, JSON.stringify({ slug: first })])
      expect((await seo(db, `/product/${first}`)).status).toBe(200)
      expect(await seo(db, '/product/canvas-tote')).toMatchObject({ status: 301, redirect: `/product/${first}` })

      await o.as()
      await expectError(db, `select public.seo_item_save('product', $1, '{"slug": "Bad Slug!"}')`, [p.productId], /lower-case letters/)
      await expectError(db, `select public.seo_redirect_save('/a', '/a')`, [], /itself/)
      await value(db, `select public.seo_redirect_save('/old-sale', '/shop')`)
      await expectError(db, `select public.seo_redirect_save('/shop', '/old-sale')`, [], /loop/)
    }))

  it('structured data uses stored facts only; private and missing pages are not indexed', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { name: 'Wool Scarf', price: 990, stock: 3 })
      const slug = await slugOf(db, p.productId)
      const page = await seo(db, `/product/${slug}`)
      const product = page.jsonld.find((x: Json) => x['@type'] === 'Product')
      expect(product.offers).toMatchObject({ '@type': 'Offer', price: 990, priceCurrency: 'BDT', availability: 'https://schema.org/InStock' })
      expect(product.aggregateRating).toBeUndefined()
      expect(product.review).toBeUndefined()
      expect(page.jsonld.find((x: Json) => x['@type'] === 'BreadcrumbList').itemListElement).toHaveLength(2)

      const free = await createProduct(db, { name: 'Free Sample', price: 0, trackInventory: false })
      const freeLd = (await seo(db, `/product/${await slugOf(db, free.productId)}`)).jsonld.find((x: Json) => x['@type'] === 'Product')
      expect(freeLd.offers).toBeUndefined()

      for (const path of ['/cart', '/checkout', '/account/orders/1', '/login']) {
        expect((await seo(db, path)).robots).toBe('noindex,nofollow')
      }
      expect(await seo(db, '/product/does-not-exist')).toMatchObject({ status: 404, robots: 'noindex,follow' })
      expect((await seo(db, '/search?q=scarf')).robots).toBe('noindex,follow')
      const home = await seo(db, '/')
      expect(home.jsonld.map((x: Json) => x['@type'])).toContain('Organization')
    }))

  it('the sitemap lists public items only; noindex and indexing switches are respected', () =>
    inTx(async (db) => {
      const shown = await createProduct(db, { name: 'Shown Item', price: 100 })
      const hidden = await createProduct(db, { name: 'Hidden Item', price: 100 })
      const draft = await createProduct(db, { name: 'Draft Item', price: 100 })
      await asSystem(db)
      await db.query(`update public.products set status = 'DRAFT' where id = $1`, [draft.productId])
      const o = await owner(db)
      await o.as()
      await value(db, `select public.seo_item_save('product', $1, '{"noindex": true}')`, [hidden.productId])

      await asAnon(db)
      let map = await value<Json>(db, `select public.storefront_sitemap()`)
      const paths = map.urls.map((u: Json) => u.path)
      expect(paths).toContain('/')
      expect(paths).toContain(`/product/${await slugOf(db, shown.productId)}`)
      expect(paths).not.toContain(`/product/${await slugOf(db, hidden.productId)}`)
      expect(paths).not.toContain(`/product/${await slugOf(db, draft.productId)}`)
      expect(paths.some((x: string) => /^\/(cart|checkout|account|login)/.test(x))).toBe(false)
      expect((await seo(db, `/product/${await slugOf(db, hidden.productId)}`)).robots).toBe('noindex,follow')

      await o.as()
      await value(db, `select public.seo_settings_save('{"indexing": {"store": false}}')`)
      await asAnon(db)
      map = await value<Json>(db, `select public.storefront_sitemap()`)
      expect(map).toMatchObject({ enabled: false, urls: [] })
      expect(await value<Json>(db, `select public.storefront_robots()`)).toMatchObject({ indexable: false })
      expect((await seo(db, '/')).robots).toBe('noindex,follow')
    }))

  it('saving the product form keeps the SEO title, description and address it was not sent', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { name: 'Form Kept', price: 500 })
      const o = await owner(db)
      await o.as()
      await value(db, `select public.seo_bulk('generate', $1)`, [JSON.stringify([{ type: 'product', key: p.productId }])])
      await value(db, `select public.seo_item_save('product', $1, '{"slug": "form-kept-classic"}')`, [p.productId])
      const before = await value<Json>(db, `select public.seo_item_get('product', $1)`, [p.productId])
      expect(before).toMatchObject({ slug: 'form-kept-classic', title_source: 'generated' })

      // The product form (no SEO keys, no address) saves a new price and name.
      const save = (extra: Json) => value(db, `select public.admin_save_product_full($1)`, [JSON.stringify({
        id: p.productId, name: 'Form Kept Renamed', price: 650, status: 'ACTIVE', variants: [{ id: p.variantIds[0], sku: `K-${p.productId.slice(0, 6)}`, title: 'Default' }], ...extra })])
      await save({})
      let after = await value<Json>(db, `select public.seo_item_get('product', $1)`, [p.productId])
      expect(after).toMatchObject({ slug: 'form-kept-classic', stored_title: before.stored_title, title_source: 'generated' })

      // A client that does send a title: it is the merchant's own from now on.
      await save({ seo_title: 'Written In The Form' })
      after = await value<Json>(db, `select public.seo_item_get('product', $1)`, [p.productId])
      expect(after).toMatchObject({ title: 'Written In The Form', title_source: 'manual', slug: 'form-kept-classic' })
    }))

  it('bulk generation never touches fields the merchant wrote; reset clears only generated ones', () =>
    inTx(async (db) => {
      const name = await storeName(db)
      const a = await createProduct(db, { name: 'Bulk A', price: 100 })
      const b = await createProduct(db, { name: 'Bulk B', price: 100 })
      const o = await owner(db)
      await o.as()
      await value(db, `select public.seo_item_save('product', $1, '{"title": "My Own A"}')`, [a.productId])
      const r = await value<Json>(db, `select public.seo_bulk('generate', $1)`,
        [JSON.stringify([{ type: 'product', key: a.productId }, { type: 'product', key: b.productId }])])
      expect(r).toMatchObject({ changed: 2, skipped_manual: 1 })
      const ia = await value<Json>(db, `select public.seo_item_get('product', $1)`, [a.productId])
      const ib = await value<Json>(db, `select public.seo_item_get('product', $1)`, [b.productId])
      expect(ia).toMatchObject({ title: 'My Own A', title_source: 'manual' })
      expect(ib).toMatchObject({ title: `Bulk B | ${name}`, title_source: 'generated' })

      await value(db, `select public.seo_bulk('reset', $1)`, [JSON.stringify([{ type: 'product', key: a.productId }, { type: 'product', key: b.productId }])])
      expect(await value<Json>(db, `select public.seo_item_get('product', $1)`, [a.productId])).toMatchObject({ title: 'My Own A', title_source: 'manual' })
      expect(await value<Json>(db, `select public.seo_item_get('product', $1)`, [b.productId])).toMatchObject({ title_source: 'auto', stored_title: null })

      // Image alt text suggestions fill only empty ones.
      await asSystem(db)
      await db.query(`insert into public.product_images (product_id, url, is_primary, position) values ($1, 'https://img.example/b.jpg', true, 0)`, [b.productId])
      await o.as()
      await value(db, `select public.seo_bulk('alt_text', $1)`, [JSON.stringify([{ type: 'product', key: b.productId }])])
      await asSystem(db)
      expect(await value(db, `select alt from public.product_images where product_id = $1`, [b.productId])).toBe('Bulk B')
    }))

  it('settings are checked; new products can start with generated values ("fill")', () =>
    inTx(async (db) => {
      const name = await storeName(db)
      const o = await owner(db)
      await o.as()
      await expectError(db, `select public.seo_settings_save('{"mode": "magic"}')`, [], /Automatic, Manual or Hybrid/)
      await expectError(db, `select public.seo_settings_save('{"templates": {"product_title": "{{name}} {{secret}}"}}')`, [], /not a value templates can use/)
      await expectError(db, `select public.seo_settings_save('{"indexing": {"store": "yes"}}')`, [], /on or off/)
      await expectError(db, `select public.seo_settings_save('{"social": {"og_image": "javascript:x"}}')`, [], /web address/)
      await value(db, `select public.seo_settings_save('{"templates": {"product_title": "Buy {{name}} online"}, "new_items": {"products": "fill"}}')`)

      const p = await createProduct(db, { name: 'Jute Basket', price: 750 })
      await o.as()
      expect(await value<Json>(db, `select public.seo_item_get('product', $1)`, [p.productId]))
        .toMatchObject({ stored_title: `Buy Jute Basket online | ${name}`, title_source: 'generated' })
      await asAnon(db)
      await expectError(db, `select public.seo_settings_save('{"mode": "manual"}')`, [], /permission denied|PERMISSION_DENIED/)
    }))

  it("each store only sees and changes its own SEO", () =>
    inTx(async (db) => {
      const p = await createProduct(db, { name: 'Tenant Product', price: 100 })
      const slug = await slugOf(db, p.productId)
      const other = await otherStore(db)
      // The other store's address does not serve this store's product.
      expect((await seo(db, `/product/${slug}`, other.m)).status).toBe(404)
      await other.staff.as()
      await expectError(db, `select public.seo_item_get('product', $1)`, [p.productId], /does not exist/)
      await expectError(db, `select public.seo_item_save('product', $1, '{"title": "Hijack"}')`, [p.productId], /does not exist/)
      await value(db, `select public.seo_settings_save('{"mode": "manual"}')`)
      // This store keeps its own mode.
      const o = await owner(db)
      await o.as()
      expect((await value<Json>(db, `select public.seo_settings_get()`)).settings.mode).toBe('hybrid')
    }))

  it('the audit finds broken links in the theme and duplicate titles', () =>
    inTx(async (db) => {
      await createProduct(db, { name: 'Twin', price: 100 })
      await createProduct(db, { name: 'Twin', price: 100 })
      await asSystem(db)
      await db.query(`update public.settings set value = jsonb_set(value, '{theme}', coalesce(value -> 'theme', '{}'::jsonb) || '{"header": {"menu": [{"label": "Gone", "link": "/collection/no-such-thing"}, {"label": "Shop", "link": "/shop"}]}}'::jsonb) where key = 'storefront'`)
      const o = await owner(db)
      await o.as()
      const audit = await value<Json>(db, `select public.seo_audit()`)
      expect(audit.issues.filter((i: Json) => i.code === 'link_broken').map((i: Json) => i.path)).toEqual(['/collection/no-such-thing'])
      expect(audit.issues.filter((i: Json) => i.code === 'title_duplicate').length).toBeGreaterThanOrEqual(2)
      expect(audit.external.length).toBeGreaterThan(0)
      // Every public item is listed once, with where its title comes from.
      const twins = audit.items.filter((i: Json) => i.type === 'product' && i.name === 'Twin')
      expect(twins).toHaveLength(2)
      expect(twins[0]).toMatchObject({ title_source: 'auto', noindex: false, robots: 'index,follow' })
      expect(audit.items.some((i: Json) => i.type === 'page' && i.key === 'home')).toBe(true)
      expect(audit.health.score).toBeGreaterThanOrEqual(0)
      expect(audit.health.score).toBeLessThanOrEqual(100)
    }))
})

describe('store builder: best sellers', () => {
  it('ranks products by units sold in the last 90 days, ignoring cancelled orders', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { name: 'Seller A', price: 100, stock: 50 })
      const b = await createProduct(db, { name: 'Seller B', price: 100, stock: 50 })
      const c = await createProduct(db, { name: 'Seller C', price: 100, stock: 50 })
      // B sold 2; A had a bigger order that was cancelled; C sold nothing.
      await createOrder(db, { phone: '01711000101', items: [{ variantId: b.variantIds[0], quantity: 2 }] })
      const big = await createOrder(db, { phone: '01711000102', items: [{ variantId: a.variantIds[0], quantity: 9 }] })
      await transition(db, big.id, 'CANCELLED')
      await asAnon(db)
      const list = await value<{ items: Array<{ id: string }> }>(db, `select public.storefront_list_products(p_sort => 'best_selling', p_limit => 60)`)
      const ids = list.items.map((x) => x.id)
      expect(ids.indexOf(b.productId)).toBe(0)
      expect(ids).toContain(a.productId)
      expect(ids).toContain(c.productId)
    }))
})
