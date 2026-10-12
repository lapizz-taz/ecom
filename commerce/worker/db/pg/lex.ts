// Tokenizer for the SQL and PL/pgSQL the Postgres migrations contain: comments,
// '…' / E'…' / $tag$…$tag$ strings, "quoted" names, $1 parameters and Postgres'
// multi-character operators.

export type TokKind = 'id' | 'str' | 'num' | 'op' | 'param' | 'punct' | 'eof'

export interface Tok {
  k: TokKind
  /** Lower-cased for unquoted names; the text for strings, numbers and operators. */
  v: string
  /** A "quoted" name (keeps case, never a keyword). */
  q?: boolean
  pos: number
}

const OPS = ['::', ':=', '=>', '..', '!~~*', '~~*', '!~~', '~~', '!~*', '~*', '!~', '<>', '!=', '<=', '>=', '||', '->>', '->', '#>>', '#>', '#-',
  '@>', '<@', '?|', '?&', '<<', '>>', '&&', '=', '<', '>', '+', '-', '*', '/', '%', '^', '~', '?', '|', '&', '#', '@', ':']

export class SqlSyntaxError extends Error {
  constructor(message: string, readonly pos: number) {
    super(message)
  }
}

export function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue }
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < n && depth) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2 } else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2 } else i++
      }
      continue
    }
    const start = i
    // E'…' (backslash escapes)
    if ((c === 'e' || c === 'E') && src[i + 1] === "'") {
      i += 2
      let v = ''
      for (;;) {
        if (i >= n) throw new SqlSyntaxError('unterminated string', start)
        const ch = src[i]
        if (ch === '\\') {
          const e = src[i + 1]
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e
          i += 2
          continue
        }
        if (ch === "'") {
          if (src[i + 1] === "'") { v += "'"; i += 2; continue }
          i++
          break
        }
        v += ch
        i++
      }
      out.push({ k: 'str', v, pos: start })
      continue
    }
    if (c === "'") {
      i++
      let v = ''
      for (;;) {
        if (i >= n) throw new SqlSyntaxError('unterminated string', start)
        if (src[i] === "'") {
          if (src[i + 1] === "'") { v += "'"; i += 2; continue }
          i++
          break
        }
        v += src[i++]
      }
      // 'a' 'b' on separate lines concatenate; not used in the migrations.
      out.push({ k: 'str', v, pos: start })
      continue
    }
    if (c === '$') {
      const m = /^\$([0-9]+)/.exec(src.slice(i, i + 12))
      if (m) {
        out.push({ k: 'param', v: m[1], pos: start })
        i += m[0].length
        continue
      }
      const d = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64))
      if (d) {
        const tag = d[0]
        const end = src.indexOf(tag, i + tag.length)
        if (end < 0) throw new SqlSyntaxError('unterminated dollar-quoted string', start)
        out.push({ k: 'str', v: src.slice(i + tag.length, end), pos: start })
        i = end + tag.length
        continue
      }
    }
    if (c === '"') {
      let v = ''
      i++
      for (;;) {
        if (i >= n) throw new SqlSyntaxError('unterminated quoted name', start)
        if (src[i] === '"') {
          if (src[i + 1] === '"') { v += '"'; i += 2; continue }
          i++
          break
        }
        v += src[i++]
      }
      out.push({ k: 'id', v, q: true, pos: start })
      continue
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9' && src[i - 1] !== '.')) {
      let j = i
      while (j < n && src[j] >= '0' && src[j] <= '9') j++
      // "1..5" is a range: the dot belongs to the operator.
      if (src[j] === '.' && src[j + 1] !== '.') {
        j++
        while (j < n && src[j] >= '0' && src[j] <= '9') j++
      }
      if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] ?? '')) {
        j += 2
        while (j < n && src[j] >= '0' && src[j] <= '9') j++
      }
      out.push({ k: 'num', v: src.slice(i, j), pos: start })
      i = j
      continue
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(src[j])) j++
      out.push({ k: 'id', v: src.slice(i, j).toLowerCase(), pos: start })
      i = j
      continue
    }
    if ('(),[];.'.includes(c) && !(c === '.' && src[i + 1] === '.')) {
      out.push({ k: 'punct', v: c, pos: start })
      i++
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new SqlSyntaxError(`unexpected character ${c}`, start)
    out.push({ k: 'op', v: op, pos: start })
    i += op.length
  }
  out.push({ k: 'eof', v: '', pos: n })
  return out
}
