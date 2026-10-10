// VoiceDrive PBX (verify_jwt = false; each action checks its caller):
//
//   Signed-in staff (POST {action})
//     getMyWebRtcCredentials  pbx.call          fresh SIP password (digest stored, password returned once),
//                                               WSS address and STUN/TURN with time-limited credentials
//     bkashStart              pbx.manage        package or top-up: the amount is set by the database
//     saveTrunkSecret         pbx.super_admin   IPTSP trunk password → Vault (never returned)
//     saveTurnSecret          pbx.super_admin   coturn static-auth-secret → Vault
//     rotateGatewayToken      pbx.super_admin   new gateway token, shown once; only its SHA-256 is kept
//
//   bKash browser return (GET ?bkash=callback&ref=…&paymentID=…&status=…)
//     verified with bKash server-to-server, applied once, then back to the admin page.
//
//   Gateway (POST {action: 'gw_*'}, Authorization: Bearer <gateway token>)
//     gw_ping, gw_trunks, gw_outbound_start, gw_inbound_start, gw_answered, gw_ended
//
//   Cron (POST {action: 'reconcile'}, x-cron-secret) finishes bKash payments
//     whose browser never came back.
import { z } from 'zod'
import { isCronRequest } from '../_shared/cron.ts'
import { requireEnv } from '../_shared/env.ts'
import { formOrQuery } from '../_shared/payment-flow.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { loadPaymentProvider, type PaymentSettings } from '../_shared/payments/registry.ts'
import type { PaymentProvider, VerifiedPayment } from '../_shared/payments/types.ts'
import { parse } from '../_shared/schemas.ts'
import { storefrontBase } from '../_shared/storefront.ts'
import { adminClient, getSettings, requireStaff, rpc } from '../_shared/supabase.ts'
import { constantTimeEqual, iceServers, randomPassword, sha256Hex, type VoiceDriveSettings } from '../_shared/voicedrive.ts'

const GATEWAY_KEY = 'voicedrive.gateway'
const TURN_KEY = 'voicedrive.turn'
const trunkKey = (businessId: string) => `voicedrive.trunk.${businessId.replace(/-/g, '')}`

const uuid = z.uuid()
const staffSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('getMyWebRtcCredentials'), userAgent: z.string().max(300).optional() }),
  z.object({
    action: z.literal('bkashStart'),
    type: z.enum(['PACKAGE', 'TOPUP']),
    package_id: uuid.optional(),
    extra_agents: z.number().int().min(0).max(500).optional(),
    extra_channels: z.number().int().min(0).max(200).optional(),
    months: z.number().int().min(1).max(12).optional(),
    amount_tk: z.number().positive().max(1_000_000).optional(),
    business_id: uuid.optional(),
  }),
  z.object({ action: z.literal('saveTrunkSecret'), business_id: uuid, password: z.string().min(1).max(200).regex(/^\S+$/, 'The trunk password has no spaces') }),
  z.object({ action: z.literal('saveTurnSecret'), secret: z.string().min(16, 'Use at least 16 characters').max(200) }),
  z.object({ action: z.literal('rotateGatewayToken') }),
])

const gatewaySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('gw_ping'), version: z.string().max(80), detail: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ action: z.literal('gw_trunks') }),
  z.object({ action: z.literal('gw_outbound_start'), sipUsername: z.string().max(40), dialed: z.string().max(40), callId: uuid.nullable(), gatewayCallId: z.string().max(120) }),
  z.object({ action: z.literal('gw_inbound_start'), did: z.string().max(40), from: z.string().max(40), gatewayCallId: z.string().max(120), businessCode: z.number().int().nullable().optional() }),
  z.object({ action: z.literal('gw_answered'), callId: uuid, sipUsername: z.string().max(40).nullable().optional() }),
  z.object({
    action: z.literal('gw_ended'), callId: uuid, status: z.string().max(20), billsec: z.number().min(0).max(86400).default(0),
    hangupCause: z.string().max(60).nullable().optional(), answered: z.boolean().nullable().optional(),
  }),
])

const PERMISSION: Record<string, string> = {
  getMyWebRtcCredentials: 'pbx.call',
  bkashStart: 'pbx.manage',
  saveTrunkSecret: 'pbx.super_admin',
  saveTurnSecret: 'pbx.super_admin',
  rotateGatewayToken: 'pbx.super_admin',
}

async function secret<T>(key: string): Promise<T | null> {
  const { data, error } = await adminClient().rpc('integration_secret_get', { p_key: key })
  if (error) throw new HttpError(500, `Could not read a stored secret: ${error.message}`, 'SECRET_READ_FAILED')
  return (data ?? null) as T | null
}

async function storeSecret(key: string, value: Record<string, unknown>, hint: string, actor: string) {
  await rpc(adminClient(), 'integration_secret_store', { p_key: key, p_value: value, p_hint: hint, p_actor: actor })
}

const functionsBase = () => `${requireEnv('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1`

