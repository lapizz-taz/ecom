import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { env, requireEnv } from './env.ts'
import { fromDbError, HttpError } from './http.ts'
import { logEvent } from './monitoring.ts'

const options = { auth: { persistSession: false, autoRefreshToken: false } }

function serviceKey(): string {
  return env('SUPABASE_SERVICE_ROLE_KEY') ?? requireEnv('SUPABASE_SECRET_KEY')
}

function anonKey(): string {
  return env('SUPABASE_ANON_KEY') ?? requireEnv('SUPABASE_PUBLISHABLE_KEY')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Service-role client acting for one merchant: the x-merchant-id header makes
 * the database scope every business function to that merchant. Without a
 * merchant the client is platform-only and merchant data is out of reach.
 * Direct table reads bypass row-level security, so always filter them by merchant.
 */
export function adminClient(merchantId?: string | null): SupabaseClient {
  if (merchantId && !UUID.test(merchantId)) throw new Error('adminClient: not a merchant id')
  const client = createClient(requireEnv('SUPABASE_URL'), serviceKey(), merchantId
    ? { ...options, global: { headers: { 'x-merchant-id': merchantId } } }
    : options)
  serviceMerchant.set(client, merchantId ?? null)
  return client
}

// Which merchant each service-role client acts for (null: platform-only).
// Clients that act as a signed-in user are not listed: row-level security scopes them.
const serviceMerchant = new WeakMap<SupabaseClient, string | null>()

/**
 * The merchant to filter direct table reads by. Service-role reads bypass
 * row-level security, so they must name the merchant; a platform-only client
 * cannot read merchant tables at all. Returns null for user clients (RLS applies).
 */
export function merchantOf(client: SupabaseClient): string | null {
  if (!serviceMerchant.has(client)) return null
  const id = serviceMerchant.get(client)
  if (!id) throw new HttpError(500, 'No merchant for this request', 'MERCHANT_REQUIRED')
  return id
}

/** Kinds of things merchant_for() can look up. */
export type MerchantLookup =
  | 'channel' | 'channel_oauth_state' | 'ad_oauth_state' | 'courier' | 'consignment' | 'payment_session' | 'payment'
  | 'site_api_key' | 'store_domain' | 'pbx_bkash_reference' | 'pbx_bkash_payment' | 'pbx_sip_username' | 'pbx_did'
  | 'pbx_business_code' | 'pbx_call' | 'order' | 'profile' | 'inbox_account'

/** The merchant that owns something arriving from outside (webhook, return URL, API key), or null. */
export async function merchantFor(kind: MerchantLookup, key: string | null | undefined): Promise<string | null> {
  if (!key) return null
  const { data, error } = await adminClient().rpc('merchant_for', { p_kind: kind, p_key: key })
  if (error) throw fromDbError(error)
  return (data as string | null) ?? null
}

/** The store the browser is on (the storefront sends x-merchant-id). */
export function storefrontMerchant(req: Request): string {
  const id = req.headers.get('x-merchant-id') ?? ''
  if (!UUID.test(id)) throw new HttpError(400, 'This request does not say which store it is for. Reload the page and try again.', 'MERCHANT_REQUIRED')
  return id.toLowerCase()
}

/** Merchants whose scheduled work should run (everyone except closed accounts). */
export async function activeMerchants(): Promise<string[]> {
  const { data, error } = await adminClient().from('merchants').select('id').neq('status', 'CLOSED').order('number')
  if (error) throw fromDbError(error)
  return (data ?? []).map((m) => m.id as string)
}

/**
 * Runs scheduled work once per merchant, each with its own client. One
 * merchant's failure is reported (not swallowed) and does not stop the others.
 */
export async function forEachMerchant<T>(
  source: string,
  work: (admin: SupabaseClient, merchantId: string) => Promise<T>,
): Promise<{ merchants: number; failed: number; results: Array<{ merchant_id: string } & ({ ok: true; result: T } | { ok: false; error: string })> }> {
  const results: Array<{ merchant_id: string } & ({ ok: true; result: T } | { ok: false; error: string })> = []
  for (const id of await activeMerchants()) {
    try {
      results.push({ merchant_id: id, ok: true, result: await work(adminClient(id), id) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ merchant_id: id, ok: false, error: message })
      void logEvent({ level: 'ERROR', category: 'JOB', source, message: `Scheduled work failed for a merchant: ${message}`, error, merchantId: id })
    }
  }
  return { merchants: results.length, failed: results.filter((r) => !r.ok).length, results }
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
  /** Acts as the signed-in staff member (their permissions and row-level security apply). */
  client: SupabaseClient
  /** Service role inside the staff member's merchant. */
  admin: SupabaseClient
  merchantId: string
  role: string
  permissions: string[]
}

/**
 * Requires a signed-in, active staff member with the given permission, under the
 * store's rules: nothing while the account is restricted, only reads while it is
 * read-only, and no operational work before checking in when the store requires it.
 *
 * `read` marks an action that only reads. A platform employee in a customer-view
 * support session is refused anything else (and reads that need more than a view):
 * edge functions act with the service role, so row-level security cannot keep a
 * viewer from placing calls, importing data or spending the merchant's credits here.
 * A read stays open in a read-only store and before check-in, as views do.
 */
export async function requireStaff(req: Request, permission: string, options: { read?: boolean } = {}): Promise<StaffContext> {
  const user = await optionalUser(req)
  if (!user) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
  const client = userClient(req)
  const { data, error } = await client.rpc('get_my_access')
  if (error) throw fromDbError(error)
  const access = data as {
    role: string; permissions: string[]; merchant_id: string | null; access_mode?: string; view_only?: boolean; support_session?: { id: string } | null
  } | null
  if (!access?.merchant_id) throw new HttpError(403, 'Staff access required', 'PERMISSION_DENIED')
  if (access.support_session && !(options.read && permission.endsWith('.view'))) {
    throw new HttpError(403, 'You are viewing this business as support: nothing can be changed or sent from here', 'SUPPORT_READ_ONLY')
  }
  if (access.role !== 'OWNER' && !access.permissions.includes(permission)) {
    throw new HttpError(403, `${permission} is required`, 'PERMISSION_DENIED')
  }
  // The role allows it; the rules for the whole store must too: its access (closed, suspended, first
  // payment not made or plan lapsed: nothing, or only viewing) and, in the operational modules, the
  // check-in rule. has_permission is the check every table and database function makes; most actions
  // here go on with the service role, which it would not stop.
  if (!access.support_session) {
    if (options.read) {
      if (access.access_mode === 'BLOCKED') throw await storeRuleRefusal(client, 'BLOCKED')
    } else if (!(await rpc<boolean>(client, 'has_permission', { p_code: permission }))) {
      throw await storeRuleRefusal(client, access.access_mode, access.view_only)
    }
  }
  return { user, client, admin: adminClient(access.merchant_id), merchantId: access.merchant_id, role: access.role, permissions: access.permissions }
}

/** Why the store's rules refuse a staff member their role's permission, in the words the admin uses. */
async function storeRuleRefusal(client: SupabaseClient, mode: string | undefined, viewOnly = false): Promise<HttpError> {
  if (mode === 'BLOCKED') {
    return new HttpError(403, 'This account is restricted: nothing can be changed or sent until it is active again. Open Billing or contact Fullfilio support.', 'ACCOUNT_RESTRICTED')
  }
  if (mode === 'READ_ONLY') {
    if (viewOnly) return new HttpError(403, 'This is a demo account: you can look around, but changes are switched off.', 'READ_ONLY')
    return new HttpError(403, 'Read-only: you can view and export, but changes are paused until the plan is renewed.', 'READ_ONLY')
  }
  const day = await rpc<{ gate?: string | null } | null>(client, 'hr_my_day').catch(() => null)
  if (day?.gate === 'CHECK_IN_REQUIRED') return new HttpError(403, 'Check in under HRM → Attendance to start work', 'CHECK_IN_REQUIRED')
  if (day?.gate === 'ON_BREAK') return new HttpError(403, 'End your break to continue working', 'ON_BREAK')
  return new HttpError(403, 'You do not have permission to do that', 'PERMISSION_DENIED')
}

/** Calls an RPC and converts database errors into HTTP errors. */
export async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw fromDbError(error)
  return data as T
}

export async function getSettings<T = Record<string, unknown>>(client: SupabaseClient, key: string): Promise<T> {
  const merchant = merchantOf(client)
  let query = client.from('settings').select('value').eq('key', key)
  if (merchant) query = query.eq('merchant_id', merchant)
  const { data, error } = await query.maybeSingle()
  if (error) throw fromDbError(error)
  return (data?.value ?? {}) as T
}
