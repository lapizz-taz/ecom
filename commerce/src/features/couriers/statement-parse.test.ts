import { describe, expect, it } from 'vitest'
import { findHeaderRow, guessMapping, parseAmount, parseCsv, toLines } from './statement-parse'

const PATHAO_CSV = `Pathao Payment Invoice,,,,,
Invoice,INV-2210,,,,
Consignment ID,Merchant Order ID,Order Status,Collected Amount,Delivery Fee,COD Fee,Payout
DL811,ISO-10070,Delivered,"1,250.00",80,12.5,"1,157.50"
DL812,ISO-10071,Return,0,70,0,-70
,,,Total,150,12.5,"1,087.50"
`

describe('courier statement parsing', () => {
  it('reads CSV with quotes, commas and a title block above the header', () => {
    const rows = parseCsv(PATHAO_CSV)
    const header = findHeaderRow(rows)
    expect(header).toBe(2)
    const mapping = guessMapping(rows[header])
    expect(mapping).toMatchObject({ consignment_id: 0, order_ref: 1, courier_status: 2, cod_collected: 3, delivery_fee: 4, cod_fee: 5, payout: 6 })
    const parsed = toLines(rows, header, mapping)
    expect(parsed.skipped).toBe(1)
    expect(parsed.errors).toEqual([])
    expect(parsed.lines).toEqual([
      { consignment_id: 'DL811', order_ref: 'ISO-10070', courier_status: 'Delivered', cod_collected: 1250, delivery_fee: 80, cod_fee: 12.5, payout: 1157.5 },
      { consignment_id: 'DL812', order_ref: 'ISO-10071', courier_status: 'Return', cod_collected: 0, delivery_fee: 70, cod_fee: 0, payout: -70 },
    ])
  })

  it('understands taka signs, brackets and blanks, and reports text in amount columns', () => {
    expect(parseAmount('৳1,250')).toBe(1250)
    expect(parseAmount('Tk 80.50')).toBe(80.5)
    expect(parseAmount('(50)')).toBe(-50)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('-')).toBeNull()
    expect(parseAmount('n/a')).toBeNaN()
    const rows = [['Consignment', 'Delivery charge'], ['A1', 'free']]
    expect(toLines(rows, 0, guessMapping(rows[0])).errors).toEqual(['Row 2: "free" is not an amount (delivery fee)'])
  })

  it('keeps a quoted newline inside one cell', () => {
    expect(parseCsv('a,"line 1\nline 2",c\r\nd,e,f')).toEqual([['a', 'line 1\nline 2', 'c'], ['d', 'e', 'f']])
  })
})