async function bkash(): Promise<PaymentProvider> {
  const admin = adminClient()
  const settings = await getSettings<PaymentSettings>(admin, 'payments')
  try {
    return await loadPaymentProvider(admin, 'bkash', settings, { allowDisabled: true })
  } catch (error) {
    throw new HttpError(422, `bKash is not connected (Settings → Payments): ${(error as Error).message}`, 'NOT_CONFIGURED')
  }
}

async function complete(verified: VerifiedPayment, reference: string) {
  return rpc<{ status: string; type?: string }>(adminClient(), 'pbx_bkash_complete', {
    p_reference: reference,
    p_success: verified.success,
    p_trx_id: verified.providerTransactionId,
    p_amount: verified.amount,
    p_reason: verified.reason ?? null,
    p_raw: verified.raw ?? null,
  })
}

/** The browser comes back from bKash: confirm with bKash, apply, return to the admin page. */
async function bkashReturn(req: Request): Promise<Response> {
  const params = await formOrQuery(req)
  const reference = params.ref ?? ''
  let outcome = 'failed'
  let type = ''
  try {
    if (!/^VD[0-9A-Z]{6,20}$/.test(reference)) throw new Error('Unknown payment reference')
    const found = params.paymentID ? await rpc<{ reference: string } | null>(adminClient(), 'pbx_bkash_find', { p_payment_id: params.paymentID }) : null
    if (!found || found.reference !== reference) throw new Error('This bKash payment does not belong to this recharge')
    const verified = await (await bkash()).verifyCallback!({ ...params, reference })
    const result = await complete(verified, reference)
    type = result.type ?? ''
    outcome = ['completed', 'already_completed'].includes(result.status) ? 'success' : result.status === 'amount_mismatch' ? 'review' : 'failed'
    if (!verified.success && /cancel/i.test(verified.reason ?? '')) outcome = 'cancelled'
  } catch (error) {
    // Not confirmed yet: the reconcile job checks bKash again.
    outcome = 'review'
    void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'voicedrive', message: 'Could not confirm a VoiceDrive bKash payment', error, context: { reference } })
  }
  const target = `${await storefrontBase(adminClient())}/admin/settings/voicedrive-pbx?${new URLSearchParams({ tab: 'package', payment: outcome, type })}`
  return new Response(null, { status: 303, headers: { Location: target, 'Cache-Control': 'no-store' } })
}

async function gateway(req: Request, body: Record<string, unknown>): Promise<Response> {
  const header = req.headers.get('authorization') ?? ''
  const token = /^Bearer\s+(\S{32,})$/i.exec(header)?.[1]
  const stored = await secret<{ token_sha256?: string }>(GATEWAY_KEY)
  if (!token || !stored?.token_sha256 || !constantTimeEqual(await sha256Hex(token), stored.token_sha256)) {
    rateLimit(`vd-gw-bad:${clientIp(req)}`, 20)
    throw new HttpError(401, 'Unknown gateway token', 'UNAUTHORIZED')
  }
  const input = parse(gatewaySchema, body)
  const admin = adminClient()
  switch (input.action) {
    case 'gw_ping':
      return json(req, await rpc(admin, 'pbx_gw_ping', { p_version: input.version, p_detail: input.detail }))
    case 'gw_trunks': {
      const trunks = await rpc<Array<Record<string, unknown> & { businessId: string }>>(admin, 'pbx_gw_trunks')
      const out = []
      for (const t of trunks ?? []) {
        const s = await secret<{ password?: string }>(trunkKey(t.businessId))
        if (s?.password) out.push({ ...t, password: s.password })
      }
      return json(req, { trunks: out })
    }
    case 'gw_outbound_start':
      return json(req, await rpc(admin, 'pbx_gw_outbound_start', {
        p_sip_username: input.sipUsername, p_dialed: input.dialed, p_call_id: input.callId, p_gateway_call_id: input.gatewayCallId }))
    case 'gw_inbound_start':
      return json(req, await rpc(admin, 'pbx_gw_inbound_start', {
        p_did: input.did, p_from: input.from, p_gateway_call_id: input.gatewayCallId, p_business_code: input.businessCode ?? null }))
    case 'gw_answered':
      return json(req, await rpc(admin, 'pbx_gw_call_answered', { p_call_id: input.callId, p_sip_username: input.sipUsername ?? null }))
    case 'gw_ended':
      return json(req, await rpc(admin, 'pbx_gw_call_ended', {
        p_call_id: input.callId, p_status: input.status, p_billsec: input.billsec, p_hangup_cause: input.hangupCause ?? null, p_answered: input.answered ?? null }))
  }
}

