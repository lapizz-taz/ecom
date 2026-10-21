import { type CSSProperties, useEffect, useSyncExternalStore } from 'react'
import { isPreviewFrame } from '@/lib/merchant'
import type { StoreConfig } from '@/types/domain'
import { DEFAULT_PRODUCT_BLOCKS, type ProductBlock, readBlocks } from './product-blocks'

// The store's theme, edited in the theme builder (Shopify-style editor) and
// saved in the public "storefront" setting as storefront.theme. Older saved
// themes (a fixed list of sections) are read and upgraded by resolveTheme().

export type Storefront = StoreConfig['storefront']
export type ThemeFont = 'poppins' | 'inter' | 'montserrat' | 'dm_sans' | 'manrope' | 'outfit' | 'jost' | 'lato' | 'roboto' | 'open_sans' | 'nunito'
  | 'playfair' | 'lora' | 'cormorant' | 'dm_serif' | 'oswald' | 'hind' | 'noto_bengali' | 'anek_bangla'
export type HeadingWeight = 'default' | '400' | '500' | '600' | '700'
export type ThemeRadius = 'sharp' | 'soft' | 'round'

export type SectionType = 'hero' | 'collections' | 'featured' | 'new' | 'best_sellers' | 'trust' | 'banner' | 'rich_text' | 'marquee' | 'image_text' | 'video'
  | 'testimonials' | 'faq' | 'newsletter'
export type Settings = Record<string, unknown>
export interface ThemeSection { id: string; type: SectionType; enabled: boolean; settings: Settings }
export interface MenuLink { label: string; link: string }
/** A collapsible row under the buttons; its text comes from the product or is typed in. */
export interface ProductAccordion { title: string; content: 'description' | 'shipping' | 'warranty' | 'custom'; text: string }

/** What the product page shows, edited under Products in the theme builder. */
export interface ProductPageSettings {
  /** classic: image and thumbnails in a box; bold: edge-to-edge photo, delivery timeline; minimal: edge-to-edge photo, name and price in one row. */
  layout: 'classic' | 'bold' | 'minimal'
  buy_now_style: 'filled' | 'outline'
  /** Corner radius of the quantity box and the two buttons, in px. */
  button_radius: number
  accordions: ProductAccordion[]
  /** Purchased → Processing → Delivered with dates (bold and minimal layouts). */
  show_delivery: boolean
  delivery_min_days: number
  delivery_max_days: number
  /** Short lines with an icon, e.g. "600+ Happy Customers". */
  highlights: string[]
  /** A small note under the highlights; **text** is bold. */
  promo_text: string
  image_aspect: 'portrait' | 'square'
  show_brand: boolean
  show_sale_badge: boolean
  show_stock: boolean
  show_quantity: boolean
  show_buy_now: boolean
  show_description: boolean
  description_title: string
  show_details: boolean
  show_sku: boolean
  show_tags: boolean
  show_related: boolean
  related_title: string
  /** Bundles, badges, timers, tabs, upsells… beside the photos (product-blocks.ts), in order; "buttons" marks the buy buttons. */
  blocks: ProductBlock[]
}

/** The cart drawer that opens when something is added. */
export interface CartSettings {
  /** A progress bar to the store's free-delivery amount (Settings → Delivery), when it has one. */
  free_shipping_bar: boolean
  free_shipping_text: string
  unlocked_text: string
  /** "You may also like" products with a quick Add. */
  upsell: boolean
  upsell_title: string
  /** Shows what the customer saves against the regular price. */
  show_savings: boolean
  /** A short line above the checkout button, e.g. delivery times. */
  note: string
}

export interface StoreTheme {
  accent: string
  /** Body text font. */
  font: ThemeFont
  /** Headings (h1–h6): their own font and, unless "default", one weight. */
  heading_font: ThemeFont
  heading_weight: HeadingWeight
  /** Text sizes in % of the theme's own: body text (and buttons, prices), and headings. */
  text_size: number
  heading_size: number
  radius: ThemeRadius
  logo_position: 'left' | 'center'
  colors: { background: string; text: string; footer_bg: string; footer_text: string; announcement_bg: string; announcement_text: string }
  announcement: { enabled: boolean; items: string[]; marquee: boolean }
  header: { menu: MenuLink[]; sticky: boolean; uppercase: boolean; transparent: boolean }
  product_card: { aspect: 'portrait' | 'square'; uppercase: boolean; sale_badge: boolean; gap: 'none' | 'small' | 'large'; image_bg: string }
  collection: { banner: boolean; columns: 2 | 3 | 4 | 5 }
  product_page: ProductPageSettings
  footer: { contact_title: string; contact_text: string; links: MenuLink[]; show_currency: boolean }
  sections: ThemeSection[]
  /** Sections shown under the product on every product page. */
  product_sections: ThemeSection[]
  /** Kept for older themes; the trust and banner sections now hold their own settings. */
  trust: Array<{ title: string; text: string }>
  banner: { title: string; text: string; image_url: string; link: string; label: string }
  whatsapp: string
  payment_badges: boolean
  cart: CartSettings
  /** The browser-tab icon of the store (square image); the app icon when empty. */
  favicon_url: string
}

