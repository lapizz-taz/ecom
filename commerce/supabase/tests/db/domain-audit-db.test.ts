import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

// Audit of the custom-domain database logic: many virtual stores and domains run through
// store_domain_guard / store_domain_save / store_domain_set_primary / store_domains_list /
// store_domain_known / storefront_resolve. Every test asserts the CORRECT behaviour, so a
// failing test marks a defect; the passing ones stay as regression coverage.

const ROOT = 'fullfilio.shop'

interface Store { m: string; owner: string; email: string }

async function platform(db: Db, main: 'store' | 'marketing' = 'marketing', root: string | null = ROOT): Promise<void> {
  await asSystem(db, null)
  await db.query(`update public.features set globally_enabled = true where code = 'custom_domains'`)
  await db.query(`update public.platform_settings set value = $1 where key = 'store_domains'`, [JSON.stringify({ root_domain: root, main_site: main })])
}

async function createMerchant(db: Db, name = `Shop ${randomUUID().slice(0, 6)}`): Promise<string> {
  await asSystem(db, null)
  const id = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [name])
  await asSystem(db, id)
  await db.query(`select public._merchant_seed_defaults($1)`, [id])
  await asSystem(db, null)
  await db.query(`insert into public.merchant_features (merchant_id, feature_code, enabled) values ($1, 'custom_domains', true) on conflict do nothing`, [id])
  return id
}

async function store(db: Db, name?: string): Promise<Store> {
  const m = await createMerchant(db, name)
  const email = `owner-${randomUUID().slice(0, 8)}@example.com`
  const owner = await createStaff(db, 'OWNER', email, m)
  return { m, owner, email }
}

const as = (db: Db, s: Store) => asUser(db, s.owner, s.email, s.m)

async function guard(db: Db, s: Store, d: string, action = 'add'): Promise<void> {
  await as(db, s)
  await db.query(`select public.store_domain_guard($1, $2)`, [d, action])
}

/**
 * What the domains edge function saves after asking the hosting (service role, merchant header).
 * The ownership TXT record counts as found (verified) unless a test says otherwise.
 */
async function save(db: Db, s: Store, d: string, status: string, extra: Record<string, unknown> = {}, actor: string | null = s.owner) {
  await asService(db, s.m)
  return value<Record<string, any>>(db, `select public.store_domain_save($1, $2, $3)`, [d, JSON.stringify({ status, verified: status !== 'REMOVED', ...extra }), actor])
}

/** The edge function's "add": guard first, then save what the hosting reported. */
async function add(db: Db, s: Store, d: string, status = 'ACTIVE') {
  await guard(db, s, d, 'add')
  return save(db, s, d, status)
}

async function remove(db: Db, s: Store, d: string): Promise<void> {
  await guard(db, s, d, 'remove')
  await save(db, s, d, 'REMOVED', { records: [], detail: 'Removed from the store' })
}

async function resolve(db: Db, host: string | null): Promise<Record<string, any> | null> {
  await asAnon(db, null)
  return value<Record<string, any> | null>(db, `select public.storefront_resolve($1)`, [host])
}

async function known(db: Db, d: string | null): Promise<boolean | null> {
  await asService(db, null)
  return value<boolean | null>(db, `select public.store_domain_known($1)`, [d])
}

async function row(db: Db, d: string): Promise<{ merchant_id: string; status: string; is_primary: boolean } | null> {
  await asSystem(db, null)
  return (await db.query(`select merchant_id, status, is_primary from public.store_domains where domain = $1`, [d])).rows[0] ?? null
}

async function primaryOf(db: Db, m: string): Promise<string[]> {
  await asSystem(db, null)
  return value<string[]>(db, `select coalesce(array_agg(domain order by domain), '{}') from public.store_domains where merchant_id = $1 and is_primary and status <> 'REMOVED'`, [m])
}

async function removedPrimaries(db: Db): Promise<number> {
  await asSystem(db, null)
  return value<number>(db, `select count(*)::int from public.store_domains where status = 'REMOVED' and is_primary`)
}

const storeOf = (r: Record<string, any> | null) => (r && r.kind === 'store' ? r.merchant_id : null)

