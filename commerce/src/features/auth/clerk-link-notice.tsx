import { RefreshCw } from 'lucide-react'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import { cn } from '@/lib/utils'

/**
 * Stands in for Clerk's sign-in and sign-up boxes while Clerk already has a
 * signed-in person here but their Fullfilio account is not open in this
 * browser. Clerk's boxes send a signed-in person straight on to the next page,
 * which sends them back to sign in: shown then, a failed link would reload
 * the page again and again. Instead: a spinner while the account opens, or
 * the reason it did not, with "Try again" and "Sign out".
 */
export function ClerkLinkNotice({ className }: { className?: string }) {
  const { clerkError, retryClerk, signOut } = useAuth()
  if (!clerkError) {
    return (
      <div className={cn('flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground', className)}>
        <Spinner className="size-5" />
        Opening your account…
      </div>
    )
  }
  return (
    <div className={cn('rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm', className)} role="alert">
      <p className="font-medium text-destructive">Your account could not be opened</p>
      <p className="mt-1 text-muted-foreground">{clerkError.message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={retryClerk}><RefreshCw /> Try again</Button>
        <Button size="sm" variant="outline" onClick={() => void signOut()}>Sign out and use another account</Button>
      </div>
    </div>
  )
}

/** Clerk is signed in here but the Fullfilio account is not open: show ClerkLinkNotice, not Clerk's boxes. */
export function useClerkLinkPending(): boolean {
  const { usesClerk, clerkSignedIn, session } = useAuth()
  return usesClerk && clerkSignedIn && !session
}
