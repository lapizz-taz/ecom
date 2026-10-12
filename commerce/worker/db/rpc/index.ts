// /rpc/<name>: the database functions the app calls, run as written in the migrations
// by the PL/pgSQL interpreter (pg/engine.ts). Each call is one transaction (all or
// nothing, like a Postgres function) and runs as its Postgres owner did: definer
// functions owned by postgres see every row, those owned by app_owner keep store
// isolation, invoker functions run with the caller's rights.
import { toTimestamp } from '../codec.ts'
import type { Context } from '../context.ts'
import { DbError } from '../errors.ts'
import { fn as fnMeta } from '../meta.ts'
import type { Sql } from '../sql.ts'
import { asDbError, PgEngine } from '../pg/engine.ts'
import type { Typed } from '../pg/runtime.ts'
import { normType } from '../pg/types.ts'
import { JNULL, plainValue } from '../pg/values.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function coerce(name: string, type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const bad = (): never => {
    throw new DbError('22P02', `invalid input syntax for type ${type}: "${String(value).slice(0, 80)}"`, `argument ${name}`)
  }
  if (type.endsWith('[]')) {
    const base = type.slice(0, -2)
    const list = Array.isArray(value) ? value : typeof value === 'string' && value.startsWith('{') ? value.slice(1, -1).split(',').filter(Boolean) : bad()
    return (list as unknown[]).map((v) => coerce(name, base, v))
  }
  switch (type) {
    case 'uuid':
      if (typeof value !== 'string' || !UUID.test(value)) bad()
      return (value as string).toLowerCase()
    case 'integer': case 'bigint': case 'smallint': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN
      if (!Number.isInteger(n)) bad()
      return n
    }
    case 'numeric': case 'double precision': case 'real': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
      if (!Number.isFinite(n)) bad()
      return n
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 'true' || value === 't') return true
      if (value === 'false' || value === 'f') return false
      return bad()
    case 'timestamp with time zone': case 'timestamp without time zone':
      return toTimestamp(value)
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : toTimestamp(value).slice(0, 10)
    case 'jsonb': case 'json':
      return value
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}

export function callRpc(sql: Sql, ctx: Context, name: string, input: Record<string, unknown>): unknown {
  const meta = fnMeta(name)
  const signature = Object.keys(input).join(', ')
  if (!meta) throw new DbError('PGRST202', `Could not find the function public.${name}(${signature}) in the schema cache`)
  if (ctx.role !== 'service_role' && !meta.grants.includes(ctx.role as 'anon' | 'authenticated')) {
    throw new DbError('42501', `permission denied for function ${name}`)
  }
  const known = new Set(meta.args.map((a) => a.name))
  for (const k of Object.keys(input)) {
    if (!known.has(k)) throw new DbError('PGRST202', `Could not find the function public.${name}(${signature}) in the schema cache`)
  }
  const args: Typed[] = []
  const names: string[] = []
  for (const a of meta.args) {
    if (!Object.hasOwn(input, a.name)) {
      if (!a.optional) throw new DbError('PGRST202', `Could not find the function public.${name}(${signature}) in the schema cache`)
      continue
    }
    // PostgREST hands the database JSON; the function's parameter types read it.
    const v = coerce(a.name, a.type, input[a.name])
    args.push({ t: a.type === 'jsonb' || a.type === 'json' ? 'jsonb' : v === null ? 'unknown' : argType(a.type), v: a.type === 'jsonb' || a.type === 'json' ? jsonArg(v) : v })
    names.push(a.name)
  }
  // The function as written in the migrations, run by the PL/pgSQL interpreter (pg/engine.ts).
  const engine = new PgEngine(sql, ctx, ctx.role)
  try {
    const result = sql.transaction(() => engine.call(name, args, names))
    return plainValue(result.v)
  } catch (e) {
    throw asDbError(e)
  }
}

/** A PostgREST argument type as the engine names it. */
function argType(type: string): string {
  const arr = type.endsWith('[]')
  const base = normType(arr ? type.slice(0, -2) : type)
  return arr ? `${base}[]` : base
}

/** JSON from the request body: a top-level null is JSON null when it was sent as a value. */
function jsonArg(v: unknown): unknown {
  return v === null ? JNULL : v
}
