// The schema the data layer works from, generated from the Postgres migrations by
// scripts/pg-to-sqlite.mjs (worker/db/generated/meta.json).
import generated from './generated/meta.json'

export type ColumnType = 'uuid' | 'text' | 'int' | 'numeric' | 'bool' | 'json' | 'array' | 'enum' | 'timestamptz' | 'date' | 'time' | 'bytes'

/** A value the data layer fills in when an insert leaves the column out. */
export type Fill =
  | { seq: string; prefix?: string; pad?: number }
  | { ctx: 'merchant' | 'uid' }
  | { expr: string }

export interface ColumnMeta {
  type: ColumnType
  elem?: ColumnType
  values?: string[]
  /** The Postgres enum type (of the column, or of its elements for arrays). */
  enum?: string
  /** timestamp without time zone (stored like timestamptz). */
  local?: boolean
  scale?: number
  nullable?: boolean
  /** The SQLite DEFAULT expression, when SQLite fills the column in. */
  default?: string
  fill?: Fill
  identity?: boolean
  generated?: boolean
}

export type Command = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL'

export interface PolicyMeta {
  name: string
  cmd: Command
  permissive: boolean
  roles: string[]
  using?: string
  check?: string
  untranslated?: boolean
}

/** A CHECK constraint SQLite cannot express (regular expressions, list containment). */
export type CheckTree =
  | { op: 'and' | 'or'; args: [CheckTree, CheckTree] }
  | { op: 'not' | 'isnull' | 'notnull'; args: [CheckTree] }
  | { op: '=' | '<>' | '<' | '<=' | '>' | '>='; args: [CheckTree, CheckTree] }
  | { op: 'match' | 'notmatch'; flags: string; args: [CheckTree, CheckTree] }
  | { op: 'subset'; args: [CheckTree, CheckTree] }
  | { col: string }
  | { lit: string | number | boolean | Array<string | number> }
  | { fn: 'length' | 'lower' | 'upper' | 'trim'; args: [CheckTree] }

export interface ForeignKey {
  name: string
  columns: string[]
  table: string
  refColumns: string[]
}

export interface TableMeta {
  columns: Record<string, ColumnMeta>
  pk: string[]
  unique: string[][]
  /** Postgres names of the primary key and unique rules, by their columns ("a,b"). */
  uniqueNames?: Record<string, string>
  partialUnique?: Array<{ columns: string[]; where: string }>
  fks: ForeignKey[]
  grants: Partial<Record<'anon' | 'authenticated', string[]>>
  rls: boolean
  policies: PolicyMeta[]
  checks: Array<{ name: string; tree?: CheckTree; manual?: string }>
  /** Keeps updated_at current (Postgres set_updated_at trigger). */
  updatedAt?: boolean
  /** Rows are permanent (Postgres prevent_mutation trigger). */
  immutable?: boolean
  /** Changes are written to audit_logs (Postgres audit_row_change trigger). */
  audit?: { key: string; events: string[] }
  /** Business triggers; each needs its TypeScript port (worker/db/triggers). */
  triggers?: TriggerMeta[]
}

export interface TriggerMeta {
  name: string
  function: string
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD'
  events: Array<'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'>
  row: boolean
  args: string[]
  when?: string
  columns?: string[]
}

export interface ViewMeta {
  columns: Record<string, ColumnMeta>
  /** The view's query in SQLite; missing when it is written by hand (see views.ts). */
  sql?: string
  pg?: string
  grants?: Partial<Record<'anon' | 'authenticated', string[]>>
}

/** A database function PostgREST exposed as /rpc/<name>. */
export interface FunctionMeta {
  args: Array<{ name: string; type: string; optional: boolean }>
  returns: string
  set: boolean
  /** SECURITY DEFINER: runs as its owner (postgres bypasses row security; app_owner keeps store isolation). */
  definer: boolean
  owner: string
  volatile: boolean
  grants: Array<'anon' | 'authenticated'>
}

export interface SchemaMeta {
  version: number
  tables: Record<string, TableMeta>
  views: Record<string, ViewMeta>
  enums: Record<string, string[]>
  sequences: Record<string, { start: number }>
  functions: Record<string, FunctionMeta>
}

export const schema = generated as unknown as SchemaMeta

export function table(name: string): TableMeta | undefined {
  return Object.hasOwn(schema.tables, name) ? schema.tables[name] : undefined
}

export function view(name: string): ViewMeta | undefined {
  return Object.hasOwn(schema.views, name) ? schema.views[name] : undefined
}

/** Columns of a table or view. */
export function columnsOf(name: string): Record<string, ColumnMeta> | undefined {
  return table(name)?.columns ?? view(name)?.columns
}

export function fn(name: string): FunctionMeta | undefined {
  return Object.hasOwn(schema.functions, name) ? schema.functions[name] : undefined
}
