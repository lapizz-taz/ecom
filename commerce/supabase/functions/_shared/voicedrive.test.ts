import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { constantTimeEqual, iceServers, randomPassword, sha256Hex, turnCredentials } from './voicedrive'

describe('voicedrive helpers', () => {
  it('makes coturn REST credentials: "<expiry>:<user>" and base64 HMAC-SHA1', async () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0)
    const c = await turnCredentials('s3cret-turn-secret', 'agent-1', 3600, now)
    expect(c.username).toBe(`${now / 1000 + 3600}:agent-1`)
    expect(c.credential).toBe(createHmac('sha1', 's3cret-turn-secret').update(c.username).digest('base64'))
    // At least a minute even if misconfigured.
    expect((await turnCredentials('x', 'a', 5, now)).expiresAt).toBe(now / 1000 + 60)
  })

  it('lists STUN always and TURN only with a secret', async () => {
    const s = { stun_urls: ['stun:stun.l.google.com:19302', 'bogus'], turn_urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'] }
    expect(await iceServers(s, null, 'a')).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }])
    const withTurn = await iceServers(s, 'secret-secret-secret', 'a')
    expect(withTurn[1]).toMatchObject({ urls: s.turn_urls })
    expect(withTurn[1].username).toMatch(/^\d+:a$/)
  })

  it('random passwords are long, unique and URL-safe; comparisons are exact', async () => {
    const a = randomPassword()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(randomPassword()).not.toBe(a)
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
})
