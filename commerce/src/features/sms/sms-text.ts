import type { Enums } from '@/types/database'

export type SmsEvent = Exclude<Enums<'notification_event'>, 'ADVANCE_RECEIVED'>

/** Events an automation can react to, in the order an order lives through them. */
export const SMS_EVENTS: Array<{ value: SmsEvent; label: string; when: string }> = [
  { value: 'ORDER_CREATED', label: 'Order placed', when: 'A customer places an order' },
  { value: 'ADVANCE_REQUIRED', label: 'Advance needed', when: 'An order needs an advance before it is confirmed' },
  { value: 'PAYMENT_RECEIVED', label: 'Payment received', when: 'A payment is recorded (advance, full or balance)' },
  { value: 'PAYMENT_FAILED', label: 'Payment failed', when: 'An online payment (bKash, PayStation…) fails' },
  { value: 'ORDER_CONFIRMED', label: 'Order approved', when: 'Your team approves the order' },
  { value: 'PRE_ORDER_CONFIRMED', label: 'Pre-order confirmed', when: 'An order is approved as a pre-order' },
  { value: 'ORDER_SHIPPED', label: 'Order shipped', when: 'The courier picks the parcel up' },
  { value: 'OUT_FOR_DELIVERY', label: 'Out for delivery', when: 'The courier is delivering today (at most once a day)' },
  { value: 'ORDER_DELIVERED', label: 'Delivered', when: 'The parcel is delivered' },
  { value: 'RETURN_INITIATED', label: 'Return initiated', when: 'The parcel, or a customer return, is on its way back' },
  { value: 'ORDER_RETURNED', label: 'Returned', when: 'The return reaches you' },
  { value: 'ORDER_CANCELLED', label: 'Order cancelled', when: 'An order is cancelled' },
]

export function eventLabel(event: string | null | undefined): string {
  if (!event || event === 'TEST') return 'Test message'
  if (event === 'ADVANCE_RECEIVED') return 'Advance received'
  return SMS_EVENTS.find((e) => e.value === event)?.label ?? event
}

/** Template variables with example values for the preview. Amounts use the SMS currency text. */
export function smsVariables(currency: string, store: { name?: string; phone?: string; website?: string } = {}) {
  const amount = (n: number) => `${currency ? `${currency} ` : ''}${n.toLocaleString('en-US')}`
  const site = (store.website || 'https://yourshop.com').replace(/\/$/, '')
  return [
    { key: 'customer_name', label: 'Customer name', sample: 'Rahim Uddin' },
    { key: 'customer_first_name', label: 'First name', sample: 'Rahim' },
    { key: 'order_number', label: 'Order number', sample: 'ISO-10123' },
    { key: 'total', label: 'Order total', sample: amount(1250) },
    { key: 'cod_amount', label: 'Cash to collect', sample: amount(1195) },
    { key: 'due_amount', label: 'Still due', sample: amount(1195) },
    { key: 'advance_amount', label: 'Advance to pay', sample: amount(55) },
    { key: 'payment_amount', label: 'Payment amount', sample: amount(55) },
    { key: 'courier_name', label: 'Courier', sample: 'Pathao' },
    { key: 'tracking_number', label: 'Tracking number', sample: 'DL0310ABC123' },
    { key: 'tracking_url', label: 'Tracking link', sample: 'https://merchant.pathao.com/tracking?consignment_id=DL0310ABC123' },
    { key: 'track_order_url', label: 'Order page link', sample: `${site}/track-order?order=ISO-10123` },
    { key: 'store_name', label: 'Store name', sample: store.name || 'My Store' },
    { key: 'store_phone', label: 'Store phone', sample: store.phone || '01700000000' },
  ]
}

/** Same as the database's render_template: known variables filled, unknown ones removed. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v)
  return out.replace(/\{\{[a-z_]+\}\}/g, '')
}

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM_EXTENDED = '^{}\\[~]|€\f'

export interface SmsParts {
  encoding: 'GSM' | 'UNICODE'
  units: number
  segments: number
  /** Characters left before the next part starts. */
  remaining: number
}

/**
 * How many SMS a text needs, as phones count it (and as the database does):
 * GSM-7 is 160 characters, 153 per part; anything else (Bangla, ৳, emoji) is
 * Unicode at 70, 67 per part.
 */
