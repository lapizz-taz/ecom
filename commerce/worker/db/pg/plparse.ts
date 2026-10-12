// PL/pgSQL parser: function bodies as written in the migrations (DECLARE / BEGIN /
// EXCEPTION blocks, IF, CASE, loops, RETURN [NEXT | QUERY], RAISE, PERFORM, GET
// DIAGNOSTICS, EXECUTE and SQL statements with INTO).
import type { Expr, Into, Select, Statement, TypeName } from './ast.ts'
import { lex } from './lex.ts'
import { Parser } from './parse.ts'
import { normType } from './types.ts'

export interface Decl {
  name: string
  type: TypeName
  constant: boolean
  notNull: boolean
  default?: Expr
  /** name ALIAS FOR $n */
  alias?: number
}

export interface Handler {
  /** Condition names (unique_violation, others) or SQLSTATE codes. */
  conditions: string[]
  body: PlStmt[]
}

export type PlStmt =
  | { k: 'block'; label?: string; decls: Decl[]; body: PlStmt[]; handlers?: Handler[] }
  | { k: 'assign'; target: Expr; e: Expr }
  | { k: 'if'; branches: Array<{ cond: Expr; body: PlStmt[] }>; else?: PlStmt[] }
  | { k: 'case'; subject?: Expr; whens: Array<{ values: Expr[]; body: PlStmt[] }>; else?: PlStmt[] }
  | { k: 'loop'; label?: string; body: PlStmt[] }
  | { k: 'while'; label?: string; cond: Expr; body: PlStmt[] }
  | { k: 'fori'; label?: string; var: string; reverse: boolean; lo: Expr; hi: Expr; by?: Expr; body: PlStmt[] }
  | { k: 'forq'; label?: string; targets: Expr[]; q?: Statement; execute?: { e: Expr; using: Expr[] }; body: PlStmt[] }
  | { k: 'foreach'; label?: string; targets: Expr[]; slice: number; arr: Expr; body: PlStmt[] }
  | { k: 'exit' | 'continue'; label?: string; when?: Expr }
  | { k: 'return'; e?: Expr }
  | { k: 'return_next'; e?: Expr }
  | { k: 'return_query'; q: Statement }
  | { k: 'raise'; level: string; fmt?: string; args: Expr[]; options: Array<{ name: string; e: Expr }>; condition?: string; sqlstate?: string }
  | { k: 'perform'; q: Statement }
  | { k: 'sql'; st: Statement }
  | { k: 'getdiag'; stacked: boolean; items: Array<{ target: Expr; item: string }> }
  | { k: 'execute'; e: Expr; into?: Into; using: Expr[] }
  | { k: 'null' }
  | { k: 'assert'; cond: Expr; msg?: Expr }
  /** CREATE / DROP / TRUNCATE / SET, kept as written (src) for the interpreter to handle. */
  | { k: 'utility'; word: string; src: string }

const LEVELS = new Set(['debug', 'log', 'info', 'notice', 'warning', 'exception'])

class PlParser extends Parser {
  /** The function body: [DECLARE …] BEGIN … END. */
  body(): PlStmt {
    const label = this.label()
    const b = this.block(label)
    this.eatPunct(';')
    if (this.peek().k !== 'eof') this.fail('unexpected input after the function body')
    return b
  }

  private label(): string | undefined {
    if (this.isOp('<<') && this.peek(1).k === 'id' && this.isOp('>>', 2)) {
      this.i++
      const name = this.name()
      this.i++
      return name
    }
    return undefined
  }

  private block(label?: string): PlStmt {
    const decls: Decl[] = []
    while (this.eatKw('declare')) {
      while (!this.isKw('begin') && !this.isKw('declare')) decls.push(this.decl())
    }
    this.expectKw('begin')
    const body = this.stmts(['end', 'exception'])
    let handlers: Handler[] | undefined
    if (this.eatKw('exception')) {
      handlers = []
      while (this.eatKw('when')) {
        const conditions: string[] = []
        do {
          if (this.eatKw('sqlstate')) {
            const tk = this.next()
            conditions.push(tk.v.toUpperCase())
          } else conditions.push(this.name())
        } while (this.eatKw('or'))
        this.expectKw('then')
        handlers.push({ conditions, body: this.stmts(['when', 'end']) })
      }
    }
    this.expectKw('end')
    if (this.peek().k === 'id' && !this.isPunct(';')) {
      if (this.peek().v === label) this.i++
    }
    return { k: 'block', label, decls, body, handlers }
  }

