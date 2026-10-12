// The few Postgres catalog views business functions read, built from the schema
// metadata (read-only; queries see them as inline tables like temporary tables):
//   pg_class / pg_attribute   tables, views and their columns (merchant deletion lists the
//                             tables holding merchant_id)
//   pg_policies               row security policies (tenancy checks)
//   pg_proc                   functions: name, SECURITY DEFINER, owner (tenancy checks)
//   pg_roles                  the database roles row security distinguishes
//   pg_stat_activity          this database's one connection (platform health)
import functions from '../generated/functions.json'
import { schema } from '../meta.ts'
import type { TempTable } from './temp.ts'

const col = (name: string, t: string) => ({ name, t })

let classes: TempTable | null = null
let attributes: TempTable | null = null

function pgClass(): TempTable {
  classes ??= {
    cols: [col('oid', 'text'), col('relname', 'text'), col('relnamespace', 'text'), col('relkind', 'text'), col('relrowsecurity', 'bool')],
    rows: [
      // users stands in for auth.users, which lives in the auth schema
      ...Object.entries(schema.tables).map(([name, t]) => [name, name, name === 'users' ? 'auth' : 'public', 'r', Boolean(t.rls)]),
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

let policies: TempTable | null = null
let procs: TempTable | null = null

function pgPolicies(): TempTable {
  policies ??= {
    cols: [col('schemaname', 'text'), col('tablename', 'text'), col('policyname', 'text'), col('permissive', 'text'),
      col('roles', 'text[]'), col('cmd', 'text'), col('qual', 'text'), col('with_check', 'text')],
    rows: Object.entries(schema.tables).flatMap(([name, t]) => (t.policies ?? []).map((p) =>
      ['public', name, p.name, p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE', p.roles, p.cmd, p.using ?? null, p.check ?? null])),
  }
  return policies
}

function pgProc(): TempTable {
  procs ??= {
    cols: [col('oid', 'text'), col('proname', 'text'), col('pronamespace', 'text'), col('prosecdef', 'bool'), col('proowner', 'text'), col('prokind', 'text')],
    rows: Object.entries(functions as Record<string, Array<{ definer?: boolean; owner?: string }>>).flatMap(([name, list]) =>
      list.map((f, i) => [`${name}/${i}`, name, 'public', Boolean(f.definer), f.owner ?? 'postgres', 'f'])),
  }
  return procs
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
    case 'pg_policies': return pgPolicies()
    case 'pg_proc': return pgProc()
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
