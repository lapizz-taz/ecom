// Storefront checkout (public). Three actions:
//   quote — prices the cart and says whether cash on delivery is available.
//   place — creates the order (see _shared/checkout-flow.ts); with ad tracking
//           on, also the browser pixels' Purchase (same event id as the server's).
//   track — the server copy of a browser ad event (Meta Conversions API,
//           TikTok Events API), same event id as the pixel so it counts once.
import { beaconEvent, browserPurchase, firstSend } from '../_shared/ads/store-tracking-service.ts'
import { quoteCart, placeOrder } from '../_shared/checkout-flow.ts'
import { dispatchNotificationsInBackground } from '../_shared/dispatch.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse, placeOrderSchema, quoteSchema, trackSchema } from '../_shared/schemas.ts'
import { adminClient, optionalUser, storefrontMerchant } from '../_shared/supabase.ts'

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await readJson<{ action?: string }>(req)
    const ip = clientIp(req)
    // The store the shopper is on; every price, stock and order check runs inside it.
    const merchantId = storefrontMerchant(req)
    const admin = adminClient(merchantId)

    if (body.action === 'quote') {
      rateLimit(`quote:${ip}`, 60)
      return json(req, await quoteCart(admin, parse(quoteSchema, body), { ip }))
    }

    if (body.action === 'place') {
      rateLimit(`place:${ip}`, 8)
      const input = parse(placeOrderSchema, body)
      const user = await optionalUser(req)
      const result = await placeOrder(admin, input, { ip, userAgent: req.headers.get('user-agent'), userId: user?.id ?? null })
      dispatchNotificationsInBackground(merchantId)
      // The browser pixels' Purchase (when it counts at once); tracking never fails an order.
      const purchase = await browserPurchase(admin, String(result.order.id), !!result.order.merged)
        .catch((error) => { void logEvent({ level: 'WARN', category: 'FUNCTION', source: 'checkout', message: 'Ad tracking: no browser Purchase', error }); return null })
      return json(req, { ...result, tracking: purchase ? { purchase } : null }, 201)
    }

    if (body.action === 'track') {
      // A shopper browsing sends a few events a minute; a store gets a busy-day ceiling.
      rateLimit(`track:${ip}`, 60)
      rateLimit(`track-store:${merchantId}`, 1500)
      const input = parse(trackSchema, body)
      // The same event id twice (a retry, a replay) is sent once.
      if (!firstSend(merchantId, input.event_id)) return json(req, { ok: true, duplicate: true }, 202)
      const r = await beaconEvent(admin, input, ip, req.headers.get('user-agent'), undefined, req.headers.get('origin'))
      return json(req, { ok: r.ok }, 202)
    }

    throw new HttpError(400, 'Unknown action', 'UNKNOWN_ACTION')
  })
)
