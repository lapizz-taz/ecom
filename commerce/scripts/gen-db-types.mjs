#!/usr/bin/env node
// Generates src/types/database.ts (supabase-js `Database` type) by introspecting
// a database that has the migrations applied. Equivalent output can be produced
// with `supabase gen types typescript --local`; this script needs only Postgres.
//
//   DATABASE_URL=postgres://… node scripts/gen-db-types.mjs
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const url = process.env.DATABASE_URL ?? process.env.COMMERCE_TEST_DB_URL ?? 'postgres://postgres:postgres@localhost:5432/commerce_test'
const out = resolve(import.meta.dirname, '..', 'src', 'types', 'database.ts')
const client = new pg.Client({ connectionString: url })
await client.connect()

const enums = (await client.query(`
  select t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as values
  from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' group by t.typname order by t.typname`)).rows
const enumNames = new Set(enums.map((e) => e.name))

const columns = (await client.query(`
  select c.relname as table, c.relkind as kind, a.attname as column, a.attnum,
         format_type(a.atttypid, a.atttypmod) as type, t.typname as udt, t.typcategory as category,
         et.typname as elem_udt,
         not a.attnotnull as nullable, a.atthasdef as has_default, a.attidentity <> '' as identity,
         a.attgenerated <> '' as generated
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
  where n.nspname = 'public' and c.relkind in ('r', 'v') and a.attnum > 0 and not a.attisdropped
  order by c.relname, a.attnum`)).rows

const fks = (await client.query(`
  select con.conname as name, c.relname as table, rc.relname as ref_table,
         array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.ord) as columns,
         array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.ord) as ref_columns,
         exists (select 1 from pg_index i where i.indrelid = con.conrelid and i.indisunique
                 and i.indnkeyatts = cardinality(con.conkey)
                 and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] @> con.conkey
                 and i.indpred is null) as one_to_one
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_class rc on rc.oid = con.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
  where con.contype = 'f' and n.nspname = 'public' and rn.nspname = 'public'
  order by c.relname, con.conname`)).rows

// Only functions callable through the API (granted to anon/authenticated).
const functions = (await client.query(`
  select p.proname as name, p.proretset as returns_set,
         pg_get_function_result(p.oid) as result,
         rt.typname as ret_udt, rt.typtype as ret_typtype, rt.typrelid <> 0 as ret_is_row,
         rt.typcategory as ret_category, (select e.typname from pg_type e where e.oid = rt.typelem) as ret_elem,
         coalesce(p.proargnames::text[], array[]::text[]) as arg_names, p.proargtypes::oid[] as arg_types, p.pronargdefaults as n_defaults,
         p.pronargs as n_args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type rt on rt.oid = p.prorettype
  where n.nspname = 'public' and p.prokind = 'f' and rt.typname <> 'trigger'
    and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
  order by p.proname`)).rows

const typeNames = new Map(
  (await client.query(`select oid, typname, typcategory, typelem from pg_type`)).rows.map((r) => [r.oid, r]),
)

function scalar(udt, category) {
  if (enumNames.has(udt)) return `Database["public"]["Enums"]["${udt}"]`
  switch (udt) {
    case 'int2': case 'int4': case 'int8': case 'float4': case 'float8': case 'numeric': return 'number'
    case 'bool': return 'boolean'
    case 'json': case 'jsonb': return 'Json'
    case 'void': return 'undefined'
    default: return category === 'N' ? 'number' : 'string'
  }
}

function tsType(col) {
  if (col.category === 'A') return `${scalar(col.elem_udt, typeNames.get(col.elem_udt)?.typcategory)}[]`
  return scalar(col.udt, col.category)
}

const tables = new Map()
for (const col of columns) {
  if (!tables.has(col.table)) tables.set(col.table, { kind: col.kind, columns: [] })
  tables.get(col.table).columns.push(col)
}

const ind = (n) => '  '.repeat(n)
const lines = []
const push = (s = '') => lines.push(s)

function relationships(table, depth) {
  const rels = fks.filter((f) => f.table === table)
  if (!rels.length) return `${ind(depth)}Relationships: []`
  const body = rels.map((f) => [
    `${ind(depth + 1)}{`,
    `${ind(depth + 2)}foreignKeyName: "${f.name}"`,
    `${ind(depth + 2)}columns: [${f.columns.map((c) => `"${c}"`).join(', ')}]`,
    `${ind(depth + 2)}isOneToOne: ${f.one_to_one}`,
    `${ind(depth + 2)}referencedRelation: "${f.ref_table}"`,
    `${ind(depth + 2)}referencedColumns: [${f.ref_columns.map((c) => `"${c}"`).join(', ')}]`,
    `${ind(depth + 1)}},`,
  ].join('\n')).join('\n')
  return `${ind(depth)}Relationships: [\n${body}\n${ind(depth)}]`
}

