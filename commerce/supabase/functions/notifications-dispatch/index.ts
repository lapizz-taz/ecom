// Sends queued customer notifications through the configured provider for
// each channel. Triggered by pg_cron (x-cron-secret) or inline after events.
import { env } from '../_shared/env.ts'
import { handle, HttpError, json } from '../_shared/http.ts'
import { type Channel, notificationProvider } from '../_shared/notifications/providers.ts'
import { adminClient, rpc } from '../_shared/supabase.ts'

interface QueuedNotification {
  id: string
  channel: Channel
  recipient: string
  subject: string | null
  body: string
  provider: string | null
  order_id: string | null
}

Deno.serve(
  handle(async (req) => {
    const secret = env('CRON_SECRET')
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
    const authorized =
      (secret && req.headers.get('x-cron-secret') === secret) ||
      (serviceKey && req.headers.get('authorization') === `Bearer ${serviceKey}`)
    if (!authorized) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED')

    const admin = adminClient()
    const batch = await rpc<QueuedNotification[]>(admin, 'claim_notifications', { p_limit: 25 })
    let sent = 0
    let failed = 0
    for (const item of batch ?? []) {
      const providerName = item.provider ?? 'console'
      try {
        const provider = notificationProvider(providerName)
        const result = await provider.send({ channel: item.channel, to: item.recipient, subject: item.subject, body: item.body })
        await rpc(admin, 'complete_notification', {
          p_id: item.id, p_success: true, p_provider: provider.name, p_provider_message_id: result.messageId ?? null, p_error: null,
        })
        sent += 1
      } catch (error) {
        failed += 1
        await rpc(admin, 'complete_notification', {
          p_id: item.id, p_success: false, p_provider: providerName, p_provider_message_id: null, p_error: (error as Error).message,
        })
      }
    }
    return json(req, { processed: batch?.length ?? 0, sent, failed })
  }),
)
