import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, closePool, inTx, value } from '../support/db'

afterAll(closePool)

describe('reading the district from a store address', () => {
  it('reads Bangla, other spellings and well-known areas (all from real orders that failed)', () =>
    inTx(async (db) => {
      await asSystem(db)
      const read = (...hints: Array<string | null>) => value<string | null>(db, `select public._bd_district($1::text[])`, [hints])
      const cases: Array<[Array<string | null>, string | null]> = [
        [['চট্টগ্রাম'], 'Chattogram'],
        [['ঢাকা'], 'Dhaka'],
        [['Cantonment'], 'Dhaka'],
        [['Bashundhara'], 'Dhaka'],
        [['Cox’sBazar'], "Cox's Bazar"],
        [['Kishorganj'], 'Kishoreganj'],
        [['Hathazari'], 'Chattogram'],
        [['মাটিডালী'], 'Bogura'],
        [['আশুগঞ্জ আড়াই সীতা'], 'Brahmanbaria'],
        // Unchanged behaviour.
        [['Dhaka'], 'Dhaka'],
        [[null, 'Mirpur 10, Dhaka'], 'Dhaka'],
        [['Chittagong'], 'Chattogram'],
        [["Cox's Bazar"], "Cox's Bazar"],
        [['Sylhet Sadar'], 'Sylhet'],
        // Not readable: nothing is guessed.
        [['asdas'], null],
        [['64'], null],
        [['এক পিস'], null],
      ]
      for (const [hints, want] of cases) expect(await read(...hints), hints.join(' | ')).toBe(want)
    }))
})
