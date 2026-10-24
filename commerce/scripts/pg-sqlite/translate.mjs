// Translates PostgreSQL expressions (as printed by pg_get_expr / pg_get_constraintdef /
// pg_policies) into SQLite, for the schema converter (scripts/pg-to-sqlite.mjs).
//
// The input is Postgres' own normalised output, so only the forms Postgres prints
// need handling. Anything without a safe SQLite equivalent (regular expressions,
// unknown functions) throws Untranslatable; the caller then keeps that rule in
// application code instead of silently dropping it.

export class Untranslatable extends Error {}

// ---------------------------------------------------------------- tokens

const OPS = ['::', '!~~*', '~~*', '!~~', '~~', '!~*', '~*', '!~', '<>', '!=', '<=', '>=', '||', '->>', '->', '#>>', '#>', '@>', '<@', '?|', '?&',
  '=', '<', '>', '+', '-', '*', '/', '%', '~', '?']

export function tokenize(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === "'") {
      let v = ''
      i++
      for (;;) {
        if (i >= src.length) throw new Error(`unterminated string in ${src}`)
        if (src[i] === "'") {
          if (src[i + 1] === "'") { v += "'"; i += 2; continue }
          i++
          break
        }
        v += src[i++]
      }
      out.push({ t: 'str', v })
      continue
    }
    if (c === '$' && /[0-9]/.test(src[i + 1] ?? '')) {
      const m = /^\$([0-9]+)/.exec(src.slice(i))
      out.push({ t: 'param', v: Number(m[1]) })
      i += m[0].length
      continue
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1)
      out.push({ t: 'id', v: src.slice(i + 1, j), quoted: true })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(src.slice(i))
      out.push({ t: 'num', v: m[0] })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(src.slice(i))
      out.push({ t: 'id', v: m[0].toLowerCase() })
      i += m[0].length
      continue
    }
    if ('(),[].;'.includes(c)) { out.push({ t: c }); i++; continue }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new Error(`unexpected character ${c} in ${src}`)
    out.push({ t: 'op', v: op })
    i += op.length
  }
  return out
}

const KEYWORDS = new Set(['and', 'or', 'not', 'is', 'null', 'true', 'false', 'in', 'between', 'like', 'ilike', 'case', 'when', 'then',
  'else', 'end', 'select', 'from', 'where', 'as', 'exists', 'distinct', 'any', 'all', 'array', 'join', 'left', 'inner', 'on', 'group',
  'by', 'order', 'having', 'limit', 'asc', 'desc', 'nulls', 'last', 'first', 'union', 'with', 'using', 'cross', 'lateral', 'filter',
  'over', 'partition', 'offset', 'collate', 'escape', 'interval'])

// SQLite's reserved words: a column with one of these names is quoted.
export const SQLITE_KEYWORDS = new Set(`abort action add after all alter always analyze and as asc attach autoincrement before begin between
  by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp
  database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain
  fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially
  inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null
  nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp
  reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to
  transaction trigger unbounded union unique update using vacuum values view virtual when where window with without`.split(/\s+/))

export const quoteId = (name) => (SQLITE_KEYWORDS.has(name) || !/^[a-z_][a-z0-9_]*$/.test(name) ? `"${name.replaceAll('"', '""')}"` : name)

const sqlString = (v) => `'${String(v).replaceAll("'", "''")}'`

/** Back to text. Column names that are SQLite reserved words are quoted. */
export function render(tokens, opts = {}) {
  let s = ''
  let prev = null
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k]
    let piece
    switch (tk.t) {
      case 'str': piece = sqlString(tk.v); break
      case 'num': piece = tk.v; break
      case 'raw': piece = tk.v; break
      case 'param': piece = `?${tk.v}`; break
      case 'id': {
        const call = tokens[k + 1]?.t === '('
        // Hand-written SQL (opts.bare) keeps names as written; Postgres' own output quotes what it must.
        piece = tk.quoted ? quoteId(tk.v) : !opts.bare && !KEYWORDS.has(tk.v) && !call ? quoteId(tk.v) : tk.v
        break
      }
      case 'op': piece = tk.v; break
      default: piece = tk.t
    }
    const tight = prev && (prev.t === '(' || prev.t === '.' || tk.t === ')' || tk.t === ',' || tk.t === '.' || tk.t === ']' || prev.t === '[' ||
      (tk.t === '(' && prev.t === 'id' && !KEYWORDS.has(prev.v)) || (tk.t === '[' && prev.t !== 'op'))
    s += (prev && !tight ? ' ' : '') + piece
    prev = tk
  }
  return s
}

