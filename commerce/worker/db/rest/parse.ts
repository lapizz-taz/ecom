// Parses PostgREST query strings (as supabase-js writes them): select lists with
// embedded resources, filters with and/or/not, order, limit and offset.
import { DbError } from '../errors.ts'

export interface JsonStep { op: '->' | '->>'; key: string }

export type SelectItem =
  | { kind: 'star' }
  | { kind: 'column'; name: string; alias?: string; json: JsonStep[]; cast?: string }
  | { kind: 'embed'; relation: string; alias?: string; hint?: string; inner: boolean; spread: boolean; select: SelectItem[] }

export const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'match', 'imatch', 'in', 'is', 'isdistinct', 'cs', 'cd', 'ov',
  'fts', 'plfts', 'phfts', 'wfts', 'sl', 'sr', 'nxr', 'nxl', 'adj'] as const
export type Operator = (typeof OPERATORS)[number]

export type Filter =
  | { kind: 'cond'; column: string; json: JsonStep[]; negate: boolean; op: Operator; quantifier?: 'any' | 'all'; value: string }
  | { kind: 'logic'; op: 'and' | 'or'; negate: boolean; items: Filter[] }

export interface OrderTerm { column: string; json: JsonStep[]; desc: boolean; nulls?: 'first' | 'last' }

/** Filters, order and paging for one level of the result (the root or an embedded resource). */
export interface Level {
  filters: Filter[]
  order: OrderTerm[]
  limit?: number
  offset?: number
}

export interface ParsedQuery {
  select: SelectItem[]
  /** Keyed by embed path: '' for the root, 'orders', 'orders.order_items', … */
  levels: Map<string, Level>
  columns?: string[]
  onConflict?: string[]
}

const bad = (message: string, details?: string): never => {
  throw new DbError('PGRST100', message, details ?? null)
}

/** Splits on commas outside brackets and double quotes. */
export function splitTop(text: string, sep = ','): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      cur += c
      if (c === '\\') cur += text[++i] ?? ''
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === '(') depth++
    else if (c === ')') depth--
    if (c === sep && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  if (depth !== 0 || quoted) bad('"failed to parse" unbalanced brackets or quotes', text)
  out.push(cur)
  return out
}

const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s)

/** name->a->>b → { name, json } */
export function parseField(text: string): { name: string; json: JsonStep[] } {
  const parts = text.split(/(->>|->)/)
  const name = unquote(parts[0].trim())
  const json: JsonStep[] = []
  for (let i = 1; i < parts.length; i += 2) json.push({ op: parts[i] as '->' | '->>', key: unquote(parts[i + 1].trim()) })
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) bad(`"failed to parse select parameter (${text})"`)
  return { name, json }
}

export function parseSelect(text: string | null): SelectItem[] {
  if (text === null || text.trim() === '') return [{ kind: 'star' }]
  return splitTop(text).map((raw) => raw.trim()).filter(Boolean).map((item): SelectItem => {
    if (item === '*') return { kind: 'star' }
    const spread = item.startsWith('...')
    const body = spread ? item.slice(3) : item
    const open = body.indexOf('(')
    if (open > 0 && body.endsWith(')')) {
      let head = body.slice(0, open)
      let alias: string | undefined
      const colon = /^([A-Za-z_][A-Za-z0-9_]*):(?!:)/.exec(head)
      if (colon) {
        alias = colon[1]
        head = head.slice(colon[0].length)
      }
      const [relation, ...hints] = head.split('!')
      let inner = false
      let hint: string | undefined
      for (const h of hints) {
        if (h === 'inner') inner = true
        else if (h === 'left') inner = false
        else hint = h
      }
      return { kind: 'embed', relation: relation.trim(), alias, hint, inner, spread, select: parseSelect(body.slice(open + 1, -1)) }
    }
    if (spread) bad('"failed to parse select parameter"', item)
    let rest = item
    let alias: string | undefined
    const colon = /^([A-Za-z_][A-Za-z0-9_]*):(?!:)/.exec(rest)
    if (colon) {
      alias = colon[1]
      rest = rest.slice(colon[0].length)
    }
    let cast: string | undefined
    const castAt = rest.indexOf('::')
    if (castAt >= 0) {
      cast = rest.slice(castAt + 2).trim()
      rest = rest.slice(0, castAt)
    }
    const { name, json } = parseField(rest)
    return { kind: 'column', name, alias, json, cast }
  })
}

/** "[not.]op[(any|all)].value" */
function parseOperation(text: string): { negate: boolean; op: Operator; quantifier?: 'any' | 'all'; value: string } {
  let rest = text
  let negate = false
  if (rest.startsWith('not.')) {
    negate = true
    rest = rest.slice(4)
  }
  const m = /^([a-z]+)(?:\((any|all)\))?\.([\s\S]*)$/.exec(rest)
  if (!m || !(OPERATORS as readonly string[]).includes(m[1])) bad(`"failed to parse filter (${text})"`)
  return { negate, op: m![1] as Operator, quantifier: m![2] as 'any' | 'all' | undefined, value: m![3] }
}

