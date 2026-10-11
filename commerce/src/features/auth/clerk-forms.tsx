import { useClerk, useUser } from '@clerk/clerk-react'
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

/**
 * The signed-in person's Clerk account, for the account page: a name saved in
 * Fullfilio is saved in Clerk too; the e-mail is changed (and verified) in
 * Clerk's own account window. Null when this session did not come from Clerk.
 */
export function useClerkAccount(): { saveName: (fullName: string) => Promise<void>; changeEmail: () => void } | null {
  const { user } = useUser()
  const clerk = useClerk()
  if (!user) return null
  return {
    saveName: async (fullName) => {
      const [firstName, ...rest] = fullName.trim().split(/\s+/)
      try {
        await user.update({ firstName: firstName ?? '', lastName: rest.join(' ') })
      } catch (error) {
        throw new Error(clerkErrorMessage(error))
      }
    },
    changeEmail: () => clerk.openUserProfile(),
  }
}
