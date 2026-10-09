/**
 * Label and invoice templates: paper, which blocks appear and in what order.
 * Saved in the `fulfillment` setting as `label_template` (stickers / courier
 * labels) and `invoice_template` (A4 / A5 invoices). Every print and the
 * builder's canvas render from them.
 */

export type TemplateKind = 'label' | 'invoice'
export type PaperId = '100x150' | '100x100' | '75x100' | '75x50' | 'A4x4' | 'A4x6' | 'A4x2' | 'A4' | 'A5' | 'custom'

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
  { id: 'A4', label: 'A4 page (210 × 297 mm)', hint: 'Full-page invoice', width: 210, height: 297, basePt: 10.5 },
  { id: 'A5', label: 'A5 page (148 × 210 mm)', hint: 'Half-page invoice', width: 148, height: 210, basePt: 9.5 },
  { id: 'custom', label: 'Custom size', hint: 'Enter your size in millimetres', width: 100, height: 150, basePt: 10 },
]

export type BlockId =
  | 'header' | 'business_header' | 'logo' | 'invoice_header' | 'order_barcode' | 'recipient' | 'courier' | 'qr' | 'cod_badge'
  | 'delivery_method' | 'items' | 'product_table' | 'price_summary' | 'note' | 'custom_text' | 'divider' | 'return_address'

/** Blocks that can be added more than once (each copy has its own uid). */
export const REPEATABLE: BlockId[] = ['custom_text', 'divider']

export interface LabelBlock {
  id: BlockId
  /** Unique within a template: the id for single blocks, id-n for repeats. */
  uid?: string
  enabled: boolean
  align?: 'left' | 'center' | 'right'
  size?: 'S' | 'M' | 'L'
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
  show_customer?: boolean
  show_advance?: boolean
  dashed?: boolean
  text?: string
  bold?: boolean
}

export interface LabelTemplate {
  version: 1
  kind: TemplateKind
  name: string
  paper: PaperId
  custom_width: number
  custom_height: number
  /** Inner margin in mm — thermal printers cannot print the very edge. */
  padding: number
  text_size: 'S' | 'M' | 'L' | 'XL'
  border: boolean
  /** Let long orders make the page taller instead of cutting the product list. */
  grow: boolean
  blocks: LabelBlock[]
}

export const BLOCK_INFO: Record<BlockId, { name: string; description: string; group: 'smart' | 'basic' }> = {
  header: { name: 'Shop and amount to collect', description: 'Logo or shop name, phone, and the COD amount', group: 'smart' },
  business_header: { name: 'Business header', description: 'Logo, shop name, address and phone', group: 'smart' },
  invoice_header: { name: 'Order summary', description: 'Invoice number and date beside the customer', group: 'smart' },
  recipient: { name: 'Customer address', description: 'Name, phone, address and district', group: 'smart' },
  product_table: { name: 'Product table', description: 'Product, quantity, price and total', group: 'smart' },
  price_summary: { name: 'Price summary', description: 'Sub total, delivery, discount, advance and COD', group: 'smart' },
  cod_badge: { name: 'COD badge', description: 'The amount to collect, large', group: 'smart' },
  courier: { name: 'Courier barcode', description: 'Courier, consignment ID and its barcode', group: 'smart' },
  delivery_method: { name: 'Delivery method', description: 'Home delivery, express or pickup', group: 'smart' },
  note: { name: 'Notes', description: 'The customer\'s note and your footer note', group: 'smart' },
  return_address: { name: 'Return address', description: 'Where undelivered parcels come back to', group: 'smart' },
  custom_text: { name: 'Text', description: 'Any text, e.g. Fragile — handle with care', group: 'basic' },
  logo: { name: 'Logo', description: 'Your logo from Store settings', group: 'basic' },
  order_barcode: { name: 'Barcode', description: 'Order number barcode for scanning', group: 'basic' },
  qr: { name: 'QR code', description: 'Tracking ID, order number or your tracking page', group: 'basic' },
  divider: { name: 'Line', description: 'A divider between blocks', group: 'basic' },
  items: { name: 'Product rows', description: 'Simple list of what is inside', group: 'basic' },
}

