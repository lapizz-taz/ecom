import { AppError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

// Links in auth e-mails (confirm sign-up, reset password) come back to the
// address the person used: the platform domain, a preview or a merchant's own
// domain. Supabase only honours addresses on the project's "Redirect URLs"
// list; anything else falls back to the project's Site URL, so both must be
// set to the live domain in the Supabase dashboard (see README → Auth URLs).

/** Absolute address on this site for an auth e-mail to return to. */
export function authRedirect(path: string): string {
  return `${window.location.origin}${path.startsWith('/') ? path : `/${path}`}`
}

export interface AuthLinkError { code: string; message: string; expired: boolean }

/**
 * The error Supabase puts in the address when a link cannot be used (expired,
 * already used, or not allowed), e.g. #error=access_denied&error_code=otp_expired.
 */
export function readAuthLinkError(loc: Pick<Location, 'hash' | 'search'> = window.location): AuthLinkError | null {
  const params = new URLSearchParams(loc.hash.replace(/^#/, ''))
  const query = new URLSearchParams(loc.search)
  const code = params.get('error_code') ?? query.get('error_code') ?? params.get('error') ?? query.get('error')
  if (!code) return null
  const description = (params.get('error_description') ?? query.get('error_description') ?? '').replace(/\+/g, ' ')
  const expired = /expired|otp|invalid|access_denied/i.test(code + ' ' + description)
  return {
    code,
    expired,
    message: expired
      ? 'This link has expired or was already used. Ask for a new one below.'
      : description || 'This link could not be used. Ask for a new one below.',
  }
}

/** Removes the error from the address once it has been shown. */
export function clearAuthLinkError() {
  const { pathname, search } = window.location
  const query = new URLSearchParams(search)
  for (const k of ['error', 'error_code', 'error_description']) query.delete(k)
  const q = query.toString()
  window.history.replaceState(window.history.state, '', `${pathname}${q ? `?${q}` : ''}`)
}

/** Sends the sign-up confirmation e-mail again. */
export async function resendSignupEmail(email: string, returnPath: string) {
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: authRedirect(returnPath) } })
  if (error) {
    // GoTrue allows one e-mail a minute per address; its own wording is confusing.
    if (/only request this after|rate limit/i.test(error.message)) throw new AppError('An e-mail was sent less than a minute ago. Wait a minute, then try again.', 'RATE_LIMITED')
    throw error
  }
}
