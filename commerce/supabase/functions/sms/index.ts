// SMS page actions (staff with sms.manage):
//   connect, disconnect, balance, send_test
// Credentials are tested against the gateway, then kept in Vault by the
// service role; the browser only ever sees a masked hint.
import { z } from 'zod'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import {
  cleanSmsCredentials, SMS_PROVIDER_CODES, smsCredentialHint, SmsError, smsProviderFromCredentials,
} from '../_shared/sms/providers.ts'
import { connectedSmsProvider, loadSmsConfig, smsSecretKey } from '../_shared/sms/registry.ts'
import { adminClient, requireStaff, rpc } from '../_shared/supabase.ts'

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('connect'),
    provider: z.enum(SMS_PROVIDER_CODES),
    credentials: z.record(z.string().regex(/^[a-z_]+$/), z.string().trim().max(1000)),
    sender_id: z.string().trim().max(20).regex(/^[A-Za-z0-9 ._+-]*$/, 'Use letters, digits, spaces, dots or dashes').optional(),
  }),
  z.object({ action: z.literal('disconnect') }),
  z.object({ action: z.literal('balance') }),
  z.object({
    action: z.literal('send_test'),
    to: z.string().trim().min(10).max(20),
    message: z.string().trim().min(1).max(1000),
  }),
])

interface LoggedMessage { id: string; recipient: string; segments: number; cost: number | null }

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const input = parse(schema, await readJson(req))
    const staff = await requireStaff(req, 'sms.manage')
    const admin = adminClient()

    switch (input.action) {
      case 'connect': {
        const creds = cleanSmsCredentials(input.provider, input.credentials)
        let balance: number | null = null
        let message: string
        try {
          const provider = smsProviderFromCredentials(input.provider, creds)
          if (input.provider === 'bulksmsbd' && !input.sender_id) throw new SmsError('BulkSMSBD needs a sender ID', true)
          balance = await provider.balance()
          message = balance === null
            ? 'Saved. This provider has no balance check, so send a test message to make sure it works.'
            : `Connected. Balance: ${balance}`
        } catch (error) {
          throw new HttpError(422, `Could not connect: ${(error as Error).message}`, 'CONNECTION_FAILED')
        }
        const previous = await loadSmsConfig(admin)
        const hint = smsCredentialHint(input.provider, creds)
        await rpc(admin, 'integration_secret_store', { p_key: smsSecretKey(input.provider), p_value: creds, p_hint: hint, p_actor: staff.user.id })
        if (previous.provider && previous.provider !== input.provider && (SMS_PROVIDER_CODES as readonly string[]).includes(previous.provider)) {
          await rpc(admin, 'integration_secret_clear', {
            p_key: smsSecretKey(previous.provider as (typeof SMS_PROVIDER_CODES)[number]), p_actor: staff.user.id,
          })
        }
        const settings = await rpc(admin, 'sms_set_connection', {
          p_provider: input.provider, p_hint: hint, p_sender_id: input.sender_id ?? '', p_balance: balance, p_actor: staff.user.id,
        })
        return json(req, { ok: true, message, balance, settings })
      }
      case 'disconnect': {
        const config = await loadSmsConfig(admin)
        if (config.provider && (SMS_PROVIDER_CODES as readonly string[]).includes(config.provider)) {
          await rpc(admin, 'integration_secret_clear', {
            p_key: smsSecretKey(config.provider as (typeof SMS_PROVIDER_CODES)[number]), p_actor: staff.user.id,
          })
        }
        const settings = await rpc(admin, 'sms_set_connection', {
          p_provider: null, p_hint: null, p_sender_id: null, p_balance: null, p_actor: staff.user.id,
        })
        return json(req, { ok: true, settings })
      }
      case 'balance': {
        try {
          const { provider } = await connectedSmsProvider(admin)
          const balance = await provider.balance()
          if (balance !== null) await rpc(admin, 'sms_set_balance', { p_balance: balance })
          return json(req, { balance, supported: balance !== null })
        } catch (error) {
          if (error instanceof HttpError) throw error
          throw new HttpError(502, `Could not get the balance: ${(error as Error).message}`, 'GATEWAY_ERROR')
        }
      }
      case 'send_test': {
        const { provider, senderId } = await connectedSmsProvider(admin).catch((error) => {
          throw new HttpError(422, (error as Error).message, 'NOT_CONNECTED')
        })
        const log = await rpc<LoggedMessage>(admin, 'sms_log_test', { p_to: input.to, p_body: input.message, p_actor: staff.user.id })
        try {
          const sent = await provider.send({ to: log.recipient, body: input.message, senderId, clientRef: log.id })
          await rpc(admin, 'complete_notification', {
            p_id: log.id, p_success: true, p_provider: provider.code, p_provider_message_id: sent.messageId, p_error: null,
            p_cost: sent.cost, p_delivery_status: sent.delivery,
          })
          return json(req, { ok: true, id: log.id, parts: log.segments, message_id: sent.messageId })
        } catch (error) {
          const message = (error as Error).message
          await rpc(admin, 'complete_notification', {
            p_id: log.id, p_success: false, p_provider: provider.code, p_provider_message_id: null, p_error: message, p_permanent: true,
          })
          void logEvent({ level: 'ERROR', category: 'SMS', source: 'sms', message: `Test SMS failed: ${message}`, context: { notification_id: log.id } })
          throw new HttpError(422, message, 'SEND_FAILED')
        }
      }
    }
  }),
)
