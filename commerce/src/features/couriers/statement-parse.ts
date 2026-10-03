// Reads a courier statement (CSV or Excel) into rows, guesses which column is
// which, and turns the rows into lines for import_courier_invoice().

export const STATEMENT_FIELDS = [
  { key: 'consignment_id', label: 'Consignment ID', patterns: [/consignment/, /^cn\b/, /tracking/, /parcel id/] },
  { key: 'order_ref', label: 'Order number', patterns: [/merchant.?order/, /^order.?(id|no|number)?$/, /invoice.?(id|no)?$/, /reference/] },
  { key: 'courier_status', label: 'Status', patterns: [/status/] },
  { key: 'cod_collected', label: 'COD collected', patterns: [/collected/, /cash.?collect/, /^cod.?amount/, /amount.?to.?collect/] },
  { key: 'delivery_fee', label: 'Delivery fee', patterns: [/delivery.?(fee|charge)/, /shipping.?(fee|charge)/] },
  { key: 'return_fee', label: 'Return charge', patterns: [/return.?(fee|charge)/] },
  { key: 'cod_fee', label: 'COD fee', patterns: [/cod.?(fee|charge)/] },
  { key: 'other_fee', label: 'Other fees', patterns: [/other/, /additional/, /weight.?charge/, /adjustment/] },
  { key: 'payout', label: 'Payout', patterns: [/payout/, /payable/, /net.?amount/, /settle/] },
] as const

export type StatementField = (typeof STATEMENT_FIELDS)[number]['key']
export type ColumnMapping = Partial<Record<StatementField, number>>
export type StatementLine = Partial<Record<StatementField, string | number | null>>

const AMOUNT_FIELDS: StatementField[] = ['cod_collected', 'delivery_fee', 'return_fee', 'cod_fee', 'other_fee', 'payout']

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''))
}

export async function readStatementFile(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.csv') || file.type === 'text/csv') return parseCsv(await file.text())
  if (name.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/browser')
    const rows = await readSheet(file)
    return rows
      .map((r) => r.map((c) => (c === null || c === undefined ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c).trim())))
      .filter((r) => r.some((c) => c !== ''))
  }
  throw new Error('Upload the statement as CSV or Excel (.xlsx). PDF statements cannot be read — download the Excel/CSV version from the courier panel.')
}

const norm = (h: string) => h.toLowerCase().replace(/[_\s]+/g, ' ').trim()

/** Best guess of each field's column from the header row. */
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {}
  const used = new Set<number>()
  for (const field of STATEMENT_FIELDS) {
    const idx = headers.findIndex((h, i) => !used.has(i) && field.patterns.some((p) => p.test(norm(h))))
    if (idx >= 0) { mapping[field.key] = idx; used.add(idx) }
  }
  return mapping
}

/** The header is the first of the top rows that names an ID column and at least one amount. */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const m = guessMapping(rows[i])
    if ((m.consignment_id !== undefined || m.order_ref !== undefined) && AMOUNT_FIELDS.some((f) => m[f] !== undefined)) return i
  }
  return 0
}

/** "৳1,250.00", "Tk 80", "(50)" → numbers; blank stays blank. */
export function parseAmount(value: string | undefined): number | null {
  if (value === undefined) return null
  const v = value.trim()
  if (!v || v === '-') return null
  const negative = /^\(.*\)$/.test(v) || v.startsWith('-')
  const n = Number(v.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(n) || v.replace(/[^0-9]/g, '') === '') return Number.NaN
  return negative ? -n : n
}

export interface ParsedStatement { lines: StatementLine[]; skipped: number; errors: string[] }

export function toLines(rows: string[][], headerRow: number, mapping: ColumnMapping): ParsedStatement {
  const lines: StatementLine[] = []
  const errors: string[] = []
  let skipped = 0
  rows.slice(headerRow + 1).forEach((row, i) => {
    const get = (f: StatementField) => (mapping[f] === undefined ? undefined : row[mapping[f]!])
    const consignment = get('consignment_id')?.trim() || null
    const orderRef = get('order_ref')?.trim() || null
    // Totals and blank rows have no parcel reference.
    if (!consignment && !orderRef) { skipped++; return }
    const line: StatementLine = { consignment_id: consignment, order_ref: orderRef, courier_status: get('courier_status')?.trim() || null }
    for (const f of AMOUNT_FIELDS) {
      if (mapping[f] === undefined) continue
      const n = parseAmount(get(f))
      if (Number.isNaN(n)) errors.push(`Row ${headerRow + i + 2}: "${get(f)}" is not an amount (${f.replace('_', ' ')})`)
      line[f] = n === null || Number.isNaN(n) ? null : n
    }
    lines.push(line)
  })
  return { lines, skipped, errors }
}
