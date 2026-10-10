import { describe, expect, it } from 'vitest'
import { buildClickRequest, isPublicHttps, mapPbxEvent, readPbxPayload, sameToken } from './pbx.ts'

describe('mapPbxEvent', () => {
  it('reads Asterisk CDR fields (src, dst, uniqueid, disposition, billsec, calldate in Dhaka time)', () => {
    const e = mapPbxEvent({ uniqueid: '1728550000.42', src: '01711000000', dst: '101', disposition: 'ANSWERED', billsec: '63', calldate: '2026-10-10 14:05:00', recordingfile: 'https://pbx.example.com/rec/42.wav' })
    expect(e).toMatchObject({ call_id: '1728550000.42', direction: 'INBOUND', from: '01711000000', to: '101', status: 'ANSWERED', duration: 63,
      started_at: '2026-10-10T08:05:00.000Z', recording_url: 'https://pbx.example.com/rec/42.wav' })
  })

  it('reads plain JSON fields and infers outbound from an extension caller', () => {
    expect(mapPbxEvent({ call_id: 'c-1', from: '102', to: '+880 1811-000000', status: 'no-answer', duration: 0 })).toMatchObject({
      direction: 'OUTBOUND', from: '102', to: '+8801811000000', status: 'NO_ANSWER', duration: 0, extension: null })
    expect(mapPbxEvent({ callid: 'c-2', direction: 'incoming', caller: '01911000000', extension: '103', event: 'ringing', timestamp: '1791660000' })).toMatchObject({
      direction: 'INBOUND', extension: '103', status: 'RINGING', started_at: new Date(1791660000 * 1000).toISOString() })
  })

  it('ignores events without a call id and non-https recordings', () => {
    expect(mapPbxEvent({ from: '1', to: '2' })).toBeNull()
    expect(mapPbxEvent({ id: 'x', recording: 'http://insecure/rec.wav' })?.recording_url).toBeNull()
    expect(mapPbxEvent({ id: 'x', billsec: '12' })?.status).toBe('ANSWERED')
  })
})

describe('readPbxPayload', () => {
  it('accepts JSON, forms and GET query strings, never the token', async () => {
    const json = new Request('https://x/pbx?token=t&src=1', { method: 'POST', body: JSON.stringify({ uniqueid: 'u' }), headers: { 'content-type': 'application/json' } })
    expect(await readPbxPayload(json)).toEqual({ src: '1', uniqueid: 'u' })
    const form = new Request('https://x/pbx?token=t', { method: 'POST', body: 'uniqueid=u2&billsec=5', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(await readPbxPayload(form)).toEqual({ uniqueid: 'u2', billsec: '5' })
    expect(await readPbxPayload(new Request('https://x/pbx?token=t&callid=g1&status=busy'))).toEqual({ callid: 'g1', status: 'busy' })
  })
})

describe('click-to-call', () => {
  it('fills the template on the server, URL-encoding values in the address', () => {
    const r = buildClickRequest({ api_method: 'GET', api_url_template: 'https://pbx.example.com/originate?ext={extension}&to={number}&key={secret}' }, 's&cret', '+8801711000000', '101')
    expect(r.url).toBe('https://pbx.example.com/originate?ext=101&to=%2B8801711000000&key=s%26cret')
    expect(r.init.method).toBe('GET')
    const p = buildClickRequest({ api_method: 'POST', api_url_template: 'https://pbx.example.com/api/call', api_body_template: '{"from":"{extension}","to":"{number}","token":"{secret}"}' }, 'k', '017', '102')
    expect(p.init).toMatchObject({ method: 'POST', body: '{"from":"102","to":"017","token":"k"}', headers: { 'Content-Type': 'application/json' } })
  })

  it('refuses private or non-https addresses', () => {
    expect(isPublicHttps('https://pbx.voicedrive.example/api')).toBe(true)
    for (const bad of ['http://pbx.example.com', 'https://localhost/x', 'https://10.0.0.5/x', 'https://192.168.1.2/x', 'https://172.20.0.1', 'https://169.254.169.254/latest']) {
      expect(isPublicHttps(bad)).toBe(false)
    }
    expect(() => buildClickRequest({ api_url_template: 'https://127.0.0.1/call?n={number}' }, 's', '1', '2')).toThrow(/public https/)
  })

  it('compares tokens', async () => {
    expect(await sameToken('abc', 'abc')).toBe(true)
    expect(await sameToken('abc', 'abd')).toBe(false)
    expect(await sameToken('abc', 'abcd')).toBe(false)
  })
})