// --- field schema (drives the editor's settings panel) ---------------------------------
export type FieldDef =
  | { key: string; label: string; type: 'text' | 'textarea' | 'image' | 'link' | 'color' | 'video'; placeholder?: string; hint?: string }
  | { key: string; label: string; type: 'select'; options: Array<{ value: string; label: string }>; hint?: string }
  | { key: string; label: string; type: 'toggle'; hint?: string }
  | { key: string; label: string; type: 'range'; min: number; max: number; step?: number; unit?: string }
  | { key: string; label: string; type: 'category'; hint?: string }
  | { key: string; label: string; type: 'categories'; hint?: string }
  | { key: string; label: string; type: 'list'; item: Array<{ key: string; label: string; multiline?: boolean }>; max: number; hint?: string }

export interface SectionDef { label: string; group: 'Banners' | 'Collections' | 'Products' | 'Text' | 'Media' | 'Trust'; description: string; defaults: Settings; fields: FieldDef[] }

const HEIGHTS = [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }, { value: 'full', label: 'Full screen' }]
const ALIGN = [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }]

export const SECTIONS: Record<SectionType, SectionDef> = {
  hero: {
    label: 'Hero', group: 'Banners', description: 'Full-width image or video with text and a button.',
    defaults: { image_url: '', video_url: '', heading: '', text: '', button_label: 'Shop now', button_link: '/shop', height: 'large', position: 'bottom-left', overlay: 25, button_style: 'solid' },
    fields: [
      { key: 'image_url', label: 'Image', type: 'image' },
      { key: 'video_url', label: 'Video (MP4 link)', type: 'video', hint: 'Plays muted on a loop instead of the image' },
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'text', label: 'Text', type: 'textarea' },
      { key: 'button_label', label: 'Button label', type: 'text' },
      { key: 'button_link', label: 'Button link', type: 'link' },
      { key: 'button_style', label: 'Button style', type: 'select', options: [{ value: 'solid', label: 'Solid' }, { value: 'link', label: 'Underlined link' }] },
      { key: 'height', label: 'Height', type: 'select', options: HEIGHTS },
      { key: 'position', label: 'Text position', type: 'select', options: [{ value: 'bottom-left', label: 'Bottom left' }, { value: 'center', label: 'Center' }, { value: 'bottom-center', label: 'Bottom center' }] },
      { key: 'overlay', label: 'Image overlay', type: 'range', min: 0, max: 80, step: 5, unit: '%' },
    ],
  },
  collections: {
    label: 'Collection list', group: 'Collections', description: 'Large image tiles linking to your categories.',
    defaults: { heading: '', categories: [], columns: 3, aspect: 'portrait', labels: 'below' },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'categories', label: 'Categories', type: 'categories', hint: 'Leave empty to show your categories with products' },
      { key: 'columns', label: 'Tiles per row', type: 'range', min: 2, max: 4 },
      { key: 'aspect', label: 'Image shape', type: 'select', options: [{ value: 'portrait', label: 'Portrait' }, { value: 'square', label: 'Square' }, { value: 'landscape', label: 'Landscape' }] },
      { key: 'labels', label: 'Names', type: 'select', options: [{ value: 'below', label: 'Below the image' }, { value: 'overlay', label: 'On the image' }] },
    ],
  },
  featured: {
    label: 'Featured collection', group: 'Products', description: 'A grid of products from a source you choose.',
    defaults: { heading: 'Featured', source: 'featured', category: '', limit: 8, columns: 4, view_all: true },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'source', label: 'Products', type: 'select', options: [{ value: 'featured', label: 'Marked featured' }, { value: 'newest', label: 'Newest' },
        { value: 'best_selling', label: 'Best selling (last 90 days)' }, { value: 'category', label: 'From a category' }] },
      { key: 'category', label: 'Category', type: 'category' },
      { key: 'limit', label: 'Products to show', type: 'range', min: 2, max: 16 },
      { key: 'columns', label: 'Columns on desktop', type: 'range', min: 2, max: 5 },
      { key: 'view_all', label: 'Show “View all”', type: 'toggle' },
    ],
  },
  new: {
    label: 'New arrivals', group: 'Products', description: 'Your newest products.',
    defaults: { heading: 'New Arrivals', source: 'newest', category: '', limit: 8, columns: 4, view_all: true },
    fields: [],
  },
  best_sellers: {
    label: 'Best sellers', group: 'Products', description: 'Your best-selling products of the last 90 days, from real orders.',
    defaults: { heading: 'Best sellers', source: 'best_selling', category: '', limit: 8, columns: 4, view_all: true },
    fields: [],
  },
  trust: {
    label: 'Trust badges', group: 'Trust', description: 'Short promises: delivery, returns, secure checkout.',
    defaults: { items: [] },
    fields: [{ key: 'items', label: 'Badges', type: 'list', item: [{ key: 'title', label: 'Title' }, { key: 'text', label: 'Text' }], max: 4 }],
  },
  banner: {
    label: 'Promo banner', group: 'Banners', description: 'A banner with an image, text and a button.',
    defaults: { title: '', text: '', image_url: '', label: 'Shop now', link: '/shop' },
    fields: [
      { key: 'title', label: 'Heading', type: 'text', hint: 'The banner shows once it has a heading' },
      { key: 'text', label: 'Text', type: 'textarea' },
      { key: 'image_url', label: 'Image', type: 'image' },
      { key: 'label', label: 'Button label', type: 'text' },
      { key: 'link', label: 'Button link', type: 'link' },
    ],
  },
  rich_text: {
    label: 'Rich text', group: 'Text', description: 'A heading and a paragraph, e.g. your story.',
    defaults: { heading: 'Made to last', text: 'Tell customers what your store is about.', align: 'center', button_label: '', button_link: '/shop' },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'text', label: 'Text', type: 'textarea' },
      { key: 'align', label: 'Alignment', type: 'select', options: ALIGN },
      { key: 'button_label', label: 'Button label', type: 'text' },
      { key: 'button_link', label: 'Button link', type: 'link' },
    ],
  },
  marquee: {
    label: 'Scrolling text', group: 'Text', description: 'A moving strip of short messages.',
    defaults: { items: 'NEW DROP · FREE DELIVERY OVER ৳2000 · CASH ON DELIVERY', speed: 30, inverted: true },
    fields: [
      { key: 'items', label: 'Text', type: 'text', hint: 'Separate messages with ·' },
      { key: 'speed', label: 'Speed (seconds per loop)', type: 'range', min: 10, max: 80, step: 5 },
      { key: 'inverted', label: 'Dark strip', type: 'toggle' },
    ],
  },
  image_text: {
    label: 'Image with text', group: 'Media', description: 'An image beside a heading, text and button.',
    defaults: { image_url: '', heading: 'Our story', text: '', button_label: '', button_link: '/shop', image_side: 'left' },
    fields: [
      { key: 'image_url', label: 'Image', type: 'image' },
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'text', label: 'Text', type: 'textarea' },
      { key: 'button_label', label: 'Button label', type: 'text' },
      { key: 'button_link', label: 'Button link', type: 'link' },
      { key: 'image_side', label: 'Image side', type: 'select', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }] },
    ],
  },
  testimonials: {
    label: 'Testimonials', group: 'Trust', description: 'What your customers said, in their words (shown once you add some).',
    defaults: { heading: 'What customers say', items: [], columns: 3 },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'items', label: 'Testimonials', type: 'list', max: 9, hint: 'Only real customers’ words, with their permission',
        item: [{ key: 'quote', label: 'What they said', multiline: true }, { key: 'name', label: 'Name' }, { key: 'detail', label: 'Place or product (optional)' }] },
      { key: 'columns', label: 'Per row on desktop', type: 'range', min: 1, max: 3 },
    ],
  },
  faq: {
    label: 'FAQ', group: 'Text', description: 'Questions and answers that open one at a time.',
    defaults: { heading: 'Questions', items: [] },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'items', label: 'Questions', type: 'list', max: 20, item: [{ key: 'question', label: 'Question' }, { key: 'answer', label: 'Answer', multiline: true }] },
    ],
  },
  newsletter: {
    label: 'Newsletter sign-up', group: 'Text', description: 'An e-mail box; sign-ups arrive in Customers → Messages.',
    defaults: { heading: 'News and offers', text: 'New arrivals and offers by e-mail. You can unsubscribe at any time.', button_label: 'Subscribe', align: 'center' },
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'text', label: 'Text', type: 'textarea' },
      { key: 'button_label', label: 'Button label', type: 'text' },
      { key: 'align', label: 'Alignment', type: 'select', options: ALIGN },
    ],
  },
  video: {
    label: 'Video', group: 'Media', description: 'A YouTube or MP4 video.',
    defaults: { url: '', heading: '', autoplay: true },
    fields: [
      { key: 'url', label: 'YouTube or MP4 link', type: 'video' },
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'autoplay', label: 'Autoplay muted (MP4)', type: 'toggle' },
    ],
  },
}
SECTIONS.new.fields = SECTIONS.featured.fields
SECTIONS.best_sellers.fields = SECTIONS.featured.fields

