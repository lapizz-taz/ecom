// Super Admin actions that need Supabase Auth's admin API (creating logins).
// Everything else in the panel calls database functions directly; those check
// platform permissions themselves. Here the caller's permission is checked
// first (as the signed-in employee), so no login is created for a request
// that would be refused.
//   invite_employee  {email, full_name, role_id, title?, merchant_scope?, merchant_ids?, password?}
//   create_merchant  {merchant: {...}, owner: {email, full_name, password?}}
//   set_owner        {merchant_id, email, full_name, password?}
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { env } from '../_shared/env.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, optionalUser, rpc, userClient } from '../_shared/supabase.ts'

const person = {
  email: z.email().max(160).transform((e) => e.toLowerCase()),
  full_name: z.string().trim().min(2).max(100),
  password: z.string().min(10).max(72).optional(),
}

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('invite_employee'),
    ...person,
    role_id: z.uuid(),
    title: z.string().trim().max(80).optional(),
    merchant_scope: z.enum(['ALL', 'ASSIGNED']).default('ALL'),
    merchant_ids: z.array(z.uuid()).max(500).default([]),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('create_merchant'),
    merchant: z.object({
      name: z.string().trim().min(2).max(120),
      slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).optional(),
      phone: z.string().trim().max(30).optional(),
      business_type: z.string().trim().max(60).optional(),
      website: z.string().trim().max(200).optional(),
      address: z.string().trim().max(300).optional(),
      notes: z.string().trim().max(2000).optional(),
      is_demo: z.boolean().default(false),
      account_manager_id: z.uuid().optional(),
      plan_code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,30}$/).optional(),
    }),
    owner: z.object(person),
  }),
  z.object({ action: z.literal('set_owner'), merchant_id: z.uuid(), ...person }),
])

/** Finds the login for this email, or creates it (invitation e-mail, or a password the employee hands over). */
async function ensureLogin(admin: SupabaseClient, who: { email: string; full_name: string; password?: string }, redirectTo: string) {
  const existing = await rpc<string | null>(admin, 'find_auth_user_id', { p_email: who.email })
  if (existing) return { id: existing, created: false }
  const result = who.password
    ? await admin.auth.admin.createUser({ email: who.email, password: who.password, email_confirm: true, user_metadata: { full_name: who.full_name } })
    : await admin.auth.admin.inviteUserByEmail(who.email, { data: { full_name: who.full_name }, redirectTo })
  if (result.error || !result.data.user) throw new HttpError(422, result.error?.message ?? 'Could not create the login', 'AUTH_ERROR')
  return { id: result.data.user.id, created: true }
}

async function require(client: SupabaseClient, module: string, action: string) {
  if (!(await rpc<boolean>(client, 'platform_can', { p_module: module, p_action: action, p_merchant: null }))) {
    await client.rpc('platform_report_denied', { p_action: `${module}.${action}`, p_detail: {} })
    throw new HttpError(403, `${module} ${action} is not allowed for your role`, 'PERMISSION_DENIED')
  }
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const user = await optionalUser(req)
    if (!user) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
    rateLimit(`platform-admin:${user.id}:${clientIp(req)}`, 30)
    const input = parse(schema, await readJson(req))
    // Acts as the employee: the database checks their platform permissions.
    const client = userClient(req)
    const admin = adminClient()
    const panel = (env('PLATFORM_URL') ?? req.headers.get('origin') ?? env('STOREFRONT_URL') ?? '').replace(/\/+$/, '')
    const redirectTo = `${panel}/admin/reset-password`

    switch (input.action) {
      case 'invite_employee': {
        await require(client, 'employees', 'create')
        const login = await ensureLogin(admin, input, redirectTo)
        try {
          const saved = await rpc(client, 'platform_staff_save', {
            p: { user_id: login.id, full_name: input.full_name, role_id: input.role_id, title: input.title ?? null,
              merchant_scope: input.merchant_scope, merchant_ids: input.merchant_ids, reason: input.reason ?? null },
          })
          return json(req, { employee: saved, invited: login.created && !input.password }, 201)
        } catch (error) {
          // A login made only for this refused request is removed again.
          if (login.created) await admin.auth.admin.deleteUser(login.id)
          throw error
        }
      }
      case 'create_merchant': {
        await require(client, 'merchants', 'create')
        const created = await rpc<{ id: string }>(client, 'platform_merchant_create', { p: { ...input.merchant, owner_email: input.owner.email } })
        const login = await ensureLogin(admin, input.owner, redirectTo)
        try {
          await rpc(client, 'platform_merchant_set_owner', { p_merchant: created.id, p_user: login.id, p_full_name: input.owner.full_name })
        } catch (error) {
          if (login.created) await admin.auth.admin.deleteUser(login.id)
          // The merchant stays (in onboarding) so the owner can be added again from its page.
          throw error
        }
        return json(req, { merchant_id: created.id, owner_invited: login.created && !input.owner.password }, 201)
      }
      case 'set_owner': {
        await require(client, 'merchants', 'manage')
        const login = await ensureLogin(admin, input, redirectTo)
        try {
          await rpc(client, 'platform_merchant_set_owner', { p_merchant: input.merchant_id, p_user: login.id, p_full_name: input.full_name })
        } catch (error) {
          if (login.created) await admin.auth.admin.deleteUser(login.id)
          throw error
        }
        return json(req, { ok: true, owner_invited: login.created && !input.password })
      }
    }
  }),
)
