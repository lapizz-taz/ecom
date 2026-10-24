import { randomUUID } from 'node:crypto'
import { asSystem, value, type Db } from './db'

// Calls every function the API exposes, with a store's own ids picked from the argument names
// (used by supabase/tests/db/cross-store-sweep.test.ts and role-write-sweep.test.ts).

/** The customer phone a sweep plants in its store (and passes to phone and search arguments). */
export const PHONE_A = '01711999001'

export interface Fn {
  name: string
  argnames: string[]
  argtypes: string[]
  ndefaults: number
}

export type Ids = Record<string, string>

export interface Target { order: string; product: string; variant: string; customer: string; owner: string; merchant: string }

export interface Call { fn: string; pick: string; filled: boolean; inputs: string[]; out: string | null; failed: boolean }

export async function createMerchant(db: Db): Promise<string> {
  await asSystem(db, null)
  const id = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
  await asSystem(db, id)
  await db.query(`select public._merchant_seed_defaults($1)`, [id])
  return id
}

/** Functions in the exposed schema that `role` may call (no triggers, no polymorphic or variadic arguments). */
export async function callable(db: Db, role: string): Promise<Fn[]> {
  const res = await db.query<{ name: string; argnames: string[] | null; argmodes: string[] | null; argtypes: string[] | null; ndefaults: number }>(
    `select p.proname as name, p.proargnames as argnames, p.proargmodes::text[] as argmodes, p.pronargdefaults as ndefaults,
            (select array_agg(format_type(t, null) order by i) from unnest(p.proargtypes) with ordinality u(t, i)) as argtypes
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.provariadic = 0
        and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        and not exists (select 1 from unnest(p.proargtypes) t where t in ('anyelement'::regtype, 'anyarray'::regtype, 'anynonarray'::regtype, 'anycompatible'::regtype, 'internal'::regtype))
        and has_function_privilege($1, p.oid, 'execute')
      order by p.proname, p.oid`,
    [role],
  )
  return res.rows.map((r) => {
    const types = r.argtypes ?? []
    // proargnames covers every argument (in and out); keep the input ones, in order.
    const names = (r.argnames ?? []).filter((_, i) => !r.argmodes || ['i', 'b'].includes(r.argmodes[i]))
    return { name: r.name, argtypes: types, argnames: types.map((_, i) => names[i] ?? ''), ndefaults: r.ndefaults }
  })
}

/** One id of the store for every table that has a merchant and a uuid id. */
export async function storeIds(db: Db, merchant: string): Promise<Ids> {
  const tables = await db.query<{ t: string }>(
    `select c.table_name as t from information_schema.columns c
       join information_schema.columns m on m.table_schema = c.table_schema and m.table_name = c.table_name and m.column_name = 'merchant_id'
       join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'id' and c.data_type = 'uuid'`,
  )
  const ids: Ids = {}
  for (const { t } of tables.rows) {
    const r = await db.query<{ id: string }>(`select id from public.${t} where merchant_id = $1 limit 1`, [merchant])
    if (r.rows[0]) ids[t] = r.rows[0].id
  }
  return ids
}

/** The store's id for an argument named like `p_<thing>_id`, or null to try the common ones. */
export function idFor(arg: string, ids: Ids, a: Target): string | null {
  const base = arg.replace(/^_?p_/, '').replace(/_?ids?$/, '')
  if (/merchant|store|shop|business/.test(base)) return a.merchant
  if (/user|staff|member|employee|owner|agent|assignee/.test(base)) return a.owner
  if (/order_item|item/.test(base)) return ids.order_items ?? a.order
  if (/variant/.test(base)) return a.variant
  if (/product/.test(base)) return a.product
  if (/customer|contact/.test(base)) return a.customer
  if (/order/.test(base)) return a.order
  for (const t of [base, `${base}s`, `${base}es`, base.replace(/y$/, 'ies'), `order_${base}s`, `${base.replace(/^order_/, '')}s`]) {
    if (ids[t]) return ids[t]
  }
  return null
}

/**
 * Calls every function in `fns` as the current role, with the target store's ids, ids only and then
 * filled. `check` runs after each call inside a savepoint that is rolled back afterwards (so it may
 * change role and read), and is told whether the call failed (then it must not query). `before`
 * runs just before each call, as the caller (it may read, not change role).
 */