  private decl(): Decl {
    const name = this.name()
    if (this.eatKw('alias')) {
      this.expectKw('for')
      const tk = this.next()
      if (tk.k !== 'param') this.fail('ALIAS FOR needs $n')
      this.expectPunct(';')
      return { name, type: { name: 'unknown', array: 0 }, constant: false, notNull: false, alias: Number(tk.v) }
    }
    const constant = this.eatKw('constant')
    const type = this.declType()
    if (this.eatKw('collate')) this.name()
    const notNull = this.eatKw('not', 'null')
    let dflt: Expr | undefined
    if (this.eatOp(':=') || this.eatOp('=') || this.eatKw('default')) dflt = this.expr()
    this.expectPunct(';')
    return { name, type, constant, notNull, default: dflt }
  }

  /** A type, or table%rowtype / table.column%type / variable%type. */
  private declType(): TypeName {
    const save = this.i
    const parts = [this.name()]
    while (this.isPunct('.') && this.peek(1).k === 'id') {
      this.i++
      parts.push(this.name())
    }
    if (this.isOp('%')) {
      this.i++
      const kind = this.name()
      const named = parts.filter((p) => p !== 'public')
      if (kind === 'rowtype') return { name: normType(named[0]), array: 0, pct: 'rowtype' }
      if (kind === 'type') return named.length > 1 ? { name: named[0], column: named[1], array: 0, pct: 'type' } : { name: named[0], array: 0, pct: 'type' }
      this.fail(`unknown %${kind}`)
    }
    this.i = save
    return this.typeName()
  }

  /** Statements until one of the given words (not consumed). */
  private stmts(until: string[]): PlStmt[] {
    const out: PlStmt[] = []
    for (;;) {
      if (until.some((w) => this.isKw(w))) return out
      if (this.peek().k === 'eof') this.fail(`expected ${until.join(' or ').toUpperCase()}`)
      out.push(this.stmt())
    }
  }

  private endWith(...words: string[]): void {
    for (const w of words) this.expectKw(w)
    if (this.peek().k === 'id' && !this.isPunct(';')) this.i++ // END LOOP label
    this.expectPunct(';')
  }

