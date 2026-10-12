// Row security, as Postgres enforced it: the converted policies of each table are
// combined (permissive ones OR-ed, restrictive ones AND-ed) for the caller's role and
// the command, and their context placeholders are filled in for this request.
//
// Reads see policies through "shadowing": every table a query mentions is replaced,
// for that one statement, by `WITH t AS NOT MATERIALIZED (SELECT * FROM main.t AS t
// WHERE <policy>)`. Joins, sub-queries, views and the policies' own sub-queries then
// only ever see permitted rows, and SQLite still uses the table's indexes.
import type { Context } from './context.ts'
import { DbError, permissionDenied } from './errors.ts'
import { quoteId } from './ident.ts'
import { schema, table, view, type Command, type PolicyMeta } from './meta.ts'
import { handViews } from './views.ts'

/** The database role a statement runs as. */
export type DbRole = 'anon' | 'authenticated' | 'service_role' | 'app_owner'

const roleOf = (ctx: Context): DbRole => ctx.role

const quote = (v: string | null) => (v === null ? 'NULL' : `'${v.replaceAll("'", "''")}'`)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A store setting as an SQL literal ({{setting:inventory.low_stock_threshold}}); '' and missing are NULL. */
function settingLiteral(ctx: Context, path: string): string {
  const [key, ...rest] = path.split('.')
  const merchant = ctx.merchantId()
  const row = merchant ? ctx.sql.all('SELECT value FROM settings WHERE key = ? AND merchant_id = ?', [key, merchant])[0] : undefined
  let v: unknown = row ? JSON.parse(String(row.value)) : null
  for (const k of rest) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : null
  if (v === null || v === undefined || v === '') return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  return quote(typeof v === 'string' ? v : JSON.stringify(v))
}

/** Fills {{merchant}}, {{uid}}, {{perm:code}}, {{setting:key.path}} … with this request's answers. */
export function fill(expr: string, ctx: Context): string {
  return expr.replace(/\{\{([a-z_]+)(?::([a-z_.]+))?\}\}/g, (_, name: string, arg?: string) => {
    switch (name) {
      case 'merchant': {
        const m = ctx.merchantId()
        if (m !== null && !UUID.test(m)) throw new DbError('XX000', 'bad merchant id')
        return quote(m)
      }
      case 'uid': {
        const u = ctx.uid
        if (u !== null && !UUID.test(u)) throw new DbError('XX000', 'bad user id')
        return quote(u)
      }
      case 'perm': return ctx.hasPermission(arg!) ? '1' : '0'
      case 'is_staff': return ctx.isStaff() ? '1' : '0'
      case 'is_platform_staff': return ctx.isPlatformStaff() ? '1' : '0'
      case 'support_read_only': return ctx.supportReadOnly() ? '1' : '0'
      case 'is_system': return ctx.isSystem() ? '1' : '0'
      case 'role_code': return quote(ctx.roleCode())
      case 'setting': return settingLiteral(ctx, arg!)
      default: throw new DbError('XX000', `unknown policy placeholder ${name}`)
    }
  })
}

function applies(p: PolicyMeta, role: DbRole, cmd: Exclude<Command, 'ALL'>): boolean {
  return (p.cmd === cmd || p.cmd === 'ALL') && (p.roles.includes(role) || p.roles.includes('public'))
}

/** Policies of a table for a role and command; null when row security does not apply. */
function policiesFor(name: string, role: DbRole, cmd: Exclude<Command, 'ALL'>): PolicyMeta[] | null {
  const t = table(name)
  if (!t || !t.rls || role === 'service_role') return null
  return t.policies.filter((p) => applies(p, role, cmd))
}

/**
 * The condition rows must meet: USING for reads, updates and deletes, WITH CHECK for
 * new rows (falling back to USING as Postgres does). Returns '1' when unrestricted.
 */
