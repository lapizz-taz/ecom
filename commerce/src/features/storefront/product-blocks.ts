import type { FieldDef, Settings } from './theme'

// Blocks inside a store's product page (beside the photos): bundles, badges, timers, tabs, upsells
// and the rest, each switched on or off and edited in the theme builder (Products page) or on
// Store → Theme. Saved in storefront.theme.product_page.blocks, in the order they show; the
// "buttons" entry marks where the buy buttons sit, so blocks go above or below them.
//
// Nothing here makes claims for the store: ratings, reviews, timers and "people bought" lines show
// only what the merchant typed, and are hidden until they do. Bundle prices are also charged by the
// server (calculate_order_quote reads the published bundles block), never just shown.

export type ProductBlockType =
  | 'buttons' | 'bundles' | 'tabs' | 'atc_style' | 'video' | 'addons' | 'sticky_atc' | 'shipping_info' | 'benefits' | 'benefits_list'
  | 'upsell' | 'social_proof' | 'payment_icons' | 'pulse_badge' | 'badges' | 'countdown' | 'review_summary' | 'coupon' | 'wrapper'
  | 'banner' | 'reviews' | 'space'

export interface ProductBlock { id: string; type: ProductBlockType; enabled: boolean; settings: Settings }

export interface ProductBlockDef {
  label: string
  description: string
  /** Where a newly switched-on block goes: above or below the buy buttons; "none" changes the page without a place of its own. */
  place: 'above' | 'below' | 'none'
  defaults: Settings
  fields: FieldDef[]
}

const PRODUCT_SOURCE = [
  { value: 'related', label: 'From the same category' }, { value: 'best_selling', label: 'Best selling' },
  { value: 'newest', label: 'Newest' }, { value: 'category', label: 'From a category' },
]

