import { useUser } from '@clerk/clerk-react'
import { clerkErrorCode, clerkErrorMessage } from '@/features/auth/clerk'

// Sign-in and sign-up use Clerk's own boxes (<SignIn>, <SignUp>); this file
// holds what the existing screens still call Clerk for directly.

/** Password change for a Clerk account; null when this session did not come from Clerk. */
export function useClerkPasswordChange(): ((current: string, next: string) => Promise<void>) | null {
  const { user } = useUser()
  if (!user) return null
  return async (current, next) => {
    try {
      await user.updatePassword({ currentPassword: current, newPassword: next, signOutOfOtherSessions: true })
    } catch (error) {
      throw new Error(clerkErrorCode(error) === 'form_password_incorrect' ? 'Your current password is incorrect' : clerkErrorMessage(error))
    }
  }
}