// ---------------------------------------------------------------------------
// 1. Two stores and the same domain
// ---------------------------------------------------------------------------
describe('two stores, one domain', () => {
  it('B cannot claim A\'s domain in any spelling (case, spaces, www twin, trailing dot)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'shop-one.test')
      for (const d of ['shop-one.test', 'SHOP-ONE.TEST', '  shop-one.test  ', 'www.shop-one.test', 'WWW.Shop-One.Test']) {
        await as(db, B)
        await expectError(db, `select public.store_domain_guard($1, 'add')`, [d], /DUPLICATE/)
      }
      // A trailing dot is the same DNS name: refused too (any error), never a second row.
      await as(db, B)
      await expectError(db, `select public.store_domain_guard($1, 'add')`, ['shop-one.test.'], /.+/)
      await expectError(db, `select public.store_domain_guard($1, 'add')`, ['www.shop-one.test.'], /.+/)
      expect(await row(db, 'shop-one.test')).toMatchObject({ merchant_id: A.m, status: 'ACTIVE', is_primary: true })
      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.store_domains where merchant_id = $1`, [B.m])).toBe(0)
      expect(storeOf(await resolve(db, 'shop-one.test'))).toBe(A.m)
      expect(storeOf(await resolve(db, 'www.shop-one.test'))).toBe(A.m)
    }))

  it('B cannot check, remove, make primary, list or overwrite A\'s domain', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'shop-two.test')
      await add(db, B, 'b-own.test')
      await as(db, B)
      for (const action of ['check', 'remove', 'primary']) {
        await expectError(db, `select public.store_domain_guard('shop-two.test', $1)`, [action], /NOT_FOUND/)
      }
      await expectError(db, `select public.store_domain_set_primary('shop-two.test')`, [], /NOT_FOUND/)
      const listB = await value<Array<{ domain: string }>>(db, `select public.store_domains_list()`)
      expect(listB.map((d) => d.domain)).toEqual(['b-own.test'])
      // The service role acting for B (x-merchant-id: B) cannot overwrite A's row either.
      await asService(db, B.m)
      await expectError(db, `select public.store_domain_save('shop-two.test', '{"status":"REMOVED"}', null)`, [], /row-level security|row level security/)
      expect(await value<Array<{ domain: string }>>(db, `select public.store_domains_list()`)).toEqual([expect.objectContaining({ domain: 'b-own.test' })])
      expect(await row(db, 'shop-two.test')).toMatchObject({ merchant_id: A.m, status: 'ACTIVE', is_primary: true })
    }))

  it('after A removed a domain, store B can connect it (a removed row serves nobody)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'moved.test')
      await remove(db, A, 'moved.test')
      expect(await resolve(db, 'moved.test')).toEqual({ kind: 'missing' })
      // The business sold the domain / moved to another store account.
      await add(db, B, 'moved.test')
      expect(await row(db, 'moved.test')).toMatchObject({ merchant_id: B.m, status: 'ACTIVE', is_primary: true })
      expect(storeOf(await resolve(db, 'moved.test'))).toBe(B.m)
      expect(await known(db, 'moved.test')).toBe(true)
      // …and A cannot take it back while B has it.
      await as(db, A)
      await expectError(db, `select public.store_domain_guard('moved.test', 'add')`, [], /DUPLICATE/)
    }))

  it('after A removed its apex, B can take the www twin; the apex then follows B and A cannot re-add it', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'apex-gone.test')
      await remove(db, A, 'apex-gone.test')
      await add(db, B, 'www.apex-gone.test')
      expect(storeOf(await resolve(db, 'www.apex-gone.test'))).toBe(B.m)
      // The removed apex is now only B's twin: it opens B (redirecting to B's live domain).
      expect(await resolve(db, 'apex-gone.test')).toMatchObject({ kind: 'store', merchant_id: B.m, redirect_to: 'www.apex-gone.test' })
      await as(db, A)
      await expectError(db, `select public.store_domain_guard('apex-gone.test', 'add')`, [], /DUPLICATE/)
      expect(await row(db, 'apex-gone.test')).toMatchObject({ merchant_id: A.m, status: 'REMOVED', is_primary: false })
    }))

  it('A removed its apex but kept www: B still cannot take the apex (A\'s twin protects it)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'kept-www.test')
      await add(db, A, 'www.kept-www.test')
      await remove(db, A, 'kept-www.test')
      await as(db, B)
      await expectError(db, `select public.store_domain_guard('kept-www.test', 'add')`, [], /DUPLICATE/)
      expect(await primaryOf(db, A.m)).toEqual(['www.kept-www.test'])
      expect(storeOf(await resolve(db, 'kept-www.test'))).toBe(A.m)
      expect(await known(db, 'kept-www.test')).toBe(true)
    }))

  it('a store can claim the apex of its own www domain even when another store removed that apex earlier', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, B, 'handover.test')
      await remove(db, B, 'handover.test')
      await add(db, A, 'www.handover.test')
      // A now serves the apex as its twin, so A must also be able to connect it.
      await add(db, A, 'handover.test')
      expect(await row(db, 'handover.test')).toMatchObject({ merchant_id: A.m })
    }))
})

// ---------------------------------------------------------------------------
// 2. Twin conflicts
// ---------------------------------------------------------------------------
describe('www / apex twins', () => {
  it('A has www.x, B adds x (and the reverse): refused both ways; resolve and known stay with A', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'www.twin-a.test')
      await add(db, A, 'twin-b.test')
      await as(db, B)
      await expectError(db, `select public.store_domain_guard('twin-a.test', 'add')`, [], /DUPLICATE/)
      await expectError(db, `select public.store_domain_guard('www.twin-b.test', 'add')`, [], /DUPLICATE/)
      expect(await resolve(db, 'twin-a.test')).toMatchObject({ kind: 'store', merchant_id: A.m, redirect_to: 'www.twin-a.test' })
      expect(storeOf(await resolve(db, 'www.twin-b.test'))).toBe(A.m)
      expect(await known(db, 'twin-a.test')).toBe(true)
      expect(await known(db, 'www.twin-b.test')).toBe(true)
    }))

  it('www.<apex> of store A never opens store B that connected www.www.<apex> (B connected first)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      // B claims the odd name first: no DNS is needed for a PENDING row to count.
      await add(db, B, 'www.www.zz-brand.test', 'PENDING')
      await add(db, A, 'zz-brand.test', 'ACTIVE')
      expect(await resolve(db, 'www.zz-brand.test')).toMatchObject({ kind: 'store', merchant_id: A.m, redirect_to: 'zz-brand.test' })
      expect(storeOf(await resolve(db, 'www.www.zz-brand.test'))).toBe(B.m)
      expect(storeOf(await resolve(db, 'zz-brand.test'))).toBe(A.m)
    }))

  it('www.<apex> of store A never opens store B that connected www.www.<apex> (A connected first)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'aa-brand.test', 'ACTIVE')
      await add(db, B, 'www.www.aa-brand.test', 'PENDING')
      expect(await resolve(db, 'www.aa-brand.test')).toMatchObject({ kind: 'store', merchant_id: A.m, redirect_to: 'aa-brand.test' })
    }))

  it('www.www.<apex> is not a twin of <apex>: unknown when only <apex> is connected', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'deep.test')
      expect(await known(db, 'www.www.deep.test')).toBe(false)
      expect(storeOf(await resolve(db, 'www.www.deep.test'))).toBeNull()
    }))

  it('connecting www.www.x does not give a store www.x (that name is the twin of x)', () =>
    inTx(async (db) => {
      await platform(db)
      const B = await store(db)
      await add(db, B, 'www.www.solo.test', 'PENDING')
      expect(await known(db, 'www.solo.test')).toBe(false)
      expect(storeOf(await resolve(db, 'www.solo.test'))).toBeNull()
      expect(storeOf(await resolve(db, 'www.www.solo.test'))).toBe(B.m)
    }))

  it('the same store adding its own domain or twin again is harmless and keeps the primary', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'idem.test')
      await add(db, A, 'IDEM.TEST')
      await add(db, A, 'www.idem.test')
      expect(await primaryOf(db, A.m)).toEqual(['idem.test'])
      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.store_domains where merchant_id = $1`, [A.m])).toBe(2)
    }))

  it('subdomain twins: www.blog.x follows blog.x; another store may own x itself', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'blog.sub-twin.test')
      expect(await known(db, 'www.blog.sub-twin.test')).toBe(true)
      expect(await resolve(db, 'www.blog.sub-twin.test')).toMatchObject({ merchant_id: A.m, redirect_to: 'blog.sub-twin.test' })
      await as(db, B)
      await expectError(db, `select public.store_domain_guard('www.blog.sub-twin.test', 'add')`, [], /DUPLICATE/)
      // The parent domain is a different name: B may connect it, and each keeps its own.
      await add(db, B, 'sub-twin.test')
      expect(storeOf(await resolve(db, 'sub-twin.test'))).toBe(B.m)
      expect(storeOf(await resolve(db, 'www.sub-twin.test'))).toBe(B.m)
      expect(storeOf(await resolve(db, 'blog.sub-twin.test'))).toBe(A.m)
      expect(storeOf(await resolve(db, 'www.blog.sub-twin.test'))).toBe(A.m)
      expect(await known(db, 'mail.sub-twin.test')).toBe(false)
    }))

  it('www.co.uk-style names stay separate from the stores under them', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'shop.co.uk')
      await add(db, B, 'www.co.uk')
      expect(storeOf(await resolve(db, 'www.shop.co.uk'))).toBe(A.m)
      expect(storeOf(await resolve(db, 'co.uk'))).toBe(B.m)
      expect(storeOf(await resolve(db, 'shop.co.uk'))).toBe(A.m)
      await as(db, A)
      await expectError(db, `select public.store_domain_guard('co.uk', 'add')`, [], /DUPLICATE/)
    }))
})

