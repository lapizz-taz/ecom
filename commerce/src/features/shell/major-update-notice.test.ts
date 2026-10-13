import { describe, expect, it } from 'vitest'
import { majorUnseen } from './major-update-notice'

describe('major update notice', () => {
  const key = '2026-10-13|Plugin 1.4'
  it('shows once per major release, keyed by date and title', () => {
    expect(majorUnseen('', key)).toBe(true)
    expect(majorUnseen(key, key)).toBe(false)
    // A second major release on the same day still shows (old value was only the date).
    expect(majorUnseen('2026-10-13', key)).toBe(true)
    expect(majorUnseen('2026-10-13|Advanced ad tracking', key)).toBe(true)
    expect(majorUnseen('2026-10-11|Older', key)).toBe(true)
  })
  it('a later seen date counts as seen', () => {
    expect(majorUnseen('9999-12-31', key)).toBe(false)
  })
})
