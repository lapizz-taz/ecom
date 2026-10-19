import { describe, expect, it } from 'vitest'
import { nestedQuantifier, noteLiteral, pgRegex } from './builtins.ts'

describe('regular expressions in the shared engine', () => {
  it('refuses patterns that can backtrack exponentially', () => {
    for (const p of ['^(\\d|\\d)*x$', '(a+)+', '(\\d+)*$', '(.*a){20}', '((ab)*)+', '(x|y)+$']) {
      expect(nestedQuantifier(p), p).toBe(true)
      expect(() => pgRegex(p), p).toThrow(/nested repetition/)
    }
  })

  it('trusts the schema\'s own patterns (string literals in its code)', () => {
    const root = '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    expect(() => pgRegex(root)).toThrow(/nested repetition/)
    noteLiteral(root)
    expect(pgRegex(root).test('shop.example.com')).toBe(true)
  })

  it('keeps ordinary patterns, phone patterns included', () => {
    for (const p of ['^01[3-9][0-9]{8}$', '^(\\+?88)?01[3-9]\\d{8}$', '^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$', '(ab){2,3}', '\\(a+\\)+', '[(a+)]+', '^(?:01|8801)[3-9]\\d{8}$']) {
      expect(nestedQuantifier(p), p).toBe(false)
      expect(pgRegex(p)).toBeInstanceOf(RegExp)
    }
  })
})
