import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

// Round 3 of the custom-domain audit: can a normal merchant action, an admin action or a
// background job take a proven, live domain offline (or leave a wrong state) while its owner
// did nothing wrong with DNS? Every test starts from "proven + ACTIVE" and asserts the CORRECT
// behaviour. it.fails marks a defect found on the current code (the comment above it says what
// should happen); the plain tests are regression coverage for scenarios that already work.

const ROOT = 'fullfilio.shop'

interface Store { m: string; owner: string; email: string }

async function platform(db: Db, main: 'store' | 'marketing' = 'marketing'): Promise<void> {
  await asSystem(db, null)
  await db.query(`update public.features set globally_enabled = true where code = 'custom_domains'`)
  await db.query(`update public.platform_settings set value = $1 where key = 'store_domains'`, [JSON.stringify({ root_domain: ROOT, main_site: main })])
}

async function store(db: Db, name = `Shop ${randomUUID().slice(0, 6)}`): Promise<Store> {
  await asSystem(db, null)
  const m = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [name])
  await asSystem(db, m)
  await db.query(`select public._merchant_seed_defaults($1)`, [m])
  await asSystem(db, null)
  await db.query(`insert into public.merchant_features (merchant_id, feature_code, enabled) values ($1, 'custom_domains', true) on conflict do nothing`, [m])
  const email = `owner-${randomUUID().slice(0, 8)}@example.com`
  const owner = await createStaff(db, 'OWNER', email, m)
  return { m, owner, email }
}

const as = (db: Db, s: Store) => asUser(db, s.owner, s.email, s.m)

async function guard(db: Db, s: Store, d: string, action = 'add'): Promise<void> {
  await as(db, s)
  await db.query(`select public.store_domain_guard($1, $2)`, [d, action])
}

/** What the domains function saves (service role, x-merchant-id of the store). */
async function save(db: Db, s: Store, d: string, p: Record<string, unknown>, actor: string | null = null) {
  await asService(db, s.m)
  return value<Record<string, any> | null>(db, `select public.store_domain_save($1, $2, $3)`, [d, JSON.stringify(p), actor])
}

/** A domain added and found live with its ownership proven (the state every scenario starts from). */
async function live(db: Db, s: Store, d: string): Promise<void> {
  await guard(db, s, d)
  await save(db, s, d, { status: 'ACTIVE', verified: true, detail: 'Live — the store opens on this domain with HTTPS' }, s.owner)
}

async function remove(db: Db, s: Store, d: string): Promise<void> {
  await guard(db, s, d, 'remove')
  await save(db, s, d, { status: 'REMOVED', records: [], detail: 'Removed from the store' }, s.owner)
}

async function resolve(db: Db, host: string): Promise<Record<string, any> | null> {
  await asAnon(db, null)
  return value<Record<string, any> | null>(db, `select public.storefront_resolve($1)`, [host])
}

async function known(db: Db, d: string): Promise<boolean | null> {
  await asService(db, null)
  return value<boolean | null>(db, `select public.store_domain_known($1)`, [d])
}

async function row(db: Db, d: string): Promise<{ merchant_id: string; status: string; is_primary: boolean; verified_at: Date | null; removed_at: Date | null } | null> {
  await asSystem(db, null)
  return (await db.query(`select merchant_id, status, is_primary, verified_at, removed_at from public.store_domains where domain = $1`, [d])).rows[0] ?? null
}

const storeOf = (r: Record<string, any> | null) => (r && r.kind === 'store' ? r.merchant_id : null)

/** The store opens on this name and the proxy may get (or renew) its certificate. */
async function serves(db: Db, s: Store, d: string): Promise<{ store: string | null; cert: boolean | null }> {
  return { store: storeOf(await resolve(db, d)), cert: await known(db, d) }
}

/** Ten domains added and never proven (a store trying names, or waiting on slow DNS). */
async function tenUnproven(db: Db, s: Store): Promise<void> {
  for (let i = 1; i <= 10; i++) await guard(db, s, `try${i}-${s.m.slice(0, 6)}.test`)
}

