// Parser for Postgres SQL: expressions with Postgres' operator precedence, queries
// (SELECT, set operations, VALUES, WITH) and INSERT / UPDATE / DELETE. PL/pgSQL
// (plparse.ts) extends it, so INTO clauses are read here when allowed.
import type { CallExpr, Conflict, Cte, Delete, Expr, FromItem, Insert, Into, OrderItem, Query, Select, SelItem, SetItem, SetOp, Statement, TypeName, Update, Values, WindowSpec, With } from './ast.ts'
import { lex, SqlSyntaxError, type Tok } from './lex.ts'
import { normType } from './types.ts'

// Words that end an expression or a select item instead of naming an alias.
const RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case', 'cast', 'check', 'collate',
  'column', 'constraint', 'create', 'current_catalog', 'current_date', 'current_role', 'current_time', 'current_timestamp', 'current_user',
  'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'from', 'grant', 'group',
  'having', 'in', 'initially', 'intersect', 'into', 'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not', 'null', 'offset', 'on',
  'only', 'or', 'order', 'placing', 'primary', 'references', 'returning', 'select', 'session_user', 'some', 'symmetric', 'table', 'then', 'to',
  'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'when', 'where', 'window', 'with',
  // not reserved in Postgres, but never an alias in the migrations and they end clauses
  'join', 'left', 'right', 'inner', 'full', 'cross', 'natural', 'outer', 'loop', 'is', 'isnull', 'notnull', 'like', 'ilike', 'similar',
  'between', 'over', 'filter', 'within', 'set', 'values', 'nulls', 'by', 'escape', 'elsif', 'elseif', 'exception', 'strict', 'returns',
  'ordinality', 'conflict', 'nothing', 'update', 'delete', 'insert', 'skip', 'nowait', 'of', 'share', 'rows', 'row', 'first', 'next', 'last',
  'reverse', 'slice', 'execute', 'raise', 'return', 'perform', 'if', 'exit', 'continue', 'while', 'foreach', 'declare', 'begin', 'get',
  'diagnostics', 'stacked', 'current', 'using'])

const TYPE_WORDS_2: Record<string, string[]> = {
  double: ['precision'],
  character: ['varying'],
  char: ['varying'],
  bit: ['varying'],
}

const COMPARE = new Set(['=', '<', '>', '<=', '>=', '<>', '!='])
const ARITH_MUL = new Set(['*', '/', '%'])
const ARITH_ADD = new Set(['+', '-'])

// Binding powers (higher binds tighter), after the Postgres documentation's table.
const BP = { or: 1, and: 2, not: 3, is: 4, cmp: 5, like: 6, other: 7, add: 8, mul: 9, exp: 10, at: 11, collate: 12, unary: 13, index: 14, cast: 15 }

export interface ParseOptions {
  /** PL/pgSQL: SELECT … INTO / RETURNING … INTO are allowed. */
  into?: boolean
}

export class Parser {
  i = 0
  constructor(readonly t: Tok[], readonly src: string, readonly opts: ParseOptions = {}) {}

  static of(src: string, opts: ParseOptions = {}): Parser {
    return new Parser(lex(src), src, opts)
  }

  // ---------------------------------------------------------------- token helpers

  peek(n = 0): Tok {
    return this.t[Math.min(this.i + n, this.t.length - 1)]
  }

  next(): Tok {
    return this.t[this.i < this.t.length - 1 ? this.i++ : this.i]
  }

  /** An unquoted word. */
  isKw(v: string, n = 0): boolean {
    const tk = this.peek(n)
    return tk.k === 'id' && !tk.q && tk.v === v
  }

  isPunct(v: string, n = 0): boolean {
    const tk = this.peek(n)
    return tk.k === 'punct' && tk.v === v
  }

  isOp(v: string, n = 0): boolean {
    const tk = this.peek(n)
    return tk.k === 'op' && tk.v === v
  }

  eatKw(...words: string[]): boolean {
    for (let k = 0; k < words.length; k++) if (!this.isKw(words[k], k)) return false
    this.i += words.length
    return true
  }

  eatPunct(v: string): boolean {
    if (!this.isPunct(v)) return false
    this.i++
    return true
  }

  eatOp(v: string): boolean {
    if (!this.isOp(v)) return false
    this.i++
    return true
  }

  fail(message: string): never {
    const tk = this.peek()
    const at = this.src.slice(Math.max(0, tk.pos - 40), tk.pos + 40).replace(/\s+/g, ' ')
    throw new SqlSyntaxError(`${message} at "${tk.v || 'end'}" near: ${at}`, tk.pos)
  }

  expectKw(v: string): void {
    if (!this.eatKw(v)) this.fail(`expected ${v.toUpperCase()}`)
  }

  expectPunct(v: string): void {
    if (!this.eatPunct(v)) this.fail(`expected "${v}"`)
  }

  expectOp(v: string): void {
    if (!this.eatOp(v)) this.fail(`expected "${v}"`)
  }

