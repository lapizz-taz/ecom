import { describe, expect, it } from 'vitest'
import { DESCRIPTION_MAX, descriptionIdeas, fit, TITLE_MAX, titleIdeas } from './writer'

const shirt = {
  store: 'Isolation', name: 'Twill Overshirt', brand: 'Isolation Studio', category: 'Overshirts', price: '৳2,450',
  sizes: 'S, M, L', colours: 'Olive, Black', short_description: 'Heavy cotton twill with two chest pockets.',
}

describe('SEO writer (no AI)', () => {
  it('fits text at a word boundary without dangling separators', () => {
    expect(fit('Linen Shirt – Breathable Summer Wear for Hot Days in Dhaka | Isolation', 40)).toBe('Linen Shirt – Breathable Summer Wear for')
    expect(fit('Short', 60)).toBe('Short')
    expect(fit('Alpha, beta, gamma, delta', 13)).toBe('Alpha, beta')
  })

  it('product titles use the real facts, the keyword and the store name when it fits', () => {
    const ideas = titleIdeas('product', shirt, 'cotton overshirt')
    expect(ideas[0]).toBe('Twill Overshirt | Isolation')
    expect(ideas).toContain('Twill Overshirt – Cotton Overshirt | Isolation')
    // The brand already names the store: no second "| Isolation".
    expect(ideas).toContain('Twill Overshirt by Isolation Studio')
    expect(ideas.every((t) => t.length <= TITLE_MAX)).toBe(true)
    expect(new Set(ideas).size).toBe(ideas.length)
  })

  it('product descriptions come from its own text and facts, within the length search results show', () => {
    const ideas = descriptionIdeas('product', shirt, 'cotton overshirt')
    expect(ideas[0]).toBe('Heavy cotton twill with two chest pockets. Price ৳2,450. Order online from Isolation.')
    expect(ideas[1]).toBe('Twill Overshirt by Isolation Studio – Overshirts. Price ৳2,450. Sizes: S, M, L. Colours: Olive, Black. Order online from Isolation.')
    expect(ideas[2]).toMatch(/^Looking for cotton overshirt\? Twill Overshirt by Isolation Studio\./)
    expect(ideas.every((d) => d.length <= DESCRIPTION_MAX)).toBe(true)
  })

  it('a product with no text and no price still gets only true sentences', () => {
    const ideas = descriptionIdeas('product', { store: 'Isolation', name: 'Snake Chain' })
    expect(ideas).toEqual(['Snake Chain. Order online from Isolation.'])
  })

  it('collections use their product count and lowest price', () => {
    const f = { store: 'Isolation', name: 'Shirts', count: 12, from_price: '৳990' }
    expect(titleIdeas('collection', f)).toContain('Shop Shirts Online | Isolation')
    expect(descriptionIdeas('collection', f)[0]).toBe('Shop Shirts at Isolation: 12 products, from ৳990. Order online.')
  })

  it('the home page uses the tagline; other pages their summary', () => {
    expect(titleIdeas('page', { store: 'Isolation', name: 'Isolation', tagline: 'Everyday menswear' })[0]).toBe('Isolation – Everyday menswear')
    expect(descriptionIdeas('page', { store: 'Isolation', name: 'Track your order', summary: 'Track your Isolation order with your order number and mobile number.' })[0])
      .toBe('Track your Isolation order with your order number and mobile number.')
  })

  it('very long names are cut, never left over the limit', () => {
    const long = { store: 'Isolation', name: 'Premium Handwoven Jamdani Cotton Panjabi With Embroidered Collar And Pearl Buttons' }
    for (const t of titleIdeas('product', long, 'eid panjabi')) expect(t.length).toBeLessThanOrEqual(TITLE_MAX)
  })
})
