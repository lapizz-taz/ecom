// Clerk → Fullfilio. Clerk calls this when an account changes:
//
//   user.updated  – the verified e-mail and name are copied to the login; a
//                   banned account blocks the login, an unbanned one frees it
//                   again (unless the business deactivated that person).
//   user.deleted  – the login is blocked; its history stays.
//
// Every call is signed by Clerk (Svix); the signing secret is the
// CLERK_WEBHOOK_SECRET edge secret or "webhook_secret" in the auth.clerk
// credential. Endpoint: <site>/functions/v1/clerk-webhook on Cloudflare (or <SUPABASE_URL>/functions/v1/clerk-webhook).
import { blockLogin, findLogin, syncLoginFromClerk, unblockLogin } from '../_shared/accounts.ts'
import { type ClerkUser, clerkWebhookSecret, verifyWebhook } from '../_shared/clerk.ts'
import { handle, HttpError, json } from '../_shared/http.ts'
import { adminClient, rpc } from '../_shared/supabase.ts'

interface ClerkEvent { type: string; data: Partial<ClerkUser> & { id?: string; deleted?: boolean } }

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await req.text()
    if (body.length > 256 * 1024) throw new HttpError(413, 'Request is too large', 'PAYLOAD_TOO_LARGE')
    const secret = await clerkWebhookSecret()
    if (!secret) throw new HttpError(503, 'The Clerk webhook is not set up yet', 'NOT_CONFIGURED')
    if (!(await verifyWebhook(secret, req.headers, body))) throw new HttpError(401, 'Bad signature', 'INVALID_SIGNATURE')

    const event = JSON.parse(body) as ClerkEvent
    const admin = adminClient()
    const clerkId = event.data?.id
    if (!clerkId) return json(req, { ignored: true })

    if (event.type === 'user.deleted') {
      const userId = await rpc<string | null>(admin, 'find_auth_user_by_clerk', { p_clerk_id: clerkId })
      if (userId) await blockLogin(admin, userId)
      return json(req, { blocked: !!userId })
    }

    if (event.type === 'user.updated') {
      const clerkUser = event.data as ClerkUser
      const user = await findLogin(admin, clerkUser)
      if (!user) return json(req, { ignored: true })
      const changed = await syncLoginFromClerk(admin, user, clerkUser)
      if (clerkUser.banned === true) await blockLogin(admin, user.id)
      else if (clerkUser.banned === false && user.banned_until) await unblockLogin(admin, user.id)
      return json(req, { updated: changed })
    }

    return json(req, { ignored: true })
  })
)
