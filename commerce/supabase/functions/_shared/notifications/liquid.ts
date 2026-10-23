// A small, safe Liquid (Shopify's template language) for customer emails and WhatsApp texts. The
// same code fills the live preview in the admin and the message the sender sends, so what the
// seller sees is what the customer gets.
//
//   {{ order.name }}  {{ order.total_price | money }}  {{ customer.first_name | default: "there" }}
//   {% if shipment.tracking_url %}…{% elsif … %}…{% else %}…{% endif %}   {% unless … %}…{% endunless %}
//   {% for item in order.line_items %}{{ forloop.index }}. {{ item.title }}{% else %}…{% endfor %}
//   {% assign n = order.line_items | size %}  {% capture x %}…{% endcapture %}  {% comment %}…{% endcomment %}
//   {% raw %}…{% endraw %}  and {%- -%} / {{- -}} to trim spaces.
//
// It never runs code: no includes, no file or network access. In HTML mode every {{ }} is escaped
// (a customer's name can't add HTML to an email). Loops, output size and nesting are capped, and a
// mistake in a template is a LiquidError naming the line, for the editor.

export class LiquidError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line ? `Line ${line}: ${message}` : message)
    this.name = 'LiquidError'
  }
}

export interface RenderOptions {
  /** 'html' escapes every {{ }} (emails); 'text' leaves it as it is (subjects, WhatsApp). */
  mode?: 'html' | 'text'
  /** The currency sign for | money (default: shop.currency_symbol, else ৳). */
  currency?: string
  /** Today, for | date: "now". */
  now?: Date
  /** IANA time zone for | date (default Asia/Dhaka). */
  timeZone?: string
}

const MAX_TEMPLATE = 200_000
const MAX_OUTPUT = 600_000
const MAX_STEPS = 20_000
const MAX_DEPTH = 40

