#!/usr/bin/env node
// Converts the Postgres schema (the supabase/migrations applied to a local database)
// into the SQLite schema of the Cloudflare database, plus the metadata the Worker's
// data layer needs (column kinds, defaults filled in by the server, keys for
// embedding, grants and row-security rules).
//
//   DATABASE_URL=postgres://… node scripts/pg-to-sqlite.mjs
//
// Writes worker/db/generated/schema.sql, meta.json and report.md. The report lists
// every rule that could not be written in SQLite and where it is enforced instead.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { conjuncts, NOW, quoteId, toCheckTree, toSqlite, Untranslatable, UUID } from './pg-sqlite/translate.mjs'

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/commerce_test'
const outDir = resolve(import.meta.dirname, '..', 'worker', 'db', 'generated')
const client = new pg.Client({ connectionString: url })
await client.connect()
const q = async (sql, params) => (await client.query(sql, params)).rows

// ---------------------------------------------------------------- catalog

const enums = Object.fromEntries((await q(`
  select t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as values
  from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' group by t.typname`)).map((r) => [r.name, r.values]))

const tables = (await q(`
  select c.oid, c.relname as name, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' order by c.relname`))

const columns = await q(`
  select c.relname as table, a.attname as name, a.attnum, t.typname as udt, t.typcategory as category,
         et.typname as elem_udt, a.atttypmod as typmod, a.attnotnull as notnull,
         pg_get_expr(d.adbin, d.adrelid) as default, a.attidentity as identity, a.attgenerated as generated,
         pg_get_serial_sequence(quote_ident(c.relname), a.attname) as serial_seq
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  order by c.relname, a.attnum`)

const constraints = await q(`
  select c.relname as table, con.conname as name, con.contype as type, pg_get_constraintdef(con.oid) as def,
         array(select a.attname::text from unnest(con.conkey) with ordinality k(n, o)
               join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o) as columns,
         rn.nspname as ref_schema, rc.relname as ref_table,
         array(select a.attname::text from unnest(con.confkey) with ordinality k(n, o)
               join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.o) as ref_columns,
         con.confdeltype as on_delete, con.confupdtype as on_update
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_class rc on rc.oid = con.confrelid
  left join pg_namespace rn on rn.oid = rc.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname, con.contype, con.conname`)

const indexes = await q(`
  select i.tablename as table, i.indexname as name, i.indexdef as def
  from pg_indexes i
  where i.schemaname = 'public'
    and not exists (select 1 from pg_constraint con where con.conname = i.indexname and con.connamespace = 'public'::regnamespace)
  order by i.tablename, i.indexname`)

const policies = await q(`
  select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd, qual, with_check
  from pg_policies where schemaname = 'public' order by tablename, policyname`)

const grants = await q(`
  select table_name as table, grantee, array_agg(lower(privilege_type) order by privilege_type) as privileges
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  group by 1, 2`)

const sequences = await q(`select sequencename as name, start_value::bigint as start, last_value::bigint as last from pg_sequences where schemaname = 'public' order by 1`)

const views = await q(`select viewname as name, definition from pg_views where schemaname = 'public' order by 1`)

const triggers = await q(`
  select c.relname as table, t.tgname as name, p.proname as function, t.tgtype as type,
         t.tgargs as rawargs,
         pg_get_triggerdef(t.oid) as def
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
  where n.nspname = 'public' and not t.tgisinternal order by c.relname, t.tgname`)
for (const tg of triggers) tg.args = tg.rawargs.toString('utf8').split('\0').filter(Boolean)

// Tables a store reset may empty although their rows are otherwise permanent (public._store_reset_tables()).
const resetTables = (await q(`select public._store_reset_tables() as t`))[0].t

// The functions PostgREST exposed as /rpc/<name> (grants say who may call them; the service role may call all).
const rpcFunctions = await q(`
  select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proretset as set,
         p.provolatile as volatility, pg_get_function_result(p.oid) as returns, p.pronargdefaults as defaults,
         coalesce(p.proargnames, '{}') as argnames, coalesce(p.proargmodes::text[], '{}') as argmodes,
         array(select format_type(t, null) from unnest(p.proargtypes) t) as argtypes,
         has_function_privilege('anon', p.oid, 'execute') as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  order by p.proname`)