push('// Generated by scripts/gen-db-types.mjs from the migrated schema. Do not edit by hand.')
push('// Regenerate: DATABASE_URL=… npm run db:types  (or `supabase gen types typescript --local`)')
push()
push('export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]')
push()
push('export type Database = {')
push('  __InternalSupabase: { PostgrestVersion: "12.2.3" }')
push('  public: {')
push('    Tables: {')
for (const [name, t] of [...tables].filter(([, t]) => t.kind === 'r')) {
  push(`      ${name}: {`)
  push('        Row: {')
  for (const c of t.columns) push(`          ${c.column}: ${tsType(c)}${c.nullable ? ' | null' : ''}`)
  push('        }')
  for (const mode of ['Insert', 'Update']) {
    push(`        ${mode}: {`)
    for (const c of t.columns) {
      if (c.generated) { push(`          ${c.column}?: never`); continue }
      const optional = mode === 'Update' || c.nullable || c.has_default || c.identity
      push(`          ${c.column}${optional ? '?' : ''}: ${tsType(c)}${c.nullable ? ' | null' : ''}`)
    }
    push('        }')
  }
  push(relationships(name, 4))
  push('      }')
}
push('    }')
push('    Views: {')
for (const [name, t] of [...tables].filter(([, t]) => t.kind === 'v')) {
  push(`      ${name}: {`)
  push('        Row: {')
  for (const c of t.columns) push(`          ${c.column}: ${tsType(c)} | null`)
  push('        }')
  push('        Relationships: []')
  push('      }')
}
push('    }')
push('    Functions: {')
for (const f of functions) {
  push(`      ${f.name}: {`)
  const argTypes = f.arg_types.map((oid) => typeNames.get(oid))
  if (!f.n_args) {
    push('        Args: Record<PropertyKey, never>')
  } else {
    push('        Args: {')
    argTypes.forEach((t, i) => {
      const optional = i >= f.n_args - f.n_defaults
      const ts = t.typcategory === 'A'
        ? `${scalar(typeNames.get(t.typelem)?.typname, typeNames.get(t.typelem)?.typcategory)}[]`
        : scalar(t.typname, t.typcategory)
      push(`          ${f.arg_names[i]}${optional ? '?' : ''}: ${ts}`)
    })
    push('        }')
  }
  let ret
  if (f.ret_is_row) {
    const t = tables.get(f.ret_udt)
    ret = `{\n${t.columns.map((c) => `          ${c.column}: ${tsType(c)}${c.nullable ? ' | null' : ''}`).join('\n')}\n        }`
  } else {
    ret = f.ret_category === 'A' ? `${scalar(f.ret_elem, 'S')}[]` : scalar(f.ret_udt, f.ret_category)
  }
  push(`        Returns: ${ret}${f.returns_set ? '[]' : ''}`)
  push('      }')
}
push('    }')
push('    Enums: {')
for (const e of enums) push(`      ${e.name}: ${e.values.map((v) => `"${v}"`).join(' | ')}`)
push('    }')
push('    CompositeTypes: {')
push('      [_ in never]: never')
push('    }')
push('  }')
push('}')
push()
push(`type PublicSchema = Database["public"]

export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"]
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"]
export type Views<T extends keyof PublicSchema["Views"]> = PublicSchema["Views"][T]["Row"]
export type Enums<T extends keyof PublicSchema["Enums"]> = PublicSchema["Enums"][T]
export type FunctionArgs<T extends keyof PublicSchema["Functions"]> = PublicSchema["Functions"][T]["Args"]
export type FunctionReturns<T extends keyof PublicSchema["Functions"]> = PublicSchema["Functions"][T]["Returns"]

export const Constants = {
  public: {
    Enums: {
${enums.map((e) => `      ${e.name}: [${e.values.map((v) => `"${v}"`).join(', ')}],`).join('\n')}
    },
  },
} as const
`)

writeFileSync(out, lines.join('\n'))
await client.end()
console.log(`Wrote ${out} (${tables.size} tables/views, ${functions.length} functions, ${enums.length} enums)`)