// ------------------------------------------------------------------ tokens
type Token =
  | { kind: 'text'; value: string; line: number }
  | { kind: 'out'; value: string; line: number }
  | { kind: 'tag'; name: string; args: string; line: number }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  let line = 1
  const lineAt = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src.charCodeAt(k) === 10) line++
  }
  const opener = /\{\{|\{%/g
  while (i < src.length) {
    opener.lastIndex = i
    const found = opener.exec(src)
    if (!found) {
      out.push({ kind: 'text', value: src.slice(i), line })
      break
    }
    const start = found.index
    if (start > i) {
      out.push({ kind: 'text', value: src.slice(i, start), line })
      lineAt(i, start)
    }
    const isTag = src[start + 1] === '%'
    const close = src.indexOf(isTag ? '%}' : '}}', start + 2)
    if (close < 0) throw new LiquidError(isTag ? 'a {% tag is not closed with %}' : 'a {{ is not closed with }}', line)
    let inner = src.slice(start + 2, close)
    const trimLeft = inner.startsWith('-')
    const trimRight = inner.endsWith('-')
    if (trimLeft) inner = inner.slice(1)
    if (trimRight) inner = inner.slice(0, -1)
    if (trimLeft && out.length && out[out.length - 1].kind === 'text') {
      const t = out[out.length - 1] as { value: string }
      t.value = t.value.replace(/\s+$/, '')
    }
    const tokenLine = line
    if (isTag) {
      const m = inner.trim().match(/^([a-z_]+)\s*([\s\S]*)$/)
      if (!m) throw new LiquidError('empty {% %} tag', tokenLine)
      out.push({ kind: 'tag', name: m[1], args: m[2].trim(), line: tokenLine })
      // {% raw %} … {% endraw %}: everything up to the end tag is text.
      if (m[1] === 'raw') {
        const end = src.slice(close + 2).search(/\{%-?\s*endraw\s*-?%\}/)
        if (end < 0) throw new LiquidError('{% raw %} has no {% endraw %}', tokenLine)
        const body = src.slice(close + 2, close + 2 + end)
        out.push({ kind: 'text', value: body, line: tokenLine })
        lineAt(start, close + 2 + end)
        const endTag = src.slice(close + 2 + end).match(/^\{%-?\s*endraw\s*-?%\}/)!
        i = close + 2 + end + endTag[0].length
        out.push({ kind: 'tag', name: 'endraw', args: '', line })
        continue
      }
    } else {
      out.push({ kind: 'out', value: inner.trim(), line: tokenLine })
    }
    lineAt(start, close + 2)
    i = close + 2
    if (trimRight) {
      const ws = src.slice(i).match(/^\s+/)
      if (ws) {
        lineAt(i, i + ws[0].length)
        i += ws[0].length
      }
    }
  }
  return out
}

// ------------------------------------------------------------------ expressions
type Expr =
  | { t: 'lit'; v: unknown }
  | { t: 'var'; path: Array<string | Expr> }
  | { t: 'range'; from: Expr; to: Expr }

interface Filter { name: string; args: Expr[] }
interface Output { expr: Expr; filters: Filter[] }

const STRING = /^(?:"([^"]*)"|'([^']*)')/
const NUMBER = /^-?\d+(?:\.\d+)?/
const IDENT = /^[A-Za-z_][\w-]*\??/

function parseExpr(raw: string, line: number): Expr {
  const s = raw.trim()
  if (!s) throw new LiquidError('a value is missing', line)
  let m = s.match(STRING)
  if (m && m[0].length === s.length) return { t: 'lit', v: m[1] ?? m[2] }
  m = s.match(NUMBER)
  if (m && m[0].length === s.length) return { t: 'lit', v: Number(s) }
  if (s === 'true' || s === 'false') return { t: 'lit', v: s === 'true' }
  if (s === 'nil' || s === 'null') return { t: 'lit', v: null }
  if (s === 'blank' || s === 'empty') return { t: 'lit', v: BLANK }
  const range = s.match(/^\(\s*(.+?)\s*\.\.\s*(.+?)\s*\)$/)
  if (range) return { t: 'range', from: parseExpr(range[1], line), to: parseExpr(range[2], line) }
  // a.b[0].c["d"]
  const path: Array<string | Expr> = []
  let rest = s
  const first = rest.match(IDENT)
  if (!first) throw new LiquidError(`"${s}" is not a value`, line)
  path.push(first[0])
  rest = rest.slice(first[0].length)
  while (rest) {
    if (rest[0] === '.') {
      const id = rest.slice(1).match(IDENT)
      if (!id) throw new LiquidError(`"${s}" is not a value`, line)
      path.push(id[0])
      rest = rest.slice(1 + id[0].length)
    } else if (rest[0] === '[') {
      const end = rest.indexOf(']')
      if (end < 0) throw new LiquidError(`"${s}" has a [ without ]`, line)
      path.push(parseExpr(rest.slice(1, end), line))
      rest = rest.slice(end + 1)
    } else {
      throw new LiquidError(`"${s}" is not a value`, line)
    }
  }
  return { t: 'var', path }
}

/** Splits on a separator outside quotes. */
function splitOutside(s: string, sep: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
      cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (s.startsWith(sep, i)) {
      parts.push(cur)
      cur = ''
      i += sep.length - 1
    } else {
      cur += c
    }
  }
  parts.push(cur)
  return parts
}

function parseOutput(raw: string, line: number): Output {
  const [head, ...rest] = splitOutside(raw, '|')
  const filters = rest.map((f) => {
    const [name, args = ''] = splitOutside(f, ':').length > 1 ? [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)] : [f]
    const n = name.trim()
    if (!FILTERS[n]) throw new LiquidError(`there is no filter called "${n}"`, line)
    return { name: n, args: args.trim() ? splitOutside(args, ',').map((a) => parseExpr(a, line)) : [] }
  })
  return { expr: parseExpr(head, line), filters }
}

type Cond =
  | { t: 'and' | 'or'; a: Cond; b: Cond }
  | { t: 'cmp'; op: string; a: Expr; b: Expr }
  | { t: 'truthy'; a: Expr }

