import { type CSSProperties, useEffect, useSyncExternalStore } from 'react'
import type { StoreConfig } from '@/types/domain'

// The store's theme, edited in the theme builder (Shopify-style editor) and
// saved in the public "storefront" setting as storefront.theme. Older saved
// themes (a fixed list of sections) are read and upgraded by resolveTheme().

export type Storefront = StoreConfig['storefront']
export type ThemeFont = 'poppins' | 'inter' | 'hind'
export type ThemeRadius = 'sharp' | 'soft' | 'round'

export type SectionType = 'hero' | 'collections' | 'featured' | 'new' | 'trust' | 'banner' | 'rich_text' | 'marquee' | 'image_text' | 'video'
export type Settings = Record<string, unknown>
export interface ThemeSection { id: string; type: SectionType; enabled: boolean; settings: Settings }
export interface MenuLink { label: string; link: string }

export interface StoreTheme {
  accent: string
  font: ThemeFont
  radius: ThemeRadius
  logo_position: 'left' | 'center'
  colors: { background: string; text: string; footer_bg: string; footer_text: string; announcement_bg: string; announcement_text: string }
  announcement: { enabled: boolean; items: string[]; marquee: boolean }
  header: { menu: MenuLink[]; sticky: boolean; uppercase: boolean; transparent: boolean }
  product_card: { aspect: 'portrait' | 'square'; uppercase: boolean; sale_badge: boolean; gap: 'none' | 'small' | 'large'; image_bg: string }
  collection: { banner: boolean; columns: 2 | 3 | 4 | 5 }
  footer: { contact_title: string; contact_text: string; links: MenuLink[]; show_currency: boolean }
  sections: ThemeSection[]
  /** Kept for older themes; the trust and banner sections now hold their own settings. */
  trust: Array<{ title: string; text: string }>
  banner: { title: string; text: string; image_url: string; link: string; label: string }
  whatsapp: string
  payment_badges: boolean
}

// --- field schema (drives the editor's settings panel) ---------------------------------
export type FieldDef =
  | { key: string; label: string; type: 'text' | 'textarea' | 'image' | 'link' | 'color' | 'video'; placeholder?: string; hint?: string }
  | { key: string; label: string; type: 'select'; options: Array<{ value: string; label: string }>; hint?: string }
  | { key: string; label: string; type: 'toggle'; hint?: string }
  | { key: string; label: string; type: 'range'; min: number; max: number; step?: number; unit?: string }
  | { key: string; label: string; type: 'category'; hint?: string }
  | { key: string; label: string; type: 'categories'; hint?: string }
  | { key: string; label: string; type: 'list'; item: Array<{ key: string; label: string }>; max: number }

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
      { key: 'source', label: 'Products', type: 'select', options: [{ value: 'featured', label: 'Marked featured' }, { value: 'newest', label: 'Newest' }, { value: 'category', label: 'From a category' }] },
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

