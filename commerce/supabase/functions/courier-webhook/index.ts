// Courier status callbacks. Every call is checked, stored in the webhook/event
// log and applied once per event (record_courier_webhook); unmatched or failed
// events are retried by the database on a schedule.
//   POST /courier-webhook?courier=<courier id>       the URL shown under Couriers
//   POST /courier-webhook?provider=pathao|steadfast  any courier of that kind
// Pathao sends the webhook secret in X-PATHAO-Signature, Steadfast as a Bearer
// token. The secret is set under Couriers (Vault), or PATHAO_WEBHOOK_SECRET /
// STEADFAST_WEBHOOK_TOKEN for provider-wide URLs.
import { env } from '../_shared/env.ts'
import { type CourierEvent, normalizePathao, normalizeSteadfast, sameSecret } from '../_shared/courier/webhooks.ts'
import { handle, HttpError, json } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { adminClient, rpc } from '../_shared/supabase.ts'

const PROVIDERS = ['pathao', 'steadfast'] as const
type Provider = (typeof PROVIDERS)[number]

// Pathao's merchant panel checks for this header (and HTTP 202) before it starts sending events.
const PATHAO_INTEGRATION_HEADER = 'X-Pathao-Merchant-Webhook-Integration-Secret'
const pathaoIntegrationSecret = () => env('PATHAO_WEBHOOK_INTEGRATION_SECRET') ?? 'f3992ecc-59da-4cbe-a049-a13da2018d51'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function reply(req: Request, provider: Provider, body: Record<string, unknown>): Response {
  return provider === 'pathao'
    ? json(req, body, 202, { [PATHAO_INTEGRATION_HEADER]: pathaoIntegrationSecret() })
    : json(req, { status: 'success', message: 'Webhook received', ...body })
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const url = new URL(req.url)
    const admin = adminClient()
    const courierId = url.searchParams.get('courier')
    let provider = url.searchParams.get('provider') as Provider | null

    let courier: { id: string; name: string; provider: string } | null = null
    if (courierId) {
      if (!UUID.test(courierId)) throw new HttpError(400, 'Unknown courier', 'UNKNOWN_COURIER')
      const { data } = await admin.from('couriers').select('id, name, provider').eq('id', courierId).maybeSingle()
      if (!data) throw new HttpError(404, 'Unknown courier', 'UNKNOWN_COURIER')
      courier = data
      provider ??= data.provider as Provider
    }
    if (!provider || !PROVIDERS.includes(provider)) {
      throw new HttpError(400, 'Say which courier sends this webhook (&provider=pathao or steadfast)', 'UNKNOWN_PROVIDER')
    }

    const expected = courier
      ? (await rpc<string | null>(admin, 'courier_webhook_secret_get', { p_courier_id: courier.id }))
        ?? env(provider === 'pathao' ? 'PATHAO_WEBHOOK_SECRET' : 'STEADFAST_WEBHOOK_TOKEN')
      : env(provider === 'pathao' ? 'PATHAO_WEBHOOK_SECRET' : 'STEADFAST_WEBHOOK_TOKEN')
    const given = provider === 'pathao'
      ? req.headers.get('x-pathao-signature')
      : (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!sameSecret(given, expected)) {
      void logEvent({
        level: 'WARN', category: 'WEBHOOK', source: 'courier-webhook',
        message: expected ? `Rejected a ${provider} webhook with a wrong secret` : `Rejected a ${provider} webhook: no webhook secret is set`,
        context: { courier: courier?.name ?? null },
      })
      throw new HttpError(401, 'Invalid webhook signature', 'UNAUTHORIZED')
    }

    const raw = await req.text()
    if (raw.length > 64 * 1024) throw new HttpError(413, 'Request is too large', 'PAYLOAD_TOO_LARGE')
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON', 'INVALID_JSON')
    }
    // Pathao's "test webhook" button: acknowledge only.
    if (provider === 'pathao' && String(body.event ?? '') === 'webhook_integration') {
      return reply(req, provider, { received: true })
    }

    const event: CourierEvent = provider === 'pathao' ? await normalizePathao(body, raw) : await normalizeSteadfast(body, raw)
    // A database error propagates (HTTP 500) so the courier sends the event again.
    const result = await rpc<{ status: string; event_id: string; error?: string }>(admin, 'record_courier_webhook', {
      p_courier_id: courier?.id ?? null, p_provider: provider, p_event: event,
    })
    if (result.status === 'failed' || result.status === 'unmatched') {
      void logEvent({
        level: 'WARN', category: 'WEBHOOK', source: 'courier-webhook',
        message: result.status === 'failed' ? `A ${provider} event could not be applied; it will be retried` : `A ${provider} event matched no parcel yet`,
        context: { event_id: result.event_id, consignment_id: event.consignment_id, order: event.order_ref, error: result.error ?? null },
      })
    }
    return reply(req, provider, { received: true, result: result.status })
  }),
)
