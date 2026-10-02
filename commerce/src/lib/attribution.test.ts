import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureTouch, currentAttribution, externalReferrer, sessionId, touchParams } from './attribution'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  }
}

const HOST = 'shop.example'
const at = (iso: string) => new Date(iso)

describe('attribution capture', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
  })

  it('reads marketing parameters and ignores everything else', () => {
    expect(touchParams('?utm_source=facebook&utm_medium=paid&utm_campaign=Belt&fbclid=IwAR1&color=red&ad_id=123'))
      .toEqual({ utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'Belt', fbclid: 'IwAR1', ad_id: '123' })
    expect(touchParams('?srsltid=AfmBOo')).toEqual({ srsltid: 'AfmBOo' })
  })

  it('only counts other sites as referrers', () => {
    expect(externalReferrer('https://l.facebook.com/l.php?u=x', HOST)).toBe('https://l.facebook.com/l.php')
    expect(externalReferrer(`https://${HOST}/shop`, HOST)).toBeNull()
    expect(externalReferrer('', HOST)).toBeNull()
  })

  it('keeps the first touch and the last non-direct touch through the journey', () => {
    // Ad click lands on a product.
    expect(captureTouch({ pathname: '/product/belt', search: '?utm_source=facebook&utm_medium=paid&utm_campaign=Korean%20Belt&ad_id=9' },
      'https://m.facebook.com/', HOST, at('2026-10-01T10:00:00Z'))).toBe(true)
    // Browsing the shop, cart and checkout is internal navigation.
    expect(captureTouch({ pathname: '/shop', search: '' }, `https://${HOST}/product/belt`, HOST, at('2026-10-01T10:02:00Z'))).toBe(false)
    expect(captureTouch({ pathname: '/checkout', search: '' }, `https://${HOST}/cart`, HOST, at('2026-10-01T10:05:00Z'))).toBe(false)
    // Coming back two days later by typing the address does not erase the ad click.
    expect(captureTouch({ pathname: '/', search: '' }, '', HOST, at('2026-10-03T09:00:00Z'))).toBe(false)
    const a = currentAttribution()
    expect(a.first_touch?.params.utm_campaign).toBe('Korean Belt')
    expect(a.last_touch?.params).toMatchObject({ utm_source: 'facebook', ad_id: '9' })
    expect(a.last_touch?.landing).toBe('/product/belt?utm_source=facebook&utm_medium=paid&utm_campaign=Korean%20Belt&ad_id=9')

    // A later Google search becomes the last touch; the first touch stays the ad.
    captureTouch({ pathname: '/', search: '?srsltid=AfmB' }, 'https://www.google.com/', HOST, at('2026-10-04T09:00:00Z'))
    const b = currentAttribution()
    expect(b.first_touch?.params.utm_source).toBe('facebook')
    expect(b.last_touch?.params).toEqual({ srsltid: 'AfmB' })
    expect(b.last_touch?.referrer).toBe('https://www.google.com')
  })

  it('treats a first visit with nothing to go on as direct', () => {
    captureTouch({ pathname: '/', search: '' }, '', HOST, at('2026-10-01T10:00:00Z'))
    const a = currentAttribution()
    expect(a.first_touch).toMatchObject({ landing: '/', params: {}, referrer: null })
    expect(a.last_touch).toBeNull()
    expect(a.visitor_id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('starts a new visit after 30 minutes of inactivity', () => {
    const t = Date.parse('2026-10-01T10:00:00Z')
    const s1 = sessionId(t)
    expect(sessionId(t + 10 * 60_000)).toBe(s1)
    expect(sessionId(t + 10 * 60_000 + 31 * 60_000)).not.toBe(s1)
  })
})