// ---------------------------------------------------------------------------
// 1. Remove / re-add, root and www
// ---------------------------------------------------------------------------
describe('r3: removing and adding back, root and www', () => {
  // Expected: the same store removed its proven root seconds ago; adding the www name instead
  // (switching the main address) is the same domain and the same store, so it stays proven like a
  // re-add of the root within 7 days. Today the new www row starts unproven, both names show
  // "missing" and the proxy refuses the certificate until a TXT record is added.
  it('removing shop.com and adding www.shop.com seconds later keeps the store open (proof carried by the same store\'s removed twin)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-switch.test')
      await remove(db, A, 'r3-switch.test')
      await guard(db, A, 'www.r3-switch.test')
      // The function finds no proven twin in the store's list (the root is REMOVED) and saves what it saw.
      await save(db, A, 'www.r3-switch.test', { status: 'VERIFYING', verified: false }, A.owner)
      expect(await serves(db, A, 'www.r3-switch.test')).toEqual({ store: A.m, cert: true })
      expect(await serves(db, A, 'r3-switch.test')).toEqual({ store: A.m, cert: true })
    }))

  // The reverse direction: www was the main domain (the root served through it as its twin).
  it('removing www.shop.com and adding shop.com seconds later keeps the store open', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'www.r3-back.test')
      await remove(db, A, 'www.r3-back.test')
      await guard(db, A, 'r3-back.test')
      await save(db, A, 'r3-back.test', { status: 'VERIFYING', verified: false }, A.owner)
      expect(await serves(db, A, 'r3-back.test')).toEqual({ store: A.m, cert: true })
    }))

  it('control: removing and re-adding the same name within 7 days keeps it proven (root, www and a subdomain)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      for (const d of ['r3-same.test', 'www.r3-samew.test', 'shop.r3-sub.test']) {
        await live(db, A, d)
        await remove(db, A, d)
        expect((await serves(db, A, d)).cert, d).toBe(false)
        await guard(db, A, d)
        expect(await serves(db, A, d), d).toEqual({ store: A.m, cert: true })
        expect((await row(db, d))!.verified_at, d).not.toBeNull()
      }
    }))

  it('removing the www row while the root stays: the root is untouched and www keeps opening the store (twin)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-keep.test')
      await live(db, A, 'www.r3-keep.test')
      await remove(db, A, 'www.r3-keep.test')
      expect(await row(db, 'r3-keep.test')).toMatchObject({ status: 'ACTIVE', is_primary: true })
      expect(await serves(db, A, 'r3-keep.test')).toEqual({ store: A.m, cert: true })
      expect(await serves(db, A, 'www.r3-keep.test')).toEqual({ store: A.m, cert: true })
      expect(await resolve(db, 'www.r3-keep.test')).toMatchObject({ redirect_to: 'r3-keep.test' })
    }))

  it('removing the primary root while a www row is live hands primary to www; both names keep working', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-prim.test')
      await live(db, A, 'www.r3-prim.test')
      await remove(db, A, 'r3-prim.test')
      expect(await row(db, 'www.r3-prim.test')).toMatchObject({ status: 'ACTIVE', is_primary: true })
      expect(await serves(db, A, 'r3-prim.test')).toEqual({ store: A.m, cert: true })
      expect(await resolve(db, 'r3-prim.test')).toMatchObject({ redirect_to: 'www.r3-prim.test' })
    }))
})

// ---------------------------------------------------------------------------
// 2. Adding a twin, make-primary
// ---------------------------------------------------------------------------
describe('r3: twins and the primary domain', () => {
  it('adding www while the root is live, then switching primary root → www → subdomain → root: never missing, no loop', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-flip.test')
      await guard(db, A, 'www.r3-flip.test')
      // Between the guard and the save the new www row is unproven: the proven root still serves www.
      expect(await serves(db, A, 'www.r3-flip.test')).toEqual({ store: A.m, cert: true })
      await save(db, A, 'www.r3-flip.test', { status: 'ACTIVE', verified: true })
      await live(db, A, 'shop.r3-flip.test')
      for (const p of ['www.r3-flip.test', 'shop.r3-flip.test', 'r3-flip.test']) {
        await as(db, A)
        await db.query(`select public.store_domain_set_primary($1)`, [p])
        for (const d of ['r3-flip.test', 'www.r3-flip.test', 'shop.r3-flip.test']) {
          const r = await resolve(db, d)
          expect(storeOf(r), `${p}: ${d}`).toBe(A.m)
          expect(r!.redirect_to, `${p}: ${d}`).toBe(d === p ? null : p)
          expect(await known(db, d), `${p}: ${d}`).toBe(true)
        }
      }
    }))
})

