// Clerk sign-in bridge.
//
//   session  – a signed-in Clerk session becomes a Supabase session for the
//              account with the same verified e-mail (created on first use).
//   migrate  – someone with an existing Fullfilio password who is not in Clerk
//              yet: the password is checked against the old account and their
//              Clerk account is created with it, so they sign in as before.
//              "legacy" when Clerk's settings cannot take the account yet (it
//              requires a phone number): the old sign-in is used meanwhile.
//   ensure   – before "forgot password": an existing confirmed account that is
//              not in Clerk yet gets one, so Clerk can e-mail the reset code.
//
// Clerk's secret key and the service-role key stay on this server.
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createClerkUser, findClerkUserByEmail, getClerkUser, verifiedPrimaryEmail, verifySessionToken } from '../_shared/clerk.ts'
import { requireEnv, env } from '../_shared/env.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, rpc } from '../_shared/supabase.ts'

const email = z.email().max(160).transform((e) => e.trim().toLowerCase())
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('session'), token: z.string().min(20).max(8000) }),
  z.object({ action: z.literal('migrate'), email, password: z.string().min(1).max(200) }),
  z.object({ action: z.literal('ensure'), email }),
])

type Admin = ReturnType<typeof adminClient>

const isRequirementMissing = (e: unknown) => e instanceof HttpError && ['form_data_missing', 'form_param_missing'].includes((e.details as { code?: string } | undefined)?.code ?? '')
const isNotFound = (e: unknown) => e instanceof HttpError && (e.details as { code?: string } | undefined)?.code === 'resource_not_found'

async function authUser(admin: Admin, address: string) {
  const id = await rpc<string | null>(admin, 'find_auth_user_id', { p_email: address })
  if (!id) return null
  const { data, error } = await admin.auth.admin.getUserById(id)
  if (error || !data.user) throw new HttpError(500, 'Could not read the account', 'INTERNAL')
  return data.user
}

async function fullName(admin: Admin, userId: string, fallback: unknown): Promise<string | null> {
  const { data } = await admin.from('profiles').select('full_name').eq('id', userId).maybeSingle()
  return (data?.full_name as string | undefined) ?? (typeof fallback === 'string' ? fallback : null)
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    rateLimit(`clerk-auth:${clientIp(req)}`, 30)
    const input = parse(schema, await readJson(req))
    const admin = adminClient()

    if (input.action === 'session') {
      const claims = await verifySessionToken(input.token)
      rateLimit(`clerk-session:${claims.sub}`, 20)
      const clerkUser = await getClerkUser(claims.sub)
      const address = verifiedPrimaryEmail(clerkUser)
      if (!address) throw new HttpError(403, 'Confirm your e-mail address first', 'EMAIL_NOT_VERIFIED')
      const name = [clerkUser.first_name, clerkUser.last_name].filter(Boolean).join(' ') || null

      let user = await authUser(admin, address)
      if (!user) {
        const created = await admin.auth.admin.createUser({
          email: address, email_confirm: true,
          user_metadata: name ? { full_name: name } : {}, app_metadata: { clerk_user_id: claims.sub },
        })
        if (created.error || !created.data.user) throw new HttpError(500, 'Could not open the account', 'INTERNAL')
        user = created.data.user
      } else {
        const linked = user.app_metadata?.clerk_user_id as string | undefined
        if (linked && linked !== claims.sub) {
          // The e-mail moved to a new Clerk account. Allow it only when the old one is gone.
          const old = await getClerkUser(linked).catch((e) => (isNotFound(e) ? null : Promise.reject(e)))
          if (old) throw new HttpError(409, 'This e-mail is linked to another sign-in. Contact support.', 'ACCOUNT_CONFLICT')
        }
        if (linked !== claims.sub || !user.email_confirmed_at) {
          const { error } = await admin.auth.admin.updateUserById(user.id, {
            email_confirm: true, app_metadata: { ...user.app_metadata, clerk_user_id: claims.sub },
          })
          if (error) throw new HttpError(500, 'Could not open the account', 'INTERNAL')
        }
      }

      const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: address })
      const hash = link.data?.properties?.hashed_token
      if (link.error || !hash) throw new HttpError(500, 'Could not open the session', 'INTERNAL')
      return json(req, { token_hash: hash, email: address, user_id: user.id })
    }

    if (input.action === 'migrate') {
      rateLimit(`clerk-migrate:${input.email}`, 5, 10 * 60_000)
      if (await findClerkUserByEmail(input.email)) return json(req, { status: 'exists' })
      const anon = createClient(requireEnv('SUPABASE_URL'), env('SUPABASE_ANON_KEY') ?? requireEnv('SUPABASE_PUBLISHABLE_KEY'), {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const check = await anon.auth.signInWithPassword({ email: input.email, password: input.password })
      if (check.error || !check.data.user) {
        if (/not confirmed/i.test(check.error?.message ?? '')) return json(req, { status: 'unconfirmed' })
        throw new HttpError(422, 'Email or password is incorrect', 'INVALID_LOGIN')
      }
      const user = check.data.user
      await anon.auth.signOut().catch(() => {})
      let created
      try {
        created = await createClerkUser({
          email: input.email, password: input.password, externalId: user.id,
          fullName: await fullName(admin, user.id, user.user_metadata?.full_name),
        })
      } catch (error) {
        // Clerk is set to require something we do not have (e.g. a phone number):
        // the person keeps signing in the old way until that setting changes.
        if (isRequirementMissing(error)) return json(req, { status: 'legacy' })
        throw error
      }
      await admin.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, clerk_user_id: created.id } })
      return json(req, { status: 'created' })
    }

    // ensure
    rateLimit(`clerk-ensure:${input.email}`, 3, 10 * 60_000)
    if (!(await findClerkUserByEmail(input.email))) {
      const user = await authUser(admin, input.email)
      if (user?.email_confirmed_at) {
        try {
          const created = await createClerkUser({
            email: input.email, externalId: user.id, fullName: await fullName(admin, user.id, user.user_metadata?.full_name),
          })
          await admin.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, clerk_user_id: created.id } })
        } catch (error) {
          if (!isRequirementMissing(error)) throw error
        }
      }
    }
    // Same answer either way, so this cannot be used to find out who has an account.
    return json(req, { ok: true })
  }),
)
