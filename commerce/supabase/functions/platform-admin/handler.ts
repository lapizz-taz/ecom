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
//   meta_app_status / meta_app_save / meta_app_clear               (the Meta app stores use for "Continue with Facebook" in Messaging)
//   pbx_trunk_secret / pbx_turn_secret / pbx_gateway_token          (PBX Setup: the shared VoiceDrive gateway)
//   health                                                          (System Health: this runtime, its database and auth access, settings present)
//   backups                                                         (Data Management: the project's backups from the Supabase Management API)
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { env, runtimeVersion } from '../_shared/env.ts'
import { clerkEnabled, ensureClerkAccount } from '../_shared/clerk.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { COURIER_HISTORY_SERVICES, CourierHistoryProvider } from '../_shared/fraud/courier-history.ts'
import {
  COURIER_PANEL_LABELS, COURIER_PANEL_LOGIN_FIELD, COURIER_PANEL_PROVIDERS, type CourierPanelCreds,
  type CourierPanelProviderId, type PanelLogin, panelAccounts, testPanelLogin,
} from '../_shared/fraud/courier-panel.ts'
import {
  courierHistoryConfig, platformCourierHistorySecret, platformPanelCreds,
  PLATFORM_BD_COURIER_SECRET, PLATFORM_COURIER_PANEL_SECRET,
} from '../_shared/fraud/service.ts'
import { META_INBOX_APP_KEY, type MetaInboxApp } from '../_shared/inbox/oauth.ts'
import { billingCallbackBase, PLATFORM_GATEWAYS, platformGateway, platformGatewaySecret } from '../_shared/platform-billing.ts'
import { parse, phoneSchema } from '../_shared/schemas.ts'
import { appBase } from '../_shared/storefront.ts'
import {
  cleanSmsCredentials, SMS_PROVIDER_CODES, smsCredentialHint, SmsError, smsProviderFromCredentials,
} from '../_shared/sms/providers.ts'
import { connectedSmsProvider, smsSecretKey } from '../_shared/sms/registry.ts'
import { adminClient, optionalUser, rpc, userClient } from '../_shared/supabase.ts'
import { randomPassword, sha256Hex } from '../_shared/voicedrive.ts'

const person = {
  email: z.email().max(160).transform((e) => e.toLowerCase()),
  full_name: z.string().trim().min(2).max(100),
  password: z.string().min(10).max(72).optional(),
}

/** The identifier to show masked next to a connected panel, e.g. ra•••@shop.com or 017•••78. */
function panelHint(provider: CourierPanelProviderId, login: PanelLogin): string {
  const field = COURIER_PANEL_LOGIN_FIELD[provider]
  const value = String((field === 'email' ? login.email : field === 'phone' ? login.phone : login.user) ?? '')
  if (field === 'email') {
    const [u, domain] = value.split('@')
    return domain ? `${u.slice(0, 2)}•••@${domain}` : `${value.slice(0, 2)}•••`
  }
  return value.length > 5 ? `${value.slice(0, 3)}•••${value.slice(-2)}` : '•••'
}

const MAX_PANEL_ACCOUNTS = 10

/** The saved logins for every courier, as lists with an id each (older single logins get one). */
async function panelLogins(admin: SupabaseClient): Promise<Record<CourierPanelProviderId, PanelLogin[]>> {
  const creds = (await platformPanelCreds(admin) as CourierPanelCreds | null) ?? {}
  return Object.fromEntries(COURIER_PANEL_PROVIDERS.map((p) => [p, panelAccounts(creds, p).map((l, i) => ({ ...l, id: l.id ?? `acct${i + 1}` }))])) as Record<CourierPanelProviderId, PanelLogin[]>
}