// ---------------------------------------------------------------------------
// 3. A live domain whose last check was unhappy (the re-check job saved VERIFYING / ERROR)
// ---------------------------------------------------------------------------
describe('r3: a proven live domain after a bad re-check', () => {
  it('VERIFYING / ERROR / detail-only saves never clear the proof: it keeps opening and keeps its certificate (root and www)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-bad.test')
      for (const p of [
        { status: 'VERIFYING', verified: true, detail: 'DNS is right — the HTTPS certificate is issued on the first visit (usually under a minute)' },
        { status: 'ERROR', detail: 'Vercel answered 500' },
        { detail: 'Could not check right now: Cloudflare answered: 500' },
        { status: 'VERIFYING', verified: false },
      ]) {
        await save(db, A, 'r3-bad.test', p)
        expect((await row(db, 'r3-bad.test'))!.verified_at, JSON.stringify(p)).not.toBeNull()
        expect(await serves(db, A, 'r3-bad.test'), JSON.stringify(p)).toEqual({ store: A.m, cert: true })
        expect(await serves(db, A, 'www.r3-bad.test'), JSON.stringify(p)).toEqual({ store: A.m, cert: true })
      }
    }))

  // Expected: the ad beacon accepts events from every address the store really serves. A proven
  // root still opens the store while a transient re-check failure left it VERIFYING, but
  // ad_track_scope lists only status = 'ACTIVE' rows, so Meta/TikTok server events from the live
  // custom domain are dropped as "Not a page of this store" until the next good check.
  it('the ad beacon still accepts the live custom domain while its last re-check said VERIFYING', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-ads.test')
      await asService(db, A.m)
      expect((await value<{ hosts: string[] }>(db, `select public.ad_track_scope('{}')`)).hosts).toContain('r3-ads.test')
      await save(db, A, 'r3-ads.test', { status: 'VERIFYING', verified: true })
      expect(await serves(db, A, 'r3-ads.test')).toEqual({ store: A.m, cert: true })
      await asService(db, A.m)
      expect((await value<{ hosts: string[] }>(db, `select public.ad_track_scope('{}')`)).hosts).toContain('r3-ads.test')
    }))

  // Expected: the admin's "Your domain" link (merchant_store_address.custom_domain) stays while
  // the store keeps opening on its proven primary; today it disappears with status <> ACTIVE.
  it('the admin\'s "Your domain" address stays while the live primary\'s last re-check said VERIFYING', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-addr.test')
      await save(db, A, 'r3-addr.test', { status: 'VERIFYING', verified: true })
      await as(db, A)
      expect((await value<{ custom_domain: string | null }>(db, `select public.merchant_store_address()`)).custom_domain).toBe('r3-addr.test')
    }))
})

// ---------------------------------------------------------------------------
// 4. The ten-unproven cap
// ---------------------------------------------------------------------------
describe('r3: the cap of 10 unproven domains', () => {
  // Expected: re-adding a domain this store proved and removed a minute ago adds no unproven
  // claim (it comes back proven), so the cap does not apply. Today: LIMIT_REACHED, and the store
  // stays offline on a domain the remove dialog promised "reconnects without proving it again".
  it('a store with 10 unproven claims can still re-add its own proven domain removed a minute ago', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-cap.test')
      await tenUnproven(db, A)
      await remove(db, A, 'r3-cap.test')
      await guard(db, A, 'r3-cap.test')
      expect(await serves(db, A, 'r3-cap.test')).toEqual({ store: A.m, cert: true })
    }))

  // Expected: the www twin of a live proven root is proven the moment it is added (the function
  // sees the proven twin), so it is not an unproven claim either.
  it('a store with 10 unproven claims can still add the www twin of its live proven root', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-capw.test')
      await tenUnproven(db, A)
      await guard(db, A, 'www.r3-capw.test')
      expect((await row(db, 'www.r3-capw.test'))?.merchant_id).toBe(A.m)
    }))

  it('control: the cap still refuses an 11th new unproven name', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await tenUnproven(db, A)
      await as(db, A)
      await expectError(db, `select public.store_domain_guard('r3-eleventh.test', 'add')`, [], /LIMIT_REACHED/)
    }))
})