export type FontGroup = 'Sans serif' | 'Serif' | 'Display' | 'Bangla'
interface FontDef { label: string; group: FontGroup; sample: string; family: string; /** Google Fonts css2 "family=" value; null for the font the app ships (Poppins). */ google: string | null }

const sans = (name: string, bangla = false) => `"${name}", ${bangla ? '' : '"Hind Siliguri", '}ui-sans-serif, system-ui, "Noto Sans Bengali", sans-serif`
const serif = (name: string) => `"${name}", ui-serif, Georgia, "Noto Serif Bengali", serif`
const w = (name: string, weights = '400;500;600;700') => `${name.replaceAll(' ', '+')}:wght@${weights}`

/** Google Fonts the store can use; each loads only when the theme uses it. */
export const FONTS: Record<ThemeFont, FontDef> = {
  poppins: { label: 'Poppins', group: 'Sans serif', sample: 'Aa', family: sans('Poppins'), google: null },
  inter: { label: 'Inter', group: 'Sans serif', sample: 'Aa', family: sans('Inter'), google: w('Inter') },
  montserrat: { label: 'Montserrat', group: 'Sans serif', sample: 'Aa', family: sans('Montserrat'), google: w('Montserrat') },
  dm_sans: { label: 'DM Sans', group: 'Sans serif', sample: 'Aa', family: sans('DM Sans'), google: w('DM Sans') },
  manrope: { label: 'Manrope', group: 'Sans serif', sample: 'Aa', family: sans('Manrope'), google: w('Manrope') },
  outfit: { label: 'Outfit', group: 'Sans serif', sample: 'Aa', family: sans('Outfit'), google: w('Outfit') },
  jost: { label: 'Jost', group: 'Sans serif', sample: 'Aa', family: sans('Jost'), google: w('Jost') },
  lato: { label: 'Lato', group: 'Sans serif', sample: 'Aa', family: sans('Lato'), google: w('Lato', '400;700') },
  roboto: { label: 'Roboto', group: 'Sans serif', sample: 'Aa', family: sans('Roboto'), google: w('Roboto', '400;500;700') },
  open_sans: { label: 'Open Sans', group: 'Sans serif', sample: 'Aa', family: sans('Open Sans'), google: w('Open Sans') },
  nunito: { label: 'Nunito', group: 'Sans serif', sample: 'Aa', family: sans('Nunito'), google: w('Nunito') },
  playfair: { label: 'Playfair Display', group: 'Serif', sample: 'Aa', family: serif('Playfair Display'), google: w('Playfair Display') },
  lora: { label: 'Lora', group: 'Serif', sample: 'Aa', family: serif('Lora'), google: w('Lora') },
  cormorant: { label: 'Cormorant Garamond', group: 'Serif', sample: 'Aa', family: serif('Cormorant Garamond'), google: w('Cormorant Garamond') },
  dm_serif: { label: 'DM Serif Display', group: 'Display', sample: 'Aa', family: serif('DM Serif Display'), google: 'DM+Serif+Display' },
  oswald: { label: 'Oswald', group: 'Display', sample: 'Aa', family: sans('Oswald'), google: w('Oswald') },
  hind: { label: 'Hind Siliguri', group: 'Bangla', sample: 'অআ', family: sans('Hind Siliguri', true), google: w('Hind Siliguri') },
  noto_bengali: { label: 'Noto Sans Bengali', group: 'Bangla', sample: 'অআ', family: sans('Noto Sans Bengali', true), google: w('Noto Sans Bengali') },
  anek_bangla: { label: 'Anek Bangla', group: 'Bangla', sample: 'অআ', family: sans('Anek Bangla', true), google: w('Anek Bangla') },
}
const isFont = (v: unknown): v is ThemeFont => typeof v === 'string' && Object.hasOwn(FONTS, v)
export const FONT_GROUPS: FontGroup[] = ['Sans serif', 'Serif', 'Display', 'Bangla']
export const HEADING_WEIGHTS: Array<{ value: HeadingWeight; label: string }> = [
  { value: 'default', label: 'Theme default' }, { value: '400', label: 'Regular' }, { value: '500', label: 'Medium' }, { value: '600', label: 'Semibold' }, { value: '700', label: 'Bold' },
]
/** Size sliders, in %. */
export const TEXT_SIZE = { min: 80, max: 130 } as const
export const HEADING_SIZE = { min: 70, max: 150 } as const

