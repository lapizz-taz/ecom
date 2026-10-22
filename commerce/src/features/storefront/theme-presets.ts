import { DEFAULT_THEME, makeSection, SECTIONS, type SectionType, type Settings, type StoreTheme, type ThemeSection } from './theme'

// Ready-made themes on Store → Theme. A preset changes the look (fonts, colours, corners, cards,
// product page layout) and the home page's section order; the store's own content stays: menu,
// announcement, footer, favicon, WhatsApp, cart texts, product page blocks, and what the merchant
// typed or uploaded into sections (images, headings, testimonials, FAQ…).

type Look = Pick<StoreTheme, 'accent' | 'font' | 'heading_font' | 'heading_weight' | 'text_size' | 'heading_size' | 'radius' | 'logo_position' | 'colors' | 'product_card' | 'collection'> & {
  header: Pick<StoreTheme['header'], 'sticky' | 'uppercase' | 'transparent'>
  product_page: Pick<StoreTheme['product_page'], 'layout' | 'buy_now_style' | 'button_radius' | 'image_aspect'>
}

export interface ThemePreset {
  id: string
  name: string
  /** Who it suits, e.g. "Beauty & cosmetics". */
  for: string
  description: string
  look: Look
  /** The home page sections, in order (their content comes from the store when it has some). */
  sections: Array<[SectionType, Settings?]>
}

const classicLook: Look = {
  accent: DEFAULT_THEME.accent, font: DEFAULT_THEME.font, heading_font: DEFAULT_THEME.heading_font, heading_weight: DEFAULT_THEME.heading_weight,
  text_size: DEFAULT_THEME.text_size, heading_size: DEFAULT_THEME.heading_size, radius: DEFAULT_THEME.radius, logo_position: DEFAULT_THEME.logo_position,
  colors: DEFAULT_THEME.colors, product_card: DEFAULT_THEME.product_card, collection: DEFAULT_THEME.collection,
  header: { sticky: DEFAULT_THEME.header.sticky, uppercase: DEFAULT_THEME.header.uppercase, transparent: DEFAULT_THEME.header.transparent },
  product_page: {
    layout: DEFAULT_THEME.product_page.layout, buy_now_style: DEFAULT_THEME.product_page.buy_now_style,
    button_radius: DEFAULT_THEME.product_page.button_radius, image_aspect: DEFAULT_THEME.product_page.image_aspect,
  },
}

const MARQUEE = 'CASH ON DELIVERY · DELIVERY ALL OVER BANGLADESH · SHOP NOW'

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'classic', name: 'Classic', for: 'Fashion & clothing',
    description: 'Black and white, big photos, centred logo. Lets the clothes do the talking.',
    look: classicLook,
    sections: [['hero'], ['collections'], ['new'], ['featured']],
  },
  {
    id: 'bloom', name: 'Bloom', for: 'Beauty & cosmetics',
    description: 'Soft blush tones, an elegant serif and rounded buttons. Square photos for bottles and jars.',
    look: {
      accent: '#9d174d', font: 'dm_sans', heading_font: 'cormorant', heading_weight: '600', text_size: 100, heading_size: 115,
      radius: 'round', logo_position: 'center',
      colors: { background: '#fffaf7', text: '#2b1d1a', footer_bg: '#2b1d1a', footer_text: '#fbeee8', announcement_bg: '#9d174d', announcement_text: '#ffffff' },
      header: { sticky: true, uppercase: false, transparent: false },
      product_card: { aspect: 'square', uppercase: false, sale_badge: true, gap: 'large', image_bg: '#f6ebe6' },
      collection: { banner: true, columns: 4 },
      product_page: { layout: 'classic', buy_now_style: 'filled', button_radius: 24, image_aspect: 'square' },
    },
    sections: [
      ['hero', { height: 'medium', position: 'center', overlay: 20 }],
      ['collections', { heading: 'Shop by category', aspect: 'square', columns: 4 }],
      ['best_sellers', { heading: 'Best sellers' }],
      ['marquee', { items: MARQUEE, inverted: false }],
      ['new', { heading: 'New in' }],
      ['testimonials'],
      ['trust'],
      ['newsletter'],
    ],
  },
  {
    id: 'volt', name: 'Volt', for: 'Gadgets & electronics',
    description: 'Crisp white and electric blue, a modern sans-serif and the Bold product page. Built for specs and prices.',
    look: {
      accent: '#1d4ed8', font: 'inter', heading_font: 'manrope', heading_weight: '700', text_size: 100, heading_size: 100,
      radius: 'soft', logo_position: 'left',
      colors: { background: '#ffffff', text: '#0f172a', footer_bg: '#0f172a', footer_text: '#e2e8f0', announcement_bg: '#1d4ed8', announcement_text: '#ffffff' },
      header: { sticky: true, uppercase: false, transparent: false },
      product_card: { aspect: 'square', uppercase: false, sale_badge: true, gap: 'small', image_bg: '#f1f5f9' },
      collection: { banner: false, columns: 5 },
      product_page: { layout: 'bold', buy_now_style: 'filled', button_radius: 10, image_aspect: 'square' },
    },
    sections: [
      ['hero', { height: 'medium', position: 'bottom-left', overlay: 35 }],
      ['trust'],
      ['collections', { heading: 'Shop by category', aspect: 'square', columns: 4 }],
      ['best_sellers', { heading: 'Best sellers', columns: 5, limit: 10 }],
      ['featured', { heading: 'Featured', columns: 5, limit: 10 }],
      ['banner'],
      ['faq'],
      ['newsletter'],
    ],
  },
  {
    id: 'bazaar', name: 'Bazaar', for: 'Home, food & gifts',
    description: 'Warm cream and terracotta with a Bangla-friendly font. Feels like a well-kept local shop.',
    look: {
      accent: '#9a3412', font: 'hind', heading_font: 'lora', heading_weight: '600', text_size: 105, heading_size: 105,
      radius: 'soft', logo_position: 'left',
      colors: { background: '#fbf7f0', text: '#292018', footer_bg: '#3b2a1e', footer_text: '#f5ebdd', announcement_bg: '#9a3412', announcement_text: '#ffffff' },
      header: { sticky: true, uppercase: false, transparent: false },
      product_card: { aspect: 'square', uppercase: false, sale_badge: true, gap: 'large', image_bg: '#f1e8da' },
      collection: { banner: true, columns: 3 },
      product_page: { layout: 'classic', buy_now_style: 'filled', button_radius: 8, image_aspect: 'square' },
    },
    sections: [
      ['hero', { height: 'large', position: 'center', overlay: 30 }],
      ['marquee', { items: MARQUEE, inverted: true }],
      ['collections', { heading: 'Shop by category', aspect: 'landscape', columns: 3, labels: 'overlay' }],
      ['new', { heading: 'New arrivals', columns: 4 }],
      ['best_sellers', { heading: 'Popular now', columns: 4 }],
      ['trust'],
      ['faq'],
      ['newsletter'],
    ],
  },
]

