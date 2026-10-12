// Postgres type names, normalised to the handful the engine distinguishes.
//
//   int        smallint, integer, bigint, serial, oid
//   numeric    numeric, decimal, real, double precision, money
//   text       text, varchar, char, name, citext, regclass, inet
//   bool, uuid, jsonb (json too), timestamptz, timestamp, date, time, interval, bytea
//   record     an anonymous row; a table name is that table's row type
//   enums keep their name; arrays are written elem[]

const ALIASES: Record<string, string> = {
  integer: 'int', int: 'int', int4: 'int', int8: 'int', int2: 'int', bigint: 'int', smallint: 'int', serial: 'int', bigserial: 'int', oid: 'int',
  serial4: 'int', serial8: 'int',
  numeric: 'numeric', decimal: 'numeric', real: 'numeric', float4: 'numeric', float8: 'numeric', 'double precision': 'numeric', money: 'numeric', float: 'numeric',
  text: 'text', varchar: 'text', 'character varying': 'text', char: 'text', character: 'text', bpchar: 'text', name: 'text', citext: 'text',
  regclass: 'text', regproc: 'text', inet: 'text', cidr: 'text', 'char varying': 'text',
  boolean: 'bool', bool: 'bool',
  json: 'jsonb', jsonb: 'jsonb',
  timestamptz: 'timestamptz', 'timestamp with time zone': 'timestamptz',
  timestamp: 'timestamp', 'timestamp without time zone': 'timestamp',
  date: 'date', time: 'time', 'time without time zone': 'time', timetz: 'time', 'time with time zone': 'time',
  interval: 'interval', uuid: 'uuid', bytea: 'bytea', void: 'void', record: 'record', trigger: 'trigger', anyelement: 'anyelement',
  unknown: 'unknown',
}

export function normType(name: string): string {
  const n = name.toLowerCase().replace(/^(public|pg_catalog|extensions)\./, '').replace(/\s+/g, ' ')
  return ALIASES[n] ?? n
}

export const isArrayType = (t: string) => t.endsWith('[]')
export const elemType = (t: string) => (t.endsWith('[]') ? t.slice(0, -2) : t)
export const arrayOf = (t: string) => `${t}[]`

/** Text-like types: stored and compared as text. */
export function isTextual(t: string, enums: Record<string, unknown>): boolean {
  return t === 'text' || t === 'uuid' || t === 'unknown' || Object.hasOwn(enums, t)
}

export const NUMERIC_TYPES = new Set(['int', 'numeric'])
