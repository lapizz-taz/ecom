import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'

// Clerk signs people in; the database works with the matching Supabase
// account. These calls go through the clerk-auth edge function, which checks
// the Clerk session on the server (see supabase/functions/clerk-auth).

/** Turns a signed-in Clerk session into the matching Supabase session in this browser. */
export async function exchangeClerkSession(clerkToken: string): Promise<void> {
  const { token_hash } = await invokeFunction<{ token_hash: string }>('clerk-auth', { action: 'session', token: clerkToken })
  const { error } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash })
  if (error) throw error
}

/**
 * Someone who signed up before Clerk: checks their existing password and
 * creates their Clerk account with it. "exists": already in Clerk (the
 * password was simply wrong); "unconfirmed": they never confirmed their e-mail.
 */
export function moveAccountToClerk(email: string, password: string) {
  return invokeFunction<{ status: 'created' | 'exists' | 'unconfirmed' | 'legacy' }>('clerk-auth', { action: 'migrate', email: email.trim(), password })
}

/** The built-in password sign-in, for accounts Clerk cannot take yet. */
export async function legacyPasswordSignIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw error
}

/** The built-in reset e-mail (a link), for accounts Clerk cannot take yet. */
export async function legacyResetEmail(email: string, redirectTo: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo })
  if (error) throw error
}

/** Before a password reset: makes sure an existing account can receive Clerk's reset code. */
export async function prepareClerkReset(email: string): Promise<void> {
  await invokeFunction('clerk-auth', { action: 'ensure', email: email.trim() })
}

/** Ends the Supabase side of a Clerk sign-in (Clerk itself is signed out by the caller). */
export async function endSupabaseSession(): Promise<void> {
  await supabase.auth.signOut()
}