/** Per-courier accounts with masked hints and last-test status for the Super Admin screen (no secrets). */
async function courierPanelStatus(admin: SupabaseClient) {
  const logins = await panelLogins(admin)
  const { data } = await admin.from('platform_settings').select('value').eq('key', 'courier_panel').maybeSingle()
  const status = ((data?.value as { providers?: Record<string, { accounts?: Record<string, Record<string, unknown>> }> } | null)?.providers) ?? {}
  return COURIER_PANEL_PROVIDERS.map((p) => ({
    provider: p,
    label: COURIER_PANEL_LABELS[p],
    login_field: COURIER_PANEL_LOGIN_FIELD[p],
    accounts: logins[p].map((l) => {
      const s = status[p]?.accounts?.[l.id!] ?? {}
      return {
        id: l.id!,
        hint: (s.hint as string | undefined) ?? panelHint(p, l),
        connected_at: (s.connected_at as string | undefined) ?? null,
        last_test_at: (s.last_test_at as string | undefined) ?? null,
        last_test_ok: (s.last_test_ok as boolean | undefined) ?? null,
        last_error: (s.last_error as string | undefined) ?? null,
      }
    }),
  }))
}

/** Saves the courier logins back to Vault (or clears the secret when none are left). */
async function storePanelLogins(admin: SupabaseClient, logins: Record<CourierPanelProviderId, PanelLogin[]>, actor: string) {
  const value = Object.fromEntries(Object.entries(logins).filter(([, list]) => list.length))
  const count = Object.values(value).reduce((n, list) => n + list.length, 0)
  if (count) {
    await rpc(admin, 'platform_secret_store', { p_key: PLATFORM_COURIER_PANEL_SECRET, p_value: value, p_hint: `${count} courier sign-in account${count === 1 ? '' : 's'}`, p_actor: actor })
  } else {
    await rpc(admin, 'platform_secret_clear', { p_key: PLATFORM_COURIER_PANEL_SECRET, p_actor: actor })
  }
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
  z.object({ action: z.literal('meta_app_status') }),
  z.object({
    action: z.literal('meta_app_save'),
    app_id: z.string().trim().regex(/^[0-9]{5,30}$/, 'The App ID is the number at the top of the Meta app dashboard'),
    app_secret: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, 'The App Secret is the 32-character code in App settings → Basic').optional(),
    login_config_id: z.string().trim().regex(/^[0-9]{5,30}$/, 'Use the Configuration ID from Facebook Login for Business'),
    whatsapp_config_id: z.union([z.string().trim().regex(/^[0-9]{5,30}$/, 'Use the Embedded Signup Configuration ID'), z.literal('')]).optional(),
    new_verify_token: z.boolean().optional(),
  }),
  z.object({ action: z.literal('meta_app_clear') }),
  z.object({
    action: z.literal('courier_panel_connect'),
    provider: z.enum(COURIER_PANEL_PROVIDERS),
    // Given: replace that account's login. Missing: add a new account.
    account_id: z.string().regex(/^[a-z0-9]{4,32}$/).optional(),
    login: z.object({
      email: z.string().trim().max(160).optional(),
      phone: z.string().trim().max(20).optional(),
      user: z.string().trim().max(160).optional(),
      password: z.string().min(1).max(200),
    }),
    test_phone: phoneSchema,
  }),
  z.object({ action: z.literal('courier_panel_test'), provider: z.enum(COURIER_PANEL_PROVIDERS), account_id: z.string().regex(/^[a-z0-9]{4,32}$/), test_phone: phoneSchema }),
  z.object({ action: z.literal('courier_panel_disconnect'), provider: z.enum(COURIER_PANEL_PROVIDERS), account_id: z.string().regex(/^[a-z0-9]{4,32}$/) }),
  z.object({ action: z.literal('courier_panel_status') }),
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
  z.object({
    action: z.literal('pbx_trunk_secret'),
    merchant_id: z.uuid(),
    // Empty clears the saved password.
    password: z.string().max(200).regex(/^\S*$/, 'The trunk password has no spaces'),
  }),
  z.object({ action: z.literal('pbx_turn_secret'), secret: z.string().min(16, 'Use at least 16 characters').max(200) }),
  z.object({ action: z.literal('pbx_gateway_token') }),
  z.object({ action: z.literal('health') }),
  z.object({ action: z.literal('backups') }),
])

