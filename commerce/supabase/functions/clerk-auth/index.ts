// Clerk sign-in bridge.
//
//   session  – a signed-in Clerk session becomes a Supabase session for the
//              account with the same verified e-mail (created on first use).
//   setup    – switches off Clerk's "choose an organization" step; needs proof
//              of Clerk's secret key. (Accounts from before Clerk were imported
//              into Clerk with their passwords; new staff are created there by
//              admin-users.)
//
// Clerk's secret key and the service-role key stay on this server.
import { z } from 'zod'
import { clerkSecret, getClerkUser, updateOrganizationSettings, verifiedPrimaryEmail, verifySessionToken } from '../_shared/clerk.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, rpc } from '../_shared/supabase.ts'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('session'), token: z.string().min(20).max(8000) }),
  z.object({ action: z.literal('setup') }),
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

    // setup: switch off Clerk's "choose an organization" step (Fullfilio has its own businesses).
    // Only someone holding Clerk's secret key can ask for it: the proof is its SHA-256.
    const secret = await clerkSecret()
    const proof = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))))
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    if (req.headers.get('x-clerk-setup') !== proof) throw new HttpError(403, 'Not allowed', 'PERMISSION_DENIED')
    const settings = await updateOrganizationSettings({ force_organization_selection: false })
    return json(req, { force_organization_selection: settings.force_organization_selection })
  }),
)