  /** A name: an unquoted or quoted identifier. */
  name(): string {
    const tk = this.peek()
    if (tk.k !== 'id') this.fail('expected a name')
    this.i++
    return tk.v
  }

  /** An optional alias: AS name, or a bare name that is not a keyword. */
  alias(): string | undefined {
    if (this.eatKw('as')) return this.name()
    const tk = this.peek()
    if (tk.k === 'id' && (tk.q || !RESERVED.has(tk.v)) && !(tk.v === 'at' && this.isKw('time', 1))) {
      this.i++
      return tk.v
    }
    return undefined
  }

  // ---------------------------------------------------------------- types

  typeName(): TypeName {
    let words = [this.name()]
    if (this.eatPunct('.')) words = [this.name()] // schema.type
    const first = words[0]
    if (TYPE_WORDS_2[first] && TYPE_WORDS_2[first].includes(this.peek().v) && this.peek().k === 'id') words.push(this.name())
    if ((first === 'timestamp' || first === 'time') && (this.isKw('with') || this.isKw('without')) && this.isKw('time', 1) && this.isKw('zone', 2)) {
      words.push(this.name(), this.name(), this.name())
    }
    if (this.isPunct('(')) {
      this.i++
      let depth = 1
      while (depth) {
        const tk = this.next()
        if (tk.k === 'eof') this.fail('unclosed type modifier')
        if (tk.k === 'punct' && tk.v === '(') depth++
        if (tk.k === 'punct' && tk.v === ')') depth--
      }
    }
    let array = 0
    while (this.isPunct('[')) {
      this.i++
      if (this.peek().k === 'num') this.i++
      this.expectPunct(']')
      array++
    }
    if (this.eatKw('array')) array = Math.max(array, 1)
    return { name: normType(words.join(' ')), array }
  }

  // ---------------------------------------------------------------- expressions

  expr(minBp = 0): Expr {
    let left = this.prefix()
    for (;;) {
      const r = this.infix(left, minBp)
      if (!r) return left
      left = r
    }
  }

  private literalNumber(v: string): Expr {
    return /^[0-9]+$/.test(v) && v.length < 16 ? { k: 'lit', v: Number(v), type: 'int' } : { k: 'lit', v: Number(v), type: 'numeric' }
  }