/** The stylesheet URL for some fonts (null when all ship with the app). `text` limits it to those letters (font pickers). */
export function fontsHref(fonts: ThemeFont[], text?: string): string | null {
  const families = [...new Set(fonts)].map((f) => FONTS[f]?.google).filter((g): g is string => !!g)
  if (!families.length) return null
  return `https://fonts.googleapis.com/css2?${families.map((g) => `family=${g}`).join('&')}&display=swap${text ? `&text=${encodeURIComponent(text)}` : ''}`
}

export const RADII: Record<ThemeRadius, { label: string; value: string }> = {
  sharp: { label: 'Sharp', value: '0rem' }, soft: { label: 'Soft', value: '0.625rem' }, round: { label: 'Round', value: '1.25rem' },
}

/** Mostly greys; a few calm colours for stores that want one. */
export const ACCENTS = ['#0b0b0c', '#3f3f46', '#71717a', '#1d4ed8', '#047857', '#b91c1c', '#9a3412', '#7c3aed']

const newId = () => Math.random().toString(36).slice(2, 10)
export const makeSection = (type: SectionType, settings: Settings = {}): ThemeSection =>
  ({ id: `${type}-${newId()}`, type, enabled: true, settings: { ...SECTIONS[type].defaults, ...settings } })

const DEFAULT_TRUST = [
  { title: 'Nationwide delivery', text: 'Cash on delivery available' },
  { title: 'Easy returns', text: 'Contact us if anything is not right' },
  { title: 'Secure checkout', text: 'Your details stay private' },
]

