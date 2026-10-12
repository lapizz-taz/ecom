// Clerk sign-in bridge.
//
//   session   – a signed-in Clerk session becomes a Supabase session for the
//               account linked to that Clerk account, else the one with the
//               same verified e-mail (created on first use). The Clerk
//               account's e-mail and name are copied to it each time.
//   setup     – switches off Clerk's "choose an organization" step.
//   import    – gives existing staff and owners their Clerk account, with the
//               password they have now (its bcrypt hash), e.g. after switching
//               to a new Clerk instance. New staff are created there by
//               admin-users and platform-admin.
//   removals  – carries out queued login removals (a deleted business, a
//               deleted person or a removed employee): blocked here, e-mail
//               freed, deleted from Clerk.
//
// setup, import and removals are internal: only a scheduled-job caller (the
// cron secret or the service role key) may use them.
//
// Clerk's secret key and the service-role key stay on this server.
import { z } from 'zod'
import { findLogin, isBlocked, loginById, retireLogin, syncLoginFromClerk } from '../_shared/accounts.ts'
import {
  BCRYPT_DIGEST, clerkFullName, deleteClerkUser, ensureClerkAccount, findClerkUserByEmail, getClerkUser,
  updateOrganizationSettings, verifiedPrimaryEmail, verifySessionToken,
} from '../_shared/clerk.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { env } from '../_shared/env.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient } from '../_shared/supabase.ts'

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
  z.object({ action: z.literal('removals'), limit: z.number().int().min(1).max(50).default(25) }),
])

type Admin = ReturnType<typeof adminClient>

const isNotFound = (e: unknown) => e instanceof HttpError && (e.details as { code?: string } | undefined)?.code === 'resource_not_found'

/** Removes queued logins (of deleted businesses, people and employees). Current platform staff keep theirs. */
async function processRemovals(admin: Admin, limit: number) {
  const { data: rows, error } = await admin.from('account_removals').select('id, user_id, attempts')
    .eq('status', 'PENDING').lt('attempts', 5).order('created_at').limit(limit)
  if (error) throw new HttpError(500, 'Could not read the removal queue', 'INTERNAL', { cause: error.message })
  const results = []
  for (const row of rows ?? []) {
    try {
      const user = await loginById(admin, row.user_id)
      const { data: staff } = await admin.from('platform_staff').select('user_id').eq('user_id', row.user_id).is('removed_at', null).maybeSingle()
      const remove = !!user && !staff
      if (remove) {
        const clerkId = (user.app_metadata?.clerk_user_id as string | undefined) ??
          (user.email ? (await findClerkUserByEmail(user.email))?.id : undefined)
        if (clerkId) await deleteClerkUser(clerkId)
        await retireLogin(admin, user)
      }
      await admin.from('account_removals').update({ status: 'DONE', done_at: new Date().toISOString(), attempts: row.attempts + 1, last_error: null })
        .eq('id', row.id)
      results.push({ id: row.id, status: remove ? 'removed' : 'skipped' })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await admin.from('account_removals')
        .update({ attempts: row.attempts + 1, last_error: message.slice(0, 500), status: row.attempts + 1 >= 5 ? 'FAILED' : 'PENDING' })
        .eq('id', row.id)
      results.push({ id: row.id, status: 'failed', error: message })
    }
  }
  return results
}

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    rateLimit(`clerk-auth:${clientIp(req)}`, 30)
    const input = parse(schema, await readJson(req))
    // Say what is missing instead of a bare "Something went wrong" (names only, never values).
    if (!env('SUPABASE_SERVICE_ROLE_KEY') && !env('SUPABASE_SECRET_KEY')) {
      throw new HttpError(503, 'Sign-in is not set up on the server yet: SUPABASE_SERVICE_ROLE_KEY is missing.', 'NOT_CONFIGURED')
    }
    const admin = adminClient()

    if (input.action === 'session') {
      const claims = await verifySessionToken(input.token)
      rateLimit(`clerk-session:${claims.sub}`, 20)
      const clerkUser = await getClerkUser(claims.sub)
      const address = verifiedPrimaryEmail(clerkUser)
      if (!address) throw new HttpError(403, 'Confirm your e-mail address first', 'EMAIL_NOT_VERIFIED')
      const name = clerkFullName(clerkUser)

      let user = await findLogin(admin, clerkUser)
      if (!user) {
        const created = await admin.auth.admin.createUser({
          email: address, email_confirm: true,
          user_metadata: name ? { full_name: name } : {}, app_metadata: { clerk_user_id: claims.sub },
        })
        if (created.error || !created.data.user) throw new HttpError(500, 'Could not open the account', 'INTERNAL')
        user = created.data.user
      } else {
        if (isBlocked(user)) {
          throw new HttpError(403, 'This sign-in is switched off. Ask your business owner or Fullfilio support.', 'ACCOUNT_DISABLED')
        }
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
        // The Clerk account's e-mail and name (changed in Clerk) carry over.
        await syncLoginFromClerk(admin, user, clerkUser)
      }

      const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: address })
      const hash = link.data?.properties?.hashed_token
      if (link.error || !hash) throw new HttpError(500, 'Could not open the session', 'INTERNAL')
      return json(req, { token_hash: hash, email: address, user_id: user.id })
    }

    if (!(await isCronRequest(req, admin))) throw new HttpError(403, 'Not allowed', 'PERMISSION_DENIED')

    if (input.action === 'removals') {
      return json(req, { results: await processRemovals(admin, input.limit) })
    }

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
  })
)