  private prefix(): Expr {
    const tk = this.peek()
    if (tk.k === 'num') {
      this.i++
      return this.literalNumber(tk.v)
    }
    if (tk.k === 'str') {
      this.i++
      return { k: 'lit', v: tk.v, type: 'unknown' }
    }
    if (tk.k === 'param') {
      this.i++
      return { k: 'param', n: Number(tk.v) }
    }
    if (tk.k === 'op') {
      if (tk.v === '-' || tk.v === '+') {
        this.i++
        const e = this.expr(BP.unary)
        if (tk.v === '-' && e.k === 'lit' && typeof e.v === 'number') return { ...e, v: -e.v }
        return tk.v === '-' ? { k: 'un', op: '-', e } : e
      }
      if (tk.v === '*') {
        this.i++
        return { k: 'star' }
      }
      this.fail('unexpected operator')
    }
    if (tk.k === 'punct' && tk.v === '(') {
      this.i++
      if (this.isKw('select') || this.isKw('with') || this.isKw('values') || (this.isPunct('(') && this.looksLikeQuery())) {
        const q = this.query()
        this.expectPunct(')')
        return this.postfixParen({ k: 'sub', q })
      }
      const e = this.expr()
      if (this.isPunct(',')) {
        const items = [e]
        while (this.eatPunct(',')) items.push(this.expr())
        this.expectPunct(')')
        return { k: 'row', items }
      }
      this.expectPunct(')')
      return this.postfixParen(e)
    }
    if (tk.k !== 'id') this.fail('expected an expression')
    if (!tk.q) {
      switch (tk.v) {
        case 'null': this.i++; return { k: 'lit', v: null, type: 'null' }
        case 'true': this.i++; return { k: 'lit', v: true, type: 'bool' }
        case 'false': this.i++; return { k: 'lit', v: false, type: 'bool' }
        case 'not': this.i++; return { k: 'un', op: 'not', e: this.expr(BP.not) }
        case 'case': return this.caseExpr()
        case 'default': this.i++; return { k: 'default' }
        case 'exists':
          if (this.isPunct('(', 1)) {
            this.i += 2
            const q = this.query()
            this.expectPunct(')')
            return { k: 'exists', q }
          }
          break
        case 'array':
          if (this.isPunct('[', 1)) {
            this.i += 2
            return { k: 'array', items: this.arrayItems() }
          }
          if (this.isPunct('(', 1)) {
            this.i += 2
            const q = this.query()
            this.expectPunct(')')
            return { k: 'arraysub', q }
          }
          break
        case 'row':
          if (this.isPunct('(', 1)) {
            this.i += 2
            const items: Expr[] = []
            if (!this.isPunct(')')) do items.push(this.expr()); while (this.eatPunct(','))
            this.expectPunct(')')
            return { k: 'row', items }
          }
          break
        case 'cast':
          if (this.isPunct('(', 1)) {
            this.i += 2
            const e = this.expr()
            this.expectKw('as')
            const type = this.typeName()
            this.expectPunct(')')
            return { k: 'cast', e, type }
          }
          break
        case 'any': case 'all': case 'some':
          if (this.isPunct('(', 1)) {
            this.i += 2
            const quant = tk.v === 'all' ? 'all' : 'any'
            if (this.isKw('select') || this.isKw('with') || this.isKw('values')) {
              const q = this.query()
              this.expectPunct(')')
              return { k: 'quantarg', quant, q }
            }
            const e = this.expr()
            this.expectPunct(')')
            return { k: 'quantarg', quant, e }
          }
          break
        case 'extract':
          if (this.isPunct('(', 1)) {
            this.i += 2
            const fieldTok = this.next()
            const field = fieldTok.v.toLowerCase()
            this.expectKw('from')
            const e = this.expr()
            this.expectPunct(')')
            return { k: 'call', name: 'extract', args: [{ k: 'lit', v: field, type: 'unknown' }, e] }
          }
          break
        case 'substring':
          if (this.isPunct('(', 1)) return this.substringExpr()
          break
        case 'position':
          if (this.isPunct('(', 1)) {
            this.i += 2
            const needle = this.expr(BP.like)
            this.expectKw('in')
            const hay = this.expr()
            this.expectPunct(')')
            return { k: 'call', name: 'strpos', args: [hay, needle] }
          }
          break
        case 'trim':
          if (this.isPunct('(', 1)) return this.trimExpr()
          break
        case 'overlay':
          if (this.isPunct('(', 1)) {
            this.i += 2
            const s = this.expr()
            this.expectKw('placing')
            const p = this.expr()
            this.expectKw('from')
            const f = this.expr()
            const args = [s, p, f]
            if (this.eatKw('for')) args.push(this.expr())
            this.expectPunct(')')
            return { k: 'call', name: 'overlay', args }
          }
          break
        case 'current_date': case 'current_timestamp': case 'localtimestamp': case 'current_time': case 'localtime':
        case 'current_user': case 'session_user': case 'current_role': case 'current_schema': case 'user':
          if (!this.isPunct('(', 1) || tk.v === 'current_timestamp' || tk.v === 'current_schema') {
            this.i++
            if (this.isPunct('(') && tk.v === 'current_timestamp') { this.i++; this.next(); this.expectPunct(')') }
            if (this.isPunct('(') && tk.v === 'current_schema') { this.i++; this.expectPunct(')') }
            return { k: 'call', name: tk.v, args: [], bare: true }
          }
          break
        case 'interval':
          if (this.peek(1).k === 'str') {
            this.i++
            const s = this.next().v
            // interval '1' day
            const unit = this.peek()
            if (unit.k === 'id' && !unit.q && /^(years?|months?|days?|hours?|minutes?|seconds?|weeks?)$/.test(unit.v)) {
              this.i++
              return { k: 'cast', e: { k: 'lit', v: `${s} ${unit.v}`, type: 'unknown' }, type: { name: 'interval', array: 0 } }
            }
            return { k: 'cast', e: { k: 'lit', v: s, type: 'unknown' }, type: { name: 'interval', array: 0 } }
          }
          break
        case 'date': case 'timestamp': case 'timestamptz': case 'time': case 'uuid': case 'numeric': case 'jsonb': case 'json':
        case 'boolean': case 'text': case 'integer': case 'bigint':
          if (this.peek(1).k === 'str') {
            this.i++
            const s = this.next().v
            return { k: 'cast', e: { k: 'lit', v: s, type: 'unknown' }, type: { name: normType(tk.v), array: 0 } }
          }
          break
      }
    }
    // a name, a qualified name, or a function call
    this.i++
    const parts = [tk.v]
    while (this.isPunct('.')) {
      if (this.isOp('*', 1)) {
        this.i += 2
        return { k: 'star', table: parts.join('.') }
      }
      if (this.peek(1).k !== 'id') break
      this.i++
      parts.push(this.next().v)
    }
    if (this.isPunct('(')) return this.call(parts)
    return { k: 'ref', parts }
  }

  /** After "( … )": (expr).field, (expr).*, (expr)[i]. */
  private postfixParen(e: Expr): Expr {
    let out = e
    for (;;) {
      if (this.isPunct('.') && this.peek(1).k === 'id') {
        this.i++
        out = { k: 'field', e: out, name: this.next().v }
      } else if (this.isPunct('.') && this.isOp('*', 1)) {
        this.i += 2
        out = { k: 'field', e: out, name: '*' }
      } else return out
    }
  }

