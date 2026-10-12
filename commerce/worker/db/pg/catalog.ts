// The few Postgres catalog views business functions read, built from the schema
// metadata (read-only; queries see them as inline tables like temporary tables):
//   pg_class / pg_attribute   tables, views and their columns (merchant deletion lists the
//                             tables holding merchant_id)
//   pg_roles                  the database roles row security distinguishes
//   pg_stat_activity          this database's one connection (platform health)
import { schema } from '../meta.ts'
import type { TempTable } from './temp.ts'

const col = (name: string, t: string) => ({ name, t })

let classes: TempTable | null = null
let attributes: TempTable | null = null

function pgClass(): TempTable {
  classes ??= {
    cols: [col('oid', 'text'), col('relname', 'text'), col('relnamespace', 'text'), col('relkind', 'text'), col('relrowsecurity', 'bool')],
    rows: [
      ...Object.entries(schema.tables).map(([name, t]) => [name, name, 'public', 'r', Boolean(t.rls)]),
      ...Object.keys(schema.views).map((name) => [name, name, 'public', 'v', false]),
    ],
  }
  return classes
}

function pgAttribute(): TempTable {
  attributes ??= {
    cols: [col('attrelid', 'text'), col('attname', 'text'), col('attnum', 'int'), col('attisdropped', 'bool'), col('attnotnull', 'bool')],
    rows: [...Object.entries(schema.tables), ...Object.entries(schema.views)].flatMap(([name, t]) =>
      Object.entries(t.columns).map(([c, m], i) => [name, c, i + 1, false, m.nullable === false])),
  }
  return attributes
}

const roles: TempTable = {
  cols: [col('rolname', 'text'), col('rolsuper', 'bool'), col('rolbypassrls', 'bool'), col('rolinherit', 'bool'), col('rolcanlogin', 'bool')],
  rows: [
    ['postgres', true, true, true, true],
    ['anon', false, false, true, false],
    ['authenticated', false, false, true, false],
    ['service_role', false, true, true, false],
    ['app_owner', false, false, true, false],
  ],
}

const activity: TempTable = {
  cols: [col('datname', 'text'), col('pid', 'int'), col('usename', 'text'), col('state', 'text')],
  rows: [['postgres', 1, 'postgres', 'active']],
}

/** A catalog view by name (pg_catalog.x or a bare pg_x), or undefined. */
export function catalogTable(name: string, schemaName?: string): TempTable | undefined {
  if (schemaName && schemaName !== 'pg_catalog') return undefined
  if (!schemaName && !name.startsWith('pg_')) return undefined
  switch (name) {
    case 'pg_class': return pgClass()
    case 'pg_attribute': return pgAttribute()
    case 'pg_roles': return roles
    case 'pg_stat_activity': return activity
    default: return undefined
  }
}

/** Server settings current_setting() reads that no session sets. */
export const SERVER_SETTINGS: Record<string, string> = {
  max_connections: '100',
  server_version: '16.0',
  server_version_num: '160000',
  TimeZone: 'UTC',
  timezone: 'UTC',
}
