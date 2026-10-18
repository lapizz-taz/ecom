// Who may call what. No function in the public schema is callable by everyone by default,
// the list of what store visitors may call is explicit, and the plan/usage helpers answer
// only the server side.
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, MERCHANT_1, value } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

/** Everything an anonymous store visitor may call: the storefront, sign-up and session helpers. */
const VISITOR_FUNCTIONS = [
  '_profiles_deleted_stay_off', '_store_reset_active', '_store_reset_tables', '_support_read_only', '_support_session_id',
  'current_merchant_id', 'current_role_code', 'has_permission', 'is_staff',
  'platform_contact_submit', 'public_lead_touch', 'public_signup_options', 'public_signup_request', 'store_slug_check', 'store_slug_suggest',
  'storefront_ad_tracking', 'storefront_cart_restore', 'storefront_cart_sync', 'storefront_categories', 'storefront_config', 'storefront_get_product',
  'storefront_list_products', 'storefront_mode', 'storefront_quote', 'storefront_resolve', 'storefront_resolve_slug',
  'submit_contact_message', 'track_order', 'track_storefront_event', 'track_visit_event',
].sort()

/** Internal helpers that take a merchant id: reached through SECURITY DEFINER functions and the service role only. */
const SERVER_ONLY = ['merchant_usage', 'merchant_limits', 'merchant_entitlements']

/** The Cloudflare engine has no pg_proc ACLs; it enforces the grants copied into its generated catalog
 *  (worker/db/rpc/index.ts, worker/db/pg/engine.ts), which the behavioural test below exercises. */
const onEngine = Boolean(process.env.CF_DB_TESTS)

describe('function grants', () => {
  it.skipIf(onEngine)('no function is callable by everyone, and a new one is not either', () =>
    inTx(async (db) => {
      await asSystem(db)
      expect(await value<string[]>(db, `select coalesce(array_agg(proname::text order by proname), '{}')::text[] from pg_proc
        where pronamespace = 'public'::regnamespace and proacl::text ~ '(\\{|,)=X/'`)).toEqual([])
      await db.query(`create function public.zz_grant_probe() returns int language sql as 'select 1'`)
      expect(await value<boolean>(db, `select has_function_privilege('anon', 'public.zz_grant_probe()', 'execute')`)).toBe(false)
      expect(await value<boolean>(db, `select has_function_privilege('authenticated', 'public.zz_grant_probe()', 'execute')`)).toBe(false)
      expect(await value<boolean>(db, `select has_function_privilege('service_role', 'public.zz_grant_probe()', 'execute')`)).toBe(true)
    }))

  it.skipIf(onEngine)('store visitors may call exactly the storefront and session helpers', () =>
    inTx(async (db) => {
      await asSystem(db)
      const anon = await value<string[]>(db, `select array_agg(proname::text order by proname)::text[] from pg_proc
        where pronamespace = 'public'::regnamespace and has_function_privilege('anon', oid, 'execute')`)
      expect(anon).toEqual(VISITOR_FUNCTIONS)
    }))

  it('plan, usage and limits are not readable by visitors or staff directly; the plan page and the service still work', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asAnon(db)
      for (const fn of SERVER_ONLY) {
        await expectError(db, `select public.${fn}()`, [], /permission denied/)
        await expectError(db, `select public.${fn}($1)`, [MERCHANT_1], /permission denied/)
      }
      await expectError(db, `select public.feature_enabled('sms')`, [], /permission denied/)
      await asUser(db, owner)
      for (const fn of SERVER_ONLY) {
        await expectError(db, `select public.${fn}()`, [], /permission denied/)
        await expectError(db, `select public.${fn}($1)`, [MERCHANT_1], /permission denied/)
      }
      await expectError(db, `select public.feature_enabled('sms')`, [], /permission denied/)
      await expectError(db, `select public.feature_enabled('sms', $1)`, [MERCHANT_1], /permission denied/)
      const plan = await value<{ limits: Record<string, number>; usage: Record<string, number>; features: Record<string, unknown> }>(db, `select public.my_plan()`)
      expect(plan.limits).toBeTruthy()
      expect(plan.usage).toBeTruthy()
      expect(plan.features).toBeTruthy()
      await asService(db)
      expect(await value(db, `select public.merchant_usage($1) ->> 'staff'`, [MERCHANT_1])).toBeTruthy()
      expect(typeof (await value(db, `select public.feature_enabled('sms', $1)`, [MERCHANT_1]))).toBe('boolean')
    }))
})