function parseCond(raw: string, line: number): Cond {
  // Liquid reads and/or from the right: a or b and c  ==  a or (b and c)
  const words = splitOutside(raw, ' ').filter((w) => w !== '')
  const idx = words.findIndex((w) => w === 'and' || w === 'or')
  if (idx >= 0) {
    return { t: words[idx] as 'and' | 'or', a: parseCond(words.slice(0, idx).join(' '), line), b: parseCond(words.slice(idx + 1).join(' '), line) }
  }
  const s = words.join(' ')
  const m = s.match(/^(.+?)\s*(==|!=|<>|>=|<=|>|<|\scontains\s)\s*(.+)$/)
  if (m) return { t: 'cmp', op: m[2].trim(), a: parseExpr(m[1], line), b: parseExpr(m[3], line) }
  return { t: 'truthy', a: parseExpr(s, line) }
}

// ------------------------------------------------------------------ tree
type Node =
  | { t: 'text'; v: string }
  | { t: 'out'; o: Output; line: number }
  | { t: 'if'; branches: Array<{ cond: Cond | null; body: Node[] }>; negate: boolean }
  | { t: 'for'; name: string; coll: Expr; limit?: Expr; offset?: Expr; reversed: boolean; body: Node[]; empty: Node[]; line: number }
  | { t: 'assign'; name: string; o: Output }
  | { t: 'capture'; name: string; body: Node[] }

function parse(tokens: Token[]): Node[] {
  let pos = 0
  const block = (ends: string[], depth: number): { nodes: Node[]; end: Token | null } => {
    if (depth > MAX_DEPTH) throw new LiquidError('too many tags inside each other', tokens[pos]?.line)
    const nodes: Node[] = []
    while (pos < tokens.length) {
      const tok = tokens[pos++]
      if (tok.kind === 'text') {
        nodes.push({ t: 'text', v: tok.value })
      } else if (tok.kind === 'out') {
        nodes.push({ t: 'out', o: parseOutput(tok.value, tok.line), line: tok.line })
      } else if (ends.includes(tok.name)) {
        return { nodes, end: tok }
      } else {
        nodes.push(tag(tok, depth))
      }
    }
    if (ends.length) throw new LiquidError(`{% ${ends[ends.length - 1]} %} is missing`)
    return { nodes, end: null }
  }
  const tag = (tok: Extract<Token, { kind: 'tag' }>, depth: number): Node => {
    const { name, args, line } = tok
    switch (name) {
      case 'if':
      case 'unless': {
        const endName = name === 'if' ? 'endif' : 'endunless'
        const branches: Array<{ cond: Cond | null; body: Node[] }> = []
        let cond: Cond | null = parseCond(args, line)
        for (;;) {
          const { nodes, end } = block(['elsif', 'else', endName], depth + 1)
          branches.push({ cond, body: nodes })
          if (!end || end.kind !== 'tag' || end.name === endName) break
          cond = end.name === 'elsif' ? parseCond(end.args, end.line) : null
        }
        return { t: 'if', branches, negate: name === 'unless' }
      }
      case 'for': {
        const m = args.match(/^([A-Za-z_]\w*)\s+in\s+(\([^)]*\)|\S+)(.*)$/)
        if (!m) throw new LiquidError('write {% for item in list %}', line)
        const opts = m[3]
        const limit = opts.match(/limit\s*:\s*(\S+)/)
        const offset = opts.match(/offset\s*:\s*(\S+)/)
        const body = block(['else', 'endfor'], depth + 1)
        let empty: Node[] = []
        if (body.end && body.end.kind === 'tag' && body.end.name === 'else') empty = block(['endfor'], depth + 1).nodes
        return {
          t: 'for', name: m[1], coll: parseExpr(m[2], line), line, reversed: /\breversed\b/.test(opts),
          limit: limit ? parseExpr(limit[1], line) : undefined, offset: offset ? parseExpr(offset[1], line) : undefined,
          body: body.nodes, empty,
        }
      }
      case 'assign': {
        const m = args.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/)
        if (!m || m[1].startsWith('__')) throw new LiquidError('write {% assign name = value %}', line)
        return { t: 'assign', name: m[1], o: parseOutput(m[2], line) }
      }
      case 'capture': {
        const m = args.match(/^([A-Za-z_]\w*)$/)
        if (!m || m[1].startsWith('__')) throw new LiquidError('write {% capture name %}', line)
        return { t: 'capture', name: m[1], body: block(['endcapture'], depth + 1).nodes }
      }
      case 'comment':
        block(['endcomment'], depth + 1)
        return { t: 'text', v: '' }
      case 'raw': {
        const text = tokens[pos++]
        pos++ // endraw
        return { t: 'text', v: text && text.kind === 'text' ? text.value : '' }
      }
      default:
        throw new LiquidError(`there is no {% ${name} %} tag here`, line)
    }
  }
  return block([], 0).nodes
}

