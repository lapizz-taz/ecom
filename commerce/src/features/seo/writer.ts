// Title and meta description suggestions written from an item's own facts (name, brand, category,
// price, sizes, colours, product count) and the focus keyword: no AI service, nothing invented.
// Each suggestion is fitted to what search results show (titles about 60 characters, descriptions
// 120–160) at a word boundary. Title parts are separated with " | ".
import type { SeoFacts } from '@/services/seo'

export const TITLE_MAX = 60
export const DESCRIPTION_MAX = 160

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** Text cut to at most max characters at a word boundary (no dangling separators). */
export function fit(text: string, max: number): string {
  const t = clean(text)
  if (t.length <= max) return t
  const cut = t.slice(0, max + 1)
  const at = cut.lastIndexOf(' ')
  return (at > max * 0.6 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s,;:–|-]+$/, '')
}

/** "linen shirt" → "Linen Shirt". */
const titleCase = (s: string) => clean(s).replace(/(^|\s)(\p{L})/gu, (_, sp: string, c: string) => sp + c.toUpperCase())
const has = (text: string, part: string) => !!part && text.toLowerCase().includes(part.toLowerCase())

/** A title with the store's name when it fits, without it when it does not. */
function withStore(core: string, store: string): string {
  const c = clean(core)
  if (!store || has(c, store)) return fit(c, TITLE_MAX)
  const full = `${c} | ${store}`
  return full.length <= TITLE_MAX ? full : fit(c, TITLE_MAX)
}

/** Sentences joined and fitted; empty parts dropped. */
function sentences(parts: Array<string | null | undefined | false>, max = DESCRIPTION_MAX): string {
  const out: string[] = []
  for (const p of parts) {
    const s = clean(p || '')
    if (!s) continue
    const next = [...out, /[.!?]$/.test(s) ? s : `${s}.`].join(' ')
    if (next.length > max && out.length) break
    out.push(/[.!?]$/.test(s) ? s : `${s}.`)
  }
  return fit(out.join(' '), max)
}

const unique = (list: string[]) => [...new Set(list.map(clean).filter(Boolean))]

export type SeoKind = 'product' | 'collection' | 'page'

/** Up to four titles, best first. */
export function titleIdeas(kind: SeoKind, f: SeoFacts, keyword = ''): string[] {
  const store = clean(f.store)
  const name = clean(f.name) || store
  const kw = clean(keyword)
  const ideas: string[] = []
  if (kind === 'product') {
    ideas.push(withStore(name, store))
    if (kw && !has(name, kw)) ideas.push(withStore(`${name} | ${titleCase(kw)}`, store))
    if (f.brand && !has(name, f.brand)) ideas.push(withStore(`${name} by ${clean(f.brand)}`, store))
    if (f.category && !has(name, f.category)) ideas.push(withStore(`${name} | ${clean(f.category)}`, store))
    ideas.push(withStore(`Buy ${name} Online${f.price ? ` | ${clean(f.price)}` : ''}`, store))
  } else if (kind === 'collection') {
    ideas.push(withStore(name, store))
    if (kw && !has(name, kw)) ideas.push(withStore(`${name} | ${titleCase(kw)}`, store))
    ideas.push(withStore(`Shop ${name} Online`, store))
    if (f.count) ideas.push(withStore(`${name} | ${f.count} ${f.count === 1 ? 'Product' : 'Products'}`, store))
  } else {
    if (name === store) {
      ideas.push(fit(f.tagline ? `${store} | ${clean(f.tagline)}` : store, TITLE_MAX))
      if (kw) ideas.push(fit(`${store} | ${titleCase(kw)}`, TITLE_MAX))
      ideas.push(fit(`${store} | Shop Online`, TITLE_MAX))
    } else {
      ideas.push(withStore(name, store))
      if (kw && !has(name, kw)) ideas.push(withStore(`${name} | ${titleCase(kw)}`, store))
    }
  }
  return unique(ideas).slice(0, 4)
}

/** Up to three meta descriptions, best first. */
export function descriptionIdeas(kind: SeoKind, f: SeoFacts, keyword = ''): string[] {
  const store = clean(f.store)
  const name = clean(f.name) || store
  const kw = clean(keyword)
  const own = clean(f.short_description) || clean(f.description)
  const ideas: string[] = []
  if (kind === 'product') {
    const facts = [
      `${name}${f.brand ? ` by ${clean(f.brand)}` : ''}${f.category ? ` – ${clean(f.category)}` : ''}`,
      f.price && `Price ${clean(f.price)}`, f.sizes && `Sizes: ${clean(f.sizes)}`, f.colours && `Colours: ${clean(f.colours)}`,
    ]
    if (own) ideas.push(sentences([own, f.price && `Price ${clean(f.price)}`, store && `Order online from ${store}`]))
    ideas.push(sentences([...facts, store && `Order online from ${store}`]))
    if (kw) ideas.push(sentences([`Looking for ${kw.toLowerCase()}? ${name}${f.brand ? ` by ${clean(f.brand)}` : ''}`, own, f.price && `Price ${clean(f.price)}`, store && `Order online from ${store}`]))
  } else if (kind === 'collection') {
    const count = f.count ? `${f.count} ${f.count === 1 ? 'product' : 'products'}${f.from_price ? `, from ${clean(f.from_price)}` : ''}` : ''
    if (own) ideas.push(sentences([own, store && `Shop online at ${store}`]))
    ideas.push(sentences([`Shop ${name}${store ? ` at ${store}` : ''}${count ? `: ${count}` : ''}`, 'Order online']))
    if (kw) ideas.push(sentences([`Looking for ${kw.toLowerCase()}? Browse ${name}${store ? ` at ${store}` : ''}${count ? `: ${count}` : ''}`, 'Order online']))
  } else {
    if (f.summary) ideas.push(fit(clean(f.summary), DESCRIPTION_MAX))
    if (name === store && f.tagline) ideas.push(sentences([clean(f.tagline), `Shop ${store} online`]))
    if (kw) ideas.push(sentences([`${titleCase(kw)} at ${store}`, f.summary]))
  }
  return unique(ideas).slice(0, 3)
}