export async function callEach(db: Db, fns: Fn[], ids: Ids, a: Target, check: (c: Call) => Promise<void>, before?: () => Promise<void>): Promise<{ calls: number; answered: number }> {
  const enums = new Map((await db.query<{ type: string; first: string }>(
    `select format_type(t.oid, null) as type, (select enumlabel from pg_enum e where e.enumtypid = t.oid order by enumsortorder limit 1) as first
       from pg_type t where t.typtype = 'e'`,
  )).rows.map((r) => [r.type, r.first]))
  const now = new Date().toISOString()
  const text = (arg: string) => (/phone|mobile|search|query|^_?p_q$|term|keyword/.test(arg) ? PHONE_A : null)
  const fill = (type: string, arg: string): unknown => {
    if (/^(integer|smallint|bigint|numeric|double precision|real)$/.test(type)) return 1
    if (type === 'boolean') return true
    if (type === 'date') return now.slice(0, 10)
    if (type.startsWith('timestamp')) return now
    if (type === 'interval') return '1 day'
    if (type === 'inet') return '127.0.0.1'
    if (type === 'text' || type === 'character varying' || type === 'citext') return text(arg) ?? 'audit'
    if (type === 'text[]') return ['audit']
    if (type === 'integer[]') return [1]
    if (enums.has(type)) return enums.get(type)
    if (type.endsWith('[]') && enums.has(type.slice(0, -2))) return [enums.get(type.slice(0, -2))]
    return null
  }
  const json = (id: string) => JSON.stringify({
    id, ids: [id], order_id: a.order, order_ids: [a.order], product_id: a.product, product_ids: [a.product],
    variant_id: a.variant, customer_id: a.customer, merchant_id: a.merchant, user_id: a.owner,
    items: [{ variant_id: a.variant, product_id: a.product, quantity: 1 }],
    phone: PHONE_A, search: PHONE_A, q: PHONE_A, query: PHONE_A,
  })
  const tryIds = [a.order, a.product, a.variant, a.customer]

  let calls = 0
  let answered = 0
  await db.query('savepoint sweep')
  for (const fn of fns) {
    const unknownUuid = fn.argtypes.some((t, i) => (t === 'uuid' || t === 'uuid[]') && !idFor(fn.argnames[i], ids, a))
    const tries = unknownUuid || fn.argtypes.includes('jsonb') || fn.argtypes.includes('json') ? tryIds : [a.order]
    const named = fn.argnames.every(Boolean)
    const firstDefault = fn.argtypes.length - fn.ndefaults
    for (const [filled, pick] of [false, true].flatMap((f) => tries.map((t) => [f, t] as const))) {
      const params: unknown[] = []
      const args: string[] = []
      const inputs: string[] = []
      fn.argtypes.forEach((type, i) => {
        const arg = fn.argnames[i]
        let v: unknown = null
        if (type === 'uuid' || type === 'uuid[]') {
          const id = idFor(arg, ids, a) ?? pick
          inputs.push(id)
          v = type === 'uuid' ? id : [id]
        } else if (type === 'jsonb' || type === 'json') {
          v = json(pick)
          inputs.push(pick, PHONE_A, a.order, a.product, a.variant, a.customer, a.owner)
        } else if (type === 'text' || type === 'character varying' || type === 'citext') {
          v = text(arg)
        }
        if (v === null && filled) v = fill(type, arg)
        if (v === PHONE_A) inputs.push(PHONE_A)
        if (v === null && named && i >= firstDefault) return
        const ref = v === null ? `null::${type}` : (params.push(v), `$${params.length}::${type}`)
        args.push(named ? `"${arg}" => ${ref}` : ref)
      })
      const sql = `select string_agg(r::text, E'\\n') as out from (select public."${fn.name}"(${args.join(', ')}) as r) s`
      await before?.()
      calls += 1
      let out: string | null = null
      let failed = false
      try {
        out = (await db.query<{ out: string | null }>(sql, params)).rows[0]?.out ?? null
        answered += 1
      } catch (e) {
        failed = true
        out = e instanceof Error ? e.message : String(e)
      }
      await check({ fn: fn.name, pick, filled, inputs, out, failed })
      await db.query('rollback to savepoint sweep')
    }
  }
  await db.query('release savepoint sweep')
  return { calls, answered }
}

export const label = (c: Call) => `${c.fn}(${c.pick}${c.filled ? ', filled' : ''})`