// ---------------------------------------------------------------------------
// 5. Plan / feature switches, closing, reset
// ---------------------------------------------------------------------------
describe('r3: admin actions', () => {
  it('custom domains switched off (globally or for the store): connected domains keep opening, keep certificates and can be re-checked', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-off.test')
      for (const off of [
        `update public.features set globally_enabled = false where code = 'custom_domains'`,
        `update public.merchant_features set enabled = false where feature_code = 'custom_domains' and merchant_id = '${A.m}'`,
      ]) {
        await asSystem(db, null)
        await db.query(off)
        expect(await serves(db, A, 'r3-off.test')).toEqual({ store: A.m, cert: true })
        expect(await serves(db, A, 'www.r3-off.test')).toEqual({ store: A.m, cert: true })
        await guard(db, A, 'r3-off.test', 'check')
        expect(await save(db, A, 'r3-off.test', { status: 'ACTIVE', verified: true })).toMatchObject({ status: 'ACTIVE' })
        await platform(db)
        await db.query(`update public.merchant_features set enabled = true where feature_code = 'custom_domains' and merchant_id = $1`, [A.m])
      }
    }))

  // A store without custom domains keeps the domains it has, but cannot add one again: the
  // panel has no Add form then, and the remove dialog says so before the store removes it.
  it('custom domains turned off for the store: a removed domain cannot be added back (the dialog warns first)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-gone.test')
      await asSystem(db, null)
      await db.query(`update public.merchant_features set enabled = false where feature_code = 'custom_domains' and merchant_id = $1`, [A.m])
      // Re-adding a name the store still has is a no-op, not a refusal.
      await guard(db, A, 'r3-gone.test')
      await remove(db, A, 'r3-gone.test')
      await as(db, A)
      await expectError(db, `select public.store_domain_guard('r3-gone.test', 'add')`, [], /FEATURE|custom_domains|not (in|available)/i)
    }))

  it('closing the store takes its domains offline; reopening brings them back proven, with certificates', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-reopen.test')
      await asSystem(db, null)
      await db.query(`update public.merchants set status = 'CLOSED' where id = $1`, [A.m])
      expect(await serves(db, A, 'r3-reopen.test')).toEqual({ store: null, cert: false })
      await asSystem(db, null)
      await db.query(`update public.merchants set status = 'ACTIVE' where id = $1`, [A.m])
      expect(await serves(db, A, 'r3-reopen.test')).toEqual({ store: A.m, cert: true })
      expect(await serves(db, A, 'www.r3-reopen.test')).toEqual({ store: A.m, cert: true })
    }))

  it('a suspended store keeps its domain and certificates (the page itself says suspended)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await live(db, A, 'r3-susp.test')
      await asSystem(db, null)
      await db.query(`update public.merchants set status = 'SUSPENDED' where id = $1`, [A.m])
      expect(await known(db, 'r3-susp.test')).toBe(true)
      expect(await resolve(db, 'r3-susp.test')).toMatchObject({ kind: 'store', merchant_id: A.m, status: 'SUSPENDED' })
    }))

  // Expected: after a full store reset the store's old domain shows "store not available" like a
  // removed domain (20261121000400). The reset deletes the rows instead, so a visitor whose browser
  // reaches the domain (Caddy keeps the certificate it has; Cloudflare keeps the custom hostname,
  // which nothing detaches) sees the platform's default store (main_site = store) or the
  // platform's own website (main_site = marketing).
  it('after a full store reset its old domain shows "missing", never the default store or the platform site', () =>
    inTx(async (db) => {
      for (const main of ['store', 'marketing'] as const) {
        await platform(db, main)
        const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
        const name = `Reset Three ${randomUUID().slice(0, 6)}`
        const A = await store(db, name)
        const d = `r3-reset-${main}.test`
        await live(db, A, d)
        await asUser(db, superId, 'staff@platform.example', null)
        await db.query(`select public.platform_merchant_export($1, 'Copy before resetting the store')`, [A.m])
        await db.query(`select public.platform_store_reset($1, 'EVERYTHING', $2, 'Fresh start before going live')`, [A.m, name])
        expect(await resolve(db, d), main).toEqual({ kind: 'missing' })
        expect(await resolve(db, `www.${d}`), main).toEqual({ kind: 'missing' })
      }
    }))

  // Expected: a re-check that was already running when the store was reset (or the row otherwise
  // deleted) cannot bring the domain back. store_domain_save still has an INSERT branch, so the
  // late "ACTIVE, verified" save re-creates the row as a proven, live domain of the reset store.
  it('a re-check that lands after a full store reset does not bring the domain back to life', () =>
    inTx(async (db) => {
      await platform(db)
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const name = `Reset Late ${randomUUID().slice(0, 6)}`
      const A = await store(db, name)
      await live(db, A, 'r3-late.test')
      await asUser(db, superId, 'staff@platform.example', null)
      await db.query(`select public.platform_merchant_export($1, 'Copy before resetting the store')`, [A.m])
      await db.query(`select public.platform_store_reset($1, 'EVERYTHING', $2, 'Fresh start before going live')`, [A.m, name])
      // The in-flight run: markVerified, then the result.
      expect(await save(db, A, 'r3-late.test', { verified: true })).toBeNull()
      expect(await save(db, A, 'r3-late.test', { status: 'ACTIVE', verified: true })).toBeNull()
      // The reset left it removed, unproven: the late check changes nothing.
      expect(await row(db, 'r3-late.test')).toMatchObject({ status: 'REMOVED' })
      expect(await known(db, 'r3-late.test')).toBe(false)
      expect(await resolve(db, 'r3-late.test')).toEqual({ kind: 'missing' })
    }))
})