export const DEFAULT_THEME: StoreTheme = {
  accent: '#0b0b0c',
  font: 'poppins',
  heading_font: 'poppins',
  heading_weight: 'default',
  text_size: 100,
  heading_size: 100,
  radius: 'sharp',
  logo_position: 'center',
  colors: { background: '#ffffff', text: '#0b0b0c', footer_bg: '#000000', footer_text: '#ffffff', announcement_bg: '#000000', announcement_text: '#ffffff' },
  announcement: { enabled: false, items: [], marquee: true },
  header: { menu: [], sticky: true, uppercase: false, transparent: true },
  product_card: { aspect: 'portrait', uppercase: true, sale_badge: true, gap: 'small', image_bg: '#f4f4f5' },
  collection: { banner: true, columns: 4 },
  product_page: {
    layout: 'minimal', buy_now_style: 'outline', button_radius: 6,
    accordions: [
      { title: 'Product Details', content: 'description', text: '' },
      { title: 'Shipping Details', content: 'shipping', text: '' },
      { title: 'Care', content: 'warranty', text: '' },
    ],
    show_delivery: false, delivery_min_days: 1, delivery_max_days: 2, highlights: [], promo_text: '',
    image_aspect: 'portrait', show_brand: true, show_sale_badge: true, show_stock: true, show_quantity: true, show_buy_now: true,
    show_description: true, description_title: 'Description', show_details: true, show_sku: true, show_tags: true,
    show_related: true, related_title: 'You may also like',
    blocks: DEFAULT_PRODUCT_BLOCKS,
  },
  footer: { contact_title: 'Contact information', contact_text: '', links: [], show_currency: true },
  sections: [
    { id: 'hero', type: 'hero', enabled: true, settings: { ...SECTIONS.hero.defaults } },
    { id: 'collections', type: 'collections', enabled: true, settings: { ...SECTIONS.collections.defaults } },
    { id: 'new', type: 'new', enabled: true, settings: { ...SECTIONS.new.defaults } },
    { id: 'featured', type: 'featured', enabled: true, settings: { ...SECTIONS.featured.defaults } },
  ],
  product_sections: [],
  trust: DEFAULT_TRUST,
  banner: { title: '', text: '', image_url: '', link: '/shop', label: 'Shop now' },
  whatsapp: '',
  payment_badges: true,
  cart: {
    free_shipping_bar: true, free_shipping_text: 'Add {amount} more for free delivery', unlocked_text: 'Your order qualifies for free delivery',
    upsell: true, upsell_title: 'You may also like', show_savings: true, note: '',
  },
  favicon_url: '',
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const hex = (v: unknown, d: string) => (isHex(v) ? v : d)
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const days = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(30, Math.max(0, Math.round(v))) : d)
const links = (v: unknown): MenuLink[] => (Array.isArray(v) ? v : [])
  .filter((l): l is MenuLink => !!l && typeof l === 'object' && typeof (l as MenuLink).label === 'string')
  .map((l) => ({ label: l.label, link: str(l.link, '/') })).slice(0, 12)

/** Sections saved by the editor ({id, type, enabled, settings}), defaults filled in. */
function readSections(v: unknown): ThemeSection[] {
  return (Array.isArray(v) ? v : []).filter((x): x is ThemeSection => !!x && typeof x === 'object' && (x as ThemeSection).type in SECTIONS)
    .map((x) => ({ id: str(x.id, newId()), type: x.type, enabled: x.enabled !== false, settings: { ...SECTIONS[x.type].defaults, ...(x.settings ?? {}) } }))
    .slice(0, 20)
}

