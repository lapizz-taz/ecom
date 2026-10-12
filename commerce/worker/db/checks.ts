// CHECK constraints SQLite cannot hold (regular expressions, list containment and a
// few hand-written ones), evaluated with SQL's three-valued logic: a check fails only
// when it is false, not when it is unknown (NULL).
import { DbError } from './errors.ts'
import type { CheckTree, TableMeta } from './meta.ts'

type V = unknown

function evalNode(t: CheckTree, row: Record<string, unknown>): V {
  if ('col' in t) return row[t.col] ?? null
  if ('lit' in t) return t.lit
  if ('fn' in t) {
    const v = evalNode(t.args[0], row)
    if (v === null) return null
    const s = String(v)
    return t.fn === 'length' ? [...s].length : t.fn === 'lower' ? s.toLowerCase() : t.fn === 'upper' ? s.toUpperCase() : s.trim()
  }
  switch (t.op) {
    case 'and': {
      const a = evalNode(t.args[0], row)
      const b = evalNode(t.args[1], row)
      if (a === false || b === false) return false
      return a === null || b === null ? null : true
    }
    case 'or': {
      const a = evalNode(t.args[0], row)
      const b = evalNode(t.args[1], row)
      if (a === true || b === true) return true
      return a === null || b === null ? null : false
    }
    case 'not': {
      const a = evalNode(t.args[0], row)
      return a === null ? null : !a
    }
    case 'isnull': return evalNode(t.args[0], row) === null
    case 'notnull': return evalNode(t.args[0], row) !== null
    case 'match': case 'notmatch': {
      const v = evalNode(t.args[0], row)
      const p = evalNode(t.args[1], row)
      if (v === null || p === null) return null
      const hit = new RegExp(String(p), t.flags).test(String(v))
      return t.op === 'match' ? hit : !hit
    }
    case 'subset': {
      const v = evalNode(t.args[0], row)
      const list = evalNode(t.args[1], row)
      if (v === null || list === null) return null
      const items = (Array.isArray(v) ? v : JSON.parse(String(v))) as unknown[]
      return items.every((x) => (list as unknown[]).includes(x))
    }
    default: {
      const a = evalNode(t.args[0], row) as number | string | null
      const b = evalNode(t.args[1], row) as number | string | null
      if (a === null || b === null) return null
      switch (t.op) {
        case '=': return a === b
        case '<>': return a !== b
        case '<': return a < b
        case '<=': return a <= b
        case '>': return a > b
        case '>=': return a >= b
      }
    }
  }
  return null
}

/** Hand-written checks for rules that called a Postgres function. */
const manual: Record<string, (row: Record<string, unknown>) => string | null> = {
  // notification_conditions_error(conditions) IS NULL
  notifications_conditions_valid: (row) => notificationConditionsError(row.conditions),
}

export function notificationConditionsError(conditions: unknown): string | null {
  if (!Array.isArray(conditions)) return 'conditions must be a list'
  if (conditions.length > 10) return 'use at most 10 conditions'
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  for (const c of conditions as unknown[]) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'each condition must be an object'
    const { field, op, value } = c as { field?: unknown; op?: unknown; value?: unknown }
    if (field === 'payment_method' || field === 'district' || field === 'source' || field === 'courier') {
      if (op !== 'in' && op !== 'not_in') return `${field} needs "is one of" or "is not one of"`
      if (!Array.isArray(value) || value.length === 0 || value.length > 70) return `choose at least one value for ${field}`
      for (const raw of value as unknown[]) {
        const item = typeof raw === 'string' ? raw : JSON.stringify(raw)
        if (item.trim().length === 0 || item.length > 80) return `${field} has an empty or too long value`
        if (field === 'payment_method' && !['COD', 'ADVANCE', 'FULL_PAYMENT'].includes(item)) return `unknown payment method ${item}`
        if (field === 'source' && !['STOREFRONT', 'ADMIN', 'IMPORT', 'API'].includes(item)) return `unknown order source ${item}`
        if (field === 'courier' && !uuid.test(item)) return 'courier must be a courier id'
      }
    } else if (field === 'total') {
      if (op !== 'gte' && op !== 'lte') return 'order total needs "at least" or "at most"'
      if (typeof value !== 'number' || value < 0) return 'order total must be a number of 0 or more'
    } else if (field === 'first_order') {
      if (op !== 'eq' || typeof value !== 'boolean') return 'first order must be yes or no'
    } else {
      return `unknown condition ${typeof field === 'string' ? field : '(none)'}`
    }
  }
  return null
}

/** Throws 23514 when a decoded row breaks one of the table's application-level checks. */
export function enforceChecks(tableName: string, t: TableMeta, row: Record<string, unknown>): void {
  for (const c of t.checks) {
    if (c.tree) {
      if (evalNode(c.tree, row) === false) {
        throw new DbError('23514', `new row for relation "${tableName}" violates check constraint "${c.name}"`)
      }
    } else if (c.manual !== undefined) {
      const check = manual[c.name]
      if (!check) throw new DbError('0A000', `NOT_PORTED: check ${c.name} on ${tableName} has no TypeScript version yet`)
      const problem = check(row)
      if (problem !== null) {
        throw new DbError('23514', `new row for relation "${tableName}" violates check constraint "${c.name}"`, problem)
      }
    }
  }
}
