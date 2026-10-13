// Courier relay (runs on Supabase only). The couriers' merchant panels sit
// behind Cloudflare and refuse requests from Cloudflare Workers, so the Worker
// sends courier sign-in tests and lookups here (see _shared/fraud/courier-relay.ts).
//   POST {action: 'lookup', phone}                    every connected courier, logins from Vault
//   POST {action: 'test', provider, login, phone}     one login, nothing saved
// Only our own servers may call it: the cron secret, or a key Supabase accepts
// as the service role (asked of Supabase, so the Worker's copy may be another format).
// Metering stays with the caller; nothing here is logged.
import { z } from 'zod'
import { carriesServiceKey, isCronRequest } from '../_shared/cron.ts'
import { COURIER_PANEL_PROVIDERS, type CourierPanelCreds, CourierPanelProvider, testPanelLogin } from '../_shared/fraud/courier-panel.ts'
import { platformPanelCreds } from '../_shared/fraud/service.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient } from '../_shared/supabase.ts'

const phone = z.string().trim().min(6).max(20).regex(/^[+0-9\s-]+$/)
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('lookup'), phone }),
  z.object({
    action: z.literal('test'), provider: z.enum(COURIER_PANEL_PROVIDERS), phone,
    login: z.object({
      email: z.string().trim().max(200).optional(), phone: z.string().trim().max(20).optional(),
      user: z.string().trim().max(200).optional(), password: z.string().min(1).max(200),
    }),
  }),
])

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const admin = adminClient()
    if (!(await isCronRequest(req, admin)) && !(await carriesServiceKey(req))) throw new HttpError(401, 'Not allowed', 'UNAUTHORIZED')
    const body = parse(input, await readJson(req))

    if (body.action === 'test') return json(req, await testPanelLogin(body.provider, body.login, body.phone))

    const provider = new CourierPanelProvider((await platformPanelCreds(admin) as CourierPanelCreds | null) ?? {})
    try {
      return json(req, { ok: true, summary: await provider.lookup(body.phone) })
    } catch (error) {
      return json(req, { ok: false, message: (error as Error).message })
    }
  })
)
