// Courier status callbacks. Each provider authenticates differently; events
// are applied idempotently through apply_shipment_status(p_event_key).
//   Steadfast: POST /courier-webhook?provider=steadfast
//              Authorization: Bearer <STEADFAST_WEBHOOK_TOKEN>
import { env } from '../_shared/env.ts'
import { mapSteadfastStatus } from '../_shared/courier/providers.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { adminClient, rpc } from '../_shared/supabase.ts'

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const provider = new URL(req.url).searchParams.get('provider')

    if (provider === 'steadfast') {
      const expected = env('STEADFAST_WEBHOOK_TOKEN')
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      if (!expected || !timingSafeEqual(token, expected)) throw new HttpError(401, 'Invalid webhook token', 'UNAUTHORIZED')

      const event = await readJson<Record<string, unknown>>(req)
      const consignmentId = event.consignment_id != null ? String(event.consignment_id) : null
      const invoice = event.invoice != null ? String(event.invoice) : null
      const status = mapSteadfastStatus(event.status as string)
      const admin = adminClient()

      let query = admin.from('shipments').select('id, couriers!inner(provider)').eq('couriers.provider', 'steadfast').eq('is_active', true)
      if (consignmentId) {
        query = query.eq('consignment_id', consignmentId)
      } else {
        const { data: order } = await admin.from('orders').select('id').eq('order_number', invoice ?? '').maybeSingle()
        query = query.eq('order_id', order?.id ?? '00000000-0000-0000-0000-000000000000')
      }
      const { data: shipment } = await query.maybeSingle()
      if (!shipment) {
        console.warn('Steadfast webhook for unknown consignment', consignmentId, invoice)
        return json(req, { status: 'success', message: 'ignored' })
      }
      if (status) {
        await rpc(admin, 'apply_shipment_status', {
          p_shipment_id: shipment.id,
          p_status: status,
          p_description: (event.tracking_message as string) ?? `Courier status: ${event.status}`,
          p_location: null,
          p_occurred_at: null,
          p_source: 'WEBHOOK',
          p_raw: event,
          p_event_key: `steadfast:${consignmentId}:${event.status}:${event.updated_at ?? ''}`,
        })
      }
      return json(req, { status: 'success', message: 'Webhook received' })
    }

    throw new HttpError(400, 'Unknown provider', 'UNKNOWN_PROVIDER')
  }),
)
