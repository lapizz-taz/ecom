import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'
import type { MyAccess, StaffMember } from '@/types/domain'

export interface StaffUser {
  id: string
  email: string
  full_name: string
  phone: string | null
  is_active: boolean
  last_seen_at: string | null
  created_at: string
  last_sign_in_at: string | null
  roles: { code: string; name: string } | null
}

export async function listStaffUsers(): Promise<StaffUser[]> {
  const res = await invokeFunction<{ users: StaffUser[] }>('admin-users', { action: 'list' })
  return res.users
}

export function createStaffUser(input: { email: string; full_name: string; role: string; password?: string }) {
  return invokeFunction<{ invited: boolean }>('admin-users', { action: 'create', ...input })
}

export function setStaffRole(userId: string, role: string, isActive = true) {
  return invokeFunction('admin-users', { action: 'set_role', user_id: userId, role, is_active: isActive })
}

export function setStaffActive(userId: string, active: boolean) {
  return invokeFunction('admin-users', { action: active ? 'reactivate' : 'deactivate', user_id: userId })
}

export async function listRoles() {
  const { data, error } = await supabase.from('roles').select('*, role_permissions(permission_id)').order('rank', { ascending: false })
  if (error) throw error
  return data ?? []
}
export type RoleRow = Awaited<ReturnType<typeof listRoles>>[number]

export async function listPermissions() {
  const { data, error } = await supabase.from('permissions').select('*').order('module').order('code')
  if (error) throw error
  return data ?? []
}

export async function setRolePermission(roleId: string, permissionId: string, granted: boolean) {
  const { error } = granted
    ? await supabase.from('role_permissions').insert({ role_id: roleId, permission_id: permissionId })
    : await supabase.from('role_permissions').delete().eq('role_id', roleId).eq('permission_id', permissionId)
  if (error) throw error
}

export async function updateMyProfile(fullName: string, phone?: string) {
  const { error } = await supabase.rpc('update_my_profile', { p_full_name: fullName, p_phone: phone || undefined })
  if (error) throw error
}

/** The signed-in person's own name and phone. */
export async function getMyProfile(userId: string) {
  const { data, error } = await supabase.from('profiles').select('full_name, phone').eq('id', userId).single()
  if (error) throw error
  return data
}

/** Is the signed-in person on the platform (Super Admin) team? */
export async function isPlatformStaff(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_platform_staff')
  if (error) throw error
  return data === true
}

/** Change the signed-in person's password, after checking the current one again. */
export async function changeMyPassword(email: string, current: string, next: string) {
  // Re-authenticate first so a session left open on a shared device cannot change the password.
  const check = await supabase.auth.signInWithPassword({ email, password: current })
  if (check.error) throw new Error('VALIDATION: your current password is incorrect')
  const { error } = await supabase.auth.updateUser({ password: next })
  if (error) throw error
}

/** The signed-in person's business, role and permissions (null: not staff anywhere). */
export async function getMyAccess(): Promise<MyAccess | null> {
  const { data, error } = await supabase.rpc('get_my_access')
  if (error) throw error
  return (data as unknown as MyAccess | null) ?? null
}

/** Names of everyone on the team, for "created by" and assignee columns. */
export async function staffDirectory(): Promise<StaffMember[]> {
  const { data, error } = await supabase.rpc('staff_directory')
  if (error) throw error
  return (data as unknown as StaffMember[] | null) ?? []
}
