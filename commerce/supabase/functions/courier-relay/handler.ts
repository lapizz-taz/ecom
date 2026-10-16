// Courier relay (runs on Supabase only). The couriers' merchant panels and BD Courier
// refuse requests from Cloudflare Workers, so the Worker sends courier sign-in tests
// and lookups here (see _shared/fraud/courier-relay.ts).
//   POST {action: 'lookup', phone}                    every connected courier, logins from Vault
//   POST {action: 'history', phone}                   BD Courier, the platform's key from Vault
//   POST {action: 'test', provider, login, phone}     one login, nothing saved
//   POST {action: 'gateway', url, method, headers, body}  one call to bKash or PayStation,
//        which refuse Workers too (see _shared/payments/gateway-relay.ts); those hosts only
// Only our own servers may call it: the cron secret, or a key Supabase accepts
// as the service role (asked of Supabase, so the Worker's copy may be another format).
// Metering stays with the caller; nothing here is logged.
import { z } from 'zod'
import { carriesServiceKey, isCronRequest } from '../_shared/cron.ts'
import { fetchWithRetry } from '../_shared/fetch-retry.ts'
import { CourierHistoryProvider } from '../_shared/fraud/courier-history.ts'
import { COURIER_PANEL_PROVIDERS, type CourierPanelCreds, CourierPanelProvider, testPanelLogin } from '../_shared/fraud/courier-panel.ts'
import { courierHistoryConfig, platformCourierHistorySecret, platformPanelCreds } from '../_shared/fraud/service.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { callGateway } from '../_shared/payments/gateway-relay.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient } from '../_shared/supabase.ts'

const phone = z.string().trim().min(6).max(20).regex(/^[+0-9\s-]+$/)
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('lookup'), phone }),
  z.object({ action: z.literal('history'), phone }),
  z.object({
    action: z.literal('gateway'), url: z.url({ protocol: /^https$/ }).max(500), method: z.enum(['GET', 'POST']),
    headers: z.record(z.string().max(64), z.string().max(2000)), body: z.string().max(100_000),
  }),
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

    if (body.action === 'gateway') return json(req, await callGateway(body))

    if (body.action === 'test') return json(req, await testPanelLogin(body.provider, body.login, body.phone))

    if (body.action === 'history') {
      const config = courierHistoryConfig(await platformCourierHistorySecret(admin), 8_000)
      if (!config) return json(req, { ok: false, message: 'BD Courier is not connected on the platform' })
      // Its own fetch: the lookup always runs here, never back through a relay.
      const provider = new CourierHistoryProvider(config, fetchWithRetry(fetch, { attempts: 2, baseDelayMs: 250, maxDelayMs: 800 }))
      try {
        return json(req, { ok: true, summary: await provider.lookup(body.phone) })
      } catch (error) {
        return json(req, { ok: false, message: (error as Error).message })
      }
    }

    const provider = new CourierPanelProvider((await platformPanelCreds(admin) as CourierPanelCreds | null) ?? {})
    try {
      return json(req, { ok: true, summary: await provider.lookup(body.phone) })
    } catch (error) {
      return json(req, { ok: false, message: (error as Error).message })
    }
  })
)