  private looksLikeQuery(): boolean {
    // "((select …) union …)": look through leading brackets.
    let k = 0
    while (this.isPunct('(', k)) k++
    return this.isKw('select', k) || this.isKw('with', k) || this.isKw('values', k)
  }

  private arrayItems(): Expr[] {
    const items: Expr[] = []
    if (!this.isPunct(']')) {
      do {
        if (this.isPunct('[')) {
          this.i++
          items.push({ k: 'array', items: this.arrayItems() })
        } else items.push(this.expr())
      } while (this.eatPunct(','))
    }
    this.expectPunct(']')
    return items
  }

  private caseExpr(): Expr {
    this.expectKw('case')
    const subject = this.isKw('when') ? undefined : this.expr()
    const whens: Array<{ when: Expr; then: Expr }> = []
    while (this.eatKw('when')) {
      const when = this.expr()
      this.expectKw('then')
      whens.push({ when, then: this.expr() })
    }
    const els = this.eatKw('else') ? this.expr() : undefined
    this.expectKw('end')
    return { k: 'case', subject, whens, else: els }
  }

  private substringExpr(): Expr {
    this.i += 2
    const s = this.expr()
    if (this.eatPunct(',')) {
      const args = [s, this.expr()]
      if (this.eatPunct(',')) args.push(this.expr())
      this.expectPunct(')')
      return { k: 'call', name: 'substring', args }
    }
    let from: Expr | undefined
    let len: Expr | undefined
    let similar = false
    if (this.eatKw('from')) from = this.expr()
    if (this.eatKw('for')) len = this.expr()
    if (this.eatKw('similar')) { similar = true; from = this.expr(); this.expectKw('escape'); this.expr() }
    this.expectPunct(')')
    if (similar) this.fail('SUBSTRING SIMILAR is not supported')
    const args = [s, from ?? { k: 'lit', v: 1, type: 'int' } as Expr]
    if (len) args.push(len)
    return { k: 'call', name: 'substring', args }
  }

  private trimExpr(): Expr {
    this.i += 2
    let side = 'both'
    if (this.isKw('both') || this.isKw('leading') || this.isKw('trailing')) side = this.next().v
    let chars: Expr | undefined
    let s: Expr
    if (this.eatKw('from')) s = this.expr()
    else {
      const first = this.expr()
      if (this.eatKw('from')) {
        chars = first
        s = this.expr()
      } else if (this.eatPunct(',')) {
        s = first
        chars = this.expr()
      } else s = first
    }
    this.expectPunct(')')
    const name = side === 'leading' ? 'ltrim' : side === 'trailing' ? 'rtrim' : 'btrim'
    return { k: 'call', name, args: chars ? [s, chars] : [s] }
  }

  private call(parts: string[]): Expr {
    this.expectPunct('(')
    const call: CallExpr = { k: 'call', name: parts[parts.length - 1], args: [] }
    if (parts.length > 1) call.schema = parts.slice(0, -1).join('.')
    if (this.isOp('*') && this.isPunct(')', 1)) {
      this.i += 2
      call.star = true
    } else if (!this.isPunct(')')) {
      if (this.eatKw('distinct')) call.distinct = true
      else this.eatKw('all')
      const names: Array<string | null> = []
      do {
        if (this.eatKw('variadic')) call.variadic = true
        if (this.peek().k === 'id' && (this.isOp('=>', 1) || this.isOp(':=', 1))) {
          names.push(this.next().v)
          this.i++
        } else names.push(null)
        call.args.push(this.expr())
      } while (this.eatPunct(','))
      if (names.some((n) => n !== null)) call.names = names
      if (this.eatKw('order', 'by')) call.order = this.orderItems()
      this.expectPunct(')')
    } else this.i++
    if (this.eatKw('within')) {
      this.expectKw('group')
      this.expectPunct('(')
      this.expectKw('order')
      this.expectKw('by')
      call.order = this.orderItems()
      this.expectPunct(')')
    }
    if (this.isKw('filter') && this.isPunct('(', 1)) {
      this.i += 2
      this.expectKw('where')
      call.filter = this.expr()
      this.expectPunct(')')
    }
    if (this.eatKw('over')) {
      if (this.peek().k === 'id' && !this.isPunct('(')) call.over = { name: this.name(), partition: [], order: [] }
      else call.over = this.windowSpec()
    }
    return call
  }

  windowSpec(): WindowSpec {
    this.expectPunct('(')
    const w: WindowSpec = { partition: [], order: [] }
    if (this.peek().k === 'id' && !['partition', 'order', 'rows', 'range', 'groups'].includes(this.peek().v)) w.name = this.name()
    if (this.eatKw('partition', 'by')) {
      do w.partition.push(this.expr()); while (this.eatPunct(','))
    }
    if (this.eatKw('order', 'by')) w.order = this.orderItems()
    if (this.isKw('rows') || this.isKw('range') || this.isKw('groups')) {
      const start = this.peek().pos
      let depth = 0
      while (!(depth === 0 && this.isPunct(')'))) {
        const tk = this.next()
        if (tk.k === 'eof') this.fail('unclosed window')
        if (tk.k === 'punct' && tk.v === '(') depth++
        if (tk.k === 'punct' && tk.v === ')') depth--
      }
      w.frame = this.src.slice(start, this.peek().pos)
    }
    this.expectPunct(')')
    return w
  }

