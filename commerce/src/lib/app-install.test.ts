import { describe, expect, it } from 'vitest'
import { phonePlatform } from './app-install'

describe('phonePlatform', () => {
  it('tells iPhone, iPad (also when it says Macintosh) and Android from computers', () => {
    expect(phonePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1', 5)).toBe('ios')
    expect(phonePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', 5)).toBe('ios')
    expect(phonePlatform('Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36', 5)).toBe('android')
    expect(phonePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36', 0)).toBe('other')
    expect(phonePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36', 0)).toBe('other')
  })
})