// ------------------------------------------------------------------ values
const BLANK = Symbol('blank')
class SafeHtml {
  constructor(readonly html: string) {}
  toString() { return this.html }
}

type Scope = Record<string, unknown>

function lookup(scopes: Scope[], expr: Expr, ctx: Ctx): unknown {
  if (expr.t === 'lit') return expr.v
  if (expr.t === 'range') {
    const a = Math.trunc(Number(lookup(scopes, expr.from, ctx)))
    const b = Math.trunc(Number(lookup(scopes, expr.to, ctx)))
    if (!Number.isFinite(a) || !Number.isFinite(b) || b - a > 1000) return []
    return Array.from({ length: Math.max(b - a + 1, 0) }, (_, i) => a + i)
  }
  const [head, ...rest] = expr.path
  let v: unknown
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (Object.hasOwn(scopes[i], head as string)) {
      v = scopes[i][head as string]
      break
    }
  }
  for (const part of rest) {
    const key = typeof part === 'string' ? part : lookup(scopes, part, ctx)
    v = member(v, key)
  }
  return v
}

function member(v: unknown, key: unknown): unknown {
  if (v == null) return undefined
  if (key === 'size' && (Array.isArray(v) || typeof v === 'string')) return v.length
  if (Array.isArray(v)) {
    if (key === 'first') return v[0]
    if (key === 'last') return v[v.length - 1]
    const n = Number(key)
    return Number.isInteger(n) ? v[n < 0 ? v.length + n : n] : undefined
  }
  if (typeof v === 'object' && (typeof key === 'string' || typeof key === 'number')) {
    const k = String(key)
    return Object.hasOwn(v as object, k) ? (v as Record<string, unknown>)[k] : undefined
  }
  return undefined
}

const truthy = (v: unknown) => v !== false && v != null && v !== undefined
const isBlank = (v: unknown) => v == null || v === false || v === '' || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !(v instanceof SafeHtml) && !Array.isArray(v) && !Object.keys(v as object).length)

function compare(op: string, a: unknown, b: unknown): boolean {
  if (b === BLANK) return op === '==' ? isBlank(a) : op === '!=' || op === '<>' ? !isBlank(a) : false
  if (a === BLANK) return compare(op, b, a)
  const x = a instanceof SafeHtml ? a.html : a
  const y = b instanceof SafeHtml ? b.html : b
  switch (op) {
    case '==': return x === y || (x == null && y == null)
    case '!=': case '<>': return !(x === y || (x == null && y == null))
    case 'contains':
      if (typeof x === 'string') return y != null && x.includes(String(y))
      if (Array.isArray(x)) return x.some((e) => e === y)
      return false
    default: {
      if (x == null || y == null) return false
      const nx = typeof x === 'number' ? x : Number(x)
      const ny = typeof y === 'number' ? y : Number(y)
      const [p, q] = Number.isFinite(nx) && Number.isFinite(ny) ? [nx, ny] : [String(x), String(y)]
      return op === '>' ? p > q : op === '<' ? p < q : op === '>=' ? p >= q : p <= q
    }
  }
}

function test(scopes: Scope[], c: Cond, ctx: Ctx): boolean {
  switch (c.t) {
    case 'cmp': return compare(c.op, lookup(scopes, c.a, ctx), lookup(scopes, c.b, ctx))
    case 'truthy': return truthy(lookup(scopes, c.a, ctx))
    case 'and': return test(scopes, c.a, ctx) && test(scopes, c.b, ctx)
    default: return test(scopes, c.a, ctx) || test(scopes, c.b, ctx)
  }
}

