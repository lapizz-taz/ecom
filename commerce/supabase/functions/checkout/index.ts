// Storefront checkout (public). Two actions:
//   quote — prices the cart and says whether cash on delivery is available.
//   place — creates the order (see _shared/checkout-flow.ts).
import { quoteCart, placeOrder } from '../_shared/checkout-flow.ts'
import { dispatchNotificationsInBackground } from '../_shared/dispatch.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { parse, placeOrderSchema, quoteSchema } from '../_shared/schemas.ts'
import { adminClient, optionalUser } from '../_shared/supabase.ts'

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await readJson<{ action?: string }>(req)
    const ip = clientIp(req)
    const admin = adminClient()

    if (body.action === 'quote') {
      rateLimit(`quote:${ip}`, 60)
      return json(req, await quoteCart(admin, parse(quoteSchema, body)))
    }

    if (body.action === 'place') {
      rateLimit(`place:${ip}`, 8)
      const input = parse(placeOrderSchema, body)
      const user = await optionalUser(req)
      const result = await placeOrder(admin, input, { ip, userAgent: req.headers.get('user-agent'), userId: user?.id ?? null })
      dispatchNotificationsInBackground()
      return json(req, result, 201)
    }

    throw new HttpError(400, 'Unknown action', 'UNKNOWN_ACTION')
  }),
)
