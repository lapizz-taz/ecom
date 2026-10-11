// Clerk sign-in bridge.
//
//   session  – a signed-in Clerk session becomes a Supabase session for the
//              account with the same verified e-mail (created on first use).
//   setup    – switches off Clerk's "choose an organization" step.
//   import   – gives existing staff and owners their Clerk account, with the
//              password they have now (its bcrypt hash), e.g. after switching
//              to a new Clerk instance. New staff are created there by
//              admin-users and platform-admin.
//
// setup and import are internal: only a scheduled-job caller (the cron secret
// or the service role key) may use them.
//
// Clerk's secret key and the service-role key stay on this server.
import { z } from 'zod'
import { BCRYPT_DIGEST, ensureClerkAccount, getClerkUser, updateOrganizationSettings, verifiedPrimaryEmail, verifySessionToken } from '../_shared/clerk.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, rpc } from '../_shared/supabase.ts'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('session'), token: z.string().min(20).max(8000) }),
  z.object({ action: z.literal('setup') }),
  z.object({
    action: z.literal('import'),
    users: z.array(z.object({
      user_id: z.uuid(),
      email: z.email().max(160).transform((e) => e.toLowerCase()),
      full_name: z.string().trim().max(100).nullable().optional(),
      password_digest: z.string().regex(BCRYPT_DIGEST).nullable().optional(),
    })).min(1).max(100),
  }),
])

type Admin = ReturnType<typeof adminClient>

const isNotFound = (e: unknown) => e instanceof HttpError && (e.details as { code?: string } | undefined)?.code === 'resource_not_found'

async function authUser(admin: Admin, address: string) {
  const id = await rpc<string | null>(admin, 'find_auth_user_id', { p_email: address })
  if (!id) return null
  const { data, error } = await admin.auth.admin.getUserById(id)
  if (error || !data.user) throw new HttpError(500, 'Could not read the account', 'INTERNAL')
  return data.user
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

    if (!(await isCronRequest(req, admin))) throw new HttpError(403, 'Not allowed', 'PERMISSION_DENIED')

    if (input.action === 'import') {
      const results = []
      for (const u of input.users) {
        // Only real accounts, under the e-mail they really have.
        const { data } = await admin.auth.admin.getUserById(u.user_id)
        if (data.user?.email?.toLowerCase() !== u.email) {
          results.push({ email: u.email, status: 'skipped: no such account' })
          continue
        }
        try {
          const status = await ensureClerkAccount(admin, { userId: u.user_id, email: u.email, passwordDigest: u.password_digest, fullName: u.full_name })
          results.push({ email: u.email, status: status || 'clerk not set up', password: Boolean(u.password_digest) })
        } catch (e) {
          results.push({ email: u.email, status: `failed: ${e instanceof Error ? e.message : String(e)}` })
        }
      }
      return json(req, { results })
    }

    // setup: switch off Clerk's "choose an organization" step (Fullfilio has its own businesses).
    const settings = await updateOrganizationSettings({ force_organization_selection: false })
    return json(req, { force_organization_selection: settings.force_organization_selection })
  }),
)
