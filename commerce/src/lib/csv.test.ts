import { describe, expect, it } from 'vitest'
import { abandonedCsv, type ShopifyAbandoned } from '@/services/abandoned'
import { toCsv } from './csv'

describe('CSV exports', () => {
  it('keeps a typed-in formula from running in a spreadsheet, and leaves numbers alone', () => {
    const csv = toCsv([{ v: '=HYPERLINK("http://x.test","Open")' }, { v: '+8801711' }, { v: '@SUM(A1)' }, { v: '-12.5' }, { v: '\t=1' }, { v: 'Karim' }],
      [{ header: 'Value', value: (r: { v: string }) => r.v }])
    const lines = csv.replace(/^﻿/, '').split('\r\n')
    expect(lines).toEqual(['Value', `"'=HYPERLINK(""http://x.test"",""Open"")"`, "'+8801711", "'@SUM(A1)", '-12.5', "'\t=1", 'Karim'])
  })

  it('writes abandoned checkouts through the same guard: what the shopper typed stays text', () => {
    const row = {
      id: '1', legacy_id: '991', name: '#991', shop_created_at: '2026-10-25T02:00:00Z', customer_name: '=cmd|"/c calc"!A1', phone: '+8801711000000',
      email: '@evil.test', country: 'BD', city: '-Dhaka+1', items: [{ title: '=Tee', variant: 'M', quantity: 2 }], total: '1200', currency: 'BDT',
      status: 'OPEN', follow_up: null, recovery_url: 'https://shop.test/r/1',
    } as unknown as ShopifyAbandoned
    const [, line] = abandonedCsv([row]).replace(/^﻿/, '').split('\r\n')
    expect(line).toContain(`"'=cmd|""/c calc""!A1"`)
    expect(line).toContain("'+8801711000000")
    expect(line).toContain("'@evil.test")
    expect(line).toContain("'-Dhaka+1")
    expect(line).toContain("'=Tee (M) x2")
    expect(line).not.toMatch(/(^|,)[=+@]/)
  })
})
