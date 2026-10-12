// Temporary tables (CREATE TEMPORARY TABLE … ON COMMIT DROP) for the length of a
// transaction. Their rows stay in memory with the transaction's context, never in the
// database; queries read them as an inline table (see Compiler.tableSource). Only the
// statements the migrations use exist: CREATE (with columns or AS a query), INSERT,
// TRUNCATE, DROP and reading.
import type { Context } from '../context.ts'
import { DbError } from '../errors.ts'
import type { Insert } from './ast.ts'
import { encodeSql } from './bridge.ts'
import { lex } from './lex.ts'
import { Parser } from './parse.ts'
import { NotSupported, type Engine, type Typed, type Vars } from './runtime.ts'
import { cast } from './values.ts'

export interface TempColumn {
  name: string
  t: string
  s?: number
}

export interface TempTable {
  cols: TempColumn[]
  rows: unknown[][]
}

const byContext = new WeakMap<Context, Map<string, TempTable>>()

function tablesOf(ctx: Context): Map<string, TempTable> {
  let m = byContext.get(ctx)
  if (!m) {
    m = new Map()
    byContext.set(ctx, m)
  }
  return m
}

/** The temporary table a name refers to (pg_temp.x or plain x), if this transaction made one. */
export function tempTable(ctx: Context, name: string, schema?: string): TempTable | undefined {
  if (schema && schema !== 'pg_temp') return undefined
  return byContext.get(ctx)?.get(name)
}

/** The table's rows as SQLite JSON: one array per row, each value as SQLite stores it. */
export function tempRowsJson(table: TempTable): string {
  return JSON.stringify(table.rows.map((r) => r.map((v, i) => encodeSql(v, table.cols[i].t))))
}

type RunQuery = (src: string) => { cols: TempColumn[]; rows: unknown[][] }

/**
 * CREATE / TRUNCATE / DROP of a temporary table, from a PL/pgSQL utility statement.
 * Returns false when the statement is not about a temporary table.
 */
export function tempUtility(engine: Engine, word: string, src: string, query: RunQuery): boolean {
  const tables = tablesOf(engine.ctx)
  if (word === 'create') {
    const m = /^\s*create\s+(?:(?:local|global)\s+)?temp(?:orary)?\s+table\s+(if\s+not\s+exists\s+)?(?:pg_temp\.)?("?)([a-z_][a-z0-9_]*)\2\s*/i.exec(src)
    if (!m) return false
    const name = m[3].toLowerCase()
    if (tables.has(name)) {
      if (m[1]) return true
      throw new DbError('42P07', `relation "${name}" already exists`)
    }
    let rest = src.slice(m[0].length)
    let cols: TempColumn[] = []
    if (rest.startsWith('(')) {
      const p = new Parser(lex(rest), rest, {})
      p.expectPunct('(')
      do {
        const col = p.name()
        const type = p.typeName()
        cols.push({ name: col, t: type.array ? `${type.name}[]` : type.name, s: type.scale })
        while (!p.isPunct(',') && !p.isPunct(')') && p.peek().k !== 'eof') p.next() // NOT NULL, DEFAULT …
      } while (p.eatPunct(','))
      p.expectPunct(')')
      rest = rest.slice(p.peek().pos)
    }
    rest = rest.replace(/^\s*on\s+commit\s+(drop|delete\s+rows|preserve\s+rows)\s*/i, '')
    let rows: unknown[][] = []
    const as = /^\s*as\s+/i.exec(rest)
    if (as) {
      const res = query(rest.slice(as[0].length).replace(/\s+with\s+(no\s+)?data\s*$/i, ''))
      cols = res.cols
      rows = /with\s+no\s+data\s*$/i.test(rest) ? [] : res.rows
    } else if (rest.trim()) throw new NotSupported(`CREATE TEMPORARY TABLE … ${rest.trim().slice(0, 40)}`)
    if (!cols.length) throw new NotSupported('a temporary table without columns')
    tables.set(name, { cols, rows })
    return true
  }
  if (word === 'truncate' || word === 'drop') {
    const m = word === 'truncate'
      ? /^\s*truncate\s+(?:table\s+)?(?:only\s+)?(?:pg_temp\.)?([a-z_][a-z0-9_]*)\s*$/i.exec(src)
      : /^\s*drop\s+table\s+(if\s+exists\s+)?(?:pg_temp\.)?([a-z_][a-z0-9_]*)\s*$/i.exec(src)
    if (!m) return false
    const name = (word === 'truncate' ? m[1] : m[2]).toLowerCase()
    const table = tables.get(name)
    if (!table) {
      if (word === 'drop' && m[1]) return true
      return false
    }
    if (word === 'truncate') table.rows = []
    else tables.delete(name)
    return true
  }
  return false
}

/** INSERT INTO a temporary table: the rows are converted to its column types and kept. */
export function insertTemp(table: TempTable, st: Insert, rows: Array<Array<Typed | undefined>>): number {
  if (st.conflict || st.returning) throw new NotSupported('ON CONFLICT / RETURNING on a temporary table')
  const names = st.cols ?? table.cols.map((c) => c.name)
  const index = names.map((n) => {
    const i = table.cols.findIndex((c) => c.name === n)
    if (i < 0) throw new DbError('42703', `column "${n}" of relation "${st.table}" does not exist`)
    return i
  })
  for (const r of rows) {
    if (r.length > names.length) throw new DbError('42601', 'INSERT has more expressions than target columns')
    const row: unknown[] = table.cols.map(() => null)
    index.forEach((ci, j) => {
      const v = r[j]
      if (!v || v.v === null) return
      const t = table.cols[ci].t
      row[ci] = v.t === t ? v.v : cast(v.v, v.t === 'unknown' ? 'text' : v.t, t)
    })
    table.rows.push(row)
  }
  return rows.length
}

export type { Vars }
