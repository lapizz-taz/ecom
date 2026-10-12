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

/** The Clerk user the account open in this browser belongs to (tabs share it), or null. */
export async function currentClerkLink(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return (data.session?.user.app_metadata?.clerk_user_id as string | undefined) ?? null
}

/**
 * Ends the Supabase side of a Clerk sign-in (Clerk itself is signed out by the caller):
 * everywhere when the person signs out, only in this browser when it follows Clerk.
 */
export async function endSupabaseSession(scope: 'global' | 'local' = 'global'): Promise<void> {
  await supabase.auth.signOut({ scope })
}
