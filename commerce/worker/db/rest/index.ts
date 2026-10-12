// /rest/v1: the PostgREST API supabase-js speaks, served from SQLite. Tables, views
// and /rpc/<function> behave as they did on Supabase, including row security,
// single-object responses, counts and Postgres-style errors.
import type { Context } from '../context.ts'
import { DbError } from '../errors.ts'
import { quoteId } from '../ident.ts'
import { table, view } from '../meta.ts'
import { callRpc } from '../rpc/index.ts'
import type { Sql } from '../sql.ts'
import { insert, remove, update, type Values, type WriteEnv } from '../writer.ts'
import { parseQuery, type ParsedQuery, type SelectItem } from './parse.ts'
import { read, readByKeys } from './select.ts'
import { filterSql, type Source } from './where.ts'

export interface RestRequest {
  method: string
  /** After /rest/v1/: "orders" or "rpc/place_order". */
  path: string
  /** The query string without '?'. */
  search: string
  headers: Record<string, string | undefined>
  /** The raw JSON body. */
  body?: string | null
}

export interface RestResponse {
  status: number
  headers: Record<string, string>
  body: string | null
}

interface Prefer {
  representation: boolean
  count: boolean
  resolution?: 'merge' | 'ignore'
  missingDefault: boolean
}

function prefer(header: string | undefined): Prefer {
  const parts = (header ?? '').split(/[,;]/).map((s) => s.trim())
  return {
    representation: parts.includes('return=representation'),
    count: parts.some((p) => /^count=(exact|planned|estimated)$/.test(p)),
    resolution: parts.includes('resolution=merge-duplicates') ? 'merge' : parts.includes('resolution=ignore-duplicates') ? 'ignore' : undefined,
    missingDefault: parts.includes('missing=default'),
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): RestResponse => ({
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  body: body === undefined ? null : JSON.stringify(body),
})

export function errorResponse(e: unknown): RestResponse {
  if (e instanceof DbError) return json(e.status, e.toJSON())
  console.error('database request failed', e)
  return json(500, { code: 'XX000', message: 'Database error', details: null, hint: null })
}

function wantsObject(headers: RestRequest['headers']): boolean {
  return /application\/vnd\.pgrst\.object\+json/.test(headers.accept ?? '')
}

function single(rows: unknown[], status: number, extra: Record<string, string> = {}): RestResponse {
  if (rows.length !== 1) {
    throw new DbError('PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${rows.length} rows`)
  }
  return json(status, rows[0], extra)
}

function parseBody(body: string | null | undefined): unknown {
  if (body === null || body === undefined || body === '') return {}
  try {
    return JSON.parse(body)
  } catch {
    throw new DbError('PGRST102', 'Empty or invalid json')
  }
}

/** Projects deleted rows onto the select list (embedded resources are not available after a delete). */
function project(rows: Values[], select: SelectItem[]): Values[] {
  if (select.some((s) => s.kind === 'star')) return rows
  return rows.map((r) => Object.fromEntries(select.filter((s) => s.kind === 'column').map((s) => {
    const c = s as Extract<SelectItem, { kind: 'column' }>
    return [c.alias ?? c.name, r[c.name]]
  })))
}

function rootWhere(name: string, q: ParsedQuery): { sql: string; params: Array<string | number | null | ArrayBuffer | Uint8Array> } {
  const t = table(name)!
  const src: Source = { name, alias: quoteId(name), columns: t.columns }
  const params: Array<string | number | null | ArrayBuffer | Uint8Array> = []
  const level = q.levels.get('')!
  for (const key of q.levels.keys()) {
    if (key !== '' && (q.levels.get(key)!.filters.length)) throw new DbError('PGRST100', 'Filters on embedded resources are not allowed when changing rows')
  }
  return { sql: filterSql(src, level.filters, params), params }
}

export function handleRest(sql: Sql, ctx: Context, req: RestRequest): RestResponse {
  try {
    const method = req.method.toUpperCase()
    if (req.path.startsWith('rpc/')) {
      const fn = req.path.slice(4)
      const args = method === 'GET' || method === 'HEAD'
        ? Object.fromEntries(new URLSearchParams(req.search))
        : parseBody(req.body) as Values
      const result = callRpc(sql, ctx, fn, args)
      if (wantsObject(req.headers) && Array.isArray(result)) return single(result, 200)
      return json(200, result === undefined ? null : result)
    }
    const name = decodeURIComponent(req.path)
    if (!table(name) && !view(name)) throw new DbError('42P01', `relation "public.${name}" does not exist`)
    const q = parseQuery(new URLSearchParams(req.search))
    const p = prefer(req.headers.prefer)
    const asObject = wantsObject(req.headers)

    if (method === 'GET' || method === 'HEAD') {
      const level = q.levels.get('')!
      const { rows, total } = read({ sql, ctx }, name, q, { count: p.count, rows: method === 'GET' })
      const from = level.offset ?? 0
      const range = rows.length ? `${from}-${from + rows.length - 1}` : '*'
      const headers = { 'Content-Range': `${range}/${total ?? '*'}` }
      if (method === 'HEAD') return { status: 200, headers, body: null }
      if (asObject) return single(rows, 200, headers)
      return json(200, rows, headers)
    }

    if (!table(name)) throw new DbError('PGRST205', `Cannot change rows of the view ${name}`)
    const env: WriteEnv = { sql, ctx, role: ctx.role }

    if (method === 'POST') {
      const body = parseBody(req.body)
      const rows = (Array.isArray(body) ? body : [body]) as Values[]
      if (rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new DbError('PGRST102', 'All object keys must match')
      const out = sql.transaction(() => {
        const keys = insert(env, name, rows, { columns: q.columns, missingDefault: p.missingDefault, onConflict: q.onConflict, resolution: p.resolution })
        return p.representation ? readByKeys({ sql, ctx }, name, q, keys) : null
      })
      if (!out) return { status: 201, headers: {}, body: null }
      if (asObject) return single(out, 201)
      return json(201, out)
    }

    if (method === 'PATCH') {
      const w = rootWhere(name, q)
      if (w.sql === '1') throw new DbError('21000', 'UPDATE requires a WHERE clause')
      const set = parseBody(req.body)
      if (!set || typeof set !== 'object' || Array.isArray(set)) throw new DbError('PGRST102', 'Empty or invalid json')
      const out = sql.transaction(() => {
        const keys = update(env, name, set as Values, w)
        return p.representation ? readByKeys({ sql, ctx }, name, q, keys) : keys
      })
      if (!p.representation) return { status: 204, headers: {}, body: null }
      if (asObject) return single(out, 200)
      return json(200, out)
    }

    if (method === 'DELETE') {
      const w = rootWhere(name, q)
      if (w.sql === '1') throw new DbError('21000', 'DELETE requires a WHERE clause')
      const removed = sql.transaction(() => remove(env, name, w))
      if (!p.representation) return { status: 204, headers: {}, body: null }
      const out = project(removed, q.select)
      if (asObject) return single(out, 200)
      return json(200, out)
    }

    throw new DbError('PGRST117', `Unsupported HTTP method: ${method}`)
  } catch (e) {
    return errorResponse(e)
  }
}
