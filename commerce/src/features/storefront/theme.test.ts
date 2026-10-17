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

  it('product pages: everything shows until the store turns it off, and sections under the product are kept', () => {
    expect(resolveTheme({}).product_page).toEqual(DEFAULT_THEME.product_page)
    expect(resolveTheme({}).product_sections).toEqual([])
    const trust = makeSection('trust')
    const t = resolveTheme({ theme: { product_page: { show_sku: false, show_tags: false, image_aspect: 'square', related_title: 'More like this', show_buy_now: 'yes' },
      product_sections: [trust, { id: 'x', type: 'unknown', enabled: true, settings: {} }] } as never })
    expect(t.product_page).toMatchObject({ show_sku: false, show_tags: false, image_aspect: 'square', related_title: 'More like this', show_buy_now: true, show_description: true })
    expect(t.product_sections.map((s) => s.id)).toEqual([trust.id])
  })

  it('product page layouts: minimal by default, bold fills its button, bad values are cleaned', () => {
    const d = resolveTheme({}).product_page
    expect(d).toMatchObject({ layout: 'minimal', buy_now_style: 'outline', button_radius: 6, show_delivery: false })
    expect(resolveTheme({ theme: { product_page: { button_radius: 99 } } } as never).product_page.button_radius).toBe(24)
    expect(d.accordions.map((a) => a.content)).toEqual(['description', 'shipping', 'warranty'])
    expect(resolveTheme({ theme: { product_page: { layout: 'bold' } } } as never).product_page.buy_now_style).toBe('filled')
    const t = resolveTheme({ theme: { product_page: {
      layout: 'weird', delivery_min_days: 5, delivery_max_days: 2, highlights: ['600+ Happy Customers', 7],
      accordions: [{ title: 'Care', content: 'nope', text: 'Keep dry' }, null],
    } } } as never).product_page
    expect(t.layout).toBe('minimal')
    expect([t.delivery_min_days, t.delivery_max_days]).toEqual([5, 5])
    expect(t.highlights).toEqual(['600+ Happy Customers'])
    expect(t.accordions).toEqual([{ title: 'Care', content: 'custom', text: 'Keep dry' }])
  })
})