// VoiceDrive gateway secrets are the platform's: one gateway serves every merchant.
const PBX_GATEWAY_KEY = 'voicedrive.gateway'
const PBX_TURN_KEY = 'voicedrive.turn'
const pbxTrunkKey = (businessId: string) => `voicedrive.trunk.${businessId.replace(/-/g, '')}`

const GATEWAY_FIELDS: Record<(typeof PLATFORM_GATEWAYS)[number], string[]> = {
  bkash: ['app_key', 'app_secret', 'username', 'password'],
  paystation: ['merchant_id', 'password'],
}

/** Finds the login for this email, or creates it (invitation e-mail, or a password the employee hands over). */
async function ensureLogin(admin: SupabaseClient, who: { email: string; full_name: string; password?: string }, redirectTo: string) {
  const clerk = await clerkEnabled()
  const existing = await rpc<string | null>(admin, 'find_auth_user_id', { p_email: who.email })
  let id = existing
  if (!id) {
    // With Clerk, Clerk does the e-mailing: no Supabase invite.
    const result = who.password || clerk
      ? await admin.auth.admin.createUser({ email: who.email, password: who.password, email_confirm: true, user_metadata: { full_name: who.full_name } })
      : await admin.auth.admin.inviteUserByEmail(who.email, { data: { full_name: who.full_name }, redirectTo })
    if (result.error || !result.data.user) throw new HttpError(422, result.error?.message ?? 'Could not create the login', 'AUTH_ERROR')
    id = result.data.user.id
  }
  await ensureClerkAccount(admin, { userId: id, email: who.email, password: who.password, fullName: who.full_name })
  // invited: Supabase e-mailed an invitation (without Clerk, and no password given).
  return { id, created: !existing, invited: !existing && !clerk && !who.password }
}

/** Runs one check and times it; a failure is reported, never thrown. */
async function timed(name: string, fn: () => Promise<string>) {
  const started = performance.now()
  try {
    const detail = await fn()
    return { name, ok: true, ms: Math.round(performance.now() - started), detail }
  } catch (error) {
    return { name, ok: false, ms: Math.round(performance.now() - started), detail: error instanceof Error ? error.message : String(error) }
  }
}

// Settings the edge functions read; only whether each is set is reported, never its value.
// CRON_SECRET is optional: scheduled calls are also accepted with the service key or the
// database's own 'cron_secret' (Vault), which is what the database scheduler sends (_shared/cron.ts).
const REQUIRED_SETTINGS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const
const OPTIONAL_SETTINGS = ['PLATFORM_URL', 'CRON_SECRET', 'STOREFRONT_URL', 'SENTRY_DSN'] as const

const maskPhone = (to: string) => (to.length > 7 ? `${to.slice(0, -7)}••••${to.slice(-3)}` : to)

