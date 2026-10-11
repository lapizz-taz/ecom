// SMS page action for merchant staff (sms.manage):
//   send_test — a test message through the platform's SMS provider, logged and
//               charged like any other message (free allowance, then credits).
// The provider account itself is the platform's (Super Admin → SMS Management);
// merchants never connect or see it.
import { z } from 'zod'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { connectedSmsProvider } from '../_shared/sms/registry.ts'
import { requireStaff, rpc } from '../_shared/supabase.ts'

const schema = z.object({
  action: z.literal('send_test'),
  to: z.string().trim().min(10).max(20),
  message: z.string().trim().min(1).max(1000),
})

interface LoggedMessage { id: string; recipient: string; segments: number; cost: number | null }

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const input = parse(schema, await readJson(req))
    const staff = await requireStaff(req, 'sms.manage')
    const admin = staff.admin

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
  }),
)
