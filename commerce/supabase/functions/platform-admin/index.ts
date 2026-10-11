// Super Admin actions that need Supabase Auth's admin API (creating logins).
// Everything else in the panel calls database functions directly; those check
// platform permissions themselves. Here the caller's permission is checked
// first (as the signed-in employee), so no login is created for a request
// that would be refused.
//   invite_employee  {email, full_name, role_id, title?, merchant_scope?, merchant_ids?, password?}
//   create_merchant  {merchant: {...}, owner: {email, full_name, password?}}
//   set_owner        {merchant_id, email, full_name, password?}
// And the platform's own service accounts (credentials go to platform
// credentials in Vault; the panel only ever sees a masked hint):
//   bd_courier_connect / bd_courier_test / bd_courier_disconnect   (BD Courier Integration)
//   sms_connect / sms_disconnect / sms_balance / sms_send_test     (SMS Management)
//   gateway_connect / gateway_disconnect                           (payments merchants make to the platform)
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { env } from '../_shared/env.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { COURIER_HISTORY_SERVICES, CourierHistoryProvider } from '../_shared/fraud/courier-history.ts'
import { courierHistoryConfig, platformCourierHistorySecret, PLATFORM_BD_COURIER_SECRET } from '../_shared/fraud/service.ts'
import { billingCallbackBase, PLATFORM_GATEWAYS, platformGateway, platformGatewaySecret } from '../_shared/platform-billing.ts'
import { parse, phoneSchema } from '../_shared/schemas.ts'
import {
  cleanSmsCredentials, SMS_PROVIDER_CODES, smsCredentialHint, SmsError, smsProviderFromCredentials,
} from '../_shared/sms/providers.ts'
import { connectedSmsProvider, smsSecretKey } from '../_shared/sms/registry.ts'
import { adminClient, optionalUser, rpc, userClient } from '../_shared/supabase.ts'

const person = {
  email: z.email().max(160).transform((e) => e.toLowerCase()),
  full_name: z.string().trim().min(2).max(100),
  password: z.string().min(10).max(72).optional(),
}

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('invite_employee'),
    ...person,
    role_id: z.uuid(),
    title: z.string().trim().max(80).optional(),
    merchant_scope: z.enum(['ALL', 'ASSIGNED']).default('ALL'),
    merchant_ids: z.array(z.uuid()).max(500).default([]),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('create_merchant'),
    merchant: z.object({
      name: z.string().trim().min(2).max(120),
      slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).optional(),
      phone: z.string().trim().max(30).optional(),
      business_type: z.string().trim().max(60).optional(),
      website: z.string().trim().max(200).optional(),
      address: z.string().trim().max(300).optional(),
      notes: z.string().trim().max(2000).optional(),
      is_demo: z.boolean().default(false),
      account_manager_id: z.uuid().optional(),
      plan_code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,30}$/).optional(),
    }),
    owner: z.object(person),
  }),
  z.object({ action: z.literal('set_owner'), merchant_id: z.uuid(), ...person }),
  z.object({
    action: z.literal('bd_courier_connect'),
    service: z.enum(['bdcourier', 'llcg']).default('bdcourier'),
    api_key: z.string().trim().min(6, 'Enter the API key').max(200).regex(/^\S+$/, 'The API key has no spaces — copy it again'),
    base_url: z.union([z.url({ protocol: /^https$/, error: 'Use an https:// address' }), z.literal('')]).optional(),
    test_phone: phoneSchema,
  }),
  z.object({ action: z.literal('bd_courier_test'), test_phone: phoneSchema }),
  z.object({ action: z.literal('bd_courier_disconnect') }),
  z.object({
    action: z.literal('sms_connect'),
    provider: z.enum(SMS_PROVIDER_CODES),
    credentials: z.record(z.string().regex(/^[a-z_]+$/), z.string().trim().max(1000)),
    sender_id: z.string().trim().max(20).regex(/^[A-Za-z0-9 ._+-]*$/, 'Use letters, digits, spaces, dots or dashes').optional(),
  }),
  z.object({ action: z.literal('sms_disconnect') }),
  z.object({ action: z.literal('sms_balance') }),
  z.object({ action: z.literal('sms_send_test'), to: z.string().trim().min(10).max(20), message: z.string().trim().min(1).max(500) }),
  z.object({
    action: z.literal('gateway_connect'),
    provider: z.enum(PLATFORM_GATEWAYS),
    sandbox: z.boolean().default(true),
    credentials: z.object({
      app_key: z.string().trim().min(1).max(200).optional(),
      app_secret: z.string().trim().min(1).max(200).optional(),
      username: z.string().trim().min(1).max(200).optional(),
      password: z.string().trim().min(1).max(200).optional(),
      merchant_id: z.string().trim().min(1).max(80).optional(),
      token: z.string().trim().min(1).max(200).optional(),
      base_url: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).optional(),
    }),
  }),
  z.object({ action: z.literal('gateway_disconnect'), provider: z.enum(PLATFORM_GATEWAYS) }),
])

