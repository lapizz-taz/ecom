import { env } from '@/lib/env'
// The Super Admin panel is not linked anywhere and does not open from its
// usual address until this device has visited the secret entry address
// (VITE_SUPER_ADMIN_PATH, set at build time). Without it, /super-admin looks
// like any missing page. This only hides the panel: every Super Admin action
// is still checked in the database against the platform staff list and roles.

const KEY = 'fullfilio:ops-entry'

/** The secret entry path ("/xyz…"), or null when no secret is configured (local development). */
export const SUPER_ADMIN_ENTRY: string | null = env.superAdminPath

/** May this device open the Super Admin pages? */
export function superAdminUnlocked(): boolean {
  if (!SUPER_ADMIN_ENTRY) return true
  try {
    return localStorage.getItem(KEY) === SUPER_ADMIN_ENTRY
  } catch {
    return false
  }
}

/** Remember that this device came in through the secret entry address. */
export function unlockSuperAdmin() {
  try {
    if (SUPER_ADMIN_ENTRY) localStorage.setItem(KEY, SUPER_ADMIN_ENTRY)
  } catch {
    // Private mode: the entry address has to be used again next time.
  }
}
