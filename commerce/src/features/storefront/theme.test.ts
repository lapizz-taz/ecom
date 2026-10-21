import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, fontsHref, makeSection, resolveTheme, themeData, themeStyle } from './theme'

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

  it('reads fonts and text sizes, keeping old themes as they were', () => {
    const old = resolveTheme({ theme: { font: 'inter' } } as never)
    expect([old.font, old.heading_font, old.heading_weight, old.text_size, old.heading_size]).toEqual(['inter', 'inter', 'default', 100, 100])
    const t = resolveTheme({ theme: { font: 'lato', heading_font: 'playfair', heading_weight: '700', text_size: 112, heading_size: 400 } } as never)
    expect([t.font, t.heading_font, t.heading_weight, t.text_size, t.heading_size]).toEqual(['lato', 'playfair', '700', 112, 150])
    const bad = resolveTheme({ theme: { font: 'toString', heading_font: 'comic', heading_weight: '900', text_size: 'big' } } as never)
    expect([bad.font, bad.heading_font, bad.heading_weight, bad.text_size]).toEqual(['poppins', 'poppins', 'default', 100])
  })

  it('scales body and heading sizes separately and marks the heading font', () => {
    const t = resolveTheme({ theme: { heading_font: 'oswald', heading_weight: '500', text_size: 110, heading_size: 80 } } as never)
    const css = themeStyle(t) as Record<string, unknown>
    expect(css['--text-sm']).toBe('0.9625rem')
    expect(css['--text-2xl']).toBe('1.2rem')
    expect(css['--store-heading-weight']).toBe('500')
    expect(String(css['--store-font-heading'])).toContain('Oswald')
    expect(themeData(t)).toEqual({ 'data-store-theme': '', 'data-heading-weight': '' })
    expect(themeData(resolveTheme({}))['data-heading-weight']).toBeUndefined()
  })

  it('loads only Google fonts the theme uses', () => {
    expect(fontsHref(['poppins'])).toBeNull()
    expect(fontsHref(['playfair', 'lato', 'playfair'])).toBe('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Lato:wght@400;700&display=swap')
  })

  it('cart drawer look: theme colours by default, bad values cleaned, a saved look read back as it was', () => {
    const d = resolveTheme({}).cart
    expect(d).toMatchObject({ side: 'right', width: 'standard', spacing: 'comfortable', background: '', text: '', button_bg: '', button_label: 'Checkout', button_radius: 8, text_scale: 100 })
    const bad = resolveTheme({ theme: { cart: { side: 'top', width: 'huge', background: 'red', button_radius: 99, text_scale: 300, button_label: '', title_size: 'xl' } } } as never).cart
    expect(resolveTheme({ theme: { cart: { image_radius: 90, stepper_radius: -4, image_size: 500 } } } as never).cart).toMatchObject({ image_radius: 24, stepper_radius: 0, image_size: 120 })
    expect(bad).toMatchObject({ side: 'right', width: 'standard', background: '', button_radius: 28, text_scale: 120, button_label: 'Checkout', title_size: 'medium' })
    const look = { ...d, side: 'left', width: 'wide', spacing: 'compact', background: '#fff7ed', text: '#1c1917', bar_color: '#ea580c', title: 'Your bag',
      title_size: 'large', title_uppercase: true, text_scale: 110, image_shape: 'portrait', image_size: 104, image_radius: 16, stepper_radius: 20, button_label: 'Place order', button_bg: '#ea580c', button_text: '#ffffff',
      button_radius: 24, button_show_total: false, button_lock_icon: false, show_view_cart: false, empty_text: 'Nothing here yet.' } as const
    const saved = resolveTheme({ theme: { cart: look } } as never)
    expect(saved.cart).toEqual(look)
    expect(resolveTheme({ theme: JSON.parse(JSON.stringify(saved)) } as never).cart).toEqual(look)
  })

  it('cart page settings and exact corners: defaults, limits, saved look read back', () => {
    const d = resolveTheme({})
    expect(d.radius_px).toBeNull()
    expect(themeStyle(d)['--radius' as never]).toBe('0rem')
    expect(themeStyle(resolveTheme({ theme: { radius_px: 14 } } as never))['--radius' as never]).toBe('14px')
    expect(resolveTheme({ theme: { radius_px: 99 } } as never).radius_px).toBe(32)
    expect(d.cart_page).toMatchObject({ title: 'Cart', layout: 'side', image_size: 96, show_coupon: true, button_label: 'Checkout', note: 'Cash on delivery available' })
    const bad = resolveTheme({ theme: { cart_page: { layout: 'grid', image_size: 900, image_radius: -3, summary_bg: 'blue', button_label: '', width: 'huge' } } } as never).cart_page
    expect(bad).toMatchObject({ layout: 'side', image_size: 160, image_radius: 0, summary_bg: '', button_label: 'Checkout', width: 'standard' })
    const look = { ...d.cart_page, title: 'Your bag', layout: 'stacked', width: 'narrow', image_size: 120, image_radius: 16, stepper_radius: 20, show_each_price: false,
      show_coupon: false, summary_title: 'Order summary', summary_bg: '#f5f5f4', summary_border: false, summary_radius: 20, button_label: 'Place order',
      button_bg: '#2563eb', button_text: '#ffffff', button_radius: 24, button_lock_icon: true, note: '', show_continue: false } as const
    expect(resolveTheme({ theme: { cart_page: look } } as never).cart_page).toEqual(look)
  })
})