const GATEWAY_FIELDS: Record<(typeof PLATFORM_GATEWAYS)[number], string[]> = {
  bkash: ['app_key', 'app_secret', 'username', 'password'],
  paystation: ['merchant_id', 'password'],
}

/** Finds the login for this email, or creates it (invitation e-mail, or a password the employee hands over). */
async function ensureLogin(admin: SupabaseClient, who: { email: string; full_name: string; password?: string }, redirectTo: string) {
  const existing = await rpc<string | null>(admin, 'find_auth_user_id', { p_email: who.email })
  if (existing) return { id: existing, created: false }
  const result = who.password
    ? await admin.auth.admin.createUser({ email: who.email, password: who.password, email_confirm: true, user_metadata: { full_name: who.full_name } })
    : await admin.auth.admin.inviteUserByEmail(who.email, { data: { full_name: who.full_name }, redirectTo })
  if (result.error || !result.data.user) throw new HttpError(422, result.error?.message ?? 'Could not create the login', 'AUTH_ERROR')
  return { id: result.data.user.id, created: true }
}

const maskPhone = (to: string) => (to.length > 7 ? `${to.slice(0, -7)}••••${to.slice(-3)}` : to)

async function require(client: SupabaseClient, module: string, action: string) {
  if (!(await rpc<boolean>(client, 'platform_can', { p_module: module, p_action: action, p_merchant: null }))) {
    await client.rpc('platform_report_denied', { p_action: `${module}.${action}`, p_detail: {} })
    throw new HttpError(403, `${module} ${action} is not allowed for your role`, 'PERMISSION_DENIED')
  }
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const user = await optionalUser(req)
    if (!user) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
    rateLimit(`platform-admin:${user.id}:${clientIp(req)}`, 30)
    const input = parse(schema, await readJson(req))
    // Acts as the employee: the database checks their platform permissions.
    const client = userClient(req)
    const admin = adminClient()
    const panel = (env('PLATFORM_URL') ?? req.headers.get('origin') ?? env('STOREFRONT_URL') ?? '').replace(/\/+$/, '')
    const redirectTo = `${panel}/admin/reset-password`

    switch (input.action) {
      case 'invite_employee': {
        await require(client, 'employees', 'create')
        const login = await ensureLogin(admin, input, redirectTo)
        try {
          const saved = await rpc(client, 'platform_staff_save', {
            p: { user_id: login.id, full_name: input.full_name, role_id: input.role_id, title: input.title ?? null,
              merchant_scope: input.merchant_scope, merchant_ids: input.merchant_ids, reason: input.reason ?? null },
          })
          return json(req, { employee: saved, invited: login.created && !input.password }, 201)
        } catch (error) {
          // A login made only for this refused request is removed again.
          if (login.created) await admin.auth.admin.deleteUser(login.id)
          throw error
        }
      }
      case 'create_merchant': {
        await require(client, 'merchants', 'create')
        const created = await rpc<{ id: string }>(client, 'platform_merchant_create', { p: { ...input.merchant, owner_email: input.owner.email } })
        const login = await ensureLogin(admin, input.owner, redirectTo)
        try {
          await rpc(client, 'platform_merchant_set_owner', { p_merchant: created.id, p_user: login.id, p_full_name: input.owner.full_name })
        } catch (error) {
          if (login.created) await admin.auth.admin.deleteUser(login.id)
          // The merchant stays (in onboarding) so the owner can be added again from its page.
          throw error
        }
        return json(req, { merchant_id: created.id, owner_invited: login.created && !input.owner.password }, 201)
      }
      case 'set_owner': {
        await require(client, 'merchants', 'manage')
        const login = await ensureLogin(admin, input, redirectTo)
        try {
          await rpc(client, 'platform_merchant_set_owner', { p_merchant: input.merchant_id, p_user: login.id, p_full_name: input.full_name })
        } catch (error) {
          if (login.created) await admin.auth.admin.deleteUser(login.id)
          throw error
        }
        return json(req, { ok: true, owner_invited: login.created && !input.password })
      }

      // ------------------------------------------------- BD Courier (platform account)
      case 'bd_courier_connect': {
        await require(client, 'bd_courier', 'manage')
        const secret = { service: input.service, api_key: input.api_key, ...(input.base_url ? { base_url: input.base_url } : {}) }
        const config = courierHistoryConfig(secret, 15_000)!
        let result
        try {
          // A real lookup proves the key before it is saved. Not charged to any merchant.
          result = await new CourierHistoryProvider(config).lookup(input.test_phone)
        } catch (error) {
          throw new HttpError(422, `BD Courier refused the key: ${(error as Error).message}`, 'CONNECTION_FAILED')
        }
        const hint = `${COURIER_HISTORY_SERVICES[input.service].label} ••••${input.api_key.slice(-4)}`
        await rpc(admin, 'platform_secret_store', { p_key: PLATFORM_BD_COURIER_SECRET, p_value: secret, p_hint: hint, p_actor: user.id })
        const settings = await rpc(admin, 'platform_bd_courier_set_connection', { p_service: input.service, p_hint: hint, p_actor: user.id, p_test_ok: true, p_error: null })
        return json(req, { ok: true, hint, settings, result })
      }
      case 'bd_courier_test': {
        await require(client, 'bd_courier', 'edit')
        const config = courierHistoryConfig(await platformCourierHistorySecret(admin), 15_000)
        if (!config) throw new HttpError(422, 'Connect the BD Courier account first', 'NOT_CONNECTED')
        try {
          const result = await new CourierHistoryProvider(config).lookup(input.test_phone)
          await rpc(admin, 'platform_bd_courier_set_connection', { p_service: null, p_hint: null, p_actor: user.id, p_test_ok: true, p_error: null })
          await rpc(admin, 'platform_record_action', { p_actor: user.id, p_action: 'bd_courier.tested', p_entity_type: 'platform_credential', p_entity_id: 'bd_courier', p_result: 'SUCCESS', p_metadata: {} })
          return json(req, { ok: true, result })
        } catch (error) {
          const message = (error as Error).message
          await rpc(admin, 'platform_bd_courier_set_connection', { p_service: null, p_hint: null, p_actor: user.id, p_test_ok: false, p_error: message })
          await rpc(admin, 'platform_record_action', { p_actor: user.id, p_action: 'bd_courier.tested', p_entity_type: 'platform_credential', p_entity_id: 'bd_courier', p_result: 'FAILED', p_metadata: { error: message } })
          throw new HttpError(422, `The lookup failed: ${message}`, 'LOOKUP_FAILED')
        }
      }
      case 'bd_courier_disconnect': {
        await require(client, 'bd_courier', 'manage')
        await rpc(admin, 'platform_secret_clear', { p_key: PLATFORM_BD_COURIER_SECRET, p_actor: user.id })
        const settings = await rpc(admin, 'platform_bd_courier_set_connection', { p_service: null, p_hint: null, p_actor: user.id, p_test_ok: null, p_error: null })
        return json(req, { ok: true, settings })
      }

      // ------------------------------------------------- SMS (platform account)
      case 'sms_connect': {
        await require(client, 'sms', 'manage')
        const creds = cleanSmsCredentials(input.provider, input.credentials)
        let balance: number | null = null
        try {
          const provider = smsProviderFromCredentials(input.provider, creds)
          if (input.provider === 'bulksmsbd' && !input.sender_id) throw new SmsError('BulkSMSBD needs a sender ID', true)
          balance = await provider.balance()
        } catch (error) {
          throw new HttpError(422, `Could not connect: ${(error as Error).message}`, 'CONNECTION_FAILED')
        }
        const { data: before } = await admin.rpc('sms_dispatch_config')
        const previous = (before as { provider?: string | null } | null)?.provider
        const hint = smsCredentialHint(input.provider, creds)
        await rpc(admin, 'platform_secret_store', { p_key: smsSecretKey(input.provider), p_value: creds, p_hint: hint, p_actor: user.id })
        if (previous && previous !== input.provider && (SMS_PROVIDER_CODES as readonly string[]).includes(previous)) {
          await rpc(admin, 'platform_secret_clear', { p_key: smsSecretKey(previous as (typeof SMS_PROVIDER_CODES)[number]), p_actor: user.id })
        }
        const settings = await rpc(admin, 'platform_sms_set_connection', {
          p_provider: input.provider, p_hint: hint, p_sender_id: input.sender_id ?? '', p_balance: balance, p_actor: user.id,
        })
        return json(req, {
          ok: true, balance, settings,
          message: balance === null ? 'Saved. This provider has no balance check, so send a test message to make sure it works.' : `Connected. Balance: ${balance}`,
        })
      }
      case 'sms_disconnect': {
        await require(client, 'sms', 'manage')
        const { data: before } = await admin.rpc('sms_dispatch_config')
        const previous = (before as { provider?: string | null } | null)?.provider
        if (previous && (SMS_PROVIDER_CODES as readonly string[]).includes(previous)) {
          await rpc(admin, 'platform_secret_clear', { p_key: smsSecretKey(previous as (typeof SMS_PROVIDER_CODES)[number]), p_actor: user.id })
        }
        const settings = await rpc(admin, 'platform_sms_set_connection', { p_provider: null, p_hint: null, p_sender_id: null, p_balance: null, p_actor: user.id })
        return json(req, { ok: true, settings })
      }
      case 'sms_balance': {
        await require(client, 'sms', 'view')
        try {
          const { provider } = await connectedSmsProvider(admin)
          const balance = await provider.balance()
          if (balance !== null) await rpc(admin, 'platform_sms_set_balance', { p_balance: balance })
          return json(req, { balance, supported: balance !== null })
        } catch (error) {
          throw new HttpError(502, `Could not get the balance: ${(error as Error).message}`, 'GATEWAY_ERROR')
        }
      }
      case 'sms_send_test': {
        await require(client, 'sms', 'edit')
        const to = input.to.replace(/\D/g, '').replace(/^0(1[3-9]\d{8})$/, '880$1')
        if (!/^8801[3-9]\d{8}$/.test(to)) throw new HttpError(422, 'Enter a Bangladesh mobile number (01XXXXXXXXX)', 'VALIDATION')
        const { provider, senderId } = await connectedSmsProvider(admin).catch((error) => {
          throw new HttpError(422, (error as Error).message, 'NOT_CONNECTED')
        })
        try {
          const sent = await provider.send({ to, body: input.message, senderId, clientRef: crypto.randomUUID() })
          await rpc(admin, 'platform_record_action', { p_actor: user.id, p_action: 'sms.test_sent', p_entity_type: 'platform_credential', p_entity_id: 'sms', p_result: 'SUCCESS',
            p_metadata: { to: maskPhone(to), provider: provider.code, message_id: sent.messageId } })
          return json(req, { ok: true, message_id: sent.messageId, delivery: sent.delivery })
        } catch (error) {
          const message = (error as Error).message
          await rpc(admin, 'platform_record_action', { p_actor: user.id, p_action: 'sms.test_sent', p_entity_type: 'platform_credential', p_entity_id: 'sms', p_result: 'FAILED',
            p_metadata: { to: maskPhone(to), provider: provider.code, error: message } })
          throw new HttpError(422, message, 'SEND_FAILED')
        }
      }

      // ------------------------------------------------- gateways for payments to the platform
      case 'gateway_connect': {
        await require(client, 'subscriptions', 'manage')
        await require(client, 'settings', 'manage')
        const missing = GATEWAY_FIELDS[input.provider].filter((k) => !input.credentials[k as keyof typeof input.credentials])
        if (missing.length) throw new HttpError(422, `Fill in: ${missing.join(', ')}`, 'VALIDATION')
        const creds = Object.fromEntries(Object.entries(input.credentials).filter(([, v]) => v)) as Record<string, string>
        let message: string
        try {
          const provider = await platformGateway(input.provider, { credentials: creds, sandbox: input.sandbox })
          message = await provider.test!(`${billingCallbackBase()}?callback=cancelled&provider=${input.provider}`)
        } catch (error) {
          throw new HttpError(422, `Could not connect: ${(error as Error).message}`, 'CONNECTION_FAILED')
        }
        const id = creds.username ?? creds.merchant_id ?? ''
        const hint = `${input.provider === 'bkash' ? 'bKash' : 'PayStation'} ${id ? `${id.slice(0, 3)}••••${id.slice(-2)}` : ''}${input.sandbox ? ' (sandbox)' : ''}`.trim()
        await rpc(admin, 'platform_secret_store', { p_key: platformGatewaySecret(input.provider), p_value: creds, p_hint: hint, p_actor: user.id })
        const gateways = await rpc(admin, 'platform_billing_gateway_set', { p_provider: input.provider, p_connected: true, p_hint: hint, p_sandbox: input.sandbox, p_actor: user.id })
        return json(req, { ok: true, message, gateways })
      }
      case 'gateway_disconnect': {
        await require(client, 'subscriptions', 'manage')
        await require(client, 'settings', 'manage')
        await rpc(admin, 'platform_secret_clear', { p_key: platformGatewaySecret(input.provider), p_actor: user.id })
        const gateways = await rpc(admin, 'platform_billing_gateway_set', { p_provider: input.provider, p_connected: false, p_hint: null, p_sandbox: null, p_actor: user.id })
        return json(req, { ok: true, gateways })
      }
    }
  }),
)
