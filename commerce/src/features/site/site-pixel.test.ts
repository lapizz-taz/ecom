import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SITE_EVENT_CODES } from './site-meta'
import { hashSitePerson, phoneDigits, siteEventId } from './site-pixel'

const sha = (v: string) => createHash('sha256').update(v).digest('hex')

describe('website pixel: in the browser', () => {
  it('hashes a new account the way Meta asks: e-mail lower case, phone 880…, first and last name', async () => {
    expect(await hashSitePerson({ email: '  Tazul@Example.COM ', phone: '017-1100 0000', name: 'Tazul  Islam' })).toEqual({
      em: sha('tazul@example.com'), ph: sha('8801711000000'), fn: sha('tazul'), ln: sha('islam'),
    })
    expect(await hashSitePerson({ email: 'not-an-email', phone: '12345', name: '' })).toEqual({})
  })

  it('reads Bangladeshi mobile numbers in any common form', () => {
    for (const p of ['01711000000', '+8801711000000', '008801711000000', '8801711000000', '1711000000']) expect(phoneDigits(p)).toBe('8801711000000')
    expect(phoneDigits('01211000000')).toBe('')
  })

  it('gives each event its own id, in the form the server accepts', () => {
    const a = siteEventId('Lead')
    expect(a).toMatch(new RegExp(`^ffw_${SITE_EVENT_CODES.Lead}_[A-Za-z0-9]{20}$`))
    expect(siteEventId('Lead')).not.toBe(a)
  })
})
