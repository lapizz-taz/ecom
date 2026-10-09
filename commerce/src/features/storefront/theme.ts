import { type CSSProperties, useEffect, useSyncExternalStore } from 'react'
import type { StoreConfig } from '@/types/domain'

export type Storefront = StoreConfig['storefront']
export type SectionType = 'hero' | 'trust' | 'categories' | 'featured' | 'new' | 'banner'
export type ThemeFont = 'poppins' | 'inter' | 'hind'
export type ThemeRadius = 'sharp' | 'soft' | 'round'

export interface StoreTheme {
  accent: string
  font: ThemeFont
  radius: ThemeRadius
  logo_position: 'left' | 'center'
  sections: Array<{ type: SectionType; enabled: boolean }>
  trust: Array<{ title: string; text: string }>
  banner: { title: string; text: string; image_url: string; link: string; label: string }
  whatsapp: string
  payment_badges: boolean
}

export const SECTION_LABELS: Record<SectionType, string> = {
  hero: 'Hero', trust: 'Trust badges', categories: 'Shop by category', featured: 'Featured products', new: 'New arrivals', banner: 'Promo banner',
}

export const FONTS: Record<ThemeFont, { label: string; sample: string; family: string; href: string | null }> = {
  poppins: { label: 'Poppins', sample: 'Aa', family: '"Poppins", ui-sans-serif, system-ui, sans-serif', href: null },
  inter: { label: 'Inter', sample: 'Aa', family: '"Inter", ui-sans-serif, system-ui, sans-serif', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap' },
  hind: { label: 'Hind Siliguri', sample: 'অআ', family: '"Hind Siliguri", "Noto Sans Bengali", ui-sans-serif, system-ui, sans-serif', href: 'https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap' },
}

export const RADII: Record<ThemeRadius, { label: string; value: string }> = {
  sharp: { label: 'Sharp', value: '0.125rem' }, soft: { label: 'Soft', value: '0.625rem' }, round: { label: 'Round', value: '1.25rem' },
}

/** Mostly greys; a few calm colours for stores that want one. */
export const ACCENTS = ['#0b0b0c', '#3f3f46', '#71717a', '#1d4ed8', '#047857', '#b91c1c', '#9a3412', '#7c3aed']

export const DEFAULT_THEME: StoreTheme = {
  accent: '#0b0b0c',
  font: 'poppins',
  radius: 'soft',
  logo_position: 'left',
  sections: [
    { type: 'hero', enabled: true }, { type: 'trust', enabled: true }, { type: 'categories', enabled: true },
    { type: 'featured', enabled: true }, { type: 'banner', enabled: false }, { type: 'new', enabled: true },
  ],
  trust: [
    { title: 'Nationwide delivery', text: 'Cash on delivery available' },
    { title: 'Easy returns', text: 'Contact us if anything is not right' },
    { title: 'Secure checkout', text: 'Your details stay private' },
  ],
  banner: { title: '', text: '', image_url: '', link: '/shop', label: 'Shop now' },
  whatsapp: '',
  payment_badges: true,
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

/** The saved theme with defaults filled in (and anything unknown ignored). */
export function resolveTheme(sf: Storefront | undefined | null): StoreTheme {
  const t = (sf?.theme ?? {}) as Partial<StoreTheme>
  const known = new Set(DEFAULT_THEME.sections.map((s) => s.type))
  const saved = (Array.isArray(t.sections) ? t.sections : []).filter((s) => known.has(s.type))
  const sections = [...saved, ...DEFAULT_THEME.sections.filter((d) => !saved.some((s) => s.type === d.type))]
  return {
    accent: isHex(t.accent) ? t.accent : DEFAULT_THEME.accent,
    font: t.font && t.font in FONTS ? t.font : DEFAULT_THEME.font,
    radius: t.radius && t.radius in RADII ? t.radius : DEFAULT_THEME.radius,
    logo_position: t.logo_position === 'center' ? 'center' : 'left',
    sections,
    trust: Array.isArray(t.trust) && t.trust.length ? t.trust.slice(0, 4) : DEFAULT_THEME.trust,
    banner: { ...DEFAULT_THEME.banner, ...(t.banner ?? {}) },
    whatsapp: typeof t.whatsapp === 'string' ? t.whatsapp : '',
    payment_badges: t.payment_badges ?? true,
  }
}

/** Text on the accent colour: white on dark colours, near-black on light ones. */
export function onColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0b0b0c' : '#fafafa'
}

export function themeStyle(t: StoreTheme): CSSProperties {
  return {
    '--primary': t.accent, '--primary-foreground': onColor(t.accent), '--ring': t.accent,
    '--radius': RADII[t.radius].value, fontFamily: FONTS[t.font].family,
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
// storefront settings to it; nothing is saved until staff publish.

let preview: Storefront | null = null
const listeners = new Set<() => void>()
let listening = false

function startListening() {
  if (listening || typeof window === 'undefined' || window.parent === window) return
  if (!new URLSearchParams(window.location.search).has('theme_preview') && !sessionStorage.getItem('theme_preview')) return
  try { sessionStorage.setItem('theme_preview', '1') } catch { /* private mode */ }
  listening = true
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin || e.data?.type !== 'theme-preview') return
    preview = e.data.storefront as Storefront
    listeners.forEach((l) => l())
  })
  window.parent.postMessage({ type: 'theme-preview-ready' }, window.location.origin)
}

/** The storefront settings to render: the builder's draft while previewing, else the saved ones. */
export function useStorefront(saved: Storefront | undefined): Storefront | undefined {
  const draft = useSyncExternalStore((l) => { startListening(); listeners.add(l); return () => { listeners.delete(l) } }, () => preview, () => null)
  return draft ?? saved
}