/** The saved theme with defaults filled in; older saved themes are upgraded. */
export function resolveTheme(sf: Storefront | undefined | null): StoreTheme {
  const t = (sf?.theme ?? {}) as Record<string, unknown> & Partial<StoreTheme>
  const legacy = !Array.isArray(t.sections) || t.sections.some((s) => !(s as ThemeSection)?.id)
  const trust = Array.isArray(t.trust) && t.trust.length ? (t.trust as StoreTheme['trust']).slice(0, 4) : DEFAULT_TRUST
  const banner = { ...DEFAULT_THEME.banner, ...((t.banner as object) ?? {}) }

  let sections: ThemeSection[]
  if (!Array.isArray(t.sections) || !t.sections.length) {
    sections = DEFAULT_THEME.sections.map((s) => ({ ...s, settings: { ...s.settings } }))
  } else if (legacy) {
    // Older themes: [{type, enabled}] with content kept on the storefront and theme.
    sections = (t.sections as Array<{ type: string; enabled: boolean }>).flatMap((s): ThemeSection[] => {
      const type = (s.type === 'categories' ? 'collections' : s.type) as SectionType
      if (!(type in SECTIONS)) return []
      return [{ id: type, type, enabled: s.enabled !== false, settings: { ...SECTIONS[type].defaults } }]
    })
  } else {
    sections = (t.sections as ThemeSection[]).filter((s) => s.type in SECTIONS)
      .map((s) => ({ id: str(s.id, newId()), type: s.type, enabled: s.enabled !== false, settings: { ...SECTIONS[s.type].defaults, ...(s.settings ?? {}) } }))
  }
  // Content that older stores kept elsewhere fills sections that never had their own.
  sections = sections.map((s) => {
    if (s.type === 'hero' && !s.settings.heading && !s.settings.image_url && legacy) {
      return { ...s, settings: { ...s.settings, heading: str(sf?.hero_title), text: str(sf?.hero_subtitle), image_url: str(sf?.hero_image_url),
        button_label: str(sf?.hero_cta_label, 'Shop now'), button_link: str(sf?.hero_cta_link, '/shop') } }
    }
    if (s.type === 'trust' && !(s.settings.items as unknown[])?.length) return { ...s, settings: { ...s.settings, items: trust } }
    if (s.type === 'banner' && !s.settings.title && legacy) return { ...s, settings: { ...s.settings, ...banner } }
    if (s.type === 'collections' && !(s.settings.categories as unknown[])?.length && sf?.featured_category_slugs?.length && legacy) {
      return { ...s, settings: { ...s.settings, categories: sf.featured_category_slugs } }
    }
    return s
  })

  const c = (t.colors ?? {}) as Partial<StoreTheme['colors']>
  const a = (t.announcement ?? {}) as Partial<StoreTheme['announcement']>
  const h = (t.header ?? {}) as Partial<StoreTheme['header']>
  const pc = (t.product_card ?? {}) as Partial<StoreTheme['product_card']>
  const col = (t.collection ?? {}) as Partial<StoreTheme['collection']>
  const f = (t.footer ?? {}) as Partial<StoreTheme['footer']>
  const pp = (t.product_page ?? {}) as Partial<ProductPageSettings>
  const dp = DEFAULT_THEME.product_page
  const legacyText = str(sf?.announcement).trim()
  const items = Array.isArray(a.items) ? a.items.filter((x): x is string => typeof x === 'string') : legacyText ? [legacyText] : []
  return {
    accent: hex(t.accent, DEFAULT_THEME.accent),
    font: isFont(t.font) ? t.font : DEFAULT_THEME.font,
    heading_font: isFont(t.heading_font) ? t.heading_font : isFont(t.font) ? t.font : DEFAULT_THEME.heading_font,
    heading_weight: HEADING_WEIGHTS.some((x) => x.value === t.heading_weight) ? t.heading_weight! : 'default',
    text_size: percent(t.text_size, TEXT_SIZE),
    heading_size: percent(t.heading_size, HEADING_SIZE),
    radius: t.radius && t.radius in RADII ? t.radius : legacy && t.radius === undefined && Array.isArray(t.sections) ? 'soft' : DEFAULT_THEME.radius,
    logo_position: t.logo_position === 'left' ? 'left' : t.logo_position === 'center' ? 'center' : legacy && Array.isArray(t.sections) ? 'left' : 'center',
    colors: {
      background: hex(c.background, DEFAULT_THEME.colors.background), text: hex(c.text, DEFAULT_THEME.colors.text),
      footer_bg: hex(c.footer_bg, DEFAULT_THEME.colors.footer_bg), footer_text: hex(c.footer_text, DEFAULT_THEME.colors.footer_text),
      announcement_bg: hex(c.announcement_bg, DEFAULT_THEME.colors.announcement_bg), announcement_text: hex(c.announcement_text, DEFAULT_THEME.colors.announcement_text),
    },
    announcement: { enabled: bool(a.enabled, items.length > 0), items, marquee: bool(a.marquee, true) },
    header: { menu: links(h.menu), sticky: bool(h.sticky, true), uppercase: bool(h.uppercase, DEFAULT_THEME.header.uppercase), transparent: bool(h.transparent, DEFAULT_THEME.header.transparent) },
    product_card: {
      aspect: pc.aspect === 'square' ? 'square' : 'portrait', uppercase: bool(pc.uppercase, true), sale_badge: bool(pc.sale_badge, true),
      gap: pc.gap === 'none' || pc.gap === 'large' ? pc.gap : 'small', image_bg: hex(pc.image_bg, DEFAULT_THEME.product_card.image_bg),
    },
    collection: { banner: bool(col.banner, true), columns: ([2, 3, 4, 5] as const).includes(col.columns as 2) ? (col.columns as 2 | 3 | 4 | 5) : 4 },
    product_page: {
      layout: pp.layout === 'classic' || pp.layout === 'bold' ? pp.layout : dp.layout,
      buy_now_style: pp.buy_now_style === 'filled' ? 'filled' : pp.buy_now_style === 'outline' ? 'outline' : pp.layout === 'bold' ? 'filled' : dp.buy_now_style,
      button_radius: typeof pp.button_radius === 'number' && Number.isFinite(pp.button_radius) ? Math.min(24, Math.max(0, Math.round(pp.button_radius))) : dp.button_radius,
      accordions: Array.isArray(pp.accordions)
        ? pp.accordions.filter((a): a is ProductAccordion => !!a && typeof a === 'object').slice(0, 8).map((a) => ({
          title: str(a.title).slice(0, 60),
          content: (['description', 'shipping', 'warranty', 'custom'] as const).includes(a.content) ? a.content : 'custom',
          text: str(a.text).slice(0, 2000),
        }))
        : dp.accordions.map((a) => ({ ...a })),
      show_delivery: bool(pp.show_delivery, dp.show_delivery),
      delivery_min_days: days(pp.delivery_min_days, dp.delivery_min_days),
      delivery_max_days: Math.max(days(pp.delivery_min_days, dp.delivery_min_days), days(pp.delivery_max_days, dp.delivery_max_days)),
      highlights: Array.isArray(pp.highlights) ? pp.highlights.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 60)).slice(0, 4) : [],
      promo_text: str(pp.promo_text).slice(0, 120),
      image_aspect: pp.image_aspect === 'square' ? 'square' : 'portrait',
      show_brand: bool(pp.show_brand, dp.show_brand), show_sale_badge: bool(pp.show_sale_badge, dp.show_sale_badge),
      show_stock: bool(pp.show_stock, dp.show_stock), show_quantity: bool(pp.show_quantity, dp.show_quantity),
      show_buy_now: bool(pp.show_buy_now, dp.show_buy_now), show_description: bool(pp.show_description, dp.show_description),
      description_title: str(pp.description_title, dp.description_title), show_details: bool(pp.show_details, dp.show_details),
      show_sku: bool(pp.show_sku, dp.show_sku), show_tags: bool(pp.show_tags, dp.show_tags),
      show_related: bool(pp.show_related, dp.show_related), related_title: str(pp.related_title, dp.related_title),
      blocks: readBlocks(pp.blocks),
    },
    footer: { contact_title: str(f.contact_title, DEFAULT_THEME.footer.contact_title), contact_text: str(f.contact_text), links: links(f.links), show_currency: bool(f.show_currency, true) },
    sections,
    product_sections: readSections(t.product_sections),
    trust,
    banner,
    whatsapp: str(t.whatsapp),
    payment_badges: bool(t.payment_badges, true),
    cart: (() => {
      const k = (t.cart ?? {}) as Partial<CartSettings>
      const d = DEFAULT_THEME.cart
      return {
        free_shipping_bar: bool(k.free_shipping_bar, d.free_shipping_bar), free_shipping_text: str(k.free_shipping_text, d.free_shipping_text).slice(0, 80),
        unlocked_text: str(k.unlocked_text, d.unlocked_text).slice(0, 80), upsell: bool(k.upsell, d.upsell),
        upsell_title: str(k.upsell_title, d.upsell_title).slice(0, 60), show_savings: bool(k.show_savings, d.show_savings), note: str(k.note).slice(0, 160),
      }
    })(),
    favicon_url: /^(https:\/\/|\/)/.test(str(t.favicon_url)) ? str(t.favicon_url) : '',
  }
}