  private stmt(): PlStmt {
    const label = this.label()
    const tk = this.peek()
    if (tk.k !== 'id' || tk.q) {
      if (tk.k === 'id') return this.assignment()
      this.fail('expected a statement')
    }
    switch (tk.v) {
      case 'declare':
      case 'begin': {
        const b = this.block(label)
        this.expectPunct(';')
        return b
      }
      case 'if': return this.ifStmt()
      case 'case': return this.caseStmt()
      case 'loop': {
        this.i++
        const body = this.stmts(['end'])
        this.endWith('end', 'loop')
        return { k: 'loop', label, body }
      }
      case 'while': {
        this.i++
        const cond = this.expr()
        this.expectKw('loop')
        const body = this.stmts(['end'])
        this.endWith('end', 'loop')
        return { k: 'while', label, cond, body }
      }
      case 'for': return this.forStmt(label)
      case 'foreach': {
        this.i++
        const targets = this.targets()
        let slice = 0
        if (this.eatKw('slice')) slice = Number(this.next().v)
        this.expectKw('in')
        this.expectKw('array')
        const arr = this.expr()
        this.expectKw('loop')
        const body = this.stmts(['end'])
        this.endWith('end', 'loop')
        return { k: 'foreach', label, targets, slice, arr, body }
      }
      case 'exit':
      case 'continue': {
        this.i++
        let lbl: string | undefined
        if (this.peek().k === 'id' && !this.isKw('when')) lbl = this.name()
        const when = this.eatKw('when') ? this.expr() : undefined
        this.expectPunct(';')
        return { k: tk.v as 'exit' | 'continue', label: lbl, when }
      }
      case 'return': {
        this.i++
        if (this.eatKw('next')) {
          const e = this.isPunct(';') ? undefined : this.expr()
          this.expectPunct(';')
          return { k: 'return_next', e }
        }
        if (this.eatKw('query')) {
          if (this.isKw('execute')) this.fail('RETURN QUERY EXECUTE is not supported')
          const q = this.statement()
          this.expectPunct(';')
          return { k: 'return_query', q }
        }
        if (this.eatPunct(';')) return { k: 'return' }
        const e = this.rhs()
        this.expectPunct(';')
        return { k: 'return', e }
      }
      case 'raise': return this.raise()
      case 'perform': {
        // PERFORM … is SELECT … with the result thrown away.
        this.t[this.i] = { ...this.t[this.i], v: 'select' }
        const q = this.statement()
        this.expectPunct(';')
        return { k: 'perform', q }
      }
      case 'get': {
        this.i++
        const stacked = this.eatKw('stacked')
        if (!stacked) this.eatKw('current')
        this.expectKw('diagnostics')
        const items: Array<{ target: Expr; item: string }> = []
        do {
          const target = this.targetExpr()
          if (!this.eatOp(':=')) this.expectOp('=')
          items.push({ target, item: this.name() })
        } while (this.eatPunct(','))
        this.expectPunct(';')
        return { k: 'getdiag', stacked, items }
      }
      case 'execute': {
        this.i++
        const e = this.expr()
        let into: Into | undefined
        const using: Expr[] = []
        for (;;) {
          if (this.isKw('into')) into = this.intoClause()
          else if (this.eatKw('using')) {
            do using.push(this.expr()); while (this.eatPunct(','))
          } else break
        }
        this.expectPunct(';')
        return { k: 'execute', e, into, using }
      }
      case 'null':
        if (this.isPunct(';', 1)) {
          this.i += 2
          return { k: 'null' }
        }
        break
      case 'assert': {
        this.i++
        const cond = this.expr()
        const msg = this.eatPunct(',') ? this.expr() : undefined
        this.expectPunct(';')
        return { k: 'assert', cond, msg }
      }
      case 'select': case 'with': case 'insert': case 'update': case 'delete': case 'values': {
        // an assignment to a variable named like a keyword is not used; these start SQL
        if (this.isOp(':=', 1) || (this.isOp('=', 1) && tk.v !== 'select')) break
        const st = this.statement()
        this.expectPunct(';')
        return { k: 'sql', st }
      }
      case 'set': case 'create': case 'drop': case 'truncate': case 'analyze': case 'lock': {
        if (this.isOp(':=', 1) || this.isOp('=', 1)) break
        const start = this.peek().pos
        while (!this.isPunct(';')) {
          if (this.peek().k === 'eof') this.fail('expected ";"')
          this.i++
        }
        const src = this.src.slice(start, this.peek().pos)
        this.i++
        return { k: 'utility', word: tk.v, src }
      }
      case 'commit': case 'rollback':
        this.fail('transaction control inside a function is not supported')
    }
    return this.assignment()
  }

  /** The right-hand side of := or RETURN: an expression, or SELECT-list FROM … (PL/pgSQL runs it as a query). */
  private rhs(): Expr {
    const e = this.expr()
    if (this.isKw('from') || this.isKw('where')) {
      const s: Select = { k: 'select', items: [{ e }], from: [], groupBy: [], orderBy: [] }
      this.selectRest(s)
      this.queryTail(s)
      return { k: 'sub', q: s }
    }
    return e
  }

  private targetExpr(): Expr {
    const parts = [this.name()]
    while (this.isPunct('.') && this.peek(1).k === 'id') {
      this.i++
      parts.push(this.next().v)
    }
    let target: Expr = { k: 'ref', parts }
    while (this.isPunct('[')) {
      this.i++
      const idx = this.expr()
      this.expectPunct(']')
      target = { k: 'index', e: target, idx, slice: false }
    }
    return target
  }

  private targets(): Expr[] {
    const out: Expr[] = []
    do out.push(this.targetExpr()); while (this.eatPunct(','))
    return out
  }

  private assignment(): PlStmt {
    const target = this.targetExpr()
    if (!this.eatOp(':=')) this.expectOp('=')
    const e = this.rhs()
    this.expectPunct(';')
    return { k: 'assign', target, e }
  }

