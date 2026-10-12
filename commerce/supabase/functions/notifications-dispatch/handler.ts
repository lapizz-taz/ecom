// Sends queued customer messages, then asks the SMS gateway for delivery
// reports that are due. Triggered by pg_cron (x-cron-secret) every minute
// while something waits, and nudged right after checkout and payments.
//   SMS        → the gateway connected on the SMS page (credentials in Vault)
//   WhatsApp / email → the provider chosen in Settings → Notifications
import type { SupabaseClient } from '@supabase/supabase-js'
import { isCronRequest } from '../_shared/cron.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { type Channel, notificationProvider } from '../_shared/notifications/providers.ts'
import { SmsError, type SmsProvider } from '../_shared/sms/providers.ts'
import { connectedSmsProvider } from '../_shared/sms/registry.ts'
import { adminClient, forEachMerchant, merchantOf, rpc } from '../_shared/supabase.ts'

interface QueuedNotification {
  id: string
  channel: Channel
  recipient: string
  subject: string | null
  body: string
  provider: string | null
  order_id: string | null
  provider_message_id: string | null
}

type Sms = Awaited<ReturnType<typeof connectedSmsProvider>>

const mask = (to: string) => (to.length > 7 ? `${to.slice(0, -7)}••••${to.slice(-3)}` : to)

async function sendOne(admin: SupabaseClient, item: QueuedNotification, sms: () => Promise<Sms>): Promise<boolean> {
  const category = item.channel === 'SMS' ? 'SMS' : 'OTHER'
  let result: Record<string, unknown>
  try {
    if (item.channel === 'SMS') {
      const { provider, senderId } = await sms()
      const sent = await provider.send({ to: item.recipient, body: item.body, senderId, clientRef: item.id })
      result = { p_provider: provider.code, p_provider_message_id: sent.messageId, p_cost: sent.cost, p_delivery_status: sent.delivery }
    } else {
      const provider = notificationProvider(item.provider ?? 'console')
      const sent = await provider.send({ channel: item.channel, to: item.recipient, subject: item.subject, body: item.body })
      result = { p_provider: provider.name, p_provider_message_id: sent.messageId ?? null }
    }
  } catch (error) {
    const message = (error as Error).message
    let status: string | null = null
    try {
      status = await rpc<string | null>(admin, 'complete_notification', {
        p_id: item.id, p_success: false, p_provider: item.provider, p_provider_message_id: null, p_error: message,
        p_permanent: error instanceof SmsError && error.permanent,
      })
    } catch (recordError) {
      void logEvent({ level: 'ERROR', category, source: 'notifications-dispatch', message: 'Could not record a failed message', error: recordError,
        context: { notification_id: item.id }, merchantId: merchantOf(admin) })
    }
    void logEvent({
      level: status === 'QUEUED' ? 'WARN' : 'ERROR', category, source: 'notifications-dispatch',
      message: `${item.channel} to ${mask(item.recipient)} ${status === 'QUEUED' ? 'will be retried' : 'failed'}: ${message}`,
      context: { notification_id: item.id, order_id: item.order_id, status }, merchantId: merchantOf(admin),
    })
    return false
  }
  // Sent: recording can fail, but the message must not be sent again because of it.
  try {
    await rpc(admin, 'complete_notification', { p_id: item.id, p_success: true, p_error: null, ...result })
  } catch (recordError) {
    void logEvent({
      level: 'ERROR', category, source: 'notifications-dispatch', error: recordError,
      message: `${item.channel} to ${mask(item.recipient)} was sent but could not be recorded`,
      context: { notification_id: item.id, ...result }, merchantId: merchantOf(admin),
    })
  }
  return true
}

/** Delivery reports for sent SMS, where the gateway offers them. */
async function checkDeliveries(admin: SupabaseClient, sms: () => Promise<Sms>): Promise<number> {
  const due = await rpc<QueuedNotification[]>(admin, 'sms_delivery_checks', { p_limit: 20 })
  if (!due?.length) return 0
  let provider: SmsProvider
  try {
    provider = (await sms()).provider
  } catch {
    return 0 // not connected any more; the messages age out as "unknown"
  }
  let checked = 0
  for (const row of due) {
    try {
      if (row.provider !== provider.code || !provider.reportsDelivery || !row.provider_message_id) {
        await rpc(admin, 'record_sms_delivery', { p_id: row.id, p_status: 'UNKNOWN', p_cost: null })
        continue
      }
      const report = await provider.report(row.provider_message_id)
      await rpc(admin, 'record_sms_delivery', { p_id: row.id, p_status: report.status, p_cost: report.cost })
      checked += 1
    } catch (error) {
      void logEvent({
        level: 'WARN', category: 'SMS', source: 'notifications-dispatch',
        message: `Could not get the delivery report for ${mask(row.recipient)}: ${(error as Error).message}`,
        context: { notification_id: row.id }, merchantId: merchantOf(admin),
      })
    }
  }
  return checked
}

/** Sends one merchant's queued messages with that merchant's SMS gateway. */
async function drain(admin: SupabaseClient) {
  // The SMS gateway is loaded once per run, and only when needed.
  let smsPromise: Promise<Sms> | null = null
  const sms = () => (smsPromise ??= connectedSmsProvider(admin))

  const batch = await rpc<QueuedNotification[]>(admin, 'claim_notifications', { p_limit: 25 })
  let sent = 0
  let failed = 0
  for (const item of batch ?? []) {
    if (await sendOne(admin, item, sms)) sent += 1
    else failed += 1
  }
  const deliveryChecked = await checkDeliveries(admin, sms)
  return { processed: batch?.length ?? 0, sent, failed, delivery_checked: deliveryChecked }
}

export default (
  handle(async (req) => {
    if (!(await isCronRequest(req, adminClient()))) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED')
    // An order event names its merchant; the scheduled run goes through every merchant.
    const body = await readJson<{ merchant_id?: string }>(req)
    if (body.merchant_id && /^[0-9a-f-]{36}$/i.test(body.merchant_id)) {
      return json(req, await drain(adminClient(body.merchant_id)))
    }
    return json(req, await forEachMerchant('notifications-dispatch', (admin) => drain(admin)))
  })
)
