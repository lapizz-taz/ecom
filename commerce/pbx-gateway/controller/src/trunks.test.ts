import { describe, expect, it } from 'vitest'
import type { Trunk } from './api.ts'
import { renderTrunks } from './trunks.ts'

const trunk = (over: Partial<Trunk> = {}): Trunk => ({
  businessId: 'b1', code: 7, did: '09639123456', callerId: '09639123456', host: 'sip.iptsp.example', port: 5060,
  transport: 'udp', user: 'acct1', password: 'p;a$$', register: true, dialFormat: 'LOCAL', enabled: true, ...over,
})

describe('renderTrunks', () => {
  it('writes endpoint, auth, aor, identify and registration for each enabled trunk', () => {
    const conf = renderTrunks([trunk()])
    for (const line of ['[vdtrunk-7]', 'context = vd-trunk-in', 'set_var = VD_BUSINESS=7', '[vdtrunk-7-auth]',
      'username = acct1', 'password = p\;a$$', 'contact = sip:sip.iptsp.example:5060', 'match = sip.iptsp.example', '[vdtrunk-7-reg]',
      'client_uri = sip:acct1@sip.iptsp.example', 'contact_user = 09639123456']) expect(conf).toContain(line)
  })

  it('never sets an endpoint caller ID (it would hide the caller on inbound calls)', () => {
    expect(renderTrunks([trunk()])).not.toMatch(/^callerid/m)
  })

  it('skips disabled or unsafe trunks and never lets a value add config lines', () => {
    expect(renderTrunks([trunk({ enabled: false })])).not.toContain('[vdtrunk-7]')
    expect(renderTrunks([trunk({ host: 'evil.example\n[x]' })])).not.toContain('evil')
    expect(renderTrunks([trunk({ user: 'a b' })])).not.toContain('[vdtrunk-7]')
    expect(() => renderTrunks([trunk({ password: 'a\nallow=all' })])).toThrow(/newline/)
  })

  it('uses TCP when asked and can skip registration', () => {
    const conf = renderTrunks([trunk({ transport: 'tcp', register: false })])
    expect(conf).toContain('transport = transport-tcp')
    expect(conf).toContain('contact = sip:sip.iptsp.example:5060;transport=tcp')
    expect(conf).not.toContain('type = registration')
  })
})