export const PRODUCT_BLOCKS: Record<Exclude<ProductBlockType, 'buttons'>, ProductBlockDef> = {
  bundles: {
    label: 'Bundles / Quantity breaks', place: 'above',
    description: 'Buy more, save more: 1, 2 or 3 pieces with their own price. The discount is charged at checkout.',
    defaults: {
      heading: 'Bundle & save', scope: 'all', category: '', style: 'stacked',
      tiers: [
        { quantity: '1', title: '1 piece', subtitle: 'Regular price', badge: '', percent: '0' },
        { quantity: '2', title: '2 pieces', subtitle: 'You save more', badge: 'Most popular', percent: '10' },
        { quantity: '3', title: '3 pieces', subtitle: 'Best value', badge: '', percent: '15' },
      ],
    },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'scope', label: 'Products', type: 'select', options: [{ value: 'all', label: 'Every product' }, { value: 'category', label: 'Products in one category' }] },
      { key: 'category', label: 'Category', type: 'category', hint: 'Shown when the products come from a category' },
      { key: 'style', label: 'Look', type: 'select', options: [{ value: 'stacked', label: 'Stacked rows' }, { value: 'grid', label: 'Side by side' }] },
      { key: 'tiers', label: 'Options', type: 'list', max: 5, hint: 'Quantity, then the discount in % for that quantity (0 for the regular price). Customers buying that many or more pay this price.',
        item: [{ key: 'quantity', label: 'Quantity (e.g. 2)' }, { key: 'title', label: 'Title (e.g. 2 pieces)' }, { key: 'subtitle', label: 'Line under the title' },
          { key: 'badge', label: 'Badge (optional, e.g. Most popular)' }, { key: 'percent', label: 'Discount % (e.g. 10)' }] },
    ],
  },
  pulse_badge: {
    label: 'Pulse badge', place: 'above', description: 'A pulsing dot with the real stock: in stock, few left or sold out.',
    defaults: { in_stock: 'In stock & ready to ship', low_stock: 'Only {count} left in stock', low_at: 5, color: '#16a34a' },
    fields: [
      { key: 'in_stock', label: 'In stock text', type: 'text' },
      { key: 'low_stock', label: 'Few left text', type: 'text', hint: '{count} is the number left' },
      { key: 'low_at', label: 'Few left from', type: 'range', min: 1, max: 20 },
      { key: 'color', label: 'Dot colour', type: 'color' },
    ],
  },
  countdown: {
    label: 'Countdown timer', place: 'above', description: 'Counts down to the end of a sale you set; hidden once it ends.',
    defaults: { heading: 'Sale ends in', ends_at: '', color: '#b91c1c' },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'ends_at', label: 'Ends at', type: 'text', placeholder: '2026-11-30 23:59', hint: 'Date and time (Bangladesh time). The timer shows only until then.' },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
  },
  coupon: {
    label: 'Coupon', place: 'above', description: 'A discount code with one-click copy.',
    defaults: { code: '', text: 'Use this code at checkout' },
    fields: [
      { key: 'code', label: 'Code', type: 'text', hint: 'Create the code in Marketing → Coupons first' },
      { key: 'text', label: 'Text', type: 'text' },
    ],
  },
  review_summary: {
    label: 'Review summary', place: 'above', description: 'Your average rating and number of reviews.',
    defaults: { rating: '', count: '', label: 'Excellent' },
    fields: [
      { key: 'rating', label: 'Average rating (e.g. 4.8)', type: 'text', hint: 'Only your real rating. Hidden while empty.' },
      { key: 'count', label: 'Number of reviews', type: 'text' },
      { key: 'label', label: 'Word before the stars', type: 'text' },
    ],
  },
  badges: {
    label: 'Badges', place: 'above', description: 'Short highlights in coloured pills.',
    defaults: { items: [{ text: 'Cash on delivery' }, { text: 'Nationwide delivery' }] },
    fields: [{ key: 'items', label: 'Badges', type: 'list', max: 5, item: [{ key: 'text', label: 'Text' }] }],
  },
  shipping_info: {
    label: 'Shipping info', place: 'below', description: 'When the order arrives, from your delivery zones’ times.',
    defaults: { heading: 'Delivery', show_dates: true, min_days: 1, max_days: 3 },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'show_dates', label: 'Show the arrival dates', type: 'toggle' },
      { key: 'min_days', label: 'Earliest (days)', type: 'range', min: 0, max: 15 },
      { key: 'max_days', label: 'Latest (days)', type: 'range', min: 0, max: 30 },
    ],
  },
  benefits_list: {
    label: 'Benefits list', place: 'below', description: 'A list with check marks: your main promises.',
    defaults: { items: [{ text: 'Cash on delivery all over Bangladesh' }, { text: 'Check the parcel before you pay' }] },
    fields: [{ key: 'items', label: 'Lines', type: 'list', max: 6, item: [{ key: 'text', label: 'Text' }] }],
  },
  benefits: {
    label: 'Benefits', place: 'below', description: 'Icons with a title and a line each, side by side or stacked.',
    defaults: { layout: 'horizontal', items: [{ title: 'Fast delivery', text: 'Inside Dhaka in 1–2 days' }, { title: 'Easy exchange', text: 'Wrong size? We exchange it' }] },
    fields: [
      { key: 'layout', label: 'Layout', type: 'select', options: [{ value: 'horizontal', label: 'Side by side' }, { value: 'vertical', label: 'Stacked' }] },
      { key: 'items', label: 'Benefits', type: 'list', max: 4, item: [{ key: 'title', label: 'Title' }, { key: 'text', label: 'Text' }] },
    ],
  },
  payment_icons: {
    label: 'Payment icons', place: 'below', description: 'How customers can pay.',
    defaults: { text: 'Pay with', cod: true, bkash: true, nagad: true, card: false },
    fields: [
      { key: 'text', label: 'Text', type: 'text' },
      { key: 'cod', label: 'Cash on delivery', type: 'toggle' },
      { key: 'bkash', label: 'bKash', type: 'toggle' },
      { key: 'nagad', label: 'Nagad', type: 'toggle' },
      { key: 'card', label: 'Visa / Mastercard', type: 'toggle' },
    ],
  },
  tabs: {
    label: 'Tabs', place: 'below', description: 'Description, shipping and your own text in tabs.',
    defaults: { description: true, shipping: true, items: [] },
    fields: [
      { key: 'description', label: 'Description tab', type: 'toggle' },
      { key: 'shipping', label: 'Shipping tab (from the product)', type: 'toggle' },
      { key: 'items', label: 'More tabs', type: 'list', max: 4, item: [{ key: 'title', label: 'Title' }, { key: 'text', label: 'Text', multiline: true }] },
    ],
  },
  addons: {
    label: 'Add-ons', place: 'below', description: 'Products to tick and add together with this one.',
    defaults: { heading: 'Complete the look', source: 'related', category: '', limit: 3 },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'source', label: 'Products', type: 'select', options: PRODUCT_SOURCE },
      { key: 'category', label: 'Category', type: 'category' },
      { key: 'limit', label: 'How many', type: 'range', min: 1, max: 4 },
    ],
  },
  upsell: {
    label: 'Upsell', place: 'below', description: 'Other products with a quick “Add” button.',
    defaults: { heading: 'You may also like', source: 'best_selling', category: '', limit: 2 },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'source', label: 'Products', type: 'select', options: PRODUCT_SOURCE },
      { key: 'category', label: 'Category', type: 'category' },
      { key: 'limit', label: 'How many', type: 'range', min: 1, max: 4 },
    ],
  },
  social_proof: {
    label: 'Social proof', place: 'below', description: 'A line about your customers, with photos.',
    defaults: { text: '', images: [] },
    fields: [
      { key: 'text', label: 'Text', type: 'text', hint: 'Only true numbers, e.g. “Loved by 2,000+ customers”. Hidden while empty.' },
      { key: 'images', label: 'Customer photos (links)', type: 'list', max: 4, item: [{ key: 'url', label: 'Image link' }] },
    ],
  },
  reviews: {
    label: 'Reviews', place: 'below', description: 'What customers said, with stars.',
    defaults: { heading: 'Reviews', items: [] },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'items', label: 'Reviews', type: 'list', max: 8, hint: 'Only real customers’ words, with their permission. Hidden while empty.',
        item: [{ key: 'name', label: 'Name' }, { key: 'rating', label: 'Stars (1–5)' }, { key: 'text', label: 'What they said', multiline: true }] },
    ],
  },
  video: {
    label: 'Video carousel', place: 'below', description: 'Short product videos that customers swipe through.',
    defaults: { heading: '', items: [] },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'items', label: 'Videos', type: 'list', max: 6, hint: 'MP4 links (upload under Products or any https link)', item: [{ key: 'url', label: 'MP4 link' }] },
    ],
  },
  banner: {
    label: 'Banner', place: 'below', description: 'An important notice in a coloured box.',
    defaults: { text: 'Free delivery on orders over ৳2,000', tone: 'info' },
    fields: [
      { key: 'text', label: 'Text', type: 'textarea' },
      { key: 'tone', label: 'Colour', type: 'select', options: [{ value: 'info', label: 'Blue' }, { value: 'success', label: 'Green' }, { value: 'warning', label: 'Amber' }, { value: 'neutral', label: 'Grey' }] },
    ],
  },
  space: {
    label: 'Space & divider', place: 'below', description: 'Space or a line between blocks.',
    defaults: { height: 16, line: true },
    fields: [
      { key: 'height', label: 'Space', type: 'range', min: 0, max: 64, step: 4, unit: 'px' },
      { key: 'line', label: 'Show a line', type: 'toggle' },
    ],
  },
  atc_style: {
    label: 'Add to cart button', place: 'none', description: 'Colour, text and a gentle animation for the buy buttons.',
    defaults: { label: 'Add to cart', buy_label: 'Buy it now', background: '#0b0b0c', text: '#ffffff', animation: 'none', full_width: true },
    fields: [
      { key: 'label', label: 'Add to cart text', type: 'text' },
      { key: 'buy_label', label: 'Buy now text', type: 'text' },
      { key: 'background', label: 'Button colour', type: 'color' },
      { key: 'text', label: 'Text colour', type: 'color' },
      { key: 'animation', label: 'Animation', type: 'select', options: [{ value: 'none', label: 'None' }, { value: 'pulse', label: 'Pulse' }, { value: 'shake', label: 'Shake every few seconds' }] },
    ],
  },
  sticky_atc: {
    label: 'Sticky add to cart', place: 'none', description: 'A bar with the price and “Add to cart” once the buttons scroll away.',
    defaults: { mobile_only: false },
    fields: [{ key: 'mobile_only', label: 'Phones only', type: 'toggle' }],
  },
  wrapper: {
    label: 'Wrapper', place: 'none', description: 'A box around the product information.',
    defaults: { style: 'border', padding: 20 },
    fields: [
      { key: 'style', label: 'Look', type: 'select', options: [{ value: 'border', label: 'Thin border' }, { value: 'filled', label: 'Light background' }] },
      { key: 'padding', label: 'Inner space', type: 'range', min: 8, max: 40, step: 4, unit: 'px' },
    ],
  },
}