/** Text on the accent colour: white on dark colours, near-black on light ones. */
function onColor(color: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0b0b0c' : '#fafafa'
}

const pct = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)))
function percent(v: unknown, range: { min: number; max: number }): number {
  return typeof v === 'number' && Number.isFinite(v) ? pct(v, range.min, range.max) : 100
}

// Tailwind's text sizes, in rem. Up to lg they are body text, from xl on headings (index.css, [data-store-theme]).
const BODY_SIZES = { xs: 0.75, sm: 0.875, base: 1, lg: 1.125 }
const HEADING_SIZES = { xl: 1.25, '2xl': 1.5, '3xl': 1.875, '4xl': 2.25, '5xl': 3, '6xl': 3.75, '7xl': 4.5, '8xl': 6, '9xl': 8 }

/** The store's look as CSS variables, for its outermost element (with themeData). */
export function themeStyle(t: StoreTheme): CSSProperties {
  const body = t.text_size / 100
  const heading = t.heading_size / 100
  const sizes: Record<string, string> = {}
  for (const [k, rem] of Object.entries(BODY_SIZES)) sizes[`--text-${k}`] = `${+(rem * body).toFixed(4)}rem`
  for (const [k, rem] of Object.entries(HEADING_SIZES)) sizes[`--text-${k}`] = `${+(rem * heading).toFixed(4)}rem`
  return {
    '--primary': t.accent, '--primary-foreground': onColor(t.accent), '--ring': t.accent,
    // Every button in the store (the app's own are blue) takes the theme colour, black by default.
    '--brand': t.accent, '--brand-foreground': onColor(t.accent), '--brand-soft': `color-mix(in srgb, ${t.accent} 8%, transparent)`,
    '--background': t.colors.background, '--foreground': t.colors.text,
    '--radius': RADII[t.radius].value, fontFamily: FONTS[t.font].family,
    '--store-font-heading': FONTS[t.heading_font].family, '--store-heading-weight': t.heading_weight === 'default' ? undefined : t.heading_weight,
    '--fs-body': body, '--fs-heading': heading, ...sizes,
    fontSize: `${body}rem`,
    background: t.colors.background, color: t.colors.text,
  } as CSSProperties
}