/** Defaults a new copy of a block starts with. */
export const BLOCK_DEFAULTS: Record<BlockId, Omit<LabelBlock, 'uid'>> = {
  header: { id: 'header', enabled: true, show_logo: true, show_phone: true, show_cod: true },
  business_header: { id: 'business_header', enabled: true, show_logo: true, show_phone: true, align: 'left' },
  logo: { id: 'logo', enabled: true, align: 'center', size: 'M' },
  invoice_header: { id: 'invoice_header', enabled: true, show_date: true, show_customer: true },
  order_barcode: { id: 'order_barcode', enabled: true, show_date: true, barcode_height: 'M' },
  recipient: { id: 'recipient', enabled: true, big_district: true },
  courier: { id: 'courier', enabled: true, show_barcode: true },
  qr: { id: 'qr', enabled: true, qr_content: 'tracking', qr_beside_address: false },
  cod_badge: { id: 'cod_badge', enabled: true, align: 'center', size: 'L' },
  delivery_method: { id: 'delivery_method', enabled: true, align: 'left' },
  items: { id: 'items', enabled: true, max_items: 4, show_sku: false },
  product_table: { id: 'product_table', enabled: true, max_items: 8, show_sku: false },
  price_summary: { id: 'price_summary', enabled: true, show_advance: true },
  note: { id: 'note', enabled: true, text: '' },
  custom_text: { id: 'custom_text', enabled: true, text: 'Fragile — handle with care', bold: true, align: 'center', size: 'M' },
  divider: { id: 'divider', enabled: true, dashed: false },
  return_address: { id: 'return_address', enabled: true },
}

const b = (id: BlockId, patch: Partial<LabelBlock> = {}): LabelBlock => ({ ...BLOCK_DEFAULTS[id], uid: id, ...patch })

/** The classic courier label (shop + COD, barcodes, big address). */
export const CLASSIC_BLOCKS: LabelBlock[] = [
  b('header'), b('order_barcode'), b('recipient'), b('courier'), b('items'), b('note'),
]

/** Sticker with prices: order summary, consignment barcode, product table and totals. */
export const STICKER_BLOCKS: LabelBlock[] = [
  b('invoice_header'), b('courier', { show_barcode: true }), b('product_table', { max_items: 6 }), b('price_summary'), b('note'),
]

export const INVOICE_BLOCKS: LabelBlock[] = [
  b('business_header'), b('divider', { uid: 'divider' }), b('invoice_header'), b('product_table', { max_items: 30, show_sku: true }),
  b('price_summary'), b('note'), b('custom_text', { text: 'Thank you for shopping with us!', bold: false, size: 'S' }),
]

export const STARTERS: Record<TemplateKind, Array<{ key: string; name: string; template: Omit<LabelTemplate, 'version' | 'kind'> }>> = {
  label: [
    { key: 'sticker', name: 'Sticker with prices', template: { name: 'Sticker', paper: '100x150', custom_width: 100, custom_height: 150, padding: 3, text_size: 'M', border: false, grow: false, blocks: STICKER_BLOCKS } },
    { key: 'classic', name: 'Courier label', template: { name: 'Courier label', paper: '100x150', custom_width: 100, custom_height: 150, padding: 4, text_size: 'M', border: false, grow: false, blocks: CLASSIC_BLOCKS } },
  ],
  invoice: [
    { key: 'invoice', name: 'Invoice', template: { name: 'Invoice', paper: 'A5', custom_width: 148, custom_height: 210, padding: 10, text_size: 'M', border: false, grow: true, blocks: INVOICE_BLOCKS } },
  ],
}

export const starter = (kind: TemplateKind, key?: string): LabelTemplate => {
  const s = STARTERS[kind].find((x) => x.key === key) ?? STARTERS[kind][0]
  return { version: 1, kind, ...structuredClone(s.template) }
}

export const DEFAULT_TEMPLATE: LabelTemplate = { version: 1, kind: 'label', name: 'Courier label', paper: '100x150', custom_width: 100, custom_height: 150, padding: 4, text_size: 'M', border: false, grow: false, blocks: CLASSIC_BLOCKS }

export const TEXT_SCALE: Record<LabelTemplate['text_size'], number> = { S: 0.85, M: 1, L: 1.15, XL: 1.3 }

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback
}