async function reconcile(req: Request): Promise<Response> {
  const admin = adminClient()
  if (!(await isCronRequest(req, admin))) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED')
  const pending = await rpc<Array<{ reference: string; paymentId: string; ageMinutes: number }>>(admin, 'pbx_bkash_pending', { p_limit: 20 })
  if (!pending?.length) return json(req, { checked: 0 })
  const provider = await bkash()
  const counts: Record<string, number> = {}
  for (const p of pending) {
    try {
      const verified = await provider.reconcile!(p.paymentId, p.reference, p.ageMinutes)
      if (!verified) { counts.waiting = (counts.waiting ?? 0) + 1; continue }
      const r = await complete(verified, p.reference)
      counts[r.status] = (counts[r.status] ?? 0) + 1
    } catch (error) {
      counts.error = (counts.error ?? 0) + 1
      void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'voicedrive', message: 'Could not reconcile a VoiceDrive bKash payment', error, context: { reference: p.reference } })
    }
  }
  return json(req, { checked: pending.length, ...counts })
}

Deno.serve(
  handle(async (req) => {
    const url = new URL(req.url)
    if (url.searchParams.get('bkash') === 'callback') return bkashReturn(req)
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')

    const body = await readJson<Record<string, unknown>>(req)
    const action = String(body.action ?? '')
    if (action.startsWith('gw_')) return gateway(req, body)
    if (action === 'reconcile') return reconcile(req)

    const input = parse(staffSchema, body)
    const staff = await requireStaff(req, PERMISSION[input.action])
    const admin = adminClient()

    if (input.action === 'getMyWebRtcCredentials') {
      rateLimit(`vd-cred:${staff.user.id}`, 12)
      const password = randomPassword()
      // Runs as the user: the database checks the agent, seat, line and maintenance.
      const issued = await rpc<{ sipUsername: string; sipUri: string; sipDomain: string; extension: string; expiresAt: string; ttlSeconds: number; agentId: string; businessId: string }>(
        staff.client, 'pbx_issue_my_credential', { p_password: password, p_user_agent: input.userAgent ?? req.headers.get('user-agent') })
      const settings = await getSettings<VoiceDriveSettings>(admin, 'voicedrive')
      if (!settings.wss_url) throw new HttpError(422, 'The gateway WebSocket address is not set (Super Admin → Gateway)', 'NOT_CONFIGURED')
      const turn = await secret<{ secret?: string }>(TURN_KEY)
      return json(req, {
        sipUri: issued.sipUri,
        aor: issued.sipUri,
        authorizationUsername: issued.sipUsername,
        password,
        wssUrl: settings.wss_url,
        iceServers: await iceServers(settings, turn?.secret ?? null, issued.agentId),
        extension: issued.extension,
        displayName: (staff.user.user_metadata?.full_name as string | undefined) ?? issued.extension,
        expiresAt: issued.expiresAt,
        ttlSeconds: issued.ttlSeconds,
      }, 200, { 'Cache-Control': 'no-store' })
    }

    if (input.action === 'bkashStart') {
      rateLimit(`vd-bkash:${staff.user.id}`, 6)
      const { action: _a, ...p } = input
      const tx = await rpc<{ id: string; reference: string; amountTk: number; type: string; businessPhone: string | null }>(staff.client, 'pbx_bkash_start', { p })
      const provider = await bkash()
      const back = `${functionsBase()}/voicedrive?bkash=callback&ref=${tx.reference}`
      let started
      try {
        started = await provider.initiate({
          payment: { id: tx.id, reference: tx.reference, amount: Number(tx.amountTk), currency: 'BDT', purpose: `PBX_${tx.type}` },
          order: { order_number: tx.reference, customer_name: 'VoiceDrive PBX', customer_phone: tx.businessPhone ?? tx.reference,
            customer_email: null, shipping_address: '', shipping_district: '' },
          urls: { success: back, fail: back, cancel: back, ipn: back },
        })
      } catch (error) {
        void logEvent({ level: 'ERROR', category: 'PAYMENT', source: 'voicedrive', message: 'bKash could not start a VoiceDrive payment', error, context: { reference: tx.reference } })
        throw new HttpError(502, 'bKash could not open the payment page. Please try again.', 'GATEWAY_ERROR')
      }
      if (started.session) await rpc(admin, 'pbx_bkash_attach', { p_id: tx.id, p_payment_id: started.session })
      return json(req, { reference: tx.reference, amountTk: Number(tx.amountTk), redirectUrl: started.redirectUrl })
    }

    if (input.action === 'saveTrunkSecret') {
      await storeSecret(trunkKey(input.business_id), { password: input.password }, `••••${input.password.slice(-2)}`, staff.user.id)
      await rpc(admin, 'pbx_admin_mark_trunk_secret', { p_business_id: input.business_id, p_set: true })
      return json(req, { ok: true })
    }

    if (input.action === 'saveTurnSecret') {
      await storeSecret(TURN_KEY, { secret: input.secret }, `••••${input.secret.slice(-3)}`, staff.user.id)
      return json(req, { ok: true })
    }

    // rotateGatewayToken
    const token = randomPassword(32)
    await storeSecret(GATEWAY_KEY, { token_sha256: await sha256Hex(token) }, `vdgw_••••${token.slice(-4)}`, staff.user.id)
    return json(req, { token }, 200, { 'Cache-Control': 'no-store' })
  }),
)