/** Index of the bracket matching the one at `open` (either direction). */
export function match(tokens, open) {
  const pairs = { '(': ')', '[': ']' }
  const back = { ')': '(', ']': '[' }
  const t = tokens[open].t
  if (pairs[t]) {
    let depth = 0
    for (let i = open; i < tokens.length; i++) {
      if (tokens[i].t === t) depth++
      else if (tokens[i].t === pairs[t] && --depth === 0) return i
    }
  } else if (back[t]) {
    let depth = 0
    for (let i = open; i >= 0; i--) {
      if (tokens[i].t === t) depth++
      else if (tokens[i].t === back[t] && --depth === 0) return i
    }
  }
  throw new Error('unbalanced brackets')
}

/** Start index of the operand that ends at `end` (a literal, a name, a call or a bracketed group). */
export function operandStart(tokens, end) {
  const tk = tokens[end]
  if (tk.t === ')' || tk.t === ']') {
    let start = match(tokens, end)
    // a call: name(…), schema.name(…), or array[...]
    if (start > 0 && tokens[start - 1].t === 'id' && !['and', 'or', 'not', 'in', 'exists', 'when', 'then', 'else', 'is', 'select', 'where', 'on', 'any', 'all'].includes(tokens[start - 1].v)) {
      start--
      while (start >= 2 && tokens[start - 1].t === '.' && tokens[start - 2].t === 'id') start -= 2
    }
    return start
  }
  let start = end
  while (start >= 2 && tokens[start - 1].t === '.' && tokens[start - 2].t === 'id') start -= 2
  return start
}

// ---------------------------------------------------------------- types

const TYPE_WORDS = new Set(['character', 'varying', 'double', 'precision', 'timestamp', 'with', 'without', 'time', 'zone'])

/** Reads a type name after '::' starting at i. Returns { name, array, end }. */
export function readType(tokens, i) {
  const words = []
  let j = i
  // schema-qualified (public.order_status)
  if (tokens[j]?.t === 'id' && tokens[j + 1]?.t === '.' && tokens[j + 2]?.t === 'id') j += 2
  words.push(tokens[j].v)
  j++
  while (tokens[j]?.t === 'id' && TYPE_WORDS.has(tokens[j].v) && TYPE_WORDS.has(words[words.length - 1])) { words.push(tokens[j].v); j++ }
  if (tokens[j]?.t === '(') j = match(tokens, j) + 1 // varchar(20), numeric(12,2)
  let array = false
  while (tokens[j]?.t === '[' && tokens[j + 1]?.t === ']') { array = true; j += 2 }
  return { name: words.join(' '), array, end: j }
}

const NUMERIC_TYPES = new Set(['numeric', 'double precision', 'real', 'float8', 'float4', 'decimal'])
const INT_TYPES = new Set(['integer', 'bigint', 'smallint', 'int', 'int4', 'int8', 'int2'])

/** '{a,b}' (Postgres array text) → JSON text. */
export function pgArrayToJson(text, elemType) {
  const inner = text.trim().replace(/^\{|\}$/g, '')
  if (inner === '') return '[]'
  const items = []
  let cur = ''
  let quoted = false
  let wasQuoted = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quoted) {
      if (c === '\\') { cur += inner[++i]; continue }
      if (c === '"') { quoted = false; continue }
      cur += c
    } else if (c === '"') { quoted = true; wasQuoted = true } else if (c === ',') {
      items.push({ v: cur, q: wasQuoted }); cur = ''; wasQuoted = false
    } else cur += c
  }
  items.push({ v: cur, q: wasQuoted })
  const num = INT_TYPES.has(elemType) || NUMERIC_TYPES.has(elemType)
  return JSON.stringify(items.map(({ v, q }) => (!q && v.toUpperCase() === 'NULL' ? null : num ? Number(v) : v)))
}