  private ifStmt(): PlStmt {
    this.expectKw('if')
    const branches: Array<{ cond: Expr; body: PlStmt[] }> = []
    let cond = this.expr()
    this.expectKw('then')
    branches.push({ cond, body: this.stmts(['elsif', 'elseif', 'else', 'end']) })
    let els: PlStmt[] | undefined
    for (;;) {
      if (this.eatKw('elsif') || this.eatKw('elseif')) {
        cond = this.expr()
        this.expectKw('then')
        branches.push({ cond, body: this.stmts(['elsif', 'elseif', 'else', 'end']) })
      } else if (this.eatKw('else')) {
        els = this.stmts(['end'])
      } else break
    }
    this.expectKw('end')
    this.expectKw('if')
    this.expectPunct(';')
    return { k: 'if', branches, else: els }
  }

  private caseStmt(): PlStmt {
    this.expectKw('case')
    const subject = this.isKw('when') ? undefined : this.expr()
    const whens: Array<{ values: Expr[]; body: PlStmt[] }> = []
    while (this.eatKw('when')) {
      const values: Expr[] = []
      do values.push(this.expr()); while (subject && this.eatPunct(','))
      this.expectKw('then')
      whens.push({ values, body: this.stmts(['when', 'else', 'end']) })
    }
    const els = this.eatKw('else') ? this.stmts(['end']) : undefined
    this.expectKw('end')
    this.expectKw('case')
    this.expectPunct(';')
    return { k: 'case', subject, whens, else: els }
  }

  private forStmt(label?: string): PlStmt {
    this.expectKw('for')
    const targets = this.targets()
    this.expectKw('in')
    if (this.isKw('execute')) {
      this.i++
      const e = this.expr()
      const using: Expr[] = []
      if (this.eatKw('using')) {
        do using.push(this.expr()); while (this.eatPunct(','))
      }
      this.expectKw('loop')
      const body = this.stmts(['end'])
      this.endWith('end', 'loop')
      return { k: 'forq', label, targets, execute: { e, using }, body }
    }
    if (this.isKw('select') || this.isKw('with') || this.isKw('values') || this.isKw('update') || this.isKw('insert') || this.isKw('delete') ||
      (this.isPunct('(') && this.queryAhead())) {
      const q = this.statement()
      this.expectKw('loop')
      const body = this.stmts(['end'])
      this.endWith('end', 'loop')
      return { k: 'forq', label, targets, q, body }
    }
    const reverse = this.eatKw('reverse')
    const lo = this.expr()
    this.expectOp('..')
    const hi = this.expr()
    const by = this.eatKw('by') ? this.expr() : undefined
    this.expectKw('loop')
    const body = this.stmts(['end'])
    this.endWith('end', 'loop')
    const t = targets[0]
    if (targets.length !== 1 || t.k !== 'ref' || t.parts.length !== 1) this.fail('integer FOR needs one variable')
    return { k: 'fori', label, var: t.parts[0], reverse, lo, hi, by, body }
  }

  private queryAhead(): boolean {
    let j = 0
    while (this.isPunct('(', j)) j++
    return this.isKw('select', j) || this.isKw('with', j)
  }

  private raise(): PlStmt {
    this.expectKw('raise')
    let level = 'exception'
    if (this.peek().k === 'id' && LEVELS.has(this.peek().v)) level = this.next().v
    const st: PlStmt & { k: 'raise' } = { k: 'raise', level, args: [], options: [] }
    if (this.peek().k === 'str') {
      st.fmt = this.next().v
      while (this.eatPunct(',')) st.args.push(this.expr())
    } else if (this.eatKw('sqlstate')) {
      st.sqlstate = this.next().v.toUpperCase()
    } else if (this.peek().k === 'id' && !this.isKw('using')) {
      st.condition = this.name()
    }
    if (this.eatKw('using')) {
      do {
        const name = this.name()
        if (!this.eatOp(':=')) this.expectOp('=')
        st.options.push({ name, e: this.expr() })
      } while (this.eatPunct(','))
    }
    this.expectPunct(';')
    return st
  }
}

/** Parses a PL/pgSQL function body (pg_proc.prosrc). */
export function parseFunction(src: string): PlStmt {
  return new PlParser(lex(src), src, { into: true }).body()
}