  orderItems(): OrderItem[] {
    const items: OrderItem[] = []
    do {
      const item: OrderItem = { e: this.expr() }
      if (this.eatKw('desc')) item.desc = true
      else this.eatKw('asc')
      if (this.eatKw('using')) this.fail('ORDER BY USING is not supported')
      if (this.eatKw('nulls')) item.nulls = this.next().v === 'first' ? 'first' : 'last'
      items.push(item)
    } while (this.eatPunct(','))
    return items
  }

  /** The operator that continues `left`, or null when the expression ends here. */
  private infix(left: Expr, minBp: number): Expr | null {
    const tk = this.peek()
    if (tk.k === 'op') {
      const op = tk.v
      if (op === '::') {
        if (BP.cast < minBp) return null
        this.i++
        return { k: 'cast', e: left, type: this.typeName() }
      }
      if (op === ':=' || op === '=>' || op === '..' || op === ':') return null
      let bp: number
      if (COMPARE.has(op)) bp = BP.cmp
      else if (ARITH_ADD.has(op)) bp = BP.add
      else if (ARITH_MUL.has(op)) bp = BP.mul
      else if (op === '^') bp = BP.exp
      else bp = BP.other
      // Left-associative: an operator of the same strength ends the right operand.
      if (bp <= minBp) return null
      this.i++
      const right = this.expr(bp)
      if (right.k === 'quantarg') {
        return { k: 'quant', op: op === '!=' ? '<>' : op, l: left, quant: right.quant, r: right.e, q: right.q }
      }
      return { k: 'bin', op: op === '!=' ? '<>' : op === '~~' ? 'like' : op, l: left, r: right }
    }
    if (tk.k === 'punct' && tk.v === '[') {
      if (BP.index < minBp) return null
      this.i++
      let idx: Expr | undefined
      let upper: Expr | undefined
      let slice = false
      if (!this.isOp(':')) idx = this.expr()
      if (this.eatOp(':')) {
        slice = true
        if (!this.isPunct(']')) upper = this.expr()
      }
      this.expectPunct(']')
      return { k: 'index', e: left, idx, upper, slice }
    }
    if (tk.k !== 'id' || tk.q) return null
    switch (tk.v) {
      case 'and':
        if (BP.and <= minBp) return null
        this.i++
        return { k: 'bin', op: 'and', l: left, r: this.expr(BP.and) }
      case 'or':
        if (BP.or <= minBp) return null
        this.i++
        return { k: 'bin', op: 'or', l: left, r: this.expr(BP.or) }
      case 'is': {
        if (BP.is <= minBp) return null
        this.i++
        const not = this.eatKw('not')
        if (this.eatKw('null')) return { k: 'is', e: left, what: 'null', not }
        if (this.eatKw('true')) return { k: 'is', e: left, what: 'true', not }
        if (this.eatKw('false')) return { k: 'is', e: left, what: 'false', not }
        if (this.eatKw('unknown')) return { k: 'is', e: left, what: 'unknown', not }
        if (this.eatKw('distinct')) {
          this.expectKw('from')
          return { k: 'isdistinct', l: left, r: this.expr(BP.is), not }
        }
        return this.fail('unsupported IS')
      }
      case 'isnull':
        if (BP.is <= minBp) return null
        this.i++
        return { k: 'is', e: left, what: 'null', not: false }
      case 'notnull':
        if (BP.is <= minBp) return null
        this.i++
        return { k: 'is', e: left, what: 'null', not: true }
      case 'not': {
        const nx = this.peek(1)
        if (nx.k !== 'id' || !['in', 'like', 'ilike', 'between', 'similar'].includes(nx.v)) return null
        if (BP.like <= minBp) return null
        this.i++
        return this.likeFamily(left, true)
      }
      case 'in': case 'like': case 'ilike': case 'between': case 'similar':
        if (BP.like <= minBp) return null
        return this.likeFamily(left, false)
      case 'at':
        if (!this.isKw('time', 1) || !this.isKw('zone', 2) || BP.at <= minBp) return null
        this.i += 3
        return { k: 'attz', e: left, zone: this.expr(BP.at) }
      case 'collate':
        if (BP.collate <= minBp) return null
        this.i++
        this.name()
        if (this.eatPunct('.')) this.name()
        return left
    }
    return null
  }

