import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Clerk's sign-in box sends a browser that is already signed in to Clerk straight
// on to the next page. When the Fullfilio account could not be opened, that page
// sent it back to sign in, again and again, until the server answered "Too many
// requests". The sign-in pages must not show Clerk's box in that state.

const auth = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/features/auth/auth-context', () => ({ useAuth: () => auth.state }))
vi.mock('@clerk/clerk-react', () => ({ SignIn: () => 'CLERK_SIGN_IN_BOX', SignUp: () => 'CLERK_SIGN_UP_BOX' }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/super-admin-gate', () => ({ superAdminUnlocked: () => true, unlockSuperAdmin: () => undefined, SUPER_ADMIN_ENTRY: null }))

const base = {
  session: null, user: null, access: null, loading: false, accessLoading: false, isStaff: false, can: () => false,
  signOut: async () => undefined, usesClerk: true, syncClerk: async () => undefined, clerkError: null,
  clerkSignedIn: false, retryClerk: () => undefined,
}

async function render(load: () => Promise<{ default: ComponentType }>, path: string): Promise<string> {
  const Page = (await load()).default
  return renderToString(createElement(MemoryRouter, { initialEntries: [path] }, createElement(Page)))
}

const pages: Array<[string, () => Promise<{ default: ComponentType }>, string]> = [
  ['the admin sign-in', () => import('@/pages/admin/login'), '/admin/login?next=%2Fadmin'],
  ['the Super Admin sign-in', () => import('@/pages/super-admin/login'), '/super-admin/login?next=%2Fsuper-admin'],
]

describe.each(pages)('%s with Clerk', (_name, load, path) => {
  beforeEach(() => { auth.state = { ...base } })

  it('shows Clerk\'s box to someone not signed in', async () => {
    expect(await render(load, path)).toContain('CLERK_SIGN_IN_BOX')
  })

  it('waits, without Clerk\'s box, while a Clerk sign-in opens the account', async () => {
    auth.state = { ...base, clerkSignedIn: true, loading: true }
    const html = await render(load, path)
    expect(html).not.toContain('CLERK_SIGN_IN_BOX')
    expect(html).toContain('Opening your account')
  })

  it('shows why the account did not open, with Try again and Sign out, and no Clerk box to bounce through', async () => {
    auth.state = { ...base, clerkSignedIn: true, clerkError: new Error('Sign-in is not set up on the server yet: CLERK_SECRET_KEY is missing.') }
    const html = await render(load, path)
    expect(html).not.toContain('CLERK_SIGN_IN_BOX')
    expect(html).toContain('CLERK_SECRET_KEY is missing')
    expect(html).toContain('Try again')
    expect(html).toContain('Sign out and use another account')
  })
})
