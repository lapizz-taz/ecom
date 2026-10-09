/**
 * Shipping label template: paper, which blocks appear and in what order.
 * Saved in the `fulfillment` setting as `label_template`; every label print
 * and the Label Builder preview render from it.
 */

export type PaperId = '100x150' | '100x100' | '75x100' | '75x50' | 'A4x4' | 'A4x6' | 'A4x2' | 'custom'

export interface Paper {
  id: PaperId
  label: string
  hint: string
  /** One label's size. */
  width: number
  height: number
  /** Several labels on one A4 sheet (columns × rows); absent = one label per page. */
  sheet?: { columns: number; rows: number }
  /** Base text size in pt before the template's text size is applied. */
  basePt: number
}

export const PAPERS: Paper[] = [
  { id: '100x150', label: '4 × 6 in (100 × 150 mm)', hint: 'Thermal label printer — most couriers', width: 100, height: 150, basePt: 10 },
  { id: '100x100', label: '4 × 4 in (100 × 100 mm)', hint: 'Square thermal labels', width: 100, height: 100, basePt: 9 },
  { id: '75x100', label: '3 × 4 in (75 × 100 mm)', hint: 'Small thermal labels', width: 75, height: 100, basePt: 8.5 },
  { id: '75x50', label: '3 × 2 in (75 × 50 mm)', hint: 'Mini labels: barcode and address only', width: 75, height: 50, basePt: 7 },
  { id: 'A4x4', label: 'A4 — 4 labels per sheet', hint: 'Any office printer (105 × 148 mm each)', width: 105, height: 148.5, sheet: { columns: 2, rows: 2 }, basePt: 10 },
  { id: 'A4x6', label: 'A4 — 6 labels per sheet', hint: 'Any office printer (105 × 99 mm each)', width: 105, height: 99, sheet: { columns: 2, rows: 3 }, basePt: 8.5 },
  { id: 'A4x2', label: 'A4 — 2 labels per sheet', hint: 'Any office printer (210 × 148 mm each)', width: 210, height: 148.5, sheet: { columns: 1, rows: 2 }, basePt: 11 },
  { id: 'custom', label: 'Custom size', hint: 'Enter your label size in millimetres', width: 100, height: 150, basePt: 10 },
]

export type BlockId = 'header' | 'order_barcode' | 'recipient' | 'courier' | 'qr' | 'items' | 'note' | 'custom_text' | 'return_address'

export interface LabelBlock {
  id: BlockId
  enabled: boolean
  // Options (only the ones that apply to the block are used).
  show_logo?: boolean
  show_phone?: boolean
  show_cod?: boolean
  show_date?: boolean
  barcode_height?: 'S' | 'M' | 'L'
  big_district?: boolean
  show_barcode?: boolean
  qr_content?: 'tracking' | 'order' | 'track_page'
  qr_beside_address?: boolean
  max_items?: number
  show_sku?: boolean
  text?: string
  bold?: boolean
}

export interface LabelTemplate {
  version: 1
  paper: PaperId
  custom_width: number
  custom_height: number
  /** Inner margin in mm — thermal printers cannot print the very edge. */
  padding: number
  text_size: 'S' | 'M' | 'L' | 'XL'
  border: boolean
  blocks: LabelBlock[]
}

export const BLOCK_INFO: Record<BlockId, { name: string; description: string }> = {
  header: { name: 'Shop and amount to collect', description: 'Logo or shop name, phone, and the COD amount' },
  order_barcode: { name: 'Order barcode', description: 'Scan it at the packing desk and Scan To Update' },
  recipient: { name: 'Customer and address', description: 'Name, phone, address and district' },
  courier: { name: 'Courier and consignment', description: 'Courier name, consignment / tracking ID and its barcode' },
  qr: { name: 'QR code', description: 'Tracking ID, order number or your order-tracking page' },
  items: { name: 'Products', description: 'What is inside the parcel' },
  note: { name: 'Notes', description: 'The customer\'s note and your footer note' },
  custom_text: { name: 'Custom text', description: 'e.g. Fragile — handle with care' },
  return_address: { name: 'Return address', description: 'Where undelivered parcels come back to' },
}