  private likeFamily(left: Expr, not: boolean): Expr {
    const word = this.next().v
    if (word === 'in') {
      this.expectPunct('(')
      if (this.isKw('select') || this.isKw('with') || this.isKw('values')) {
        const q = this.query()
        this.expectPunct(')')
        return { k: 'in', e: left, q, not }
      }
      const list: Expr[] = []
      do list.push(this.expr()); while (this.eatPunct(','))
      this.expectPunct(')')
      return { k: 'in', e: left, list, not }
    }
    if (word === 'between') {
      this.eatKw('symmetric')
      const lo = this.expr(BP.like)
      this.expectKw('and')
      const hi = this.expr(BP.like)
      return { k: 'between', e: left, lo, hi, not }
    }
    let similar = false
    if (word === 'similar') {
      this.expectKw('to')
      similar = true
    }
    const ci = word === 'ilike'
    const p = this.expr(BP.like)
    if (p.k === 'quantarg') {
      return { k: 'quant', op: ci ? (not ? 'not ilike' : 'ilike') : not ? 'not like' : 'like', l: left, quant: p.quant, r: p.e, q: p.q }
    }
    const escape = this.eatKw('escape') ? this.expr(BP.like) : undefined
    return { k: 'like', e: left, p, ci, not, similar, escape }
  }

  // ---------------------------------------------------------------- queries

  /** SELECT / VALUES / WITH … / ( query ), with set operations, ORDER BY and LIMIT. */
  query(): Query {
    let withClause: With | undefined
    if (this.isKw('with')) withClause = this.withClause()
    let q = this.queryTerm()
    while (this.isKw('union') || this.isKw('intersect') || this.isKw('except')) {
      const op = this.next().v as 'union' | 'intersect' | 'except'
      const all = this.eatKw('all')
      if (!all) this.eatKw('distinct')
      const r = this.queryTerm()
      q = { k: 'setop', op, all, l: q, r, orderBy: [] }
    }
    this.queryTail(q)
    if (withClause) {
      if (q.k === 'values') q = { k: 'select', items: [{ e: { k: 'star' } }], from: [{ k: 'subq', q, alias: '_values', lateral: false }], groupBy: [], orderBy: [] }
      ;(q as Select | SetOp).with = withClause
    }
    return q
  }

  private queryTerm(): Query {
    if (this.isPunct('(')) {
      this.i++
      const q = this.query()
      this.expectPunct(')')
      return q
    }
    if (this.isKw('values')) return this.values()
    return this.selectCore()
  }

  queryTail(q: Query): void {
    const target = q as Select
    if (this.eatKw('order', 'by')) target.orderBy = this.orderItems()
    for (;;) {
      if (this.eatKw('limit')) {
        if (this.eatKw('all')) continue
        target.limit = this.expr()
      } else if (this.eatKw('offset')) {
        target.offset = this.expr()
        if (!this.eatKw('rows')) this.eatKw('row')
      } else if (this.isKw('fetch')) {
        this.i++
        if (!this.eatKw('first')) this.eatKw('next')
        target.limit = this.isKw('rows') || this.isKw('row') ? { k: 'lit', v: 1, type: 'int' } : this.expr()
        if (!this.eatKw('rows')) this.eatKw('row')
        this.expectKw('only')
      } else if (this.isKw('for') && (this.isKw('update', 1) || this.isKw('share', 1) || this.isKw('no', 1) || this.isKw('key', 1))) {
        this.i++
        while (this.eatKw('no') || this.eatKw('key') || this.eatKw('update') || this.eatKw('share')) { /* lock strength */ }
        if (this.eatKw('of')) {
          do this.name(); while (this.eatPunct(','))
        }
        if (!this.eatKw('nowait')) this.eatKw('skip', 'locked')
        target.lock = true
      } else if (this.opts.into && this.isKw('into') && q.k !== 'values' && !(q as Select).into) {
        ;(q as Select).into = this.intoClause()
      } else break
    }
  }

  intoClause(): Into {
    this.expectKw('into')
    const strict = this.eatKw('strict')
    const targets: Expr[] = []
    do {
      const parts = [this.name()]
      while (this.isPunct('.') && this.peek(1).k === 'id') {
        this.i++
        parts.push(this.next().v)
      }
      targets.push({ k: 'ref', parts })
    } while (this.eatPunct(','))
    return { strict, targets }
  }

  private values(): Values {
    this.expectKw('values')
    const rows: Expr[][] = []
    do {
      this.expectPunct('(')
      const row: Expr[] = []
      do row.push(this.expr()); while (this.eatPunct(','))
      this.expectPunct(')')
      rows.push(row)
    } while (this.eatPunct(','))
    return { k: 'values', rows, orderBy: [] }
  }

  private selectCore(): Select {
    this.expectKw('select')
    const s: Select = { k: 'select', items: [], from: [], groupBy: [], orderBy: [] }
    if (this.eatKw('distinct')) {
      if (this.eatKw('on')) {
        this.expectPunct('(')
        const on: Expr[] = []
        do on.push(this.expr()); while (this.eatPunct(','))
        this.expectPunct(')')
        s.distinct = on
      } else s.distinct = true
    } else this.eatKw('all')
    if (!this.isKw('from') && !this.isKw('into') && !this.isPunct(';') && !this.isPunct(')') && this.peek().k !== 'eof') s.items = this.selectItems()
    return this.selectRest(s)
  }

