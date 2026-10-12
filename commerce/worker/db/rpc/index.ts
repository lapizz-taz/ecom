// /rpc/<name>: the database functions the app calls, ported to TypeScript. Each runs
// in one transaction (all or nothing, like a Postgres function), as its Postgres
// owner did: definer functions owned by postgres see every row, those owned by
// app_owner keep store isolation, invoker functions run with the caller's rights.
import { toTimestamp } from '../codec.ts'
import type { Context } from '../context.ts'
import { DbError } from '../errors.ts'
import { fn as fnMeta, type FunctionMeta } from '../meta.ts'
import type { DbRole } from '../policy.ts'
import type { Sql } from '../sql.ts'
import type { WriteEnv } from '../writer.ts'
import { functions as registry } from './registry.ts'

export interface RpcCall {
  sql: Sql
  ctx: Context
  /** Writes as the function's owner (see roleFor). */
  env: WriteEnv
  /** Arguments by name, converted to their declared types; missing optional ones are undefined. */
  args: Record<string, unknown>
}

export type RpcImpl = (call: RpcCall) => unknown

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function roleFor(meta: FunctionMeta, ctx: Context): DbRole {
  if (!meta.definer) return ctx.role
  return meta.owner === 'app_owner' ? 'app_owner' : 'service_role'
}

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
  const args: Record<string, unknown> = {}
  const known = new Set(meta.args.map((a) => a.name))
  for (const k of Object.keys(input)) {
    if (!known.has(k)) throw new DbError('PGRST202', `Could not find the function public.${name}(${signature}) in the schema cache`)
  }
  for (const a of meta.args) {
    if (!Object.hasOwn(input, a.name)) {
      if (!a.optional) throw new DbError('PGRST202', `Could not find the function public.${name}(${signature}) in the schema cache`)
      args[a.name] = undefined
    } else args[a.name] = coerce(a.name, a.type, input[a.name])
  }
  const impl = registry[name]
  if (!impl) throw new DbError('0A000', `NOT_PORTED: ${name} is not available on the Cloudflare database yet`)
  const env: WriteEnv = { sql, ctx, role: roleFor(meta, ctx) }
  return sql.transaction(() => impl({ sql, ctx, env, args }))
}
