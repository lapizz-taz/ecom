// Embedded resources: how a related table hangs off its parent, found from foreign
// keys the way PostgREST does it (many-to-one → object, one-to-many → array,
// one-to-one → object).
import { DbError } from '../errors.ts'
import { schema, table, type ForeignKey } from '../meta.ts'

export interface Relationship {
  /** The related table. */
  target: string
  /** Parent columns and the target columns they match, pairwise. */
  parentColumns: string[]
  targetColumns: string[]
  /** true: one object (or null); false: an array. */
  toOne: boolean
  constraint: string
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((c) => b.includes(c))

function isUnique(tableName: string, columns: string[]): boolean {
  const t = table(tableName)
  if (!t) return false
  return sameSet(t.pk, columns) || t.unique.some((u) => sameSet(u, columns))
}

/** Every foreign-key path between parent and the named relation. */
function candidates(parent: string, relation: string): Relationship[] {
  const out: Relationship[] = []
  const p = table(parent)
  if (!p) return out
  // many-to-one: parent → relation (the relation may also be named by the FK column or constraint)
  for (const fk of p.fks) {
    if (fk.table === relation || fk.name === relation || (fk.columns.length === 1 && fk.columns[0] === relation)) {
      out.push({ target: fk.table, parentColumns: fk.columns, targetColumns: fk.refColumns, toOne: true, constraint: fk.name })
    }
  }
  // one-to-many / one-to-one: relation → parent
  const r = table(relation)
  if (r) {
    for (const fk of r.fks) {
      if (fk.table !== parent) continue
      out.push({ target: relation, parentColumns: fk.refColumns, targetColumns: fk.columns, toOne: isUnique(relation, fk.columns), constraint: fk.name })
    }
  }
  return out
}

/** Resolves rel!hint to one relationship, or fails like PostgREST (PGRST200 / PGRST201). */
export function resolve(parent: string, relation: string, hint?: string): Relationship {
  let list = candidates(parent, relation)
  if (hint) {
    list = list.filter((r) => r.constraint === hint || (r.toOne ? r.parentColumns : r.targetColumns).join(',') === hint ||
      (r.toOne ? r.parentColumns : r.targetColumns).includes(hint))
  }
  // Self-references show up twice (both directions); without a hint prefer many-to-one.
  if (list.length > 1 && !hint && relation === parent) list = list.filter((r) => r.toOne)
  if (list.length === 1) return list[0]
  if (list.length === 0) {
    throw new DbError('PGRST200', `Could not find a relationship between '${parent}' and '${relation}' in the schema cache`, null,
      'Perhaps you meant a different table name.')
  }
  throw new DbError('PGRST201', `Could not embed because more than one relationship was found for '${parent}' and '${relation}'`,
    JSON.stringify(list.map((r) => r.constraint)), `Try changing '${relation}' to one of the constraint names with '!'.`)
}

export function foreignKeysTo(target: string): Array<{ table: string; fk: ForeignKey }> {
  const out: Array<{ table: string; fk: ForeignKey }> = []
  for (const [name, t] of Object.entries(schema.tables)) for (const fk of t.fks) if (fk.table === target) out.push({ table: name, fk })
  return out
}
