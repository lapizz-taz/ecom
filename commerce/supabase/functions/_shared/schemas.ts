import { z } from 'zod'
import { HttpError } from './http.ts'

// Server-side validation for every public payload. The database validates
// again (prices, stock, coupons, phone pattern) — this layer rejects junk early.

const text = (max: number) => z.string().trim().max(max)
const optionalText = (max: number) => text(max).optional().nullable()

export const phoneSchema = z.string().trim().min(6).max(20).regex(/^[+0-9\s-]+$/, 'Enter a valid phone number')

export const cartItemSchema = z.object({
  variant_id: z.uuid(),
  quantity: z.number().int().min(1).max(100),
})

export const paymentMethodSchema = z.enum(['COD', 'ADVANCE', 'FULL_PAYMENT'])

/** One visit source as the storefront saw it (UTM tags, click ids, referrer, landing page). */
export const touchSchema = z.object({
  at: z.string().max(40),
  landing: z.string().max(300),
  referrer: z.string().max(300).nullable().optional(),
  params: z.record(z.string().regex(/^[a-z_]{2,30}$/), z.string().max(200)).refine((p) => Object.keys(p).length <= 30, 'Too many parameters'),
})

/** The browser's own ad ids (Meta _fbp/_fbc, TikTok _ttp, GA client id) for the server-side events. */
export const browserIdsSchema = z.object({
  fbp: z.string().regex(/^fb\.\d\.\d{10,13}\.\d{1,25}$/),
  fbc: z.string().max(600).regex(/^fb\.\d\.\d{10,13}\.[A-Za-z0-9_.-]{4,550}$/),
  ttp: z.string().regex(/^[A-Za-z0-9_.-]{8,80}$/),
  ga: z.string().regex(/^\d{5,12}\.\d{9,12}$/),
}).partial()

export const attributionSchema = z.object({
  visitor_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  session_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional().nullable(),
  first_touch: touchSchema.nullable().optional(),
  last_touch: touchSchema.nullable().optional(),
  // A malformed id drops only the ids, never the attribution.
  browser: browserIdsSchema.optional().catch(undefined),
})

/** A browser ad event's server copy, sent by the storefront (public, rate-limited). */
export const trackSchema = z.object({
  action: z.literal('track'),
  event: z.enum(['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout']),
  event_id: z.string().regex(/^ffs_[a-z]{2}_[A-Za-z0-9]{8,40}$/),
  url: z.string().max(500).regex(/^https?:\/\//),
  visitor_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  value: z.number().min(0).max(10_000_000).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  contents: z.array(z.object({
    id: z.string().max(64), name: z.string().max(120).optional(), quantity: z.number().int().min(1).max(999), price: z.number().min(0).max(10_000_000),
  })).max(50).optional(),
  browser: browserIdsSchema.omit({ ga: true }).optional().catch(undefined),
  click: z.object({ fbclid: z.string().max(500).regex(/^[A-Za-z0-9_.-]+$/), ttclid: z.string().max(500).regex(/^[A-Za-z0-9_.-]+$/) }).partial().optional().catch(undefined),
})

export const quoteSchema = z.object({
  action: z.literal('quote'),
  items: z.array(cartItemSchema).min(1).max(50),
  district: optionalText(60),
  area: optionalText(80),
  delivery_method: text(30).default('standard'),
  coupon_code: optionalText(32),
  phone: phoneSchema.optional().nullable().or(z.literal('')),
  payment_method: paymentMethodSchema.default('COD'),
  /** Run the courier check for this phone now (once, after the price is shown); limited per visitor and store. */
  check: z.boolean().optional().default(false),
  /** What the customer has typed so far, kept as an incomplete order if they leave. */
  lead: z.object({
    customer_name: optionalText(100),
    address: optionalText(300),
  }).optional().nullable(),
  attribution: attributionSchema.optional().nullable().catch(null),
})

export const placeOrderSchema = z.object({
  action: z.literal('place'),
  customer: z.object({
    full_name: text(100).min(2, 'Enter your name'),
    phone: phoneSchema,
    email: z.email().max(160).optional().nullable().or(z.literal('')),
  }),
  shipping: z.object({
    address: text(300).min(5, 'Enter your full address'),
    area: optionalText(80),
    city: optionalText(80),
    district: text(60).min(2, 'Choose your district'),
    postal_code: optionalText(12),
  }),
  items: z.array(cartItemSchema).min(1).max(50),
  delivery_method: text(30).default('standard'),
  payment_method: paymentMethodSchema.default('COD'),
  coupon_code: optionalText(32),
  customer_note: optionalText(500),
  idempotency_key: z.string().min(8).max(100),
  /** bKash / Nagad "Send Money" made at checkout when an advance is required. */
  advance_payment: z
    .object({
      channel: z.enum(['BKASH', 'NAGAD', 'ROCKET']),
      sender_phone: phoneSchema,
      transaction_id: z.string().trim().min(6).max(30),
    })
    .optional()
    .nullable(),
  utm: z
    .object({ source: optionalText(100), medium: optionalText(100), campaign: optionalText(100) })
    .partial()
    .optional()
    .nullable(),
  /** Bad tracking data never blocks an order; it just isn't recorded. */
  attribution: attributionSchema.optional().nullable().catch(null),
})

export const initiatePaymentSchema = z.object({
  action: z.literal('initiate'),
  order_number: text(30).min(3),
  phone: phoneSchema,
  provider: z.string().regex(/^[a-z0-9_]+$/),
  purpose: z.enum(['ADVANCE', 'FULL', 'BALANCE']).default('ADVANCE'),
})

export const manualPaymentSchema = z.object({
  action: z.literal('submit_manual'),
  order_number: text(30).min(3),
  phone: phoneSchema,
  channel: z.enum(['BKASH', 'NAGAD', 'ROCKET', 'BANK_TRANSFER', 'OTHER']),
  sender_phone: phoneSchema,
  transaction_id: z.string().trim().min(6).max(30),
  amount: z.number().positive().max(10_000_000),
})

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    throw new HttpError(422, issues[0]?.message ?? 'Invalid request', 'VALIDATION', issues)
  }
  return result.data
}