// ---------------------------------------------------------------------------
// 3. Platform-reserved names
// ---------------------------------------------------------------------------
describe('platform-reserved names', () => {
  const reserved = ['fullfilio.com', 'www.fullfilio.com', 'stores.fullfilio.com', 'anything.fullfilio.com', 'FULLFILIO.COM', ' fullfilio.com ',
    ROOT, `www.${ROOT}`, `some-store.${ROOT}`]

  it('the guard refuses every platform name', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      for (const d of reserved) {
        await as(db, A)
        await expectError(db, `select public.store_domain_guard($1, 'add')`, [d], /DOMAIN_REJECTED/)
      }
      // Look-alikes that are not platform names are fine.
      await add(db, A, 'notfullfilio.com')
      await add(db, A, 'fullfilio.com.bd')
    }))

  it('store_domain_known is false for every platform name, even with a row that slipped in', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await asSystem(db, null)
      for (const d of ['fullfilio.com', 'www.fullfilio.com', 'stores.fullfilio.com', 'anything.fullfilio.com', ROOT, `www.${ROOT}`, `x.${ROOT}`]) {
        await db.query(`insert into public.store_domains (merchant_id, domain, status) values ($1, $2, 'ACTIVE')`, [A.m, d])
      }
      for (const d of reserved) expect(await known(db, d), d).toBe(false)
      expect(await known(db, `www.x.${ROOT}`)).toBe(false)
      expect(await known(db, 'www.stores.fullfilio.com')).toBe(false)
      // And the resolver never serves the slipped-in rows.
      expect(storeOf(await resolve(db, 'fullfilio.com'))).toBeNull()
      expect(storeOf(await resolve(db, `x.${ROOT}`))).toBeNull()
    }))

  it('store_domain_save (service role) does not create the twin of another store\'s domain', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'save-twin.test')
      await asService(db, B.m)
      await expectError(db, `select public.store_domain_save('www.save-twin.test', '{"status":"ACTIVE"}', null)`, [], /DUPLICATE/)
      expect(storeOf(await resolve(db, 'www.save-twin.test'))).toBe(A.m)
    }))

  it('store_domain_save (service role) refuses a platform name too', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await asService(db, A.m)
      for (const d of ['fullfilio.com', 'www.fullfilio.com', `x.${ROOT}`]) {
        await expectError(db, `select public.store_domain_save($1, '{"status":"ACTIVE"}', null)`, [d], /DOMAIN_REJECTED|reserved|platform/i)
      }
    }))
})

