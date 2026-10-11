import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { resend: vi.fn() } } }))
const { readAuthLinkError } = await import('./auth-links')

const at = (hash: string, search = '') => ({ hash, search })

describe('auth link errors', () => {
  it('reads an expired or used link from the hash', () => {
    const e = readAuthLinkError(at('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'))
    expect(e).toMatchObject({ code: 'otp_expired', expired: true })
    expect(e?.message).toMatch(/expired or was already used/)
  })

  it('reads errors from the query too and keeps other descriptions', () => {
    expect(readAuthLinkError(at('', '?error=server_error&error_description=Unable+to+send+email'))).toMatchObject({
      code: 'server_error', expired: false, message: 'Unable to send email',
    })
  })

  it('returns nothing for a normal sign-in link', () => {
    expect(readAuthLinkError(at('#access_token=abc&type=signup'))).toBeNull()
    expect(readAuthLinkError(at('', '?next=/account'))).toBeNull()
  })
})