// ------------------------------------------------------------------ filters
const str = (v: unknown): string => {
  if (v == null || v === BLANK) return ''
  if (v instanceof SafeHtml) return v.html
  if (Array.isArray(v)) return v.map(str).join('')
  if (typeof v === 'object') return ''
  return String(v)
}
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(str(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}
export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** 1250 → "1,250"; 1250.5 → "1,250.50". */
export function formatAmount(n: number): string {
  const fixed = Math.abs(n % 1) > 0.0001 ? 2 : 0
  return n.toLocaleString('en-US', { minimumFractionDigits: fixed, maximumFractionDigits: fixed })
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function formatDate(v: unknown, fmt: string, ctx: Ctx): string {
  const raw = str(v)
  const d = raw === 'now' || raw === 'today' ? ctx.now : new Date(typeof v === 'number' ? v * 1000 : raw)
  if (Number.isNaN(d.getTime())) return raw
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ctx.timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
    weekday: 'long', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]))
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  const hour = Number(parts.hour) % 24
  const pad = (n: number) => String(n).padStart(2, '0')
  return fmt.replace(/%([a-zA-Z%])/g, (_, k: string) => {
    switch (k) {
      case 'Y': return String(year)
      case 'y': return pad(year % 100)
      case 'm': return pad(month)
      case 'B': return MONTHS[month - 1]
      case 'b': return MONTHS[month - 1].slice(0, 3)
      case 'd': return pad(day)
      case 'e': return String(day)
      case 'H': return pad(hour)
      case 'I': return pad(hour % 12 || 12)
      case 'l': return String(hour % 12 || 12)
      case 'M': return parts.minute
      case 'p': return hour < 12 ? 'AM' : 'PM'
      case 'A': return parts.weekday
      case 'a': return parts.weekday.slice(0, 3)
      case '%': return '%'
      default: return `%${k}`
    }
  })
}

type FilterFn = (v: unknown, args: unknown[], ctx: Ctx) => unknown
const FILTERS: Record<string, FilterFn> = {
  money: (v, _a, ctx) => `${ctx.currency}${formatAmount(num(v))}`,
  money_without_currency: (v) => formatAmount(num(v)),
  upcase: (v) => str(v).toUpperCase(),
  downcase: (v) => str(v).toLowerCase(),
  capitalize: (v) => { const s = str(v); return s.charAt(0).toUpperCase() + s.slice(1) },
  default: (v, a) => (isBlank(v) ? a[0] : v),
  date: (v, a, ctx) => formatDate(v, str(a[0] ?? '%d %b %Y'), ctx),
  escape: (v) => escapeHtml(str(v)),
  strip: (v) => str(v).trim(),
  truncate: (v, a) => {
    const s = str(v)
    const n = Math.max(Math.trunc(num(a[0] ?? 50)), 0)
    const tail = a[1] === undefined ? '...' : str(a[1])
    return s.length > n ? s.slice(0, Math.max(n - tail.length, 0)) + tail : s
  },
  append: (v, a) => str(v) + str(a[0]),
  prepend: (v, a) => str(a[0]) + str(v),
  replace: (v, a) => str(v).split(str(a[0])).join(str(a[1])),
  remove: (v, a) => str(v).split(str(a[0])).join(''),
  plus: (v, a) => num(v) + num(a[0]),
  minus: (v, a) => num(v) - num(a[0]),
  times: (v, a) => num(v) * num(a[0]),
  divided_by: (v, a) => (num(a[0]) === 0 ? 0 : num(v) / num(a[0])),
  round: (v, a) => { const p = 10 ** Math.trunc(num(a[0] ?? 0)); return Math.round(num(v) * p) / p },
  size: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : 0),
  first: (v) => (Array.isArray(v) ? v[0] : str(v).charAt(0)),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : str(v).slice(-1)),
  join: (v, a) => (Array.isArray(v) ? v.map(str).join(a[0] === undefined ? ' ' : str(a[0])) : str(v)),
  url_encode: (v) => encodeURIComponent(str(v)),
  newline_to_br: (v) => new SafeHtml(escapeHtml(str(v)).replace(/\r?\n/g, '<br>')),
  strip_html: (v) => str(v).replace(/<[^>]*>/g, ''),
}

// ------------------------------------------------------------------ render
interface Ctx { mode: 'html' | 'text'; currency: string; now: Date; timeZone: string; steps: number; size: number }