  /** FROM … WHERE … GROUP BY … HAVING … WINDOW … of a SELECT whose list is already read. */
  selectRest(s: Select): Select {
    if (this.opts.into && this.isKw('into')) s.into = this.intoClause()
    if (this.eatKw('from')) s.from = this.fromList()
    if (this.opts.into && this.isKw('into') && !s.into) s.into = this.intoClause()
    if (this.eatKw('where')) s.where = this.expr()
    if (this.eatKw('group', 'by')) {
      do s.groupBy.push(this.expr()); while (this.eatPunct(','))
    }
    if (this.eatKw('having')) s.having = this.expr()
    if (this.eatKw('window')) {
      s.windows = {}
      do {
        const name = this.name()
        this.expectKw('as')
        s.windows[name] = this.windowSpec()
      } while (this.eatPunct(','))
    }
    return s
  }

  selectItems(): SelItem[] {
    const items: SelItem[] = []
    do {
      const e = this.expr()
      const alias = e.k === 'star' ? undefined : this.alias()
      items.push(alias ? { e, alias } : { e })
    } while (this.eatPunct(','))
    return items
  }

  withClause(): With {
    this.expectKw('with')
    const recursive = this.eatKw('recursive')
    const ctes: Cte[] = []
    do {
      const name = this.name()
      let cols: string[] | undefined
      if (this.isPunct('(')) cols = this.nameList()
      this.expectKw('as')
      let materialized: boolean | undefined
      if (this.eatKw('materialized')) materialized = true
      else if (this.eatKw('not', 'materialized')) materialized = false
      this.expectPunct('(')
      const q = this.statement()
      this.expectPunct(')')
      ctes.push({ name, cols, q, materialized })
    } while (this.eatPunct(','))
    return { recursive, ctes }
  }

  nameList(): string[] {
    this.expectPunct('(')
    const out: string[] = []
    do out.push(this.name()); while (this.eatPunct(','))
    this.expectPunct(')')
    return out
  }

  // ---------------------------------------------------------------- FROM

  fromList(): FromItem[] {
    const items: FromItem[] = []
    do items.push(this.fromItem()); while (this.eatPunct(','))
    return items
  }

  private fromItem(): FromItem {
    let left = this.fromPrimary()
    for (;;) {
      let type: 'inner' | 'left' | 'right' | 'full' | 'cross' | null = null
      if (this.eatKw('cross', 'join')) type = 'cross'
      else if (this.eatKw('join') || this.eatKw('inner', 'join')) type = 'inner'
      else if (this.eatKw('left', 'join') || this.eatKw('left', 'outer', 'join')) type = 'left'
      else if (this.eatKw('right', 'join') || this.eatKw('right', 'outer', 'join')) type = 'right'
      else if (this.eatKw('full', 'join') || this.eatKw('full', 'outer', 'join')) type = 'full'
      if (!type) return left
      const right = this.fromPrimary()
      const join: FromItem = { k: 'join', type, l: left, r: right }
      if (type !== 'cross') {
        if (this.eatKw('on')) join.on = this.expr()
        else if (this.eatKw('using')) join.using = this.nameList()
      }
      left = join
    }
  }

  private fromPrimary(): FromItem {
    const lateral = this.eatKw('lateral')
    if (this.isPunct('(')) {
      if (this.looksLikeQueryAt(1)) {
        this.i++
        const q = this.query()
        this.expectPunct(')')
        const alias = this.alias()
        const cols = alias && this.isPunct('(') ? this.nameList() : undefined
        return { k: 'subq', q, alias, cols, lateral }
      }
      this.i++
      const inner = this.fromItem()
      this.expectPunct(')')
      return inner
    }
    this.eatKw('only')
    let schema: string | undefined
    let name = this.name()
    if (this.isPunct('.') && this.peek(1).k === 'id') {
      this.i++
      schema = name
      name = this.name()
    }
    if (this.isPunct('(')) {
      const call = this.call(schema ? [schema, name] : [name]) as CallExpr
      const ordinality = this.eatKw('with', 'ordinality')
      const alias = this.alias()
      let cols: string[] | undefined
      let coldefs: Array<{ name: string; type: TypeName }> | undefined
      if (this.isPunct('(')) {
        // AS r(a int, b text) defines the columns; AS r(a, b) renames them.
        const isDef = this.peek(2).k === 'id' && !this.isPunct(',', 2) && !this.isPunct(')', 2)
        if (isDef) {
          this.i++
          coldefs = []
          do coldefs.push({ name: this.name(), type: this.typeName() }); while (this.eatPunct(','))
          this.expectPunct(')')
        } else cols = this.nameList()
      }
      return { k: 'func', call, alias, cols, coldefs, lateral, ordinality }
    }
    const alias = this.alias()
    const cols = alias && this.isPunct('(') ? this.nameList() : undefined
    return { k: 'table', schema, name, alias, cols }
  }