export function condition(name: string, ctx: Context, cmd: Exclude<Command, 'ALL'>, kind: 'using' | 'check', role = roleOf(ctx)): string {
  const list = policiesFor(name, role, cmd)
  if (list === null) return '1'
  const exprOf = (p: PolicyMeta) => {
    if (p.untranslated) return '0'
    // WITH CHECK falls back to USING, as in Postgres; a policy without the clause adds nothing.
    const e = kind === 'check' ? p.check ?? p.using : p.using
    return e === undefined ? null : `(${fill(e, ctx)})`
  }
  const permissive = list.filter((p) => p.permissive).map(exprOf).filter((e): e is string => e !== null)
  const restrictive = list.filter((p) => !p.permissive).map(exprOf).filter((e): e is string => e !== null)
  const parts = [permissive.length ? `(${permissive.join(' OR ')})` : '0', ...restrictive]
  return parts.join(' AND ')
}

/** Table privileges (GRANT) for the API roles; definer code and the service role have all. */
export function requireGrant(name: string, ctx: Context, privilege: 'select' | 'insert' | 'update' | 'delete'): void {
  const role = roleOf(ctx)
  if (role === 'service_role') return
  const grants = table(name)?.grants ?? view(name)?.grants
  if (!grants) permissionDenied(`table ${name}`)
  if (!(grants![role as 'anon' | 'authenticated'] ?? []).includes(privilege)) permissionDenied(`table ${name}`)
}

let viewCompiler: ((name: string, ctx: Context, role: DbRole) => string | undefined) | null = null

/** Views kept in Postgres SQL are compiled to SQLite by the engine (pg/engine.ts). */
export function setViewCompiler(fn: (name: string, ctx: Context, role: DbRole) => string | undefined): void {
  viewCompiler = fn
}

/** Names of tables and views mentioned in some SQL (over-inclusion is harmless). */
export function mentioned(sql: string): Set<string> {
  const names = new Set<string>()
  for (const m of sql.matchAll(/"([^"]+)"|\b([a-z_][a-z0-9_]*)\b/g)) {
    const n = m[1] ?? m[2]
    if (Object.hasOwn(schema.tables, n) || Object.hasOwn(schema.views, n)) names.add(n)
  }
  return names
}

/**
 * The WITH clause that makes a SELECT see only permitted rows: policy-filtered copies
 * of the mentioned tables (and of tables their policies read), then the views the
 * statement uses, in dependency order.
 */
export function shadow(sql: string, ctx: Context, role = roleOf(ctx)): string[] {
  const ctes: string[] = []
  const done = new Set<string>()
  const active = new Set<string>()

  const visit = (name: string) => {
    if (done.has(name)) return
    if (active.has(name)) throw new DbError('42P17', `infinite recursion detected in policy for relation "${name}"`)
    active.add(name)
    const v = view(name)
    if (v) {
      const body = v.sql ?? handViews[name] ?? viewCompiler?.(name, ctx, role)
      if (!body) throw new DbError('0A000', `NOT_PORTED: view ${name} is not available on the Cloudflare database yet`)
      for (const dep of mentioned(body)) if (dep !== name) visit(dep)
      ctes.push(`${quoteId(name)} AS NOT MATERIALIZED (${fill(body, ctx)})`)
    } else if (table(name)) {
      const cond = condition(name, ctx, 'SELECT', 'using', role)
      if (cond !== '1') {
        for (const dep of mentioned(cond)) if (dep !== name) visit(dep)
        ctes.push(`${quoteId(name)} AS NOT MATERIALIZED (SELECT * FROM main.${quoteId(name)} AS ${quoteId(name)} WHERE ${cond})`)
      }
    }
    active.delete(name)
    done.add(name)
  }
  for (const name of mentioned(sql)) visit(name)
  return ctes
}

/** Prefixes a statement with its shadowing WITH clause (merging an existing WITH). */
export function secure(sql: string, ctx: Context, role = roleOf(ctx)): string {
  const ctes = shadow(sql, ctx, role)
  if (!ctes.length) return sql
  const existing = /^\s*WITH\s+/i.exec(sql)
  return existing ? `WITH ${ctes.join(', ')}, ${sql.slice(existing[0].length)}` : `WITH ${ctes.join(', ')} ${sql}`
}