// Every function's source, for the PL/pgSQL interpreter (worker/db/pg): the business
// logic runs as written in the migrations.
const allFunctions = await q(`
  select p.proname as name, l.lanname as lang, p.prosrc as src, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner,
         p.proretset as set, p.provolatile as volatility, format_type(p.prorettype, null) as returns,
         coalesce(p.proargnames, '{}') as argnames, coalesce(p.proargmodes::text[], '{}') as argmodes,
         array(select format_type(t, null) from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) t) as argtypes,
         pg_get_expr(p.proargdefaults, 0) as defaults, coalesce(p.proconfig, '{}') as config,
         has_function_privilege('anon', p.oid, 'execute') as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.prokind = 'f' and l.lanname in ('plpgsql', 'sql')
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  order by p.proname, p.oid`)

const sqlFunctions = new Set((await q(`
  select distinct p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).map((r) => r.name))

// ---------------------------------------------------------------- conversion

const report = { checks: [], policies: [], indexes: [], views: [], defaults: [], triggers: [] }
const meta = { version: 1, tables: {}, enums, sequences: {}, views: {}, functions: {} }
const ddl = []

/** The SQLite storage kind of a Postgres column. */
function kindOf(col) {
  if (col.category === 'A') {
    const e = kindOf({ udt: col.elem_udt, category: enums[col.elem_udt] ? 'E' : '' })
    return { kind: 'array', elem: e.kind, ...(e.enum ? { enum: e.enum } : {}) }
  }
  if (enums[col.udt]) return { kind: 'enum', values: enums[col.udt], enum: col.udt }
  switch (col.udt) {
    case 'uuid': return { kind: 'uuid' }
    case 'text': case 'varchar': case 'bpchar': case 'citext': case 'name': case 'inet': return { kind: 'text' }
    case 'int2': case 'int4': return { kind: 'int' }
    case 'int8': return { kind: 'int', big: true }
    case 'numeric': {
      const scale = col.typmod > 0 ? (col.typmod - 4) & 0xffff : undefined
      return scale === undefined ? { kind: 'numeric' } : { kind: 'numeric', scale }
    }
    case 'float4': case 'float8': return { kind: 'numeric' }
    case 'bool': return { kind: 'bool' }
    case 'json': case 'jsonb': return { kind: 'json' }
    case 'timestamptz': case 'timestamp': return { kind: 'timestamptz' }
    case 'date': return { kind: 'date' }
    case 'time': case 'timetz': return { kind: 'time' }
    case 'bytea': return { kind: 'bytes' }
    default: throw new Error(`unknown column type ${col.udt} (${col.table}.${col.name})`)
  }
}

const STORAGE = { uuid: 'TEXT', text: 'TEXT', int: 'INTEGER', numeric: 'REAL', bool: 'INTEGER', json: 'TEXT', array: 'TEXT', enum: 'TEXT',
  timestamptz: 'TEXT', date: 'TEXT', time: 'TEXT', bytes: 'BLOB' }

const sqlString = (v) => `'${String(v).replaceAll("'", "''")}'`

/** Type-level checks that Postgres enforces by the column type itself. */
function typeCheck(name, k) {
  const c = quoteId(name)
  switch (k.kind) {
    case 'uuid': return `length(${c}) = 36`
    case 'bool': return `${c} IN (0, 1)`
    case 'json': return `json_valid(${c})`
    case 'array': return `json_type(${c}) = 'array'`
    case 'enum': return `${c} IN (${k.values.map(sqlString).join(', ')})`
    // Canonical forms only (a Durable Object allows LIKE/GLOB patterns of at most 50 bytes).
    case 'timestamptz': return `strftime('%Y-%m-%dT%H:%M:%fZ', ${c}) = ${c}`
    case 'date': return `date(${c}) = ${c}`
    case 'time': return `time(${c}) = ${c}`
    default: return null
  }
}

/** A column default: SQL that SQLite runs, or a value the data layer fills in. */
function convertDefault(col, k, table) {
  const d = col.default
  if (d == null) return {}
  const seq = /nextval\('([a-z_0-9]+)'::regclass\)/.exec(d)
  if (seq) {
    const prefix = /^\('([^']*)'::text \|\| /.exec(d)?.[1]
    const pad = /lpad\(.*, (\d+), '0'::text\)/.exec(d)?.[1]
    return { fill: { seq: seq[1], ...(prefix ? { prefix } : {}), ...(pad ? { pad: Number(pad) } : {}) } }
  }
  if (/^current_merchant_id\(\)$/.test(d)) return { fill: { ctx: 'merchant' } }
  if (/^auth\.uid\(\)$/.test(d)) return { fill: { ctx: 'uid' } }
  if (k.kind === 'bool') return { sql: d === 'true' ? '1' : d === 'false' ? '0' : fail() }
  try {
    const sql = toSqlite(d, { functions: new Set() })
    return { sql: /^[-0-9.]+$|^'.*'$/s.test(sql) ? sql : `(${sql})` }
  } catch (e) {
    if (!(e instanceof Untranslatable)) throw e
    report.defaults.push(`${table}.${col.name}: ${d} (${e.message}) — filled in by the data layer`)
    return { fill: { expr: d } }
  }
  function fail() { throw new Error(`odd default ${d}`) }
}

const ON_DELETE = { a: '', r: ' ON DELETE RESTRICT', c: ' ON DELETE CASCADE', n: ' ON DELETE SET NULL', d: ' ON DELETE SET DEFAULT' }
const ON_UPDATE = { a: '', r: ' ON UPDATE RESTRICT', c: ' ON UPDATE CASCADE', n: ' ON UPDATE SET NULL', d: ' ON UPDATE SET DEFAULT' }

for (const t of tables) {
  const cols = columns.filter((c) => c.table === t.name)
  const cons = constraints.filter((c) => c.table === t.name)
  const pk = cons.find((c) => c.type === 'p')?.columns ?? []
  const tmeta = { columns: {}, pk, unique: [], fks: [], grants: {}, rls: t.rls, policies: [], checks: [] }
  const pkName = cons.find((c) => c.type === 'p')?.name
  if (pkName) tmeta.uniqueNames = { [pk.join(',')]: pkName }
  const lines = []

  for (const col of cols) {
    const k = kindOf(col)
    const cm = { type: k.kind }
    if (k.elem) cm.elem = k.elem
    if (k.values) cm.values = k.values
    if (k.enum) cm.enum = k.enum
    if (col.udt === 'timestamp') cm.local = true
    if (k.scale !== undefined) cm.scale = k.scale
    if (k.big) cm.big = true
    if (!col.notnull) cm.nullable = true
    let line = `${quoteId(col.name)} ${STORAGE[k.kind]}`
    const autoPk = col.identity && pk.length === 1 && pk[0] === col.name && k.kind === 'int'
    if (autoPk) {
      line += ' PRIMARY KEY AUTOINCREMENT'
      cm.identity = true
    } else if (col.identity) {
      cm.fill = { seq: col.serial_seq.replace(/^public\./, '') }
    }
    if (col.generated) {
      cm.generated = true
      line += ` GENERATED ALWAYS AS (${toSqlite(col.default)}) STORED`
    } else if (!autoPk) {
      const def = convertDefault(col, k, t.name)
      if (def.sql) { line += ` DEFAULT ${def.sql}`; cm.default = def.sql }
      if (def.fill) cm.fill = def.fill
    }
    if (col.notnull && !autoPk) line += ' NOT NULL'
    const tc = typeCheck(col.name, k)
    if (tc && !col.generated) line += ` CHECK (${col.notnull ? tc : `${quoteId(col.name)} IS NULL OR ${tc}`})`
    lines.push(line)
    tmeta.columns[col.name] = cm
  }

  const hasAutoPk = Object.values(tmeta.columns).some((c) => c.identity)
  if (pk.length && !hasAutoPk) lines.push(`PRIMARY KEY (${pk.map(quoteId).join(', ')})`)

  for (const con of cons) {
    if (con.type === 'u') {
      if (/NULLS NOT DISTINCT/.test(con.def)) report.indexes.push(`${t.name}.${con.name}: NULLS NOT DISTINCT is not available; checked as a plain unique key`)
      lines.push(`CONSTRAINT ${quoteId(con.name)} UNIQUE (${con.columns.map(quoteId).join(', ')})`)
      tmeta.unique.push(con.columns)
      ;(tmeta.uniqueNames ??= {})[con.columns.join(',')] = con.name
    } else if (con.type === 'f') {
      const ref = con.ref_schema === 'auth' && con.ref_table === 'users' ? 'users' : con.ref_table
      if (con.ref_schema !== 'public' && ref !== 'users') throw new Error(`foreign key to ${con.ref_schema}.${con.ref_table}`)
      lines.push(`CONSTRAINT ${quoteId(con.name)} FOREIGN KEY (${con.columns.map(quoteId).join(', ')}) REFERENCES ${quoteId(ref)} (${con.ref_columns.map(quoteId).join(', ')})${ON_DELETE[con.on_delete]}${ON_UPDATE[con.on_update]}${/DEFERRABLE/.test(con.def) ? ' DEFERRABLE INITIALLY DEFERRED' : ''}`)
      tmeta.fks.push({ name: con.name, columns: con.columns, table: ref, refColumns: con.ref_columns })
    } else if (con.type === 'c') {
      const expr = /^CHECK \((.*)\)( NOT VALID)?$/s.exec(con.def)[1]
      const sqlParts = []
      for (const part of conjuncts(expr)) {
        try {
          sqlParts.push(toSqlite(part))
        } catch (e) {
          if (!(e instanceof Untranslatable)) throw e
          try {
            tmeta.checks.push({ name: con.name, tree: toCheckTree(part) })
            report.checks.push(`${t.name}.${con.name}: ${part} — checked by the data layer (${e.message})`)
          } catch (e2) {
            if (!(e2 instanceof Untranslatable)) throw e2
            tmeta.checks.push({ name: con.name, manual: part })
            report.checks.push(`${t.name}.${con.name}: ${part} — NEEDS A HAND-WRITTEN CHECK (${e2.message})`)
          }
        }
      }
      if (sqlParts.length) lines.push(`CONSTRAINT ${quoteId(con.name)} CHECK (${sqlParts.join(' AND ')})`)
    } else if (con.type === 'x') {
      report.checks.push(`${t.name}.${con.name}: exclusion constraint ${con.def} — NEEDS A HAND-WRITTEN CHECK`)
      tmeta.checks.push({ name: con.name, manual: con.def })
    }
  }

  for (const g of grants.filter((g) => g.table === t.name)) tmeta.grants[g.grantee] = g.privileges

  for (const p of policies.filter((p) => p.table === t.name)) {
    const pm = { name: p.name, cmd: p.cmd, permissive: p.permissive === 'PERMISSIVE', roles: p.roles }
    for (const [key, expr] of [['using', p.qual], ['check', p.with_check]]) {
      if (expr == null) continue
      try {
        pm[key] = toSqlite(expr, { context: true, functions: new Set() })
      } catch (e) {
        if (!(e instanceof Untranslatable)) throw e
        pm[`${key}Pg`] = expr
        pm.untranslated = true
        report.policies.push(`${t.name}.${p.name} (${p.cmd} ${key}): ${expr} — ${e.message}; access is refused until it is hand-written`)
      }
    }
    tmeta.policies.push(pm)
  }

  ddl.push(`CREATE TABLE ${quoteId(t.name)} (\n  ${lines.join(',\n  ')}\n) STRICT;`)

  // Triggers: the generic ones become SQLite triggers (they hold for every write, also
  // from hand-written SQL); business triggers are listed for the data layer, which
  // refuses writes to the table until each one has its TypeScript port.
  for (const tg of triggers.filter((x) => x.table === t.name)) {
    const T = quoteId(t.name)
    if (tg.function === 'set_updated_at') {
      ddl.push(`CREATE TRIGGER ${quoteId(`${t.name}_updated_at`)} AFTER UPDATE ON ${T} FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at\nBEGIN UPDATE ${T} SET updated_at = ${NOW} WHERE rowid = NEW.rowid; END;`)
      tmeta.updatedAt = true
    } else if (tg.function === 'prevent_mutation') {
      const erasable = t.name === 'shipment_events' ? ` WHEN NOT EXISTS (SELECT 1 FROM _flags WHERE name = 'erasure' AND value = NEW.merchant_id)` : ''
      const resettable = resetTables.includes(t.name) ? ` WHEN NOT EXISTS (SELECT 1 FROM _flags WHERE name = 'store_reset' AND value = OLD.merchant_id)` : ''
      ddl.push(`CREATE TRIGGER ${quoteId(`${t.name}_no_update`)} BEFORE UPDATE ON ${T} FOR EACH ROW${erasable}\nBEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RECORD: ${t.name} rows cannot be updated; record a correcting entry instead'); END;`)
      ddl.push(`CREATE TRIGGER ${quoteId(`${t.name}_no_delete`)} BEFORE DELETE ON ${T} FOR EACH ROW${resettable}\nBEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RECORD: ${t.name} rows cannot be deleted; record a correcting entry instead'); END;`)
      tmeta.immutable = true
    } else if (tg.function === 'audit_row_change') {
      tmeta.audit = { key: tg.args[0] || 'id', events: triggerEvents(tg.type) }
    } else {
      ;(tmeta.triggers ??= []).push({ name: tg.name, function: tg.function, timing: tg.type & 2 ? 'BEFORE' : tg.type & 64 ? 'INSTEAD' : 'AFTER',
        events: triggerEvents(tg.type), row: Boolean(tg.type & 1), args: tg.args,
        ...(/ WHEN \((.*)\) EXECUTE/s.exec(tg.def) ? { when: / WHEN \((.*)\) EXECUTE/s.exec(tg.def)[1] } : {}),
        ...(/ UPDATE OF ([\w, ]+) ON/.exec(tg.def) ? { columns: / UPDATE OF ([\w, ]+) ON/.exec(tg.def)[1].split(', ') } : {}) })
      report.triggers.push(`${t.name}.${tg.name}: ${tg.function}()`)
    }
  }
  meta.tables[t.name] = tmeta
}

// Indexes (GIN trigram and array indexes have no SQLite equivalent; searches scan instead).
for (const ix of indexes) {
  const m = /^CREATE (UNIQUE )?INDEX (\S+) ON public\.(\S+) USING (\w+) \((.*?)\)(?: INCLUDE \(.*?\))?(?: NULLS NOT DISTINCT)?(?: WHERE (.*))?$/s.exec(ix.def)
  if (!m) throw new Error(`cannot read index ${ix.def}`)
  const [, unique, name, table, method, cols, where] = m
  if (method !== 'btree') {
    report.indexes.push(`${table}.${name}: ${method} index skipped (${cols})`)
    continue
  }
  try {
    const parts = splitCols(cols).map((c) => toSqlite(c.replace(/ NULLS (FIRST|LAST)$/, '')))
    const pred = where ? ` WHERE ${toSqlite(where)}` : ''
    ddl.push(`CREATE ${unique ?? ''}INDEX ${quoteId(name)} ON ${quoteId(table)} (${parts.join(', ')})${pred};`)
    if (unique && !where) meta.tables[table].unique.push(splitCols(cols).map((c) => c.replace(/"/g, '')))
    if (unique) (meta.tables[table].uniqueNames ??= {})[splitCols(cols).map((c) => c.replace(/"/g, '')).join(',')] = name
    if (unique && where) (meta.tables[table].partialUnique ??= []).push({ columns: splitCols(cols), where: toSqlite(where) })
  } catch (e) {
    if (!(e instanceof Untranslatable)) throw e
    report.indexes.push(`${table}.${name}: ${ix.def} — ${e.message}${unique ? ' — UNIQUE RULE NEEDS A HAND-WRITTEN CHECK' : ''}`)
  }
}

function triggerEvents(type) {
  return [type & 4 && 'INSERT', type & 8 && 'DELETE', type & 16 && 'UPDATE', type & 32 && 'TRUNCATE'].filter(Boolean)
}

function splitCols(s) {
  const out = ['']
  let depth = 0
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) out.push('')
    else out[out.length - 1] += ch
  }
  return out.map((x) => x.trim())
}

// Views (all security_invoker in Postgres) are not stored in SQLite: the data layer
// inlines their query after the row-security filters, so they see only what the
// caller may see. Definitions that do not translate are written by hand.
for (const v of views) {
  const columnsOf = (await q(`select a.attname as name, t.typname as udt, t.typcategory as category, et.typname as elem_udt, a.atttypmod as typmod
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace join pg_type t on t.oid = a.atttypid
    left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
    where n.nspname = 'public' and c.relname = $1 and a.attnum > 0 order by a.attnum`, [v.name]))
  const vmeta = { columns: Object.fromEntries(columnsOf.map((c) => {
    const k = kindOf({ ...c, table: v.name })
    return [c.name, { type: k.kind, ...(k.scale !== undefined ? { scale: k.scale } : {}), ...(k.big ? { big: true } : {}), ...(k.elem ? { elem: k.elem } : {}), ...(k.enum ? { enum: k.enum } : {}), nullable: true }]
  })) }
  try {
    vmeta.sql = toSqlite(v.definition.trim().replace(/;$/, ''), { functions: new Set() })
    // Check it compiles once the tables exist (done by the loader test).
  } catch (e) {
    if (!(e instanceof Untranslatable)) throw e
    vmeta.pg = v.definition.trim()
    report.views.push(`${v.name}: ${e.message}`)
  }
  for (const g of grants.filter((g) => g.table === v.name)) (vmeta.grants ??= {})[g.grantee] = g.privileges
  meta.views[v.name] = vmeta
}

for (const s of sequences) meta.sequences[s.name] = { start: Number(s.start) }

meta.functions = {}
for (const f of rpcFunctions) {
  const inNames = f.argnames.filter((_, i) => !f.argmodes.length || ['i', 'b', 'v'].includes(f.argmodes[i]))
  const args = f.argtypes.map((type, i) => ({ name: inNames[i] ?? `$${i + 1}`, type, optional: i >= f.argtypes.length - f.defaults }))
  meta.functions[f.name] = {
    args, returns: f.returns, set: f.set, definer: f.definer, owner: f.owner, volatile: f.volatility === 'v',
    grants: [f.anon && 'anon', f.authenticated && 'authenticated'].filter(Boolean),
  }
}

// ---------------------------------------------------------------- output

const header = `-- Generated by scripts/pg-to-sqlite.mjs from supabase/migrations. Do not edit by hand.
-- Kinds: uuid/text/enum/timestamptz(ISO 8601 UTC, ms, Z)/date/time/json/array → TEXT,
-- bool/int → INTEGER, numeric → REAL rounded to the column's scale on write.
PRAGMA foreign_keys = ON;

-- Sign-in accounts (Supabase's auth.users). The id stays the same uuid; Clerk is linked by clerk_user_id.
CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  email TEXT COLLATE NOCASE UNIQUE,
  phone TEXT,
  clerk_user_id TEXT UNIQUE,
  user_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(user_metadata)),
  app_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(app_metadata)),
  email_confirmed_at TEXT,
  banned_until TEXT,
  last_sign_in_at TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW})
) STRICT;

-- Switches a store reset or an approved data erasure turns on inside its own transaction,
-- so the permanent-record triggers let that one operation through.
CREATE TABLE _flags (name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (name, value)) STRICT;

-- Supabase Vault's secrets (courier, payment and platform credentials). Only database
-- functions read them; the REST API never serves internal tables.
CREATE TABLE _vault_secrets (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  name TEXT UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW})
) STRICT;

-- Counters that replace Postgres sequences (order numbers, invoice numbers, …).
CREATE TABLE _sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
INSERT INTO _sequences (name, value) VALUES
  ${sequences.map((s) => `(${sqlString(s.name)}, ${Number(s.start) - 1})`).join(',\n  ')};
`
// SQLite rejects a default it cannot run; make sure the uuid one is referenced as written.
void UUID

mkdirSync(outDir, { recursive: true })
const schemaSql = `${header}\n${ddl.join('\n\n')}\n`
writeFileSync(resolve(outDir, 'schema.sql'), schemaSql)
// The same SQL as a module of single statements, for the Worker bundle and the tests
// (a Durable Object runs one statement of at most 100 KB at a time).
const headerStatements = header.split(/;\n/).map((x) => x.replace(/^(\s*--[^\n]*\n)+/g, '').trim()).filter(Boolean).map((x) => `${x};`)
const statements = [...headerStatements, ...ddl]
for (const st of statements) if (st.length > 90_000) throw new Error(`statement over 90 KB: ${st.slice(0, 80)}`)
writeFileSync(resolve(outDir, 'schema.ts'), `// Generated by scripts/pg-to-sqlite.mjs (see schema.sql). Do not edit by hand.\nexport default ${JSON.stringify(statements, null, 0)}\n`)
meta.tables.users = {
  columns: {
    id: { type: 'uuid' }, email: { type: 'text', nullable: true }, phone: { type: 'text', nullable: true }, clerk_user_id: { type: 'text', nullable: true },
    user_metadata: { type: 'json', default: "'{}'" }, app_metadata: { type: 'json', default: "'{}'" },
    email_confirmed_at: { type: 'timestamptz', nullable: true }, banned_until: { type: 'timestamptz', nullable: true },
    last_sign_in_at: { type: 'timestamptz', nullable: true }, created_at: { type: 'timestamptz', default: `(${NOW})` }, updated_at: { type: 'timestamptz', default: `(${NOW})` },
  },
  pk: ['id'], unique: [['email'], ['clerk_user_id']], fks: [], grants: {}, rls: true, policies: [], checks: [],
}
writeFileSync(resolve(outDir, 'meta.json'), `${JSON.stringify(meta)}\n`)

// name → overloads: { lang, src, args [{ name, type, mode i/o/b/v/t, default? }], returns, set, definer, owner, volatility, config, grants }
const functionSources = {}
for (const f of allFunctions) {
  const modes = f.argmodes.length ? f.argmodes : f.argtypes.map(() => 'i')
  const args = f.argtypes.map((type, i) => ({ name: f.argnames[i] || null, type, mode: modes[i] }))
  ;(functionSources[f.name] ??= []).push({
    lang: f.lang, src: f.src, args, defaults: f.defaults ?? undefined, returns: f.returns, set: f.set, definer: f.definer, owner: f.owner,
    volatility: f.volatility, config: f.config, grants: [f.anon && 'anon', f.authenticated && 'authenticated'].filter(Boolean),
  })
}
writeFileSync(resolve(outDir, 'functions.json'), `${JSON.stringify(functionSources)}\n`)

const section = (title, items) => `## ${title} (${items.length})\n\n${items.map((i) => `- ${i}`).join('\n') || '- none'}\n`
writeFileSync(resolve(outDir, 'report.md'), `# Schema conversion report\n\nGenerated by scripts/pg-to-sqlite.mjs. ${tables.length} tables, ${indexes.length} indexes, ${policies.length} row-security rules, ${views.length} views.\n\n${[
  section('Checks enforced by the data layer instead of SQLite', report.checks),
  section('Row-security rules to hand-write', report.policies),
  section('Indexes not carried over', report.indexes),
  section('Views to hand-write', report.views),
  section('Defaults filled in by the data layer', report.defaults),
  section('Business triggers ported to TypeScript (writes to these tables are refused until ported)', report.triggers),
].join('\n')}`)

await client.end()
console.log(`tables ${tables.length}, checks moved ${report.checks.length}, rules to hand-write ${report.policies.length}, indexes skipped ${report.indexes.length}, views to hand-write ${report.views.length}`)
