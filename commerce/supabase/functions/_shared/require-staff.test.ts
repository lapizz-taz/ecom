import { beforeEach, describe, expect, it, vi } from 'vitest'

// requireStaff against a fake database: the signed-in user, get_my_access, and the store-wide
// rules (has_permission, hr_my_day). Most backend actions go on with the service role, so the
// rules the database applies to the caller have to be applied here before that.
const H = vi.hoisted(() => ({
  access: null as Record<string, unknown> | null,
  allowed: true,
  gate: null as string | null,
  calls: [] as Array<{ fn: string; args: unknown }>,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    rpc: async (fn: string, args: unknown) => {
      H.calls.push({ fn, args })
      if (fn === 'get_my_access') return { data: H.access, error: null }
      if (fn === 'has_permission') return { data: H.allowed, error: null }
      if (fn === 'hr_my_day') return { data: { gate: H.gate }, error: null }
      return { data: null, error: { message: `unexpected ${fn}` } }
    },
  }),
}))

const { requireStaff } = await import('./supabase.ts')

const M = '00000000-0000-4000-8000-000000000001'
const req = () => new Request('https://x.test/functions/v1/sms', { headers: { Authorization: 'Bearer token-of-u1' } })
const staff = (role: string, permissions: string[], access_mode = 'FULL', extra: Record<string, unknown> = {}) =>
  ({ user_id: 'u1', merchant_id: M, role, permissions, access_mode, ...extra })

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test'
  process.env.SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  H.access = null
  H.allowed = true
  H.gate = null
  H.calls = []
})

describe('requireStaff', () => {
  it('lets a staff member through when the role and the store rules allow it, asking the database for that permission', async () => {
    H.access = staff('MANAGER', ['sms.manage'])
    const ctx = await requireStaff(req(), 'sms.manage')
    expect(ctx).toMatchObject({ merchantId: M, role: 'MANAGER' })
    expect(H.calls.find((c) => c.fn === 'has_permission')?.args).toEqual({ p_code: 'sms.manage' })
  })

  it('refuses a restricted store (closed, suspended, first payment not made), the owner included', async () => {
    H.access = staff('OWNER', [], 'BLOCKED')
    H.allowed = false
    await expect(requireStaff(req(), 'shipments.manage')).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_RESTRICTED' })
  })

  it('refuses changes in a read-only store', async () => {
    H.access = staff('OWNER', [], 'READ_ONLY')
    H.allowed = false
    await expect(requireStaff(req(), 'settings.manage')).rejects.toMatchObject({ status: 403, code: 'READ_ONLY' })
  })

  it('refuses operational work until the staff member checks in, or while on a break', async () => {
    H.access = staff('MANAGER', ['shipments.manage'])
    H.allowed = false
    H.gate = 'CHECK_IN_REQUIRED'
    await expect(requireStaff(req(), 'shipments.manage')).rejects.toMatchObject({ status: 403, code: 'CHECK_IN_REQUIRED' })
    H.gate = 'ON_BREAK'
    await expect(requireStaff(req(), 'shipments.manage')).rejects.toMatchObject({ status: 403, code: 'ON_BREAK' })
    H.gate = null
    await expect(requireStaff(req(), 'shipments.manage')).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
  })

  it('still refuses a permission the role does not have, before asking about the store', async () => {
    H.access = staff('VIEWER', ['orders.view'])
    await expect(requireStaff(req(), 'sms.manage')).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' })
    expect(H.calls.map((c) => c.fn)).toEqual(['get_my_access'])
  })

  it('an action that only reads stays open in a read-only store and before check-in, but not in a restricted store', async () => {
    H.allowed = false
    H.access = staff('OWNER', [], 'READ_ONLY')
    await expect(requireStaff(req(), 'users.manage', { read: true })).resolves.toMatchObject({ role: 'OWNER' })
    H.access = staff('MANAGER', ['shipments.manage'])
    H.gate = 'CHECK_IN_REQUIRED'
    await expect(requireStaff(req(), 'shipments.manage', { read: true })).resolves.toMatchObject({ role: 'MANAGER' })
    expect(H.calls.some((c) => c.fn === 'has_permission')).toBe(false)
    H.access = staff('OWNER', [], 'BLOCKED')
    await expect(requireStaff(req(), 'users.manage', { read: true })).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_RESTRICTED' })
  })

  it('support viewing a store: views only, as before', async () => {
    H.access = staff('SUPPORT_VIEW', ['orders.view', 'users.manage'], 'FULL', { support_session: { id: 's1' } })
    await expect(requireStaff(req(), 'orders.view', { read: true })).resolves.toMatchObject({ role: 'SUPPORT_VIEW' })
    await expect(requireStaff(req(), 'orders.update')).rejects.toMatchObject({ code: 'SUPPORT_READ_ONLY' })
    // A read that needs more than a view is still not theirs.
    await expect(requireStaff(req(), 'users.manage', { read: true })).rejects.toMatchObject({ code: 'SUPPORT_READ_ONLY' })
  })
})
