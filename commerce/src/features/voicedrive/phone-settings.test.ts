import { describe, expect, it } from 'vitest'
import { combineRepeated } from './phone-settings'

const call = (id: string, phone: string, status: string, direction = 'INBOUND') =>
  ({ id, normalizedCustomerPhone: phone, customerPhone: phone, status, direction })

describe('combineRepeated', () => {
  it('folds runs of the same number, status and direction, keeping the newest first', () => {
    const rows = combineRepeated([
      call('a', '01711000111', 'NO_ANSWER'), call('b', '01711000111', 'NO_ANSWER'), call('c', '01711000111', 'NO_ANSWER'),
      call('d', '01711000111', 'COMPLETED'),
      call('e', '01711000111', 'NO_ANSWER', 'OUTBOUND'),
      call('f', '01822000222', 'NO_ANSWER'), call('g', '01711000111', 'NO_ANSWER'),
    ])
    expect(rows.map((r) => [r.id, r.repeat])).toEqual([['a', 3], ['d', 1], ['e', 1], ['f', 1], ['g', 1]])
  })
  it('does not change the input', () => {
    const input = [call('a', '1', 'BUSY'), call('b', '1', 'BUSY')]
    combineRepeated(input)
    expect(input).toHaveLength(2)
  })
})