  private looksLikeQueryAt(k: number): boolean {
    let j = k
    while (this.isPunct('(', j)) j++
    return this.isKw('select', j) || this.isKw('with', j) || this.isKw('values', j)
  }

  // ---------------------------------------------------------------- statements

  statement(): Statement {
    let withClause: With | undefined
    if (this.isKw('with')) {
      const save = this.i
      withClause = this.withClause()
      if (!this.isKw('insert') && !this.isKw('update') && !this.isKw('delete')) {
        this.i = save
        return this.query()
      }
    }
    let st: Statement
    if (this.isKw('insert')) st = this.insert()
    else if (this.isKw('update')) st = this.update()
    else if (this.isKw('delete')) st = this.delete()
    else return this.query()
    if (withClause) st.with = withClause
    return st
  }

  private targetTable(): { schema?: string; table: string } {
    let table = this.name()
    let schema: string | undefined
    if (this.isPunct('.') && this.peek(1).k === 'id') {
      this.i++
      schema = table
      table = this.name()
    }
    return { schema, table }
  }

  private returning(st: Insert | Update | Delete): void {
    if (this.eatKw('returning')) st.returning = this.selectItems()
    if (this.opts.into && this.isKw('into')) st.into = this.intoClause()
  }

  private insert(): Insert {
    this.expectKw('insert')
    this.expectKw('into')
    const st: Insert = { k: 'insert', ...this.targetTable(), source: 'default' }
    if (this.eatKw('as')) st.alias = this.name()
    if (this.isPunct('(') && !this.looksLikeQueryAt(1)) st.cols = this.nameList()
    if (this.eatKw('overriding')) {
      this.next()
      this.expectKw('value')
    }
    if (this.eatKw('default', 'values')) st.source = 'default'
    else st.source = this.query()
    if (this.eatKw('on', 'conflict')) {
      const c: Conflict = { action: 'nothing' }
      if (this.isPunct('(')) {
        this.i++
        c.target = []
        do c.target.push(this.expr()); while (this.eatPunct(','))
        this.expectPunct(')')
        if (this.eatKw('where')) c.where = this.expr()
      } else if (this.eatKw('on', 'constraint')) c.constraint = this.name()
      this.expectKw('do')
      if (this.eatKw('nothing')) c.action = 'nothing'
      else {
        this.expectKw('update')
        this.expectKw('set')
        const set = this.setItems()
        c.action = { set, where: this.eatKw('where') ? this.expr() : undefined }
      }
      st.conflict = c
    }
    this.returning(st)
    return st
  }

  private setItems(): SetItem[] {
    const items: SetItem[] = []
    do {
      if (this.isPunct('(')) {
        const cols = this.nameList()
        this.expectOp('=')
        items.push({ cols, e: this.expr() })
      } else {
        const col = this.name()
        if (this.isPunct('.') || this.isPunct('[')) this.fail('assigning to a field or element is not supported')
        this.expectOp('=')
        items.push({ cols: [col], e: this.expr() })
      }
    } while (this.eatPunct(','))
    return items
  }

  private update(): Update {
    this.expectKw('update')
    this.eatKw('only')
    const st: Update = { k: 'update', ...this.targetTable(), set: [], from: [] }
    st.alias = this.isKw('set') ? undefined : this.alias()
    this.expectKw('set')
    st.set = this.setItems()
    if (this.eatKw('from')) st.from = this.fromList()
    if (this.eatKw('where')) st.where = this.expr()
    this.returning(st)
    return st
  }

  private delete(): Delete {
    this.expectKw('delete')
    this.expectKw('from')
    this.eatKw('only')
    const st: Delete = { k: 'delete', ...this.targetTable(), using: [] }
    st.alias = this.isKw('using') || this.isKw('where') || this.isKw('returning') ? undefined : this.alias()
    if (this.eatKw('using')) st.using = this.fromList()
    if (this.eatKw('where')) st.where = this.expr()
    this.returning(st)
    return st
  }

  /** Statements separated by semicolons, to the end of the input. */
  statements(): Statement[] {
    const out: Statement[] = []
    for (;;) {
      while (this.eatPunct(';')) { /* empty */ }
      if (this.peek().k === 'eof') return out
      out.push(this.statement())
      if (!this.isPunct(';') && this.peek().k !== 'eof') this.fail('expected ";"')
    }
  }
}

export function parseStatements(src: string, opts: ParseOptions = {}): Statement[] {
  return Parser.of(src, opts).statements()
}

export function parseExpr(src: string): Expr {
  const p = Parser.of(src)
  const e = p.expr()
  if (p.peek().k !== 'eof') p.fail('unexpected input after the expression')
  return e
}