export const FONTS: Record<ThemeFont, { label: string; sample: string; family: string; href: string | null }> = {
  poppins: { label: 'Poppins', sample: 'Aa', family: '"Poppins", ui-sans-serif, system-ui, sans-serif', href: null },
  inter: { label: 'Inter', sample: 'Aa', family: '"Inter", ui-sans-serif, system-ui, sans-serif', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap' },
  hind: { label: 'Hind Siliguri', sample: 'অআ', family: '"Hind Siliguri", "Noto Sans Bengali", ui-sans-serif, system-ui, sans-serif', href: 'https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap' },
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
  radius: 'sharp',
  logo_position: 'center',
  colors: { background: '#ffffff', text: '#0b0b0c', footer_bg: '#000000', footer_text: '#ffffff', announcement_bg: '#000000', announcement_text: '#ffffff' },
  announcement: { enabled: false, items: [], marquee: true },
  header: { menu: [], sticky: true, uppercase: true, transparent: false },
  product_card: { aspect: 'portrait', uppercase: true, sale_badge: true, gap: 'small', image_bg: '#f4f4f5' },
  collection: { banner: true, columns: 4 },
  footer: { contact_title: 'Contact information', contact_text: '', links: [], show_currency: true },
  sections: [
    { id: 'hero', type: 'hero', enabled: true, settings: { ...SECTIONS.hero.defaults } },
    { id: 'collections', type: 'collections', enabled: true, settings: { ...SECTIONS.collections.defaults } },
    { id: 'new', type: 'new', enabled: true, settings: { ...SECTIONS.new.defaults } },
    { id: 'featured', type: 'featured', enabled: true, settings: { ...SECTIONS.featured.defaults } },
  ],
  trust: DEFAULT_TRUST,
  banner: { title: '', text: '', image_url: '', link: '/shop', label: 'Shop now' },
  whatsapp: '',
  payment_badges: true,
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const hex = (v: unknown, d: string) => (isHex(v) ? v : d)
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const links = (v: unknown): MenuLink[] => (Array.isArray(v) ? v : [])
  .filter((l): l is MenuLink => !!l && typeof l === 'object' && typeof (l as MenuLink).label === 'string')
  .map((l) => ({ label: l.label, link: str(l.link, '/') })).slice(0, 12)

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
  const legacyText = str(sf?.announcement).trim()
  const items = Array.isArray(a.items) ? a.items.filter((x): x is string => typeof x === 'string') : legacyText ? [legacyText] : []
  return {
    accent: hex(t.accent, DEFAULT_THEME.accent),
    font: t.font && t.font in FONTS ? t.font : DEFAULT_THEME.font,
    radius: t.radius && t.radius in RADII ? t.radius : legacy && t.radius === undefined && Array.isArray(t.sections) ? 'soft' : DEFAULT_THEME.radius,
    logo_position: t.logo_position === 'left' ? 'left' : t.logo_position === 'center' ? 'center' : legacy && Array.isArray(t.sections) ? 'left' : 'center',
    colors: {
      background: hex(c.background, DEFAULT_THEME.colors.background), text: hex(c.text, DEFAULT_THEME.colors.text),
      footer_bg: hex(c.footer_bg, DEFAULT_THEME.colors.footer_bg), footer_text: hex(c.footer_text, DEFAULT_THEME.colors.footer_text),
      announcement_bg: hex(c.announcement_bg, DEFAULT_THEME.colors.announcement_bg), announcement_text: hex(c.announcement_text, DEFAULT_THEME.colors.announcement_text),
    },
    announcement: { enabled: bool(a.enabled, items.length > 0), items, marquee: bool(a.marquee, true) },
    header: { menu: links(h.menu), sticky: bool(h.sticky, true), uppercase: bool(h.uppercase, true), transparent: bool(h.transparent, false) },
    product_card: {
      aspect: pc.aspect === 'square' ? 'square' : 'portrait', uppercase: bool(pc.uppercase, true), sale_badge: bool(pc.sale_badge, true),
      gap: pc.gap === 'none' || pc.gap === 'large' ? pc.gap : 'small', image_bg: hex(pc.image_bg, DEFAULT_THEME.product_card.image_bg),
    },
    collection: { banner: bool(col.banner, true), columns: ([2, 3, 4, 5] as const).includes(col.columns as 2) ? (col.columns as 2 | 3 | 4 | 5) : 4 },
    footer: { contact_title: str(f.contact_title, DEFAULT_THEME.footer.contact_title), contact_text: str(f.contact_text), links: links(f.links), show_currency: bool(f.show_currency, true) },
    sections,
    trust,
    banner,
    whatsapp: str(t.whatsapp),
    payment_badges: bool(t.payment_badges, true),
  }
}

/** Text on the accent colour: white on dark colours, near-black on light ones. */
export function onColor(color: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0b0b0c' : '#fafafa'
}

export function themeStyle(t: StoreTheme): CSSProperties {
  return {
    '--primary': t.accent, '--primary-foreground': onColor(t.accent), '--ring': t.accent,
    '--background': t.colors.background, '--foreground': t.colors.text,
    '--radius': RADII[t.radius].value, fontFamily: FONTS[t.font].family,
    background: t.colors.background, color: t.colors.text,
  } as CSSProperties
}

/** Loads the web font the theme uses (Poppins ships with the app). */
export function useThemeFont(font: ThemeFont) {
  useEffect(() => {
    const href = FONTS[font].href
    if (!href || document.querySelector(`link[data-theme-font="${font}"]`)) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset.themeFont = font
    document.head.appendChild(link)
  }, [font])
}

// --- live preview inside the theme builder ------------------------------------------
// The builder shows the store in an iframe (?theme_preview=1) and posts the draft
// storefront settings and the selected section to it; nothing is saved until
// staff save. Clicking a section in the preview selects it in the editor.

interface PreviewState { storefront: Storefront | null; selected: string | null; hovered: string | null; inspect: boolean }
let preview: PreviewState = { storefront: null, selected: null, hovered: null, inspect: true }
const listeners = new Set<() => void>()
let listening = false

function startListening() {
  if (listening || typeof window === 'undefined' || window.parent === window) return
  if (!new URLSearchParams(window.location.search).has('theme_preview') && !sessionStorage.getItem('theme_preview')) return
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
    } else if (e.data?.type === 'theme-navigate' && typeof e.data.path === 'string' && e.data.path.startsWith('/')) {
      window.location.assign(e.data.path + (e.data.path.includes('?') ? '&' : '?') + 'theme_preview=1')
      return
    } else return
    listeners.forEach((l) => l())
  })
  window.parent.postMessage({ type: 'theme-preview-ready', path: window.location.pathname }, window.location.origin)
}

const subscribe = (l: () => void) => { startListening(); listeners.add(l); return () => { listeners.delete(l) } }

/** True inside the theme builder's preview frame. */
export function isThemePreview(): boolean {
  if (typeof window === 'undefined' || window.parent === window) return false
  try { return new URLSearchParams(window.location.search).has('theme_preview') || !!sessionStorage.getItem('theme_preview') } catch { return false }
}

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