export const findPreset = (id: string | null | undefined) => THEME_PRESETS.find((p) => p.id === id)

/** The preset a store's look comes from; stores that never picked one started on Classic. */
export const currentPresetId = (t: StoreTheme) => t.preset || 'classic'

// What the merchant put into a section. Layout keys (height, columns, overlay…) come from the preset.
const CONTENT = ['image_url', 'video_url', 'url', 'heading', 'title', 'text', 'button_label', 'button_link', 'label', 'link', 'items', 'categories', 'category', 'source'] as const

// Text a preset or the section itself starts with (e.g. Bloom's "New in"): not the merchant's own.
const STOCK = new Set(THEME_PRESETS.flatMap((p) => p.sections.flatMap(([type, settings]) =>
  Object.entries(settings ?? {}).map(([key, v]) => `${type}.${key}=${JSON.stringify(v)}`))))

function ownContent(section: ThemeSection): Settings {
  const defaults = SECTIONS[section.type].defaults
  const out: Settings = {}
  for (const key of CONTENT) {
    const v = section.settings[key]
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue
    const json = JSON.stringify(v)
    if (json === JSON.stringify(defaults[key]) || STOCK.has(`${section.type}.${key}=${json}`)) continue
    out[key] = v
  }
  return out
}

/** The theme with a preset's look and layout, keeping the store's content. */
export function applyPreset(current: StoreTheme, preset: ThemePreset): StoreTheme {
  const used = new Set<string>()
  const sections = preset.sections.map(([type, settings]) => {
    const mine = current.sections.find((x) => x.type === type && !used.has(x.id))
    if (mine) used.add(mine.id)
    // Trust badges start from the store's badges, as resolveTheme fills them in.
    const base = type === 'trust' ? { items: current.trust } : {}
    return makeSection(type, { ...base, ...settings, ...(mine ? ownContent(mine) : {}) })
  })
  // Sections the preset has no place for are kept at the end when the merchant filled them in.
  const extra = current.sections.filter((x) => !used.has(x.id) && Object.keys(ownContent(x)).length)
    .map((x) => ({ ...x, settings: structuredClone(x.settings) }))

  const { look } = preset
  return {
    ...current,
    preset: preset.id,
    accent: look.accent, font: look.font, heading_font: look.heading_font, heading_weight: look.heading_weight,
    text_size: look.text_size, heading_size: look.heading_size, radius: look.radius, logo_position: look.logo_position,
    // The preset's corners, not an exact value set before it.
    radius_px: null,
    colors: { ...look.colors },
    header: { ...current.header, ...look.header },
    product_card: { ...look.product_card },
    collection: { ...look.collection },
    product_page: { ...current.product_page, ...look.product_page },
    sections: [...sections, ...extra].slice(0, 20),
  }
}