export const DEFAULT_BLOCKS: LabelBlock[] = [
  { id: 'header', enabled: true, show_logo: true, show_phone: true, show_cod: true },
  { id: 'order_barcode', enabled: true, show_date: true, barcode_height: 'M' },
  { id: 'recipient', enabled: true, big_district: true },
  { id: 'qr', enabled: false, qr_content: 'tracking', qr_beside_address: true },
  { id: 'courier', enabled: true, show_barcode: true },
  { id: 'items', enabled: true, max_items: 4, show_sku: false },
  { id: 'note', enabled: true, text: '' },
  { id: 'custom_text', enabled: false, text: 'Fragile — handle with care', bold: true },
  { id: 'return_address', enabled: false },
]

export const DEFAULT_TEMPLATE: LabelTemplate = {
  version: 1, paper: '100x150', custom_width: 100, custom_height: 150, padding: 4, text_size: 'M', border: false, blocks: DEFAULT_BLOCKS,
}

export const TEXT_SCALE: Record<LabelTemplate['text_size'], number> = { S: 0.85, M: 1, L: 1.15, XL: 1.3 }

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback
}

/**
 * A saved template made safe to render: unknown blocks dropped, missing
 * ones added (switched off) and sizes kept in range. Older settings
 * (label_size, show_cod_on_label…) seed the first template.
 */
export function normalizeTemplate(saved: unknown, legacy: { label_size?: string; show_cod_on_label?: boolean; show_items_on_label?: boolean; label_note?: string } = {}): LabelTemplate {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<LabelTemplate>
  const legacyPaper = legacy.label_size === 'A4' ? 'A4x4' : legacy.label_size
  const paper = PAPERS.some((p) => p.id === s.paper) ? s.paper! : PAPERS.some((p) => p.id === legacyPaper) ? (legacyPaper as PaperId) : '100x150'
  const savedBlocks = Array.isArray(s.blocks) ? s.blocks.filter((b): b is LabelBlock => !!b && typeof b === 'object' && b.id in BLOCK_INFO) : null
  const blocks = savedBlocks
    ? [
      ...savedBlocks.filter((b, i) => savedBlocks.findIndex((x) => x.id === b.id) === i)
        .map((b) => ({ ...DEFAULT_BLOCKS.find((d) => d.id === b.id), ...b, enabled: b.enabled !== false })),
      ...DEFAULT_BLOCKS.filter((d) => !savedBlocks.some((b) => b.id === d.id)).map((d) => ({ ...d, enabled: false })),
    ]
    : DEFAULT_BLOCKS.map((b) => {
      if (b.id === 'header') return { ...b, show_cod: legacy.show_cod_on_label !== false }
      if (b.id === 'items') return { ...b, enabled: legacy.show_items_on_label !== false }
      if (b.id === 'note') return { ...b, text: legacy.label_note ?? '' }
      return b
    })
  return {
    version: 1,
    paper,
    custom_width: clamp(s.custom_width, 30, 210, 100),
    custom_height: clamp(s.custom_height, 20, 297, 150),
    padding: clamp(s.padding, 0, 12, 4),
    text_size: s.text_size && s.text_size in TEXT_SCALE ? s.text_size : 'M',
    border: s.border === true,
    blocks,
  }
}

/** The paper for a template, with the custom size applied. */
export function paperOf(t: LabelTemplate): Paper {
  const p = PAPERS.find((x) => x.id === t.paper) ?? PAPERS[0]
  if (p.id !== 'custom') return p
  const area = t.custom_width * t.custom_height
  return { ...p, width: t.custom_width, height: t.custom_height, basePt: area < 4500 ? 7 : area < 9000 ? 8.5 : 10 }
}

/** @page rule for the browser print dialog. */
export function pageCss(paper: Paper): string {
  return paper.sheet ? '@page { size: A4 portrait; margin: 0 }' : `@page { size: ${paper.width}mm ${paper.height}mm; margin: 0 }`
}

export function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}
