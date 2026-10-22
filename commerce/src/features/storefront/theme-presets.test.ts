import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, makeSection, resolveTheme } from './theme'
import { applyPreset, currentPresetId, findPreset, THEME_PRESETS } from './theme-presets'

const bloom = findPreset('bloom')!
const classic = findPreset('classic')!

describe('ready-made themes', () => {
  it('each preset survives a save: resolveTheme reads it back unchanged', () => {
    for (const p of THEME_PRESETS) {
      const t = applyPreset(resolveTheme({}), p)
      expect(resolveTheme({ theme: t } as never)).toEqual(t)
      expect(t.preset).toBe(p.id)
    }
  })

  it('Classic is the default look, and stores that never picked one are on it', () => {
    const t = applyPreset(resolveTheme({}), classic)
    const d = resolveTheme({})
    expect(currentPresetId(d)).toBe('classic')
    expect({ ...t, sections: [], preset: '' }).toEqual({ ...d, sections: [] })
    expect(t.sections.map((s) => s.type)).toEqual(d.sections.map((s) => s.type))
  })

  it('changes the look but keeps the store’s own content', () => {
    const hero = makeSection('hero', { image_url: 'https://x/eid.jpg', heading: 'Eid collection', height: 'small' })
    const faq = makeSection('faq', { items: [{ question: 'COD?', answer: 'Yes' }] })
    const emptyVideo = makeSection('video')
    const current = resolveTheme({ theme: {
      ...DEFAULT_THEME,
      header: { ...DEFAULT_THEME.header, menu: [{ label: 'Sale', link: '/shop' }] },
      announcement: { enabled: true, items: ['Free gift over ৳3000'], marquee: false },
      footer: { ...DEFAULT_THEME.footer, contact_text: '017…' },
      favicon_url: '/f.png', whatsapp: '8801700000000',
      product_page: { ...DEFAULT_THEME.product_page, highlights: ['600+ happy customers'], blocks: [{ id: 'b1', type: 'coupon', enabled: true, settings: { code: 'EID10' } }] },
      sections: [hero, faq, emptyVideo],
    } } as never)
    const t = applyPreset(current, bloom)

    expect(t).toMatchObject({ accent: '#9d174d', heading_font: 'cormorant', radius: 'round', preset: 'bloom' })
    expect(t.product_page.layout).toBe('classic')
    expect(t.header.menu).toEqual([{ label: 'Sale', link: '/shop' }])
    expect(t.announcement).toEqual(current.announcement)
    expect(t.footer).toEqual(current.footer)
    expect([t.favicon_url, t.whatsapp]).toEqual(['/f.png', '8801700000000'])
    expect(t.product_page.highlights).toEqual(['600+ happy customers'])
    expect(t.product_page.blocks).toEqual(current.product_page.blocks)

    // The hero keeps its picture and words but takes the preset's height.
    const h = t.sections.find((s) => s.type === 'hero')!
    expect(h.settings).toMatchObject({ image_url: 'https://x/eid.jpg', heading: 'Eid collection', height: 'medium', position: 'center' })
    // A filled-in section the preset has no place for is kept at the end; an empty one is dropped.
    expect(t.sections.at(-1)!.settings.items).toEqual([{ question: 'COD?', answer: 'Yes' }])
    expect(t.sections.some((s) => s.type === 'video')).toBe(false)
    expect(t.sections.map((s) => s.type).slice(0, bloom.sections.length)).toEqual(bloom.sections.map(([type]) => type))
  })

  it('preset headings replace untouched defaults, not the merchant’s own', () => {
    const own = makeSection('best_sellers', { heading: 'আমাদের সেরা' })
    const t = applyPreset(resolveTheme({ theme: { sections: [own, makeSection('new')] } } as never), bloom)
    expect(t.sections.find((s) => s.type === 'best_sellers')!.settings.heading).toBe('আমাদের সেরা')
    expect(t.sections.find((s) => s.type === 'new')!.settings.heading).toBe('New in')
  })

  it('switching back and forth does not lose content', () => {
    const hero = makeSection('hero', { image_url: 'https://x/h.jpg' })
    const start = resolveTheme({ theme: { sections: [hero] } } as never)
    let t = start
    for (const p of [...THEME_PRESETS, ...THEME_PRESETS]) t = applyPreset(t, p)
    expect(t.sections.find((s) => s.type === 'hero')!.settings.image_url).toBe('https://x/h.jpg')
    expect(t.sections.length).toBeLessThanOrEqual(20)
  })

  it('switching presets does not pile up the previous preset’s sections', () => {
    const volt = findPreset('volt')!
    const t = applyPreset(applyPreset(resolveTheme({}), bloom), volt)
    expect(t.sections.map((s) => s.type)).toEqual(volt.sections.map(([type]) => type))
    expect(applyPreset(t, bloom).sections.map((s) => s.type)).toEqual(bloom.sections.map(([type]) => type))
  })

  it('a preset brings its own corners, replacing an exact corner value', () => {
    const t = applyPreset(resolveTheme({ theme: { radius_px: 3 } } as never), bloom)
    expect(t.radius_px).toBeNull()
    expect(t.radius).toBe('round')
  })

  it('an unknown preset id from a saved theme is cleaned', () => {
    expect(resolveTheme({ theme: { preset: '<b>x</b>' } } as never).preset).toBe('')
  })
})