// ---------------------------------------------------------------------------
// 4. store_domain_known
// ---------------------------------------------------------------------------
describe('store_domain_known', () => {
  it('accepts case and whitespace; refuses ports, empty, NULL and names nobody connected', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'known.test', 'PENDING')
      for (const d of ['known.test', 'KNOWN.TEST', '  known.test ', 'www.known.test', 'WWW.Known.Test']) expect(await known(db, d), d).toBe(true)
      for (const d of ['known.test:443', '', '   ', 'other.test', 'www.other.test', 'mail.known.test', 'known.tes', 'xknown.test']) {
        expect(await known(db, d), d).toBe(false)
      }
      expect(await known(db, null)).toBe(false)
    }))

  it('removed domain, removed twin, only-the-twin-removed', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'gone.test')
      await remove(db, A, 'gone.test')
      expect(await known(db, 'gone.test')).toBe(false)
      expect(await known(db, 'www.gone.test')).toBe(false)

      await add(db, A, 'pair.test')
      await add(db, A, 'www.pair.test')
      await remove(db, A, 'www.pair.test')
      // Only the twin row was removed: the apex is still connected, so its twin still works.
      expect(await known(db, 'pair.test')).toBe(true)
      expect(await known(db, 'www.pair.test')).toBe(true)
      await remove(db, A, 'pair.test')
      expect(await known(db, 'pair.test')).toBe(false)
      expect(await known(db, 'www.pair.test')).toBe(false)
    }))

  it('a closed business gets no new certificates for its domains', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'closed-cert.test')
      await asSystem(db, null)
      await db.query(`update public.merchants set status = 'CLOSED' where id = $1`, [A.m])
      expect(await known(db, 'closed-cert.test')).toBe(false)
      expect(await known(db, 'www.closed-cert.test')).toBe(false)
    }))
})