// ---------------------------------------------------------------------------
// 6. Two stores and a live domain
// ---------------------------------------------------------------------------
describe('r3: another store and a live domain', () => {
  it('a live proven domain (30 days old) is never released: B cannot take the root, www or www.www, and A keeps serving', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await live(db, A, 'r3-mine.test')
      await asSystem(db, null)
      await db.query(`update public.store_domains set created_at = now() - interval '30 days', checked_at = now() - interval '3 days' where domain = 'r3-mine.test'`)
      for (const d of ['r3-mine.test', 'www.r3-mine.test', 'R3-MINE.TEST', 'r3-mine.test.']) {
        await as(db, B)
        await expectError(db, `select public.store_domain_guard($1, 'add')`, [d], /.+/)
      }
      await guard(db, B, 'www.www.r3-mine.test')
      expect(await row(db, 'r3-mine.test')).toMatchObject({ merchant_id: A.m, status: 'ACTIVE' })
      expect(await serves(db, A, 'r3-mine.test')).toEqual({ store: A.m, cert: true })
      expect(await serves(db, A, 'www.r3-mine.test')).toEqual({ store: A.m, cert: true })
      // B's unproven www.www claim opens nothing and gets no certificate of its own.
      expect(storeOf(await resolve(db, 'www.www.r3-mine.test'))).not.toBe(B.m)
    }))

  it('a live root VERIFYING after a bad re-check (proven) is still never released to another store', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await live(db, A, 'r3-hold.test')
      await save(db, A, 'r3-hold.test', { status: 'VERIFYING', verified: true })
      await asSystem(db, null)
      await db.query(`update public.store_domains set created_at = now() - interval '30 days' where domain = 'r3-hold.test'`)
      await as(db, B)
      await expectError(db, `select public.store_domain_guard('r3-hold.test', 'add')`, [], /DUPLICATE/)
      await expectError(db, `select public.store_domain_guard('www.r3-hold.test', 'add')`, [], /DUPLICATE/)
      expect(await serves(db, A, 'r3-hold.test')).toEqual({ store: A.m, cert: true })
    }))
})

// ---------------------------------------------------------------------------
// 7. Certificates (Caddy "ask") for every name a live store serves
// ---------------------------------------------------------------------------
describe('r3: the proxy\'s certificate check covers every name a live store opens on', () => {
  it('root, www twin and primary, in every status a re-check can leave behind; never for another store\'s name', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await live(db, A, 'r3-ask.test')
      await live(db, A, 'www.r3-askw.test')
      await as(db, A)
      await db.query(`select public.store_domain_set_primary('www.r3-askw.test')`)
      for (const status of ['ACTIVE', 'VERIFYING', 'ERROR', 'MANUAL', 'PENDING']) {
        await save(db, A, 'r3-ask.test', { status })
        await save(db, A, 'www.r3-askw.test', { status })
        for (const d of ['r3-ask.test', 'www.r3-ask.test', 'www.r3-askw.test', 'r3-askw.test']) {
          expect(await known(db, d), `${status} ${d}`).toBe(true)
          expect(storeOf(await resolve(db, d)), `${status} ${d}`).toBe(A.m)
        }
      }
      expect(await known(db, 'www.www.r3-ask.test')).toBe(false)
      expect(storeOf(await resolve(db, 'r3-ask.test'))).not.toBe(B.m)
    }))
})
