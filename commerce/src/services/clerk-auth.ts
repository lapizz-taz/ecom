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

/** Ends the Supabase side of a Clerk sign-in (Clerk itself is signed out by the caller). */
export async function endSupabaseSession(): Promise<void> {
  await supabase.auth.signOut()
}