// ---------------------------------------------------------------------------
// 5. storefront_resolve
// ---------------------------------------------------------------------------
describe('storefront_resolve', () => {
  it('host with port, uppercase and spaces opens the same store', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'forms.test')
      for (const h of ['forms.test', 'FORMS.TEST', ' forms.test ', 'forms.test:443', 'Forms.Test:8080']) {
        expect(await resolve(db, h), h).toMatchObject({ kind: 'store', merchant_id: A.m, redirect_to: null })
      }
      expect(await resolve(db, 'www.forms.test:443')).toMatchObject({ kind: 'store', merchant_id: A.m, redirect_to: 'forms.test' })
    }))

  it('a trailing dot (what browsers send for "shop.com.") opens the same store', () =>
    inTx(async (db) => {
      // 'store' first: there the trailing dot opens Merchant #1's store on A's domain.
      for (const main of ['store', 'marketing'] as const) {
        await platform(db, main)
        const A = await store(db)
        const d = `dot-${main}.test`
        await add(db, A, d)
        for (const h of [`${d}.`, `${d.toUpperCase()}.`, `${d}.:8443`, `www.${d}.`]) {
          expect(storeOf(await resolve(db, h)), `${main} ${h}`).toBe(A.m)
        }
      }
    }))

  it('the twin and non-primary domains go to the primary domain; the primary stays', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'first.test')
      await add(db, A, 'brand.test')
      await as(db, A)
      await db.query(`select public.store_domain_set_primary(' Brand.Test ')`)
      expect(await primaryOf(db, A.m)).toEqual(['brand.test'])
      expect(await resolve(db, 'first.test')).toMatchObject({ merchant_id: A.m, redirect_to: 'brand.test' })
      expect(await resolve(db, 'www.first.test')).toMatchObject({ merchant_id: A.m, redirect_to: 'brand.test' })
      expect(await resolve(db, 'brand.test')).toMatchObject({ merchant_id: A.m, redirect_to: null })
      expect(await resolve(db, 'www.brand.test')).toMatchObject({ merchant_id: A.m, redirect_to: 'brand.test' })
    }))

  it('no redirect loops: following redirect_to once always lands on a page that stays', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const hosts = ['loop-a.test', 'www.loop-a.test', 'loop-b.test', 'www.loop-b.test', 'loop-c.test']
      await add(db, A, 'loop-a.test')
      await add(db, A, 'www.loop-a.test')
      await add(db, A, 'loop-b.test', 'PENDING')
      await add(db, A, 'loop-c.test', 'ERROR')
      for (const p of ['loop-b.test', 'www.loop-a.test', 'loop-c.test', 'loop-a.test']) {
        await as(db, A)
        await db.query(`select public.store_domain_set_primary($1)`, [p])
        for (const h of hosts) {
          const r = await resolve(db, h)
          expect(storeOf(r), `${p} ${h}`).toBe(A.m)
          if (r?.redirect_to) {
            expect(r.redirect_to, `${p} ${h}`).not.toBe(h)
            expect((await resolve(db, r.redirect_to))?.redirect_to ?? null, `${p} ${h} -> ${r.redirect_to}`).toBeNull()
            expect((await row(db, r.redirect_to))?.status, `${p} ${h}`).toBe('ACTIVE')
          }
        }
      }
    }))

  it('primary not live: nobody is redirected; a store without any primary redirects nobody either', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'waiting.test', 'PENDING')
      await add(db, A, 'live.test', 'ACTIVE')
      expect(await primaryOf(db, A.m)).toEqual(['waiting.test'])
      expect(await resolve(db, 'live.test')).toMatchObject({ merchant_id: A.m, redirect_to: null })
      expect(await resolve(db, 'waiting.test')).toMatchObject({ merchant_id: A.m, redirect_to: null })
      await asSystem(db, null)
      await db.query(`update public.store_domains set is_primary = false where merchant_id = $1`, [A.m])
      expect(await resolve(db, 'live.test')).toMatchObject({ merchant_id: A.m, redirect_to: null })
      // Only the twin is asked for: it goes on to the live connected domain.
      expect(await resolve(db, 'www.live.test')).toMatchObject({ merchant_id: A.m, redirect_to: 'live.test' })
      expect(await resolve(db, 'www.waiting.test')).toMatchObject({ merchant_id: A.m, redirect_to: null })
    }))

  it('a removed domain and its twin show "missing" in both platform modes', () =>
    inTx(async (db) => {
      for (const main of ['marketing', 'store'] as const) {
        await platform(db, main)
        const A = await store(db)
        const d = `removed-${main}.test`
        await add(db, A, d)
        await remove(db, A, d)
        expect(await resolve(db, d), main).toEqual({ kind: 'missing' })
        expect(await resolve(db, `www.${d}`), main).toEqual({ kind: 'missing' })
        expect(await resolve(db, `${d.toUpperCase()}:443`), main).toEqual({ kind: 'missing' })
      }
    }))

  it('a closed business\'s domain shows "missing", never the platform site or another store', () =>
    inTx(async (db) => {
      // 'store' first: the resolver returns NULL there, which the web app shows as the platform site.
      for (const main of ['store', 'marketing'] as const) {
        await platform(db, main)
        const A = await store(db)
        const d = `closed-${main}.test`
        await add(db, A, d)
        await asSystem(db, null)
        await db.query(`update public.merchants set status = 'CLOSED' where id = $1`, [A.m])
        expect(await resolve(db, d), main).toEqual({ kind: 'missing' })
        expect(await resolve(db, `www.${d}`), main).toEqual({ kind: 'missing' })
      }
    }))

  it('storefront OFF / Shopify / WooCommerce: the custom domain still names the store (the page shows "closed")', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'mode.test')
      for (const mode of ['OFF', 'SHOPIFY', 'WOOCOMMERCE', 'OWN']) {
        await asSystem(db, A.m)
        await db.query(`update public.settings set value = value || jsonb_build_object('mode', $1::text) where merchant_id = $2 and key = 'storefront'`, [mode, A.m])
        expect(await resolve(db, 'mode.test'), mode).toMatchObject({ kind: 'store', merchant_id: A.m })
      }
    }))

  it('empty / NULL host and unknown hosts follow the platform setting, not some store\'s domain', () =>
    inTx(async (db) => {
      await platform(db, 'marketing')
      const A = await store(db)
      await add(db, A, 'some.test')
      for (const h of ['', null, 'never.test', 'www.never.test', ROOT, `www.${ROOT}`]) {
        expect(await resolve(db, h), String(h)).toEqual({ kind: 'platform' })
      }
      expect(await resolve(db, `nobody.${ROOT}`)).toEqual({ kind: 'missing' })
    }))

  it('the <slug>.<root> address opens the store; a domain row never overrides it', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await asSystem(db, null)
      await db.query(`update public.merchants set slug = 'alpha-shop' where id = $1`, [A.m])
      expect(storeOf(await resolve(db, `alpha-shop.${ROOT}`))).toBe(A.m)
      expect(storeOf(await resolve(db, `ALPHA-SHOP.${ROOT.toUpperCase()}:443`))).toBe(A.m)
      await as(db, B)
      await expectError(db, `select public.store_domain_guard($1, 'add')`, [`alpha-shop.${ROOT}`], /DOMAIN_REJECTED/)
      await expectError(db, `select public.store_domain_guard($1, 'add')`, [`www.alpha-shop.${ROOT}`], /DOMAIN_REJECTED/)
    }))
})

