// Cloud PBX (VoiceDrive or any Asterisk-style PBX):
//   webhook  — the PBX posts call events to  …/functions/v1/pbx?token=…
//              (JSON, form or GET). Each call is stored once per call id;
//              repeats update it. The token is checked against Vault.
//   status   — what is set up (never the secret itself)            settings.view
//   save     — store the PBX API secret and/or a new webhook token  settings.manage
//   webhook_url — the address to paste into the PBX                 settings.manage
//   call     — click-to-call: the server fills the admin's URL
//              template with the agent's extension, the number and
//              the secret, and calls the PBX                       orders.view
import { z } from 'zod'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { buildClickRequest, mapPbxEvent, type PbxSettings, readPbxPayload, sameToken } from '../_shared/pbx.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, getSettings, requireStaff, rpc } from '../_shared/supabase.ts'
import { requireEnv } from '../_shared/env.ts'

const SECRET_KEY = 'pbx'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({
    action: z.literal('save'),
    api_secret: z.string().trim().max(500).regex(/^\S*$/, 'The secret has no spaces — copy it again').optional(),
    clear_api_secret: z.boolean().default(false),
    rotate_webhook: z.boolean().default(false),
  }),
  z.object({ action: z.literal('webhook_url') }),
  z.object({
    action: z.literal('call'),
    phone: z.string().trim().regex(/^\+?[0-9]{5,15}$/, 'Enter a valid phone number'),
    order_id: z.uuid().optional(),
  }),
])

const PERMISSION: Record<string, string> = { status: 'settings.view', save: 'settings.manage', webhook_url: 'settings.manage', call: 'orders.view' }

interface PbxSecret { api_secret?: string; webhook_token?: string }

async function readSecret(): Promise<PbxSecret> {
  const { data, error } = await adminClient().rpc('integration_secret_get', { p_key: SECRET_KEY })
  if (error) throw new HttpError(500, `Could not read the PBX settings: ${error.message}`, 'SECRET_READ_FAILED')
  return (data ?? {}) as PbxSecret
}

const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
const webhookUrl = (token: string) => `${requireEnv('SUPABASE_URL').replace(/\/$/, '')}/functions/v1/pbx?token=${token}`

async function handleWebhook(req: Request, token: string): Promise<Response> {
  rateLimit(`pbx:${clientIp(req)}`, 600)
  const secret = await readSecret()
  if (!secret.webhook_token || !(await sameToken(token, secret.webhook_token))) {
    throw new HttpError(401, 'Unknown webhook token', 'UNAUTHORIZED')
  }
  let payload: Record<string, unknown>
  try {
    payload = await readPbxPayload(req)
  } catch (error) {
    throw new HttpError(400, `Could not read the call event: ${(error as Error).message}`, 'INVALID_PAYLOAD')
  }
  const event = mapPbxEvent(payload)
  if (!event) {
    // Nothing to store (e.g. a "test" ping). Acknowledge so the PBX doesn't retry forever.
    return json(req, { ok: true, stored: false, reason: 'No call id in the event' })
  }
  const admin = adminClient()
  const { data, error } = await admin.rpc('pbx_record_call', { p: event })
  if (error) {
    void logEvent({ level: 'ERROR', category: 'WEBHOOK', source: 'pbx', message: `Could not store PBX call ${event.call_id}: ${error.message}`, context: { call_id: event.call_id } })
    // 500 so the PBX retries; storing is idempotent per call id.
    throw new HttpError(500, 'Could not store the call', 'STORE_FAILED')
  }
  return json(req, { ok: true, stored: true, id: (data as { id: string }).id })
}

Deno.serve(
  handle(async (req) => {
    const token = new URL(req.url).searchParams.get('token')
    if (token) return handleWebhook(req, token)

    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const input = parse(schema, await readJson<Record<string, unknown>>(req))
    const staff = await requireStaff(req, PERMISSION[input.action])
    const admin = adminClient()

    if (input.action === 'status') {
      const secret = await readSecret()
      return json(req, { has_api_secret: !!secret.api_secret, has_webhook: !!secret.webhook_token,
        api_secret_hint: secret.api_secret ? `••••${secret.api_secret.slice(-4)}` : null })
    }

    if (input.action === 'webhook_url') {
      const secret = await readSecret()
      return json(req, { url: secret.webhook_token ? webhookUrl(secret.webhook_token) : null })
    }

    if (input.action === 'save') {
      const current = await readSecret()
      const next: PbxSecret = { ...current }
      if (input.clear_api_secret) delete next.api_secret
      else if (input.api_secret) next.api_secret = input.api_secret
      if (input.rotate_webhook || !next.webhook_token) next.webhook_token = newToken()
      const hint = [next.api_secret ? `API ••••${next.api_secret.slice(-4)}` : null, 'webhook'].filter(Boolean).join(' + ')
      await rpc(admin, 'integration_secret_store', { p_key: SECRET_KEY, p_value: next, p_hint: hint, p_actor: staff.user.id })
      return json(req, { ok: true, has_api_secret: !!next.api_secret, url: webhookUrl(next.webhook_token!) })
    }

    // call
    const settings = await getSettings<PbxSettings>(admin, 'pbx')
    if (!settings.enabled) throw new HttpError(422, 'The PBX is switched off in Settings → VoiceDrive PBX', 'NOT_ENABLED')
    if (settings.click_mode !== 'api') throw new HttpError(422, 'Click-to-call through the PBX is not set up — calls use the phone link', 'NOT_CONFIGURED')
    const extension = settings.extensions?.find((e) => e.profile_id === staff.user.id)?.extension
    if (!extension) throw new HttpError(422, 'You have no PBX extension yet — ask an admin to add one in Settings → VoiceDrive PBX', 'NO_EXTENSION')
    const secret = await readSecret()
    let request: ReturnType<typeof buildClickRequest>
    try {
      request = buildClickRequest(settings, secret.api_secret ?? '', input.phone, extension)
    } catch (error) {
      throw new HttpError(422, (error as Error).message, 'NOT_CONFIGURED')
    }
    let res: Response
    try {
      res = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(10_000) })
    } catch (error) {
      throw new HttpError(502, `The PBX did not answer: ${(error as Error).message}`, 'PBX_UNREACHABLE')
    }
    const text = (await res.text()).slice(0, 300)
    if (!res.ok) {
      void logEvent({ level: 'WARN', category: 'OTHER', source: 'pbx', message: `Click-to-call failed (${res.status})`, context: { status: res.status, body: text } })
      throw new HttpError(502, `The PBX refused the call (HTTP ${res.status})`, 'PBX_REFUSED')
    }
    const callId = `click:${crypto.randomUUID()}`
    const { error } = await admin.rpc('pbx_record_call', { p: {
      call_id: callId, direction: 'OUTBOUND', from: extension, to: input.phone, extension, status: 'RINGING',
      started_at: new Date().toISOString(), raw: { via: 'click-to-call', order_id: input.order_id ?? null, by: staff.user.id, pbx_response: text },
    } })
    if (error) void logEvent({ level: 'WARN', category: 'OTHER', source: 'pbx', message: `Call placed but not logged: ${error.message}`, context: { call_id: callId } })
    return json(req, { ok: true, call_id: callId, extension })
  }),
)
