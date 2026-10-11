import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, makeSection, resolveTheme } from './theme'

describe('store theme', () => {
  it('gives a new store the editorial default', () => {
    const t = resolveTheme({})
    expect(t.logo_position).toBe('center')
    expect(t.sections.map((s) => s.type)).toEqual(['hero', 'collections', 'new', 'featured'])
    expect(t.colors.footer_bg).toBe('#000000')
  })

  it('upgrades an older saved theme without losing its content', () => {
    const t = resolveTheme({
      announcement: 'Free delivery in Dhaka',
      hero_title: 'Eid collection', hero_subtitle: 'New in', hero_image_url: 'https://x/h.jpg', hero_cta_label: 'Shop', hero_cta_link: '/shop',
      featured_category_slugs: ['belts'],
      theme: {
        accent: '#1d4ed8', font: 'inter', logo_position: 'left',
        sections: [{ type: 'hero', enabled: true }, { type: 'categories', enabled: false }, { type: 'banner', enabled: true }, { type: 'trust', enabled: true }],
        banner: { title: 'Sale', text: '50% off', image_url: '', link: '/shop', label: 'Go' },
        trust: [{ title: 'Fast', text: '24h' }],
      },
    })
    expect(t.accent).toBe('#1d4ed8')
    expect(t.logo_position).toBe('left')
    expect(t.radius).toBe('soft')
    expect(t.announcement).toEqual({ enabled: true, items: ['Free delivery in Dhaka'], marquee: true })
    expect(t.sections.map((s) => [s.type, s.enabled])).toEqual([['hero', true], ['collections', false], ['banner', true], ['trust', true]])
    expect(t.sections[0].settings).toMatchObject({ heading: 'Eid collection', text: 'New in', image_url: 'https://x/h.jpg' })
    expect(t.sections[1].settings.categories).toEqual(['belts'])
    expect(t.sections[2].settings).toMatchObject({ title: 'Sale', label: 'Go' })
    expect(t.sections[3].settings.items).toEqual([{ title: 'Fast', text: '24h' }])
  })

  it('keeps sections saved by the new editor as they are', () => {
    const hero = makeSection('hero', { heading: 'Hi' })
    const marquee = makeSection('marquee')
    const t = resolveTheme({ theme: { ...DEFAULT_THEME, sections: [marquee, hero, { id: 'x', type: 'unknown', enabled: true, settings: {} }] } as never })
    expect(t.sections.map((s) => s.id)).toEqual([marquee.id, hero.id])
    expect(t.sections[1].settings.heading).toBe('Hi')
  })
})
