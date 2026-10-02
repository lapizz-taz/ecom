import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { env, requireEnv } from './env.ts'
import { fromDbError, HttpError } from './http.ts'

const options = { auth: { persistSession: false, autoRefreshToken: false } }

function serviceKey(): string {
  return env('SUPABASE_SERVICE_ROLE_KEY') ?? requireEnv('SUPABASE_SECRET_KEY')
}

function anonKey(): string {
  return env('SUPABASE_ANON_KEY') ?? requireEnv('SUPABASE_PUBLISHABLE_KEY')
}

/** Service-role client. Bypasses RLS — only use after validating input. */
export function adminClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), serviceKey(), options)
}

/** Client acting as the caller, so RLS and permission checks apply. */
export function userClient(req: Request): SupabaseClient {
  const authorization = req.headers.get('Authorization') ?? ''
  return createClient(requireEnv('SUPABASE_URL'), anonKey(), {
    ...options,
    global: { headers: { Authorization: authorization } },
  })
}

function bearer(req: Request): string | null {
  const header = req.headers.get('Authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1] : null
}

/** Signed-in user for the request, or null for anonymous visitors. */
export async function optionalUser(req: Request): Promise<User | null> {
  const token = bearer(req)
  if (!token) return null
  const { data, error } = await adminClient().auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

export interface StaffContext {
  user: User
  client: SupabaseClient
  role: string
  permissions: string[]
}

/** Requires a signed-in, active staff member with the given permission. */
export async function requireStaff(req: Request, permission: string): Promise<StaffContext> {
  const user = await optionalUser(req)
  if (!user) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
  const client = userClient(req)
  const { data, error } = await client.rpc('get_my_access')
  if (error) throw fromDbError(error)
  const access = data as { role: string; permissions: string[] } | null
  if (!access) throw new HttpError(403, 'Staff access required', 'PERMISSION_DENIED')
  if (access.role !== 'OWNER' && !access.permissions.includes(permission)) {
    throw new HttpError(403, `${permission} is required`, 'PERMISSION_DENIED')
  }
  return { user, client, role: access.role, permissions: access.permissions }
}

/** Calls an RPC and converts database errors into HTTP errors. */
export async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw fromDbError(error)
  return data as T
}

export async function getSettings<T = Record<string, unknown>>(client: SupabaseClient, key: string): Promise<T> {
  const { data, error } = await client.from('settings').select('value').eq('key', key).maybeSingle()
  if (error) throw fromDbError(error)
  return (data?.value ?? {}) as T
}
