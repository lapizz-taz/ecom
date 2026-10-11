// Keeps a Fullfilio login in step with its Clerk account: the same verified
// e-mail and name on the login, the staff profile and the platform staff
// record; a Clerk account deleted or banned means the login is blocked.
import type { AdminUserAttributes, SupabaseClient, User } from '@supabase/supabase-js'
import { type ClerkUser, clerkFullName, verifiedPrimaryEmail } from './clerk.ts'
import { HttpError } from './http.ts'
import { adminClient, rpc } from './supabase.ts'

type Admin = SupabaseClient

/** Blocked for a hundred years: the way Supabase Auth switches a login off. */
export const BLOCKED = '876000h'

export async function loginById(admin: Admin, id: string): Promise<User | null> {
  const { data, error } = await admin.auth.admin.getUserById(id)
  if (error || !data.user) return null
  return data.user
}

/** The login of a Clerk account: the one linked to it, else the one with its verified e-mail. */
export async function findLogin(admin: Admin, clerkUser: ClerkUser): Promise<User | null> {
  const linked = await rpc<string | null>(admin, 'find_auth_user_by_clerk', { p_clerk_id: clerkUser.id })
  if (linked) return loginById(admin, linked)
  const email = verifiedPrimaryEmail(clerkUser)
  if (!email) return null
  const byEmail = await rpc<string | null>(admin, 'find_auth_user_id', { p_email: email })
  return byEmail ? loginById(admin, byEmail) : null
}

export const isBlocked = (u: Pick<User, 'banned_until'>, now = Date.now()) =>
  !!u.banned_until && new Date(u.banned_until).getTime() > now

/** Changes the staff profile (in its business, so the business's audit log records it) and the platform staff record. */
async function updatePeople(admin: Admin, userId: string, fields: Record<string, unknown>) {
  const { data: profile } = await admin.from('profiles').select('merchant_id').eq('id', userId).maybeSingle()
  if (profile?.merchant_id) {
    const { error } = await adminClient(profile.merchant_id as string).from('profiles').update(fields).eq('id', userId)
    if (error) throw new HttpError(500, 'Could not update the staff profile', 'INTERNAL', { cause: error.message })
  }
  const staffFields = Object.fromEntries(Object.entries(fields).filter(([k]) => k === 'email' || k === 'full_name'))
  if (Object.keys(staffFields).length) await admin.from('platform_staff').update(staffFields).eq('user_id', userId)
}

/** Copies the Clerk account's verified e-mail and name to the login. */
export async function syncLoginFromClerk(admin: Admin, user: User, clerkUser: ClerkUser): Promise<{ email: boolean; name: boolean }> {
  const email = verifiedPrimaryEmail(clerkUser)
  const name = clerkFullName(clerkUser)
  const patch: AdminUserAttributes = {}
  const changed = { email: false, name: false }
  if (email && email !== (user.email ?? '').toLowerCase()) {
    const taken = await rpc<string | null>(admin, 'find_auth_user_id', { p_email: email })
    if (taken && taken !== user.id) {
      throw new HttpError(409, 'This e-mail already belongs to another Fullfilio account. Contact support.', 'ACCOUNT_CONFLICT')
    }
    patch.email = email
    patch.email_confirm = true
    changed.email = true
  }
  if (name && name !== ((user.user_metadata?.full_name as string | undefined) ?? null)) {
    patch.user_metadata = { ...user.user_metadata, full_name: name }
    changed.name = true
  }
  if (patch.email || patch.user_metadata) {
    const { error } = await admin.auth.admin.updateUserById(user.id, patch)
    if (error) throw new HttpError(500, 'Could not update the account', 'INTERNAL', { cause: error.message })
  }
  const fields = { ...(changed.email ? { email } : {}), ...(changed.name ? { full_name: name } : {}) }
  if (Object.keys(fields).length) await updatePeople(admin, user.id, fields)
  return changed
}

/** Switches a login off (its history stays): no sign-in, and its staff profile shows as inactive. */
export async function blockLogin(admin: Admin, userId: string) {
  const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: BLOCKED })
  if (error) throw new HttpError(500, 'Could not block the account', 'INTERNAL', { cause: error.message })
  const { data: profile } = await admin.from('profiles').select('merchant_id, is_active').eq('id', userId).maybeSingle()
  if (profile?.merchant_id && profile.is_active) await updatePeople(admin, userId, { is_active: false })
}

/** Turns a login back on after its Clerk account was unbanned (only if its staff profile is still active). */
export async function unblockLogin(admin: Admin, userId: string) {
  const { data: profile } = await admin.from('profiles').select('is_active').eq('id', userId).maybeSingle()
  if (profile && !profile.is_active) return
  await admin.auth.admin.updateUserById(userId, { ban_duration: 'none' })
}

/**
 * Removes a login that belonged only to a deleted business: blocked for good,
 * its e-mail address freed (so it can sign up again later) and its names cleared.
 */
export async function retireLogin(admin: Admin, user: User) {
  const { clerk_user_id: _clerk, ...appMetadata } = (user.app_metadata ?? {}) as Record<string, unknown>
  const { error } = await admin.auth.admin.updateUserById(user.id, {
    email: `deleted.${user.id}@users.invalid`,
    email_confirm: true,
    ban_duration: BLOCKED,
    user_metadata: {},
    app_metadata: { ...appMetadata, deleted_at: new Date().toISOString() },
  })
  if (error) throw new HttpError(500, 'Could not remove the login', 'INTERNAL', { cause: error.message })
}
