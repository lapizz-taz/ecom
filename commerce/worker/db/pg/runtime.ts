// Interfaces shared by the evaluator, the SQL compiler, the statement executor and
// the PL/pgSQL interpreter.
import type { Context } from '../context.ts'
import type { DbRole } from '../policy.ts'
import type { Sql } from '../sql.ts'
import type { Select } from './ast.ts'

/** A value with its Postgres type. */
export interface Typed {
  t: string
  v: unknown
  /** A numeric's display scale: the decimals Postgres prints (990.00 has 2). FLOAT for float8. */
  s?: number
}

/** The scale marking a float8 (double precision) value: printed shortest, returned as a number. */
export const FLOAT = -1
/** The display hint of a bigint (int8): the Postgres driver returns it as text. */
export const BIGINT = -2

export const NULL: Typed = Object.freeze({ t: 'unknown', v: null }) as Typed
export const typed = (t: string, v: unknown): Typed => ({ t, v })

/** Names a statement can see besides table columns: PL/pgSQL variables, NEW/OLD, record fields. */
export interface Vars {
  lookup(parts: string[]): Typed | null
}

export const NO_VARS: Vars = { lookup: () => null }

/** An SQL-language function body that can be inlined into a query. */
export interface Inline {
  q: Select
  params: string[]
  types: string[]
  /** Runs with row security bypassed (SECURITY DEFINER owned by postgres). */
  bypass: boolean
}

export interface Engine {
  readonly ctx: Context
  readonly sql: Sql
  /** current_user: whose table privileges and row security apply. */
  role: DbRole
  /** Name current_user / session_user report. */
  roleName(): string
  /** Calls a database function (ported, native or interpreted). */
  call(name: string, args: Typed[], names?: Array<string | null>, schema?: string): Typed
  /** The return type of a user function for these argument types, or null when there is none. */
  returnType(name: string, argTypes: string[], schema?: string): string | null
  /** Column names and types of a set- or record-returning user function. */
  resultColumns(name: string, argTypes: string[]): Array<{ name: string; type: string }> | null
  /** Whether a user function has side effects or depends on more than its arguments per row. */
  volatile(name: string, argTypes: string[]): boolean
  /** The SQL body of a simple LANGUAGE sql function, for use with per-row arguments. */
  inline(name: string, argTypes: string[]): Inline | null
}

export class NotSupported extends Error {}