async function require(client: SupabaseClient, module: string, action: string, merchant: string | null = null) {
  if (!(await rpc<boolean>(client, 'platform_can', { p_module: module, p_action: action, p_merchant: merchant }))) {
    await client.rpc('platform_report_denied', { p_action: `${module}.${action}`, p_detail: {} })
    throw new HttpError(403, `${module} ${action} is not allowed for your role`, 'PERMISSION_DENIED')
  }
}

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const user = await optionalUser(req)
    if (!user) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
    rateLimit(`platform-admin:${user.id}:${clientIp(req)}`, 30)
    const input = parse(schema, await readJson(req))
    // Acts as the employee: the database checks their platform permissions.
    const client = userClient(req)
    const admin = adminClient()
    // Invite/reset links carry one-time tokens, so the base must come from
    // APP_URL/PLATFORM_URL (or an allow-listed Origin), never the raw request
    // Origin — a forged Origin could otherwise capture an employee's tokens.
    const redirectTo = `${appBase(req)}/admin/reset-password`

    switch (input.action) {
      case 'invite_employee': {
        await require(client, 'employees', 'create')
        const login = await ensureLogin(admin, input, redirectTo)
        try {
          const saved = await rpc(client, 'platform_staff_save', {
            p: { user_id: login.id, full_name: input.full_name, role_id: input.role_id, title: input.title ?? null,
              merchant_scope: input.merchant_scope, merchant_ids: input.merchant_ids, reason: input.reason ?? null },
          })
          return json(req, { employee: saved, invited: login.invited }, 201)
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
        return json(req, { merchant_id: created.id, owner_invited: login.invited }, 201)
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
        return json(req, { ok: true, owner_invited: login.invited })
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

      // ------------------------------------- Meta app for Messaging (one app, every store)
      case 'meta_app_status': {
        await require(client, 'integrations', 'view')
        const app = await rpc<MetaInboxApp | null>(admin, 'platform_secret_get', { p_key: META_INBOX_APP_KEY }) ?? {}
        const canManage = await rpc<boolean>(client, 'platform_can', { p_module: 'integrations', p_action: 'manage', p_merchant: null })
        const base = appBase(req)
        return json(req, {
          app_id: app.app_id ?? null, login_config_id: app.login_config_id ?? null, whatsapp_config_id: app.whatsapp_config_id ?? null,
          has_secret: !!app.app_secret, verify_token: canManage ? app.verify_token ?? null : null,
          webhook_url: `${base}/functions/v1/inbox`, redirect_uri: `${base}/admin/inbox/meta-callback`, can_manage: canManage,
        })
      }
      case 'meta_app_save': {
        await require(client, 'integrations', 'manage')
        const prev = await rpc<MetaInboxApp | null>(admin, 'platform_secret_get', { p_key: META_INBOX_APP_KEY }) ?? {}
        const next: MetaInboxApp = {
          app_id: input.app_id, app_secret: input.app_secret ?? (prev.app_id === input.app_id ? prev.app_secret : undefined),
          login_config_id: input.login_config_id, whatsapp_config_id: input.whatsapp_config_id || undefined,
          verify_token: input.new_verify_token || !prev.verify_token ? randomPassword(32).replace(/[^A-Za-z0-9]/g, '') : prev.verify_token,
        }
        if (!next.app_secret) throw new HttpError(422, 'Paste the App Secret', 'VALIDATION')
        // The App ID and Secret must belong together: ask Meta for the app with its own app token.
        const check = await fetch(`https://graph.facebook.com/v23.0/${next.app_id}?fields=id,name`, {
          headers: { Authorization: `Bearer ${next.app_id}|${next.app_secret}` }, signal: AbortSignal.timeout(15_000),
        })
          .then((r) => r.json() as Promise<{ id?: string; name?: string; error?: { message?: string } }>)
          .catch((e): { id?: string; name?: string; error?: { message?: string } } => ({ error: { message: (e as Error).message } }))
        if (!check.id) throw new HttpError(422, `Meta did not accept this App ID and App Secret: ${check.error?.message ?? 'unknown error'}`, 'CONNECTION_FAILED')
        await rpc(admin, 'platform_secret_store', { p_key: META_INBOX_APP_KEY, p_value: next, p_hint: `${check.name ?? 'Meta app'} · ${next.app_id}`, p_actor: user.id })
        return json(req, { ok: true, name: check.name ?? null, verify_token: next.verify_token })
      }
      case 'meta_app_clear': {
        await require(client, 'integrations', 'manage')
        await rpc(admin, 'platform_secret_clear', { p_key: META_INBOX_APP_KEY, p_actor: user.id })
        return json(req, { ok: true })
      }

      // ------------------------------------- Courier sign-in accounts (platform, under BD Courier)
      case 'courier_panel_status': {
        await require(client, 'bd_courier', 'view')
        return json(req, { providers: await courierPanelStatus(admin) })
      }
      case 'courier_panel_connect': {
        await require(client, 'bd_courier', 'manage')
        const logins = await panelLogins(admin)
        const list = logins[input.provider]
        const index = input.account_id ? list.findIndex((l) => l.id === input.account_id) : -1
        if (input.account_id && index < 0) throw new HttpError(404, 'That account was removed — add it again', 'NOT_FOUND')
        if (!input.account_id && list.length >= MAX_PANEL_ACCOUNTS) {
          throw new HttpError(422, `Up to ${MAX_PANEL_ACCOUNTS} ${COURIER_PANEL_LABELS[input.provider]} accounts`, 'LIMIT_REACHED')
        }
        const login: PanelLogin = { ...(input.login as PanelLogin), id: input.account_id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12) }
        // Sign in (and read the fraud page) to prove the login before saving it.
        const tested = await testPanelLogin(input.provider, login, input.test_phone)
        if (!tested.ok) throw new HttpError(422, tested.message, 'CONNECTION_FAILED')
        if (index >= 0) list[index] = login
        else list.push(login)
        await storePanelLogins(admin, logins, user.id)
        await rpc(admin, 'platform_courier_panel_set', {
          p_provider: input.provider, p_account: login.id, p_hint: panelHint(input.provider, login), p_actor: user.id, p_connected: true, p_test_ok: true, p_error: null,
        })
        return json(req, { ok: true, message: tested.message, providers: await courierPanelStatus(admin) })
      }
      case 'courier_panel_test': {
        await require(client, 'bd_courier', 'edit')
        const login = (await panelLogins(admin))[input.provider].find((l) => l.id === input.account_id)
        if (!login) throw new HttpError(404, 'That account is not connected', 'NOT_CONNECTED')
        const tested = await testPanelLogin(input.provider, login, input.test_phone)
        await rpc(admin, 'platform_courier_panel_set', {
          p_provider: input.provider, p_account: input.account_id, p_hint: null, p_actor: user.id, p_connected: null, p_test_ok: tested.ok, p_error: tested.ok ? null : tested.message,
        })
        if (!tested.ok) throw new HttpError(422, tested.message, 'LOOKUP_FAILED')
        return json(req, { ok: true, message: tested.message, providers: await courierPanelStatus(admin) })
      }
      case 'courier_panel_disconnect': {
        await require(client, 'bd_courier', 'manage')
        const logins = await panelLogins(admin)
        logins[input.provider] = logins[input.provider].filter((l) => l.id !== input.account_id)
        await storePanelLogins(admin, logins, user.id)
        await rpc(admin, 'platform_courier_panel_set', {
          p_provider: input.provider, p_account: input.account_id, p_hint: null, p_actor: user.id, p_connected: false, p_test_ok: null, p_error: null,
        })
        return json(req, { ok: true, providers: await courierPanelStatus(admin) })
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

      // ------------------------------------------------- PBX Setup (VoiceDrive gateway)
      case 'pbx_trunk_secret': {
        await require(client, 'pbx', 'manage', input.merchant_id)
        const detail = await rpc<{ business: { id: string } | null }>(client, 'platform_pbx_merchant', { p_merchant: input.merchant_id })
        if (!detail.business) throw new HttpError(422, 'Set up the merchant\'s PBX line first', 'NOT_CONFIGURED')
        const key = pbxTrunkKey(detail.business.id)
        let hint: string | null = null
        if (input.password) {
          hint = `••${input.password.slice(-2)}`
          await rpc(admin, 'platform_secret_store', { p_key: key, p_value: { password: input.password }, p_hint: hint, p_actor: user.id })
        } else {
          await rpc(admin, 'platform_secret_clear', { p_key: key, p_actor: user.id })
        }
        // As the employee: the database checks their access again, marks the line and records it.
        const business = await rpc(client, 'platform_pbx_trunk_secret_saved', { p_merchant: input.merchant_id, p_set: Boolean(input.password), p_hint: hint })
        return json(req, { ok: true, business })
      }
      case 'pbx_turn_secret': {
        await require(client, 'pbx', 'manage')
        const hint = `••••${input.secret.slice(-3)}`
        await rpc(admin, 'platform_secret_store', { p_key: PBX_TURN_KEY, p_value: { secret: input.secret }, p_hint: hint, p_actor: user.id })
        await rpc(admin, 'platform_record_action', { p_actor: user.id, p_action: 'pbx.turn_secret_saved', p_entity_type: 'platform_credential', p_entity_id: PBX_TURN_KEY, p_result: 'SUCCESS', p_metadata: { hint } })
        return json(req, { ok: true, hint })
      }
      case 'pbx_gateway_token': {
        await require(client, 'pbx', 'manage')
        // Shown once; only its SHA-256 is kept. The running gateway keeps working until it is given the new token.
        const token = randomPassword(32)
        const hint = `vdgw_••••${token.slice(-4)}`
        await rpc(admin, 'platform_secret_store', { p_key: PBX_GATEWAY_KEY, p_value: { token_sha256: await sha256Hex(token) }, p_hint: hint, p_actor: user.id })
        await rpc(admin, 'platform_record_action', { p_actor: user.id, p_action: 'pbx.gateway_token_rotated', p_entity_type: 'platform_credential', p_entity_id: PBX_GATEWAY_KEY, p_result: 'SUCCESS', p_metadata: { hint } })
        return json(req, { token, hint }, 200, { 'Cache-Control': 'no-store' })
      }
      case 'backups': {
        await require(client, 'data', 'view')
        // Backups are made by Supabase; with a Management API token the panel can read their status.
        // (Edge function secrets cannot start with SUPABASE_, hence these names.)
        const token = env('MANAGEMENT_API_TOKEN')
        const ref = env('PROJECT_REF') ?? new URL(env('SUPABASE_URL') ?? 'http://localhost').hostname.split('.')[0]
        if (!token) return json(req, { configured: false, ref })
        const base = (env('MANAGEMENT_API_URL') ?? 'https://api.supabase.com').replace(/\/+$/, '')
        let res: Response
        try {
          res = await fetch(`${base}/v1/projects/${encodeURIComponent(ref)}/database/backups`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
          })
        } catch (error) {
          return json(req, { configured: true, ref, ok: false, error: error instanceof Error ? error.message : 'Could not reach the Management API' })
        }
        if (!res.ok) return json(req, { configured: true, ref, ok: false, status: res.status, error: (await res.text()).slice(0, 300) })
        const body = await res.json() as { region?: string; pitr_enabled?: boolean; walg_enabled?: boolean
          backups?: Array<{ status?: string; inserted_at?: string; is_physical_backup?: boolean }> }
        const backups = (body.backups ?? []).map((b) => ({ status: b.status ?? null, inserted_at: b.inserted_at ?? null, physical: Boolean(b.is_physical_backup) }))
          .sort((a, b) => String(b.inserted_at).localeCompare(String(a.inserted_at)))
        return json(req, { configured: true, ref, ok: true, region: body.region ?? null, pitr_enabled: Boolean(body.pitr_enabled),
          last_completed: backups.find((b) => /complete/i.test(b.status ?? ''))?.inserted_at ?? null, backups: backups.slice(0, 30) })
      }
      case 'health': {
        await require(client, 'health', 'view')
        const checks = await Promise.all([
          timed('database', async () => {
            const { count, error } = await admin.from('merchants').select('id', { head: true, count: 'exact' })
            if (error) throw new Error(error.message)
            return `Answered with the service key (${count ?? 0} merchants)`
          }),
          timed('auth', async () => {
            const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
            if (error) throw new Error(error.message)
            return 'The admin API answered'
          }),
        ])
        const has = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, Boolean(env(name))]))
        return json(req, { at: new Date().toISOString(), runtime: { ok: true, version: runtimeVersion() }, checks,
          settings: { required: has(REQUIRED_SETTINGS), optional: has(OPTIONAL_SETTINGS) } }, 200, { 'Cache-Control': 'no-store' })
      }
    }
  })
)