/** One item of an and()/or() list: "col.op.value" or a nested "and(...)". */
function parseLogicItem(text: string): Filter {
  const t = text.trim()
  const logic = /^(not\.)?(and|or)\(([\s\S]*)\)$/.exec(t)
  if (logic) return { kind: 'logic', negate: Boolean(logic[1]), op: logic[2] as 'and' | 'or', items: splitTop(logic[3]).map(parseLogicItem) }
  // The column ends at the first dot that is not inside a JSON path.
  const m = /^((?:"[^"]*"|[^.])+?)\.((?:not\.)?[a-z]+(?:\((?:any|all)\))?\.[\s\S]*)$/.exec(t)
  if (!m) bad(`"failed to parse logic tree (${t})"`)
  const field = parseField(m![1])
  return { kind: 'cond', column: field.name, json: field.json, ...parseOperation(m![2]) }
}

export function parseLogic(op: 'and' | 'or', negate: boolean, value: string): Filter {
  if (!value.startsWith('(') || !value.endsWith(')')) bad(`"failed to parse logic tree (${value})"`)
  return { kind: 'logic', op, negate, items: splitTop(value.slice(1, -1)).map(parseLogicItem) }
}

export function parseOrder(text: string): OrderTerm[] {
  return splitTop(text).map((raw) => raw.trim()).filter(Boolean).map((term) => {
    const parts = term.split('.')
    const field = parseField(parts[0])
    let desc = false
    let nulls: 'first' | 'last' | undefined
    for (const p of parts.slice(1)) {
      if (p === 'desc') desc = true
      else if (p === 'asc') desc = false
      else if (p === 'nullsfirst') nulls = 'first'
      else if (p === 'nullslast') nulls = 'last'
      else bad(`"failed to parse order (${term})"`)
    }
    return { column: field.name, json: field.json, desc, nulls }
  })
}

/** Values of in.(a,"b,c") and cs.{a,b}. */
export function parseList(value: string, open = '(', close = ')'): string[] {
  const v = value.trim()
  if (!v.startsWith(open) || !v.endsWith(close)) bad(`"failed to parse list (${value})"`)
  const inner = v.slice(1, -1)
  if (inner.trim() === '') return []
  return splitTop(inner).map((s) => unquote(s.trim()))
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'])

export function parseQuery(params: Iterable<[string, string]>): ParsedQuery {
  const levels = new Map<string, Level>()
  const level = (path: string) => {
    let l = levels.get(path)
    if (!l) levels.set(path, (l = { filters: [], order: [] }))
    return l
  }
  level('')
  let select: string | null = null
  let columns: string[] | undefined
  let onConflict: string[] | undefined
  for (const [key, value] of params) {
    if (key === 'select') { select = value; continue }
    if (key === 'columns') { columns = splitTop(value).map((c) => unquote(c.trim())); continue }
    if (key === 'on_conflict') { onConflict = splitTop(value).map((c) => unquote(c.trim())); continue }
    const dot = key.lastIndexOf('.')
    const lastPart = dot >= 0 ? key.slice(dot + 1) : key
    // Embedded-level keys: orders.order=…, orders.limit=…, orders.or=…, orders.status=eq.x
    const embedPath = (name: string) => (key.length > name.length ? key.slice(0, key.length - name.length - 1) : '')
    if (RESERVED.has(lastPart) && lastPart !== 'columns' && lastPart !== 'on_conflict' && lastPart !== 'select') {
      const l = level(embedPath(lastPart))
      if (lastPart === 'order') l.order.push(...parseOrder(value))
      else if (lastPart === 'limit') l.limit = toInt(value, key)
      else if (lastPart === 'offset') l.offset = toInt(value, key)
      continue
    }
    const logic = /^(?:(.*)\.)?(not\.)?(and|or)$/.exec(key)
    if (logic) {
      level(logic[1] ?? '').filters.push(parseLogic(logic[3] as 'and' | 'or', Boolean(logic[2]), value))
      continue
    }
    // A plain filter. The column may carry a JSON path (data->>key), which has no dots.
    const arrow = key.indexOf('->')
    const head = arrow >= 0 ? key.slice(0, arrow) : key
    const split = head.lastIndexOf('.')
    const path = split >= 0 ? head.slice(0, split) : ''
    const field = parseField(split >= 0 ? key.slice(split + 1) : key)
    level(path).filters.push({ kind: 'cond', column: field.name, json: field.json, ...parseOperation(value) })
  }
  return { select: parseSelect(select), levels, columns, onConflict }
}

function toInt(value: string, key: string): number {
  if (!/^\d+$/.test(value)) bad(`"failed to parse ${key}"`)
  return Number(value)
}