// ---------------------------------------------------------------------------
// 6. Primary rules
// ---------------------------------------------------------------------------
describe('primary domain', () => {
  it('one primary per store; each store has its own; set_primary never touches another store', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'a1.test')
      await add(db, A, 'a2.test')
      await add(db, B, 'b1.test')
      await add(db, B, 'b2.test')
      expect(await primaryOf(db, A.m)).toEqual(['a1.test'])
      expect(await primaryOf(db, B.m)).toEqual(['b1.test'])
      await as(db, A)
      await db.query(`select public.store_domain_set_primary('a2.test')`)
      expect(await primaryOf(db, A.m)).toEqual(['a2.test'])
      expect(await primaryOf(db, B.m)).toEqual(['b1.test'])
      await expectError(db, `select public.store_domain_set_primary('b2.test')`, [], /NOT_FOUND/)
      expect(await primaryOf(db, B.m)).toEqual(['b1.test'])
    }))

  it('removing the primary hands it to the oldest live domain, else the oldest; none when all are gone', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'p1.test')
      await add(db, A, 'p2.test', 'PENDING')
      await add(db, A, 'p3.test', 'ACTIVE')
      await remove(db, A, 'p1.test')
      expect(await primaryOf(db, A.m)).toEqual(['p3.test'])
      await remove(db, A, 'p3.test')
      expect(await primaryOf(db, A.m)).toEqual(['p2.test'])
      await remove(db, A, 'p2.test')
      expect(await primaryOf(db, A.m)).toEqual([])
      expect(await removedPrimaries(db)).toBe(0)
    }))

  it('set_primary refuses a removed domain, a twin that is not connected, another store\'s domain; VIEWER and MANAGER cannot', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await add(db, A, 'sp1.test')
      await add(db, A, 'sp2.test')
      await remove(db, A, 'sp2.test')
      await add(db, B, 'sp-b.test')
      await as(db, A)
      for (const d of ['sp2.test', 'www.sp1.test', 'sp-b.test', '', 'sp1.test.']) {
        await expectError(db, `select public.store_domain_set_primary($1)`, [d], /NOT_FOUND/)
      }
      await expectError(db, `select public.store_domain_set_primary(null)`, [], /NOT_FOUND/)
      for (const role of ['VIEWER', 'MANAGER']) {
        const email = `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`
        const id = await createStaff(db, role, email, A.m)
        await asUser(db, id, email, A.m)
        await expectError(db, `select public.store_domain_set_primary('sp1.test')`, [], /PERMISSION_DENIED/)
      }
      expect(await primaryOf(db, A.m)).toEqual(['sp1.test'])
      expect(await removedPrimaries(db)).toBe(0)
    }))

  it('a domain added again is primary when the store has no other, secondary otherwise', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'again.test')
      await remove(db, A, 'again.test')
      await add(db, A, 'again.test', 'PENDING')
      expect(await row(db, 'again.test')).toMatchObject({ status: 'PENDING', is_primary: true })
      await add(db, A, 'other-again.test')
      await remove(db, A, 'again.test')
      expect(await primaryOf(db, A.m)).toEqual(['other-again.test'])
      await add(db, A, 'again.test')
      expect(await row(db, 'again.test')).toMatchObject({ status: 'ACTIVE', is_primary: false })
      expect(await removedPrimaries(db)).toBe(0)
    }))

  it('a re-check that lands after the domain was removed does not bring it back', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'revive.test')
      // recheck_all listed the domain, then the owner removed it while the hosting was being asked…
      await remove(db, A, 'revive.test')
      // …and the re-check saves what it found (service role, no actor).
      await save(db, A, 'revive.test', 'ACTIVE', { records: [] }, null)
      expect(await row(db, 'revive.test')).toMatchObject({ status: 'REMOVED', is_primary: false })
      expect(await known(db, 'revive.test')).toBe(false)
      expect(await resolve(db, 'revive.test')).toEqual({ kind: 'missing' })
    }))
})