/** Data attributes for the same element: headings take the heading font (and weight) from them. */
export function themeData(t: StoreTheme): Record<string, string | undefined> {
  return { 'data-store-theme': '', 'data-heading-weight': t.heading_weight === 'default' ? undefined : '' }
}

/** Loads the web fonts the theme uses (Poppins ships with the app). */
export function useThemeFont(...fonts: ThemeFont[]) {
  const key = [...new Set(fonts)].sort().join(',')
  useEffect(() => {
    for (const font of key.split(',') as ThemeFont[]) {
      const href = FONTS[font] && fontsHref([font])
      if (!href || document.querySelector(`link[data-theme-font="${font}"]`)) continue
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      link.dataset.themeFont = font
      document.head.appendChild(link)
    }
  }, [key])
}

// --- live preview inside the theme builder ------------------------------------------
// The builder shows the staff's own store in an iframe on this site
// (/?theme_preview=1, resolved by storefront_resolve_preview) and posts the draft
// storefront settings and the selected section to it; nothing is saved until
// staff save. Clicking a section in the preview selects it in the editor.

interface PreviewState { storefront: Storefront | null; selected: string | null; hovered: string | null; inspect: boolean }
let preview: PreviewState = { storefront: null, selected: null, hovered: null, inspect: true }
const listeners = new Set<() => void>()
let listening = false

function startListening() {
  if (listening || !isPreviewFrame()) return
  try { sessionStorage.setItem('theme_preview', '1') } catch { /* private mode */ }
  listening = true
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return
    if (e.data?.type === 'theme-preview') {
      preview = { ...preview, storefront: e.data.storefront as Storefront, selected: e.data.selected ?? null, inspect: e.data.inspect !== false }
    } else if (e.data?.type === 'theme-select') {
      preview = { ...preview, selected: e.data.id ?? null }
      if (e.data.id && e.data.scroll) document.querySelector(`[data-section-id="${CSS.escape(e.data.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (e.data?.type === 'theme-hover') {
      preview = { ...preview, hovered: e.data.id ?? null }
    } else if (e.data?.type === 'theme-navigate' && typeof e.data.path === 'string' && e.data.path.startsWith('/') && !e.data.path.startsWith('//') && !e.data.path.startsWith('/\\')) {
      window.location.assign(e.data.path + (e.data.path.includes('?') ? '&' : '?') + 'theme_preview=1')
      return
    } else return
    listeners.forEach((l) => l())
  })
  window.parent.postMessage({ type: 'theme-preview-ready', path: window.location.pathname }, window.location.origin)
}

const subscribe = (l: () => void) => { startListening(); listeners.add(l); return () => { listeners.delete(l) } }

/** True inside the theme builder's preview frame. */
export const isThemePreview = isPreviewFrame

/** The storefront settings to render: the builder's draft while previewing, else the saved ones. */
export function useStorefront(saved: Storefront | undefined): Storefront | undefined {
  const draft = useSyncExternalStore(subscribe, () => preview.storefront, () => null)
  return draft ?? saved
}

/** Which section the builder has selected / is pointing at (preview only). */
export function usePreviewSelection(): { selected: string | null; hovered: string | null; inspect: boolean } {
  const state = useSyncExternalStore(subscribe, () => preview, () => preview)
  return { selected: state.selected, hovered: state.hovered, inspect: state.inspect }
}

/** Tells the builder a section was clicked in the preview. */
export function selectInBuilder(id: string) {
  if (isThemePreview()) window.parent.postMessage({ type: 'theme-section-click', id }, window.location.origin)
}
