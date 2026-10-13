import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, checkedBaseUrl, isPublicHttpUrl } from './net.ts'

describe('isPublicHttpUrl', () => {
  it('accepts public https hosts', () => {
    expect(isPublicHttpUrl('https://api.sslcommerz.com')).toBe(true)
    expect(isPublicHttpUrl('https://portal.packzy.com/api/v1')).toBe(true)
    expect(isPublicHttpUrl('https://shop.example.com/')).toBe(true)
    expect(isPublicHttpUrl('https://8.8.8.8')).toBe(true) // a public IP literal is fine
  })

  it('rejects non-https unless http is explicitly allowed', () => {
    expect(isPublicHttpUrl('http://shop.example.com')).toBe(false)
    expect(isPublicHttpUrl('http://shop.example.com', { allowHttp: true })).toBe(true)
    expect(isPublicHttpUrl('ftp://shop.example.com')).toBe(false)
    expect(isPublicHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isPublicHttpUrl('not a url')).toBe(false)
  })

  it('rejects cloud metadata, loopback, link-local and RFC1918 IPv4', () => {
    for (const h of ['https://169.254.169.254/latest/meta-data/', 'https://127.0.0.1', 'https://10.0.0.5',
      'https://172.16.0.1', 'https://172.31.255.255', 'https://192.168.1.1', 'https://0.0.0.0',
      'https://100.64.0.1']) {
      expect(isPublicHttpUrl(h)).toBe(false)
    }
    // still private even when http is allowed
    expect(isPublicHttpUrl('http://192.168.0.1', { allowHttp: true })).toBe(false)
  })

  it('rejects localhost and internal suffixes', () => {
    for (const h of ['https://localhost', 'https://db.localhost', 'https://api.local', 'https://svc.internal']) {
      expect(isPublicHttpUrl(h)).toBe(false)
    }
  })

  it('rejects literal IPv6 and embedded credentials', () => {
    expect(isPublicHttpUrl('https://[::1]')).toBe(false)
    expect(isPublicHttpUrl('https://[fd00::1]')).toBe(false)
    expect(isPublicHttpUrl('https://user:pass@evil.example.com')).toBe(false)
  })
})

describe('checkedBaseUrl', () => {
  it('returns undefined for empty input so the platform default is used', () => {
    expect(checkedBaseUrl('', 'bKash API URL')).toBeUndefined()
    expect(checkedBaseUrl(null, 'bKash API URL')).toBeUndefined()
    expect(checkedBaseUrl('   ', 'bKash API URL')).toBeUndefined()
  })

  it('passes a public override through', () => {
    expect(checkedBaseUrl('https://pay.example.com', 'bKash API URL')).toBe('https://pay.example.com')
  })

  it('throws on a private or non-https override', () => {
    expect(() => checkedBaseUrl('https://169.254.169.254', 'bKash API URL')).toThrow()
    expect(() => checkedBaseUrl('http://pay.example.com', 'bKash API URL')).toThrow()
  })
})

describe('assertPublicHttpUrl', () => {
  it('returns the url when public and throws otherwise', () => {
    expect(assertPublicHttpUrl('https://ok.example.com', 'address')).toBe('https://ok.example.com')
    expect(() => assertPublicHttpUrl('https://127.0.0.1', 'address')).toThrow()
  })
})