/** Every block a merchant can switch on, in the order the library lists them. */
export const BLOCK_TYPES = Object.keys(PRODUCT_BLOCKS) as Array<Exclude<ProductBlockType, 'buttons'>>

const newId = () => Math.random().toString(36).slice(2, 10)
export const makeBlock = (type: Exclude<ProductBlockType, 'buttons'>, enabled = true): ProductBlock =>
  ({ id: `${type}-${newId()}`, type, enabled, settings: structuredClone(PRODUCT_BLOCKS[type].defaults) })

export const BUTTONS_BLOCK: ProductBlock = { id: 'buttons', type: 'buttons', enabled: true, settings: {} }

/** A store that never chose: delivery times from its zones and a sticky add-to-cart bar (nothing that makes claims). */
export const DEFAULT_PRODUCT_BLOCKS: ProductBlock[] = [
  BUTTONS_BLOCK,
  { id: 'shipping_info', type: 'shipping_info', enabled: true, settings: structuredClone(PRODUCT_BLOCKS.shipping_info.defaults) },
  { id: 'sticky_atc', type: 'sticky_atc', enabled: true, settings: structuredClone(PRODUCT_BLOCKS.sticky_atc.defaults) },
]

/** The saved blocks, defaults filled in; exactly one buy-buttons entry. */
export function readBlocks(v: unknown): ProductBlock[] {
  if (!Array.isArray(v)) return DEFAULT_PRODUCT_BLOCKS.map((b) => ({ ...b, settings: structuredClone(b.settings) }))
  const out: ProductBlock[] = []
  let buttons = false
  for (const x of v.slice(0, 40)) {
    if (!x || typeof x !== 'object') continue
    const b = x as Partial<ProductBlock>
    if (b.type === 'buttons') {
      if (!buttons) out.push(BUTTONS_BLOCK)
      buttons = true
      continue
    }
    if (!b.type || !(b.type in PRODUCT_BLOCKS)) continue
    const def = PRODUCT_BLOCKS[b.type as keyof typeof PRODUCT_BLOCKS]
    out.push({ id: typeof b.id === 'string' && b.id ? b.id : newId(), type: b.type, enabled: b.enabled !== false,
      settings: { ...structuredClone(def.defaults), ...(b.settings && typeof b.settings === 'object' ? b.settings : {}) } })
  }
  if (!buttons) out.unshift(BUTTONS_BLOCK)
  return out
}