function show(v: unknown, ctx: Ctx): string {
  if (v instanceof SafeHtml) return v.html
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)) : str(v)
  return ctx.mode === 'html' ? escapeHtml(s) : s
}

function evalOutput(scopes: Scope[], o: Output, ctx: Ctx, line: number): unknown {
  let v = lookup(scopes, o.expr, ctx)
  for (const f of o.filters) {
    try {
      v = FILTERS[f.name](v, f.args.map((a) => lookup(scopes, a, ctx)), ctx)
    } catch (e) {
      throw new LiquidError(`the ${f.name} filter failed: ${(e as Error).message}`, line)
    }
  }
  return v
}

function run(nodes: Node[], scopes: Scope[], ctx: Ctx, out: string[]): void {
  for (const n of nodes) {
    if (++ctx.steps > MAX_STEPS) throw new LiquidError('the template does too much work (loops are too long)')
    let piece = ''
    switch (n.t) {
      case 'text': piece = n.v; break
      case 'out': piece = show(evalOutput(scopes, n.o, ctx, n.line), ctx); break
      case 'assign': scopes[0][n.name] = evalOutput(scopes, n.o, ctx, 0); break
      case 'capture': {
        const buf: string[] = []
        run(n.body, scopes, ctx, buf)
        scopes[0][n.name] = ctx.mode === 'html' ? new SafeHtml(buf.join('')) : buf.join('')
        break
      }
      case 'if': {
        for (const b of n.branches) {
          const ok = b.cond === null || (n.negate && b === n.branches[0] ? !test(scopes, b.cond, ctx) : test(scopes, b.cond, ctx))
          if (ok) {
            run(b.body, scopes, ctx, out)
            break
          }
        }
        break
      }
      case 'for': {
        let list = lookup(scopes, n.coll, ctx)
        if (list && typeof list === 'object' && !Array.isArray(list)) list = Object.entries(list as object).map(([k, v]) => [k, v])
        let items = Array.isArray(list) ? list : []
        const offset = n.offset ? Math.max(Math.trunc(num(lookup(scopes, n.offset, ctx))), 0) : 0
        items = items.slice(offset)
        if (n.limit) items = items.slice(0, Math.max(Math.trunc(num(lookup(scopes, n.limit, ctx))), 0))
        if (n.reversed) items = [...items].reverse()
        if (!items.length) {
          run(n.empty, scopes, ctx, out)
          break
        }
        items.forEach((item, i) => {
          const forloop = { index: i + 1, index0: i, rindex: items.length - i, rindex0: items.length - i - 1, first: i === 0, last: i === items.length - 1, length: items.length }
          run(n.body, [...scopes, { [n.name]: item, forloop }], ctx, out)
        })
        break
      }
    }
    if (piece) {
      ctx.size += piece.length
      if (ctx.size > MAX_OUTPUT) throw new LiquidError('the message is too long')
      out.push(piece)
    }
  }
}

/** Checks a template; returns the error, or null when it is fine. */
export function liquidError(template: string): LiquidError | null {
  try {
    compile(template)
    return null
  } catch (e) {
    return e instanceof LiquidError ? e : new LiquidError(String((e as Error).message ?? e))
  }
}

function compile(template: string): Node[] {
  if (template.length > MAX_TEMPLATE) throw new LiquidError(`the template is longer than ${MAX_TEMPLATE.toLocaleString('en-US')} characters`)
  return parse(tokenize(template))
}

export function renderLiquid(template: string, data: Record<string, unknown>, options: RenderOptions = {}): string {
  const shop = (data.shop ?? {}) as Record<string, unknown>
  const ctx: Ctx = {
    mode: options.mode ?? 'html',
    currency: options.currency ?? (typeof shop.currency_symbol === 'string' ? shop.currency_symbol : '৳'),
    now: options.now ?? new Date(),
    timeZone: options.timeZone ?? 'Asia/Dhaka',
    steps: 0,
    size: 0,
  }
  const out: string[] = []
  run(compile(template), [{ ...data }], ctx, out)
  return out.join('')
}

/** The plain-text version of an HTML email (for mail apps that show text only). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
      const t = text.replace(/<[^>]*>/g, '').trim()
      return t && t !== href ? `${t} (${href})` : href
    })
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim()
}