export function smsParts(text: string): SmsParts {
  let gsm = 0
  let unicode = false
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) gsm += 1
    else if (GSM_EXTENDED.includes(ch)) gsm += 2
    else {
      unicode = true
      break
    }
  }
  if (unicode) {
    const units = text.length // UTF-16 code units, as the network counts them
    const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67)
    return { encoding: 'UNICODE', units, segments, remaining: (segments <= 1 ? 70 : segments * 67) - units }
  }
  const segments = gsm === 0 ? 0 : gsm <= 160 ? 1 : Math.ceil(gsm / 153)
  return { encoding: 'GSM', units: gsm, segments, remaining: (segments <= 1 ? 160 : segments * 153) - gsm }
}

// -----------------------------------------------------------------------------
// Conditions
// -----------------------------------------------------------------------------
export type ConditionField = 'payment_method' | 'total' | 'district' | 'source' | 'first_order' | 'courier'
export interface Condition {
  field: ConditionField
  op: 'in' | 'not_in' | 'gte' | 'lte' | 'eq'
  value: string[] | number | boolean
}

export const CONDITION_FIELDS: Array<{ value: ConditionField; label: string }> = [
  { value: 'payment_method', label: 'Payment' },
  { value: 'total', label: 'Order total' },
  { value: 'district', label: 'District' },
  { value: 'first_order', label: 'Customer' },
  { value: 'courier', label: 'Courier' },
  { value: 'source', label: 'Placed from' },
]

export const PAYMENT_OPTIONS = [
  { value: 'COD', label: 'Cash on delivery' },
  { value: 'ADVANCE', label: 'Advance' },
  { value: 'FULL_PAYMENT', label: 'Paid in full' },
]
export const SOURCE_OPTIONS = [
  { value: 'STOREFRONT', label: 'Website' },
  { value: 'ADMIN', label: 'Admin' },
  { value: 'IMPORT', label: 'Import' },
  { value: 'API', label: 'API' },
]

export function newCondition(field: ConditionField): Condition {
  switch (field) {
    case 'total':
      return { field, op: 'gte', value: 1000 }
    case 'first_order':
      return { field, op: 'eq', value: true }
    case 'payment_method':
      return { field, op: 'in', value: ['COD'] }
    default:
      return { field, op: 'in', value: [] }
  }
}

/** "Payment is Cash on delivery", "Order total at least Tk 1,000", … */
export function describeCondition(c: Condition, opts: { couriers?: Array<{ id: string; name: string }>; currency?: string } = {}): string {
  const list = (values: string[], options?: Array<{ value: string; label: string }>) =>
    values.map((v) => options?.find((o) => o.value === v)?.label ?? opts.couriers?.find((x) => x.id === v)?.name ?? v).join(', ')
  const not = c.op === 'not_in' ? 'is not' : 'is'
  switch (c.field) {
    case 'payment_method':
      return `Payment ${not} ${list(c.value as string[], PAYMENT_OPTIONS)}`
    case 'total':
      return `Order total ${c.op === 'gte' ? 'at least' : 'at most'} ${opts.currency ? `${opts.currency} ` : ''}${Number(c.value).toLocaleString('en-US')}`
    case 'district':
      return `District ${not} ${list(c.value as string[])}`
    case 'source':
      return `Placed from ${list(c.value as string[], SOURCE_OPTIONS)}${c.op === 'not_in' ? ' (excluded)' : ''}`
    case 'courier':
      return `Courier ${not} ${list(c.value as string[])}`
    case 'first_order':
      return c.value ? 'First order' : 'Repeat customer'
  }
}

/** What's missing before the database will accept the conditions (null when fine). */
export function conditionProblem(conditions: Condition[]): string | null {
  for (const c of conditions) {
    if (Array.isArray(c.value) && c.value.filter((v) => v.trim()).length === 0) {
      return `Choose at least one value for "${CONDITION_FIELDS.find((f) => f.value === c.field)?.label}"`
    }
    if (c.field === 'total' && (!Number.isFinite(Number(c.value)) || Number(c.value) < 0)) return 'Enter an order total of 0 or more'
  }
  return null
}
