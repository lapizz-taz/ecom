import { ClerkAPIResponseError } from '@clerk/shared/error'
import { describe, expect, it } from 'vitest'
import { CLERK_NETWORK_MESSAGE, clerkErrorMessage, clerkNetworkError } from './clerk'

const apiError = (code: string, extra: Record<string, unknown> = {}) =>
  new ClerkAPIResponseError('Request failed', { data: [{ code, message: 'raw', long_message: 'Raw long message', ...extra }], status: 422 })

describe('sign-up and sign-in errors, in plain words', () => {
  it('a request that never reached Clerk says so, without ClerkJS wording or the address', () => {
    const raw = new Error('ClerkJS: Network error at "https://clerk.fullfilio.com/v1/client/sign_ups?__clerk_api_version=2025-11-10&_clerk_js_version=5.128.0" - TypeError: Failed to fetch. Please try again.')
    expect(clerkNetworkError(raw)).toBe(true)
    expect(clerkErrorMessage(raw)).toBe(CLERK_NETWORK_MESSAGE)
    expect(clerkErrorMessage(new TypeError('Load failed'))).toBe(CLERK_NETWORK_MESSAGE)
  })
  it('known Clerk answers get our wording; others keep Clerk\'s long message', () => {
    expect(clerkErrorMessage(apiError('form_identifier_exists'))).toMatch(/already has an account/)
    expect(clerkErrorMessage(apiError('form_password_pwned'))).toMatch(/data leak/)
    expect(clerkErrorMessage(apiError('form_param_format_invalid', { meta: { param_name: 'email_address' } }))).toBe('Enter a valid e-mail address.')
    expect(clerkErrorMessage(apiError('something_new'))).toBe('Raw long message')
  })
  it('other ClerkJS messages are not shown as they are', () => {
    expect(clerkErrorMessage(new Error('ClerkJS: something internal'))).toBe('Something went wrong. Please try again.')
    expect(clerkErrorMessage(new Error('Your current password is incorrect'))).toBe('Your current password is incorrect')
    expect(clerkNetworkError(apiError('form_code_incorrect'))).toBe(false)
  })
})