// ---------------------------------------------------------------------------
// 7. Permissions
// ---------------------------------------------------------------------------
describe('permissions', () => {
  it('VIEWER cannot list, add or remove; MANAGER can list but not add or remove', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'perm.test')
      const viewerEmail = `viewer-${randomUUID().slice(0, 6)}@example.com`
      const viewer = await createStaff(db, 'VIEWER', viewerEmail, A.m)
      const managerEmail = `manager-${randomUUID().slice(0, 6)}@example.com`
      const manager = await createStaff(db, 'MANAGER', managerEmail, A.m)
      await asUser(db, viewer, viewerEmail, A.m)
      await expectError(db, `select public.store_domains_list()`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.store_domain_guard('new-perm.test', 'add')`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.store_domain_guard('perm.test', 'remove')`, [], /PERMISSION_DENIED/)
      await asUser(db, manager, managerEmail, A.m)
      expect(await value<unknown[]>(db, `select public.store_domains_list()`)).toHaveLength(1)
      await expectError(db, `select public.store_domain_guard('new-perm.test', 'add')`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.store_domain_guard('perm.test', 'remove')`, [], /PERMISSION_DENIED/)
      expect(await row(db, 'new-perm.test')).toBeNull()
    }))

  it('anon can only resolve; signed-in staff cannot call the service-only functions', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await add(db, A, 'grants.test')
      const calls = [
        `select public.store_domain_guard('grants.test', 'remove')`,
        `select public.store_domain_save('grants.test', '{"status":"REMOVED"}', null)`,
        `select public.store_domain_set_primary('grants.test')`,
        `select public.store_domains_list()`,
        `select public.store_domain_known('grants.test')`,
        `select public._store_domain_taken('grants.test', gen_random_uuid())`,
        `select public._store_domain_reserved('grants.test')`,
      ]
      for (const sql of calls) {
        await asAnon(db, A.m)
        await expectError(db, sql, [], /permission denied/)
      }
      for (const sql of calls.slice(1)) {
        if (sql.includes('set_primary') || sql.includes('store_domains_list')) continue
        await as(db, A)
        await expectError(db, sql, [], /permission denied|PERMISSION_DENIED/)
      }
      await asAnon(db, A.m)
      expect(storeOf(await value(db, `select public.storefront_resolve('grants.test')`))).toBe(A.m)
      expect(await row(db, 'grants.test')).toMatchObject({ status: 'ACTIVE' })
    }))

  it('a closed or suspended store\'s owner cannot add a domain', () =>
    inTx(async (db) => {
      await platform(db)
      for (const status of ['CLOSED', 'SUSPENDED']) {
        const A = await store(db)
        await asSystem(db, null)
        await db.query(`update public.merchants set status = $1 where id = $2`, [status, A.m])
        await as(db, A)
        await expectError(db, `select public.store_domain_guard($1, 'add')`, [`${status.toLowerCase()}-claim.test`], /PERMISSION_DENIED|FEATURE|No merchant/)
        expect(await row(db, `${status.toLowerCase()}-claim.test`)).toBeNull()
      }
    }))

  it('the service role without a merchant cannot claim or save a domain', () =>
    inTx(async (db) => {
      await platform(db)
      await asService(db, null)
      await expectError(db, `select public.store_domain_guard('orphan.test', 'add')`, [], /No merchant in context/)
      await expectError(db, `select public.store_domain_save('orphan.test', '{"status":"PENDING"}', null)`, [], /.+/)
      expect(await row(db, 'orphan.test')).toBeNull()
    }))
})

// ---------------------------------------------------------------------------
// 8. Store reset and merchant delete
// ---------------------------------------------------------------------------
describe('store reset and merchant delete', () => {
  const asPlatform = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

  it('a full store reset removes the domains: no certificate, no store, and the name is free again', () =>
    inTx(async (db) => {
      await platform(db)
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const A = await store(db, `Reset Shop ${randomUUID().slice(0, 6)}`)
      const B = await store(db)
      await add(db, A, 'reset-shop.test')
      await add(db, A, 'www.reset-shop.test')
      await asSystem(db, null)
      const name = await value<string>(db, `select name from public.merchants where id = $1`, [A.m])
      await asPlatform(db, superId)
      await db.query(`select public.platform_merchant_export($1, 'Copy before resetting the store')`, [A.m])
      await db.query(`select public.platform_store_reset($1, 'EVERYTHING', $2, 'Fresh start before going live')`, [A.m, name])
      expect(await row(db, 'reset-shop.test')).toBeNull()
      expect(await known(db, 'reset-shop.test')).toBe(false)
      expect(await known(db, 'www.reset-shop.test')).toBe(false)
      expect(storeOf(await resolve(db, 'reset-shop.test'))).not.toBe(A.m)
      await add(db, B, 'reset-shop.test')
      expect(storeOf(await resolve(db, 'reset-shop.test'))).toBe(B.m)
    }))

  it('deleting a merchant removes its domains and certificates are no longer asked for', () =>
    inTx(async (db) => {
      await platform(db)
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      const superB = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asPlatform(db, superA)
      const id = (await value<{ id: string }>(db, `select public.platform_merchant_create('{"name": "Doomed Domains"}')`)).id
      await asSystem(db, null)
      await db.query(`insert into public.merchant_features (merchant_id, feature_code, enabled) values ($1, 'custom_domains', true) on conflict do nothing`, [id])
      const email = `owner-${randomUUID().slice(0, 6)}@doomed.example`
      const A: Store = { m: id, owner: await createStaff(db, 'OWNER', email, id), email }
      await add(db, A, 'doomed.test')
      expect(await known(db, 'doomed.test')).toBe(true)
      await asPlatform(db, superA)
      await db.query(`select public.platform_merchant_export($1, 'Copy before deleting the merchant')`, [id])
      const req = await value<{ approval_id: string }>(db, `select public.platform_merchant_delete_request($1, 'Doomed Domains', 'Closing the test account')`, [id])
      await asPlatform(db, superB)
      const done = await value<Record<string, any>>(db, `select public.platform_approval_decide($1, true, 'Confirmed with the owner by phone')`, [req.approval_id])
      expect(done.status).toBe('EXECUTED')
      expect(await row(db, 'doomed.test')).toBeNull()
      expect(await known(db, 'doomed.test')).toBe(false)
      expect(await known(db, 'www.doomed.test')).toBe(false)
      expect(storeOf(await resolve(db, 'doomed.test'))).toBeNull()
    }))
})

describe('ownership (the _fullfilio TXT record)', () => {
  it('a domain not proven yet gets no certificate and opens no store; proven, it does', () =>
    inTx(async (db) => {
      await platform(db)
      const a = await store(db)
      await add(db, a, 'zz-claim.test', 'VERIFYING')
      // Saved as the function does before the record is found.
      await guard(db, a, 'zz-new.test', 'add')
      await save(db, a, 'zz-new.test', 'VERIFYING', { verified: false })
      expect(await known(db, 'zz-new.test')).toBe(false)
      expect(await known(db, 'www.zz-new.test')).toBe(false)
      expect(await resolve(db, 'zz-new.test')).toEqual({ kind: 'missing' })
      // Found: the code proves it.
      await save(db, a, 'zz-new.test', 'VERIFYING', { verified: true })
      expect(await known(db, 'zz-new.test')).toBe(true)
      expect(await resolve(db, 'zz-new.test')).toMatchObject({ kind: 'store' })
      expect(await known(db, 'zz-claim.test')).toBe(true)
    }))

  it('every claim has its own code; removing clears the proof and a re-add keeps the code', () =>
    inTx(async (db) => {
      await platform(db)
      const a = await store(db)
      const b = await store(db)
      await guard(db, a, 'zz-one.test', 'add')
      await guard(db, b, 'zz-two.test', 'add')
      await asSystem(db, null)
      const codes = (await db.query(`select domain, verify_code from public.store_domains where domain in ('zz-one.test', 'zz-two.test') order by domain`)).rows
      expect(codes.every((r) => /^[0-9a-f]{32}$/.test(r.verify_code))).toBe(true)
      expect(codes[0].verify_code).not.toBe(codes[1].verify_code)
      await save(db, a, 'zz-one.test', 'ACTIVE')
      await remove(db, a, 'zz-one.test')
      await asSystem(db, null)
      expect((await db.query(`select verified_at from public.store_domains where domain = 'zz-one.test'`)).rows[0].verified_at).toBeNull()
      await guard(db, a, 'zz-one.test', 'add')
      await asSystem(db, null)
      expect((await db.query(`select verify_code, verified_at from public.store_domains where domain = 'zz-one.test'`)).rows[0])
        .toEqual({ verify_code: codes[0].verify_code, verified_at: null })
      expect(await known(db, 'zz-one.test')).toBe(false)
    }))

  it('a proven twin opens the store even while the other name is still being proven', () =>
    inTx(async (db) => {
      await platform(db)
      const a = await store(db)
      await add(db, a, 'zz-twin.test', 'ACTIVE')
      await guard(db, a, 'www.zz-twin.test', 'add')
      await save(db, a, 'www.zz-twin.test', 'VERIFYING', { verified: false })
      expect(await resolve(db, 'www.zz-twin.test')).toMatchObject({ kind: 'store', redirect_to: 'zz-twin.test' })
      expect(await known(db, 'www.zz-twin.test')).toBe(true)
    }))
})