/** '72:00:00', '7 days', '1 mon' → SQLite date modifiers. */
export function intervalModifiers(text, sign = '+') {
  const mods = []
  let rest = text.trim()
  const hms = /(-)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(rest)
  if (hms) {
    const secs = (Number(hms[2]) * 3600 + Number(hms[3]) * 60 + Number(hms[4])) * (hms[1] ? -1 : 1)
    if (secs) mods.push(`${secs < 0 !== (sign === '-') ? '-' : '+'}${Math.abs(secs)} seconds`)
    rest = rest.slice(0, hms.index).trim()
  }
  const units = { year: 'years', years: 'years', mon: 'months', mons: 'months', month: 'months', months: 'months', day: 'days', days: 'days',
    hour: 'hours', hours: 'hours', minute: 'minutes', minutes: 'minutes', min: 'minutes', mins: 'minutes', second: 'seconds', seconds: 'seconds',
    sec: 'seconds', secs: 'seconds', week: 'weeks', weeks: 'weeks' }
  for (const m of rest.matchAll(/(-?\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    let unit = units[m[2]]
    if (!unit) throw new Untranslatable(`interval unit ${m[2]}`)
    let n = Number(m[1]) * (sign === '-' ? -1 : 1)
    if (unit === 'weeks') { unit = 'days'; n *= 7 }
    mods.push(`${n < 0 ? '-' : '+'}${Math.abs(n)} ${unit}`)
  }
  return mods
}

export const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
export const UUID = "lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',1+(abs(random())%4),1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))"

const raw = (v) => ({ t: 'raw', v })

// ---------------------------------------------------------------- translation

/** public._can_read_catalog(): any of these permissions (worker/db/snapshot.test.ts checks it against the migrations). */
export const CATALOG_READ_PERMISSIONS = ['products.view', 'inventory.view', 'purchases.view', 'production.view', 'finance.view', 'marketing.view']

/**
 * Context functions used by row-security rules. They depend only on who is asking,
 * so they become placeholders that the runtime fills in for each request.
 */
const CONTEXT = {
  'current_merchant_id': () => '{{merchant}}',
  'auth.uid': () => '{{uid}}',
  'is_staff': () => '{{is_staff}}',
  'is_platform_staff': () => '{{is_platform_staff}}',
  '_support_read_only': () => '{{support_read_only}}',
  'current_role_code': () => '{{role_code}}',
  'is_system_context': () => '{{is_system}}',
  '_can_read_catalog': () => CATALOG_READ_PERMISSIONS.map((p) => `{{perm:${p}}}`).join(' OR ').replace(/^(.*)$/, '($1)'),
  'has_permission': (args) => {
    if (args.length !== 1 || args[0].t !== 'str') throw new Untranslatable('has_permission with a non-literal code')
    if (!/^[a-z_]+\.[a-z_]+$/.test(args[0].v)) throw new Untranslatable(`odd permission code ${args[0].v}`)
    return `{{perm:${args[0].v}}}`
  },
}

const RENAME = {
  char_length: 'length', character_length: 'length', btrim: 'trim', jsonb_typeof: 'json_type', json_typeof: 'json_type',
  jsonb_array_length: 'json_array_length', cardinality: 'json_array_length', jsonb_extract_path_text: 'json_extract',
  jsonb_agg: 'json_group_array', json_agg: 'json_group_array', array_agg: 'json_group_array', jsonb_object_agg: 'json_group_object',
  json_object_agg: 'json_group_object', string_agg: 'group_concat', bool_or: 'max', bool_and: 'min',
}
const SAME = new Set(['length', 'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'coalesce', 'nullif', 'abs', 'round', 'replace', 'substr',
  'substring', 'json_array_length', 'json_type', 'max', 'min', 'sum', 'count', 'avg', 'strftime', 'date', 'datetime', 'json_extract',
  'json_each', 'json_valid', 'hex', 'randomblob', 'random', 'instr', 'iif', 'json_group_array', 'json_object', 'json_array', 'total',
  'json_group_object', 'group_concat', 'json_set', 'json_patch', 'json', 'ifnull', 'typeof', 'printf', 'json_remove', 'julianday', 'unixepoch'])

/**
 * Rewrites a token list in place (recursively for brackets) and returns the new list.
 * opts.context: allow context placeholders (row-security rules).
 */
export function rewrite(tokens, opts) {
  let out = [...tokens]

  // 1. ( SELECT f(args) AS alias ) → f(args)   (Postgres' "initplan" wrapping)
  for (let i = 0; i < out.length; i++) {
    if (out[i].t === '(' && out[i + 1]?.t === 'id' && out[i + 1].v === 'select') {
      const close = match(out, i)
      const inner = out.slice(i + 2, close)
      const asAt = inner.findIndex((t) => t.t === 'id' && t.v === 'as')
      if (asAt > 0 && asAt === inner.length - 2 && inner[asAt - 1].t === ')' && !inner.some((t) => t.t === 'id' && t.v === 'from')) {
        out.splice(i, close - i + 1, ...inner.slice(0, asAt))
      }
    }
  }

  // 2. casts
  for (let i = 0; i < out.length; i++) {
    if (!(out[i].t === 'op' && out[i].v === '::')) continue
    const { name, array, end } = readType(out, i + 1)
    const start = operandStart(out, i - 1)
    const operand = out.slice(start, i)
    let replacement
    const lit = operand.length === 1 && (operand[0].t === 'str' || operand[0].t === 'num')
      ? operand[0]
      : operand.length === 3 && operand[0].t === '(' && (operand[1].t === 'num' || operand[1].t === 'str') ? operand[1] : null
    if (array) {
      if (lit?.t === 'str') replacement = [{ t: 'str', v: pgArrayToJson(lit.v, name) }]
      else if (operand[0].t === 'id' && operand[0].v === 'array') replacement = arrayToJson(operand, opts)
      else replacement = operand
    } else if (name === 'interval') {
      if (lit?.t !== 'str') throw new Untranslatable('non-literal interval')
      replacement = [{ t: 'interval', v: lit.v }]
    } else if (lit) {
      if (NUMERIC_TYPES.has(name) || INT_TYPES.has(name)) replacement = [{ t: 'num', v: String(Number(lit.v)) }]
      else if (name === 'boolean') replacement = [raw(/^(t|true|y|yes|on|1)$/i.test(lit.v) ? '1' : '0')]
      else replacement = [lit]
    } else if (NUMERIC_TYPES.has(name)) {
      replacement = [raw('CAST('), ...operand, raw(' AS REAL)')]
    } else if (INT_TYPES.has(name)) {
      replacement = [raw('CAST('), ...operand, raw(' AS INTEGER)')]
    } else if (name === 'date') {
      replacement = [raw('date('), ...operand, raw(')')]
    } else {
      // text, varchar, uuid, enums, jsonb, timestamptz, regclass …: same representation in SQLite.
      replacement = operand
    }
    out.splice(start, end - start, ...replacement)
    i = start - 1
  }

  // 3. ARRAY[...] outside casts → JSON array literal when constant
  for (let i = 0; i < out.length; i++) {
    if (out[i].t === 'id' && out[i].v === 'array' && out[i + 1]?.t === '[') {
      const close = match(out, i + 1)
      out.splice(i, close - i + 1, { t: 'arrayexpr', items: splitTop(out.slice(i + 2, close)) })
    }
  }

  // 4. x = ANY (array) / x <> ALL (array)
  for (let i = 0; i < out.length; i++) {
    const tk = out[i]
    if (tk.t === 'id' && (tk.v === 'any' || tk.v === 'all') && out[i - 1]?.t === 'op' && out[i + 1]?.t === '(') {
      const op = out[i - 1].v
      const close = match(out, i + 1)
      const inner = out.slice(i + 2, close)
      let list
      if (inner.length === 1 && inner[0].t === 'arrayexpr') list = joinTop(inner[0].items)
      else if (inner.length === 1 && inner[0].t === 'str' && inner[0].v.startsWith('[')) {
        list = JSON.parse(inner[0].v).flatMap((v, k) => [...(k ? [{ t: ',' }] : []), typeof v === 'number' ? { t: 'num', v: String(v) } : { t: 'str', v }])
      } else list = [raw('SELECT value FROM json_each('), ...inner, raw(')')]
      let kw
      if (tk.v === 'any' && op === '=') kw = 'IN'
      else if (tk.v === 'all' && (op === '<>' || op === '!=')) kw = 'NOT IN'
      else throw new Untranslatable(`${op} ${tk.v.toUpperCase()}`)
      out.splice(i - 1, close - i + 2, raw(kw), { t: '(' }, ...list, { t: ')' })
    }
  }
  if (out.some((t) => t.t === 'arrayexpr')) {
    out = out.flatMap((t) => (t.t === 'arrayexpr' ? arrayToJson([t], opts) : [t]))
  }

  // 5. operators and keywords
  for (let i = 0; i < out.length; i++) {
    const tk = out[i]
    if (tk.t === 'op') {
      if (['~', '~*', '!~', '!~*'].includes(tk.v)) throw new Untranslatable('regular expression')
      if (['@>', '<@', '?|', '?&', '?', '#>', '#>>'].includes(tk.v)) throw new Untranslatable(`operator ${tk.v}`)
      if (tk.v === '~~' || tk.v === '~~*') out[i] = raw('LIKE')
      if (tk.v === '!~~' || tk.v === '!~~*') out[i] = raw('NOT LIKE')
      if (tk.v === '!=') out[i] = { t: 'op', v: '<>' }
    }
    if (tk.t === 'id' && tk.v === 'is' && out[i + 1]?.v === 'distinct' && out[i + 2]?.v === 'from') {
      out.splice(i, 3, raw('IS NOT'))
    } else if (tk.t === 'id' && tk.v === 'is' && out[i + 1]?.v === 'not' && out[i + 2]?.v === 'distinct' && out[i + 3]?.v === 'from') {
      out.splice(i, 4, raw('IS'))
    }
    if (tk.t === 'id' && tk.v === 'current_date') out[i] = raw("date('now')")
    if (tk.t === 'id' && tk.v === 'ilike') out[i] = raw('LIKE')
  }

  // 6. names: schema prefixes, context functions, function renames
  for (let i = 0; i < out.length; i++) {
    const tk = out[i]
    if (tk.t !== 'id') continue
    if ((tk.v === 'public' || tk.v === 'extensions' || tk.v === 'pg_catalog') && out[i + 1]?.t === '.') { out.splice(i, 2); i--; continue }
    if (tk.v === 'auth' && out[i + 1]?.t === '.' && out[i + 2]?.v === 'users') { out.splice(i, 3, { t: 'id', v: 'users' }); continue }
    const qualified = tk.v === 'auth' && out[i + 1]?.t === '.' && out[i + 2]?.t === 'id' ? `auth.${out[i + 2].v}` : tk.v
    const nameLen = qualified.includes('.') ? 3 : 1
    if (out[i + nameLen]?.t !== '(') continue
    if (KEYWORDS.has(tk.v) && !['left', 'replace'].includes(tk.v)) continue
    const close = match(out, i + nameLen)
    const args = splitTop(out.slice(i + nameLen + 1, close))
    if (CONTEXT[qualified]) {
      if (!opts.context) throw new Untranslatable(`${qualified}() outside a row-security rule`)
      out.splice(i, close - i + 1, raw(CONTEXT[qualified](args.map((a) => a[0]))))
      continue
    }
    if (qualified.startsWith('auth.')) throw new Untranslatable(qualified)
    const fn = tk.v
    if (fn === 'now' || fn === 'clock_timestamp' || fn === 'statement_timestamp' || fn === 'transaction_timestamp') {
      // now() ± interval
      const after = out[close + 1]
      const iv = out[close + 2]
      if (after?.t === 'op' && (after.v === '+' || after.v === '-') && iv?.t === 'interval') {
        const mods = intervalModifiers(iv.v, after.v).map(sqlString).join(',')
        out.splice(i, close - i + 3, raw(`strftime('%Y-%m-%dT%H:%M:%fZ','now',${mods})`))
      } else out.splice(i, close - i + 1, raw(NOW))
      continue
    }
    if (fn === 'gen_random_uuid' || fn === 'uuid_generate_v4') { out.splice(i, close - i + 1, raw(`(${UUID})`)); continue }
    if (fn === 'lpad') {
      if (args.length !== 3) throw new Untranslatable('lpad')
      const [s, n, fill] = args
      if (n.length !== 1 || n[0].t !== 'num' || fill.length !== 1 || fill[0].t !== 'str' || fill[0].v.length !== 1) throw new Untranslatable('lpad')
      const width = Number(n[0].v)
      const pad = fill[0].v.repeat(width)
      out.splice(i, close - i + 1, raw(`substr(${sqlString(pad)}||`), { t: '(' }, ...s, { t: ')' }, raw(`,-${width},${width})`))
      continue
    }
    if (fn === 'date_trunc') {
      const unit = args[0]?.[0]
      const fmt = { day: '%Y-%m-%dT00:00:00.000Z', month: '%Y-%m-01T00:00:00.000Z', year: '%Y-01-01T00:00:00.000Z', hour: '%Y-%m-%dT%H:00:00.000Z' }[unit?.v]
      if (unit?.t !== 'str' || !fmt) throw new Untranslatable('date_trunc unit')
      out.splice(i, close - i + 1, raw(`strftime('${fmt}',`), ...args[1], raw(')'))
      continue
    }
    if (fn === 'trim' && args.length === 1 && args[0][0]?.t === 'id' && ['both', 'leading', 'trailing'].includes(args[0][0].v)) {
      // TRIM(BOTH [chars] FROM x) → trim(x[, chars])
      const a = args[0]
      const from = a.findIndex((t) => t.t === 'id' && t.v === 'from')
      const chars = a.slice(1, from)
      const name = { both: 'trim', leading: 'ltrim', trailing: 'rtrim' }[a[0].v]
      out.splice(i, close - i + 1, raw(`${name}(`), ...a.slice(from + 1), ...(chars.length ? [{ t: ',' }, ...chars] : []), raw(')'))
      continue
    }
    if (fn === 'jsonb_set' || fn === 'json_set') {
      if (fn === 'json_set' || args.length < 3) continue
      const path = args[1]
      if (path.length !== 1 || path[0].t !== 'str') throw new Untranslatable('jsonb_set with a computed path')
      const keys = path[0].v.replace(/^\{|\}$/g, '').split(',').map((k) => k.trim().replace(/^"|"$/g, ''))
      const jsonPath = `'$${keys.map((k) => (/^\d+$/.test(k) ? `[${k}]` : `."${k.replaceAll("'", "''")}"`)).join('')}'`
      out.splice(i, close - i + 1, raw('json_set('), ...args[0], raw(`, ${jsonPath}, json(`), ...args[2], raw('))'))
      continue
    }
    if (fn === 'array_length') {
      out.splice(i, close - i + 1, raw('json_array_length('), ...args[0], raw(')'))
      continue
    }
    if (fn === 'num_nonnulls' || fn === 'num_nulls') {
      const test = fn === 'num_nonnulls' ? 'IS NOT NULL' : 'IS NULL'
      const parts = args.flatMap((a, k) => [...(k ? [raw('+')] : []), { t: '(' }, { t: '(' }, ...a, { t: ')' }, raw(test), { t: ')' }])
      out.splice(i, close - i + 1, { t: '(' }, ...parts, { t: ')' })
      continue
    }
    if (fn === 'greatest' || fn === 'least') {
      // Postgres ignores NULL arguments; SQLite's scalar max()/min() would return NULL.
      const agg = fn === 'greatest' ? 'max' : 'min'
      const parts = args.flatMap((a, k) => [raw(k ? ' UNION ALL SELECT' : 'SELECT'), ...a, ...(k ? [] : [raw('AS v')])])
      out.splice(i, close - i + 1, raw(`(SELECT ${agg}(v) FROM (`), ...parts, raw('))'))
      continue
    }
    if (RENAME[fn]) { out[i] = { t: 'id', v: RENAME[fn] }; continue }
    if (fn === 'jsonb_build_object' || fn === 'json_build_object') { out[i] = { t: 'id', v: 'json_object' }; continue }
    if (fn === 'jsonb_build_array' || fn === 'json_build_array') { out[i] = { t: 'id', v: 'json_array' }; continue }
    if (fn === 'extract' || fn === 'date_part' || fn === 'to_char' || fn === 'age') throw new Untranslatable(fn)
    if (!SAME.has(fn) && !(opts.functions?.has(fn))) throw new Untranslatable(`function ${fn}`)
  }
  // 7. timestamp ± interval → strftime(…, ts, modifiers)
  for (let i = 0; i < out.length; i++) {
    if (out[i].t !== 'interval') continue
    const op = out[i - 1]
    if (op?.t !== 'op' || (op.v !== '+' && op.v !== '-') || i < 2) throw new Untranslatable('interval arithmetic')
    const start = operandStart(out, i - 2)
    const mods = intervalModifiers(out[i].v, op.v).map(sqlString).join(',')
    out.splice(start, i - start + 1, raw("strftime('%Y-%m-%dT%H:%M:%fZ',"), ...out.slice(start, i - 1), raw(`,${mods})`))
    i = start
  }
  if (out.some((t) => t.t === 'id' && t.v === 'lateral')) throw new Untranslatable('LATERAL join')
  return out
}

export function splitTop(tokens) {
  const parts = [[]]
  let depth = 0
  for (const tk of tokens) {
    if (tk.t === '(' || tk.t === '[') depth++
    if (tk.t === ')' || tk.t === ']') depth--
    if (tk.t === ',' && depth === 0) parts.push([])
    else parts[parts.length - 1].push(tk)
  }
  return parts.filter((p) => p.length)
}

function joinTop(parts) {
  return parts.flatMap((p, k) => [...(k ? [{ t: ',' }] : []), ...p])
}

/** ARRAY['a', 'b'] → '["a","b"]' when every item is a literal; otherwise json_array(…). */
function arrayToJson(tokens, opts) {
  const items = tokens[0].t === 'arrayexpr' ? tokens[0].items : splitTop(tokens.slice(2, -1))
  if (items.every((it) => it.length === 1 && (it[0].t === 'str' || it[0].t === 'num'))) {
    return [{ t: 'str', v: JSON.stringify(items.map((it) => (it[0].t === 'num' ? Number(it[0].v) : it[0].v))) }]
  }
  return [raw('json_array('), ...joinTop(items.map((it) => rewrite(it, opts))), raw(')')]
}

/** Translates one Postgres expression to SQLite text. */
export function toSqlite(expr, opts = {}) {
  return render(rewrite(tokenize(expr), opts), opts)
}

/** Splits an expression into its top-level AND parts (outer brackets removed). */
export function conjuncts(expr) {
  let tokens = tokenize(expr)
  const strip = (t) => {
    while (t.length && t[0].t === '(' && match(t, 0) === t.length - 1) t = t.slice(1, -1)
    return t
  }
  tokens = strip(tokens)
  const parts = [[]]
  let depth = 0
  for (const tk of tokens) {
    if (tk.t === '(' || tk.t === '[') depth++
    if (tk.t === ')' || tk.t === ']') depth--
    if (depth === 0 && tk.t === 'id' && tk.v === 'and') parts.push([])
    else parts[parts.length - 1].push(tk)
  }
  // "between x and y" splits wrongly; rejoin parts after a dangling BETWEEN
  const fixed = []
  for (const p of parts) {
    const prev = fixed[fixed.length - 1]
    if (prev && prev.some((t) => t.t === 'id' && t.v === 'between') && !prev.some((t) => t.t === 'id' && t.v === 'and')) {
      prev.push({ t: 'id', v: 'and' }, ...p)
    } else fixed.push(p)
  }
  return fixed.map((p) => renderPg(strip(p)))
}

/** Renders tokens back to Postgres text (strings re-escaped). */
function renderPg(tokens) {
  return tokens.map((tk) => (tk.t === 'str' ? sqlString(tk.v) : tk.t === 'id' ? (tk.quoted ? `"${tk.v}"` : tk.v) : tk.t === 'num' || tk.t === 'op' ? tk.v : tk.t)).join(' ')
}

// ---------------------------------------------------------------- application-level checks

/**
 * Parses a simple Postgres boolean expression (as used in CHECK constraints with regular
 * expressions) into a small tree the runtime evaluates with SQL three-valued logic.
 * Supported: AND/OR/NOT, IS [NOT] NULL, comparisons, ~ ~* !~ !~*, length().
 */
export function toCheckTree(expr) {
  const tokens = tokenize(expr)
  let i = 0
  const peek = () => tokens[i]
  const eat = (t, v) => {
    const tk = tokens[i]
    if (!tk || tk.t !== t || (v !== undefined && tk.v !== v)) throw new Untranslatable(`check: expected ${v ?? t} in ${expr}`)
    i++
    return tk
  }
  const isKw = (v) => peek()?.t === 'id' && peek().v === v
  function orExpr() {
    let left = andExpr()
    while (isKw('or')) { i++; left = { op: 'or', args: [left, andExpr()] } }
    return left
  }
  function andExpr() {
    let left = notExpr()
    while (isKw('and')) { i++; left = { op: 'and', args: [left, notExpr()] } }
    return left
  }
  function notExpr() {
    if (isKw('not')) { i++; return { op: 'not', args: [notExpr()] } }
    return cmp()
  }
  function cmp() {
    const left = value()
    if (isKw('is')) {
      i++
      const neg = isKw('not') ? (i++, true) : false
      eat('id', 'null')
      return { op: neg ? 'notnull' : 'isnull', args: [left] }
    }
    const tk = peek()
    if (tk?.t === 'op' && tk.v === '<@') {
      i++
      const right = value()
      if (!Array.isArray(right.lit)) throw new Untranslatable('check: <@ needs a literal list')
      return { op: 'subset', args: [left, right] }
    }
    if (tk?.t === 'op' && ['=', '<>', '!=', '<', '<=', '>', '>=', '~', '~*', '!~', '!~*'].includes(tk.v)) {
      i++
      const right = value()
      if (tk.v.includes('~')) {
        if (right.lit === undefined || typeof right.lit !== 'string') throw new Untranslatable('check: non-literal pattern')
        new RegExp(right.lit) // must also be a valid JavaScript pattern
        return { op: tk.v.startsWith('!') ? 'notmatch' : 'match', flags: tk.v.endsWith('*') ? 'i' : '', args: [left, right] }
      }
      return { op: tk.v === '!=' ? '<>' : tk.v, args: [left, right] }
    }
    return left
  }
  function value() {
    const tk = peek()
    let v
    if (tk?.t === '(') {
      i++
      v = orExpr()
      eat(')')
    } else if (tk?.t === 'str') { i++; v = { lit: tk.v } } else if (tk?.t === 'num') { i++; v = { lit: Number(tk.v) } } else if (tk?.t === 'id' && (tk.v === 'true' || tk.v === 'false')) {
      i++; v = { lit: tk.v === 'true' }
    } else if (tk?.t === 'id' && tk.v === 'array' && tokens[i + 1]?.t === '[') {
      i += 2
      const items = []
      while (peek()?.t !== ']') {
        const item = value()
        if (item.lit === undefined) throw new Untranslatable('check: non-literal array item')
        items.push(item.lit)
        if (peek()?.t === ',') i++
      }
      i++
      v = { lit: items }
    } else if (tk?.t === 'id' && tokens[i + 1]?.t === '(') {
      const fn = tk.v
      if (!['length', 'char_length', 'lower', 'upper', 'btrim'].includes(fn)) throw new Untranslatable(`check: function ${fn}`)
      i += 2
      const arg = orExpr()
      eat(')')
      v = { fn: fn === 'char_length' ? 'length' : fn === 'btrim' ? 'trim' : fn, args: [arg] }
    } else if (tk?.t === 'id') { i++; v = { col: tk.v } } else throw new Untranslatable(`check: unexpected ${tk?.t} in ${expr}`)
    while (peek()?.t === 'op' && peek().v === '::') {
      i++
      const type = readType(tokens, i)
      i = type.end
      if (type.array && typeof v.lit === 'string') v = { lit: JSON.parse(pgArrayToJson(v.lit, type.name)) }
    }
    return v
  }
  const tree = orExpr()
  if (i !== tokens.length) throw new Untranslatable(`check: trailing tokens in ${expr}`)
  return tree
}
