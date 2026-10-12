// Syntax tree of the Postgres SQL the migrations use (see parse.ts).

export interface TypeName {
  /** Normalised: int, numeric, text, bool, uuid, jsonb, timestamptz, timestamp, date, time, interval, bytea, record, void, an enum or a table name. */
  name: string
  /** Array dimensions (0 for a scalar). */
  array: number
  /** table%rowtype / table.column%type (PL/pgSQL declarations). */
  pct?: 'rowtype' | 'type'
  /** The column of a %type reference. */
  column?: string
}

export type Expr =
  | { k: 'lit'; v: string | number | boolean | null; type: 'unknown' | 'int' | 'numeric' | 'bool' | 'null' }
  | { k: 'param'; n: number }
  | { k: 'ref'; parts: string[] }
  | { k: 'star'; table?: string }
  | CallExpr
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'un'; op: string; e: Expr }
  | { k: 'is'; e: Expr; what: 'null' | 'true' | 'false' | 'unknown'; not: boolean }
  | { k: 'isdistinct'; l: Expr; r: Expr; not: boolean }
  | { k: 'between'; e: Expr; lo: Expr; hi: Expr; not: boolean }
  | { k: 'in'; e: Expr; list?: Expr[]; q?: Query; not: boolean }
  | { k: 'quant'; op: string; l: Expr; quant: 'any' | 'all'; r?: Expr; q?: Query }
  | { k: 'like'; e: Expr; p: Expr; ci: boolean; not: boolean; similar?: boolean; escape?: Expr }
  | { k: 'case'; subject?: Expr; whens: Array<{ when: Expr; then: Expr }>; else?: Expr }
  | { k: 'cast'; e: Expr; type: TypeName }
  | { k: 'exists'; q: Query }
  | { k: 'sub'; q: Query }
  | { k: 'array'; items: Expr[] }
  | { k: 'arraysub'; q: Query }
  | { k: 'row'; items: Expr[] }
  | { k: 'field'; e: Expr; name: string }
  | { k: 'index'; e: Expr; idx?: Expr; upper?: Expr; slice: boolean }
  | { k: 'attz'; e: Expr; zone: Expr }
  | { k: 'default' }
  /** A value already computed (constant folding, PL/pgSQL variables). */
  | { k: 'value'; v: unknown; type: string }
  /** A placeholder for an argument quantifier while parsing (x = ANY(…)). */
  | { k: 'quantarg'; quant: 'any' | 'all'; e?: Expr; q?: Query }

export interface CallExpr {
  k: 'call'
  name: string
  schema?: string
  args: Expr[]
  /** Named arguments (name => value): the name per argument, null when positional. */
  names?: Array<string | null>
  distinct?: boolean
  order?: OrderItem[]
  filter?: Expr
  over?: WindowSpec
  star?: boolean
  variadic?: boolean
  /** current_date and friends, written without brackets. */
  bare?: boolean
}

export interface OrderItem {
  e: Expr
  desc?: boolean
  nulls?: 'first' | 'last'
}

export interface WindowSpec {
  name?: string
  partition: Expr[]
  order: OrderItem[]
  /** The frame clause as written (ROWS BETWEEN …), passed through. */
  frame?: string
}

export interface SelItem {
  e: Expr
  alias?: string
}

export interface Into {
  strict: boolean
  targets: Expr[]
}

export interface Cte {
  name: string
  cols?: string[]
  q: Statement
  materialized?: boolean
}

export interface With {
  recursive: boolean
  ctes: Cte[]
}

export interface Select {
  k: 'select'
  with?: With
  distinct?: true | Expr[]
  items: SelItem[]
  into?: Into
  from: FromItem[]
  where?: Expr
  groupBy: Expr[]
  having?: Expr
  windows?: Record<string, WindowSpec>
  orderBy: OrderItem[]
  limit?: Expr
  offset?: Expr
  lock?: boolean
}

export interface SetOp {
  k: 'setop'
  with?: With
  op: 'union' | 'intersect' | 'except'
  all: boolean
  l: Query
  r: Query
  orderBy: OrderItem[]
  limit?: Expr
  offset?: Expr
  into?: Into
}

export interface Values {
  k: 'values'
  rows: Expr[][]
  orderBy: OrderItem[]
  limit?: Expr
  offset?: Expr
}

export type Query = Select | SetOp | Values

export type FromItem =
  | { k: 'table'; schema?: string; name: string; alias?: string; cols?: string[] }
  | { k: 'subq'; q: Query; alias?: string; cols?: string[]; lateral: boolean }
  | { k: 'func'; call: CallExpr; alias?: string; cols?: string[]; coldefs?: Array<{ name: string; type: TypeName }>; lateral: boolean; ordinality: boolean }
  | { k: 'join'; type: 'inner' | 'left' | 'right' | 'full' | 'cross'; l: FromItem; r: FromItem; on?: Expr; using?: string[] }

export interface SetItem {
  cols: string[]
  e: Expr
}

export interface Conflict {
  target?: Expr[]
  constraint?: string
  where?: Expr
  action: 'nothing' | { set: SetItem[]; where?: Expr }
}

export interface Insert {
  k: 'insert'
  with?: With
  schema?: string
  table: string
  alias?: string
  cols?: string[]
  source: Query | 'default'
  conflict?: Conflict
  returning?: SelItem[]
  into?: Into
}

export interface Update {
  k: 'update'
  with?: With
  schema?: string
  table: string
  alias?: string
  set: SetItem[]
  from: FromItem[]
  where?: Expr
  returning?: SelItem[]
  into?: Into
}

export interface Delete {
  k: 'delete'
  with?: With
  schema?: string
  table: string
  alias?: string
  using: FromItem[]
  where?: Expr
  returning?: SelItem[]
  into?: Into
}

export type Statement = Query | Insert | Update | Delete