/** A fresh uid for another copy of a block. */
export function nextUid(blocks: LabelBlock[], id: BlockId): string {
  if (!REPEATABLE.includes(id) && !blocks.some((x) => x.uid === id)) return id
  let n = 2
  while (blocks.some((x) => x.uid === `${id}-${n}`)) n++
  return `${id}-${n}`
}

/**
 * A saved template made safe to render: unknown blocks dropped, single blocks
 * kept once, sizes kept in range. A label with no saved design keeps the
 * classic layout (older settings — label_size, show_cod_on_label… — seed it).
 */
export function normalizeTemplate(saved: unknown, legacy: { label_size?: string; show_cod_on_label?: boolean; show_items_on_label?: boolean; label_note?: string } = {}, kind: TemplateKind = 'label'): LabelTemplate {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<LabelTemplate>
  const base = kind === 'invoice' ? starter('invoice') : DEFAULT_TEMPLATE
  const legacyPaper = legacy.label_size === 'A4' ? 'A4x4' : legacy.label_size
  const paper = PAPERS.some((p) => p.id === s.paper) ? s.paper!
    : kind === 'label' && PAPERS.some((p) => p.id === legacyPaper) ? (legacyPaper as PaperId) : base.paper
  const savedBlocks = Array.isArray(s.blocks) ? s.blocks.filter((x): x is LabelBlock => !!x && typeof x === 'object' && x.id in BLOCK_INFO) : null
  let blocks: LabelBlock[]
  if (savedBlocks) {
    blocks = []
    for (const x of savedBlocks) {
      const repeat = REPEATABLE.includes(x.id)
      if (!repeat && blocks.some((y) => y.id === x.id)) continue
      const uid = typeof x.uid === 'string' && x.uid && !blocks.some((y) => y.uid === x.uid) ? x.uid : nextUid(blocks, x.id)
      blocks.push({ ...BLOCK_DEFAULTS[x.id], ...x, uid, enabled: x.enabled !== false })
    }
  } else if (kind === 'label') {
    blocks = CLASSIC_BLOCKS.map((x) => {
      if (x.id === 'header') return { ...x, show_cod: legacy.show_cod_on_label !== false }
      if (x.id === 'items') return { ...x, enabled: legacy.show_items_on_label !== false }
      if (x.id === 'note') return { ...x, text: legacy.label_note ?? '' }
      return x
    })
  } else {
    blocks = base.blocks
  }
  return {
    version: 1,
    kind,
    name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 60) : base.name,
    paper,
    custom_width: clamp(s.custom_width, 30, 297, base.custom_width),
    custom_height: clamp(s.custom_height, 20, 420, base.custom_height),
    padding: clamp(s.padding, 0, 20, base.padding),
    text_size: s.text_size && s.text_size in TEXT_SCALE ? s.text_size : 'M',
    border: s.border === true,
    grow: typeof s.grow === 'boolean' ? s.grow : base.grow,
    blocks,
  }
}

/** The paper for a template, with the custom size applied. */
export function paperOf(t: LabelTemplate): Paper {
  const p = PAPERS.find((x) => x.id === t.paper) ?? PAPERS[0]
  if (p.id !== 'custom') return p
  const area = t.custom_width * t.custom_height
  return { ...p, width: t.custom_width, height: t.custom_height, basePt: area < 4500 ? 7 : area < 9000 ? 8.5 : area < 30000 ? 10 : 10.5 }
}

/** @page rule for the browser print dialog. `height` overrides the page height (a grown page). */
export function pageCss(paper: Paper, height?: number): string {
  return paper.sheet ? '@page { size: A4 portrait; margin: 0 }' : `@page { size: ${paper.width}mm ${Math.ceil(height ?? paper.height)}mm; margin: 0 }`
}

/** Tallest rendered page in mm, for templates that grow with long orders. */
export function measuredHeight(container: HTMLElement | null, paper: Paper): number {
  if (!container) return paper.height
  const pxPerMm = 96 / 25.4
  let max = paper.height
  container.querySelectorAll<HTMLElement>('.shipping-label').forEach((el) => { max = Math.max(max, el.scrollHeight / pxPerMm) })
  return max
}

export function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}
