// Staff account management. Creating auth users needs the service role, but
// every role change goes through admin_set_user_role() as the caller, so the
// database enforces who may grant what (no privilege escalation).
import { z } from 'zod'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { storefrontBase } from '../_shared/storefront.ts'
import { adminClient, requireStaff, rpc } from '../_shared/supabase.ts'

const roleSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/)

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('create'),
    email: z.email().max(160),
    full_name: z.string().trim().min(2).max(100),
    role: roleSchema,
    password: z.string().min(10).max(72).optional(),
  }),
  z.object({ action: z.literal('set_role'), user_id: z.uuid(), role: roleSchema, is_active: z.boolean().default(true) }),
  z.object({ action: z.literal('deactivate'), user_id: z.uuid() }),
  z.object({ action: z.literal('reactivate'), user_id: z.uuid() }),
])

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const staff = await requireStaff(req, 'users.manage')
    const input = parse(schema, await readJson(req))
    const admin = adminClient()

    switch (input.action) {
      case 'list': {
        const { data: profiles, error } = await staff.client
          .from('profiles')
          .select('id, email, full_name, phone, is_active, last_seen_at, created_at, roles(code, name)')
          .order('created_at')
        if (error) throw new HttpError(500, 'Could not load staff', 'INTERNAL')
        const lastSignIn: Record<string, string | null> = {}
        for (const p of profiles ?? []) {
          const { data } = await admin.auth.admin.getUserById(p.id)
          lastSignIn[p.id] = data.user?.last_sign_in_at ?? null
        }
        return json(req, { users: (profiles ?? []).map((p) => ({ ...p, last_sign_in_at: lastSignIn[p.id] })) })
      }

      case 'create': {
        const existingId = await rpc<string | null>(admin, 'find_auth_user_id', { p_email: input.email })
        let userId = existingId
        let created = false
        if (!userId) {
          const redirectTo = `${await storefrontBase(admin)}/admin/reset-password`
          const result = input.password
            ? await admin.auth.admin.createUser({
                email: input.email, password: input.password, email_confirm: true, user_metadata: { full_name: input.full_name },
              })
            : await admin.auth.admin.inviteUserByEmail(input.email, { data: { full_name: input.full_name }, redirectTo })
          if (result.error || !result.data.user) {
            throw new HttpError(422, result.error?.message ?? 'Could not create the user', 'AUTH_ERROR')
          }
          userId = result.data.user.id
          created = true
        }
        try {
          const profile = await rpc(staff.client, 'admin_set_user_role', { p_user_id: userId, p_role_code: input.role, p_is_active: true })
          return json(req, { profile, invited: created && !input.password }, 201)
        } catch (error) {
          if (created) await admin.auth.admin.deleteUser(userId!)
          throw error
        }
      }

      case 'set_role': {
        const profile = await rpc(staff.client, 'admin_set_user_role', {
          p_user_id: input.user_id, p_role_code: input.role, p_is_active: input.is_active,
        })
        return json(req, { profile })
      }

      case 'deactivate':
      case 'reactivate': {
        const active = input.action === 'reactivate'
        const { data: current } = await staff.client.from('profiles').select('roles(code)').eq('id', input.user_id).maybeSingle()
        const role = (current?.roles as unknown as { code: string } | null)?.code
        if (!role) throw new HttpError(404, 'Staff member not found', 'NOT_FOUND')
        const profile = await rpc(staff.client, 'admin_set_user_role', { p_user_id: input.user_id, p_role_code: role, p_is_active: active })
        // Also block sign-in at the auth layer while deactivated.
        await admin.auth.admin.updateUserById(input.user_id, { ban_duration: active ? 'none' : '876000h' })
        return json(req, { profile })
      }
    }
  }),
)