/** The first block of this type (switched on or off), if the store has one. */
export const findBlock = (blocks: ProductBlock[], type: ProductBlockType) => blocks.find((b) => b.type === type)
/** The block of this type when it is switched on. */
export const activeBlock = (blocks: ProductBlock[], type: ProductBlockType) => blocks.find((b) => b.type === type && b.enabled)

/** Switches a block type on or off; one that was never added is added where it belongs (above or below the buttons). */
export function toggleBlock(blocks: ProductBlock[], type: Exclude<ProductBlockType, 'buttons'>, on: boolean): ProductBlock[] {
  if (blocks.some((b) => b.type === type)) return blocks.map((b) => (b.type === type ? { ...b, enabled: on } : b))
  if (!on) return blocks
  const block = makeBlock(type)
  const at = blocks.findIndex((b) => b.type === 'buttons')
  if (PRODUCT_BLOCKS[type].place === 'above' && at >= 0) return [...blocks.slice(0, at), block, ...blocks.slice(at)]
  return [...blocks, block]
}

// --- bundles: the same price rule the server applies (calculate_order_quote) ------------------------

export interface BundleTier { quantity: number; title: string; subtitle: string; badge: string; percent: number }

/** The bundle options, cleaned up and sorted by quantity (as the server reads them). */
export function bundleTiers(settings: Settings): BundleTier[] {
  const rows = Array.isArray(settings.tiers) ? (settings.tiers as Array<Record<string, unknown>>) : []
  const tiers = rows.map((r) => ({
    quantity: Math.floor(Number(r.quantity)),
    title: String(r.title ?? '').trim(),
    subtitle: String(r.subtitle ?? '').trim(),
    badge: String(r.badge ?? '').trim(),
    percent: Math.min(90, Math.max(0, Number(r.percent) || 0)),
  })).filter((t) => Number.isFinite(t.quantity) && t.quantity >= 1 && t.quantity <= 50)
  const seen = new Set<number>()
  return tiers.filter((t) => (seen.has(t.quantity) ? false : (seen.add(t.quantity), true))).sort((a, b) => a.quantity - b.quantity)
}

/** Whether the bundle block applies to a product in this category. */
export const bundleApplies = (settings: Settings, categorySlug: string | null | undefined) =>
  settings.scope !== 'category' || (!!settings.category && settings.category === categorySlug)

/** The discount % for buying this many (the largest option at or under it). */
export function bundlePercent(tiers: BundleTier[], quantity: number): number {
  let pct = 0
  for (const t of tiers) if (t.quantity <= quantity) pct = t.percent
  return pct
}

/** The unit price after the bundle discount, rounded to the paisa like the server's money(). */
export const bundleUnitPrice = (unit: number, percent: number) => Math.round(unit * (1 - percent / 100) * 100) / 100
