// The default customer emails (HTML + Liquid) and WhatsApp texts for every order event, the
// sample order the editor previews with, and the list of placeholders the editor offers.
// The migration that adds the Email and WhatsApp modules stores these same texts in
// public.notification_defaults (a test keeps the two equal), so "Reset to default" and every new
// store use them.

export const MESSAGE_EVENTS = [
  'ORDER_CREATED', 'ORDER_CONFIRMED', 'PRE_ORDER_CONFIRMED', 'ADVANCE_REQUIRED', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED',
  'ORDER_SHIPPED', 'OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'RETURN_INITIATED', 'ORDER_RETURNED',
] as const
export type MessageEvent = (typeof MESSAGE_EVENTS)[number]

/** Where each event shows in the Email and WhatsApp lists (like Shopify's groups), with its description. */
export const EVENT_INFO: Record<MessageEvent, { group: 'Order processing' | 'Payments' | 'Order exceptions'; title: string; when: string }> = {
  ORDER_CREATED: { group: 'Order processing', title: 'Order confirmation', when: 'Sent when a customer places an order' },
  ORDER_CONFIRMED: { group: 'Order processing', title: 'Order approved', when: 'Sent when your team approves the order' },
  PRE_ORDER_CONFIRMED: { group: 'Order processing', title: 'Pre-order confirmed', when: 'Sent when a pre-order is approved' },
  ORDER_SHIPPED: { group: 'Order processing', title: 'Shipping confirmation', when: 'Sent when the parcel is handed to the courier' },
  OUT_FOR_DELIVERY: { group: 'Order processing', title: 'Out for delivery', when: 'Sent when the courier is on the way to the customer' },
  ORDER_DELIVERED: { group: 'Order processing', title: 'Order delivered', when: 'Sent when the courier delivers the parcel' },
  ADVANCE_REQUIRED: { group: 'Payments', title: 'Advance payment needed', when: 'Sent when an order needs an advance before it ships' },
  PAYMENT_RECEIVED: { group: 'Payments', title: 'Payment received', when: 'Sent for every payment you receive for an order' },
  PAYMENT_FAILED: { group: 'Payments', title: 'Payment failed', when: "Sent when a customer's online payment doesn't go through" },
  ORDER_CANCELLED: { group: 'Order exceptions', title: 'Order cancelled', when: 'Sent when an order is cancelled' },
  RETURN_INITIATED: { group: 'Order exceptions', title: 'Return started', when: 'Sent when a parcel is on its way back to you' },
  ORDER_RETURNED: { group: 'Order exceptions', title: 'Return received', when: 'Sent when a returned parcel reaches you' },
}

// ------------------------------------------------------------------ email
interface EmailPart { subject: string; title: string; intro: string; button?: { label: string; url: string; when?: string }; summary?: 'full' | 'short' | 'none'; extra?: string }

const P = 'margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;'

const EMAIL_PARTS: Record<MessageEvent, EmailPart> = {
  ORDER_CREATED: {
    subject: 'Order {{ order.name }} received',
    title: 'Thank you for your order!',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, we have received your order {{ order.name }}. We will call you shortly to confirm it before it ships.</p>`,
    button: { label: 'View your order', url: '{{ order.status_url }}', when: 'order.status_url' },
    summary: 'full',
  },
  ORDER_CONFIRMED: {
    subject: 'Order {{ order.name }} confirmed',
    title: 'Your order is confirmed',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} is confirmed and we are getting it ready.</p>
{% if order.cod_amount > 0 %}<p style="${P}">Please keep <strong>{{ order.cod_amount | money }}</strong> ready to pay on delivery.</p>{% endif %}`,
    button: { label: 'View your order', url: '{{ order.status_url }}', when: 'order.status_url' },
    summary: 'full',
  },
  PRE_ORDER_CONFIRMED: {
    subject: 'Pre-order {{ order.name }} confirmed',
    title: 'Your pre-order is confirmed',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, your pre-order {{ order.name }} is confirmed. We will ship it as soon as it arrives in stock.</p>`,
    button: { label: 'View your order', url: '{{ order.status_url }}', when: 'order.status_url' },
    summary: 'full',
  },
  ADVANCE_REQUIRED: {
    subject: 'Advance payment needed for order {{ order.name }}',
    title: 'One more step to confirm your order',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, to confirm order {{ order.name }} please pay an advance of <strong>{{ order.advance_amount | money }}</strong>. The rest is paid on delivery.</p>`,
    button: { label: 'Pay the advance', url: '{{ order.status_url }}', when: 'order.status_url' },
    summary: 'full',
  },
  PAYMENT_RECEIVED: {
    subject: 'Payment received for order {{ order.name }}',
    title: 'We received your payment',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, we received <strong>{{ payment.amount | money }}</strong> for order {{ order.name }}. Thank you!</p>
{% if order.due_amount > 0 %}<p style="${P}">Still to pay on delivery: <strong>{{ order.due_amount | money }}</strong>.</p>{% endif %}`,
    summary: 'short',
  },
  PAYMENT_FAILED: {
    subject: 'Payment for order {{ order.name }} did not go through',
    title: "Your payment didn't go through",
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, your payment of <strong>{{ payment.amount | money }}</strong> for order {{ order.name }} did not go through. No money was taken. You can try again below.</p>`,
    button: { label: 'Try again', url: '{{ order.status_url }}', when: 'order.status_url' },
    summary: 'short',
  },
  ORDER_SHIPPED: {
    subject: 'Order {{ order.name }} is on the way',
    title: 'Your order is on the way',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} has been handed to {{ shipment.courier | default: "the courier" }}.</p>
{% if shipment.tracking_number %}<p style="${P}">Tracking number: <strong>{{ shipment.tracking_number }}</strong></p>{% endif %}
{% if order.cod_amount > 0 %}<p style="${P}">Please keep <strong>{{ order.cod_amount | money }}</strong> ready to pay on delivery.</p>{% endif %}`,
    button: { label: 'Track your parcel', url: '{{ shipment.tracking_url | default: order.status_url }}', when: 'shipment.tracking_url or order.status_url' },
    summary: 'short',
  },
  OUT_FOR_DELIVERY: {
    subject: 'Order {{ order.name }} is out for delivery',
    title: 'Your order arrives today',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} is out for delivery today{% if shipment.courier %} with {{ shipment.courier }}{% endif %}.</p>
{% if order.cod_amount > 0 %}<p style="${P}">Please keep <strong>{{ order.cod_amount | money }}</strong> ready for the delivery person.</p>{% endif %}`,
    button: { label: 'Track your parcel', url: '{{ shipment.tracking_url | default: order.status_url }}', when: 'shipment.tracking_url or order.status_url' },
    summary: 'none',
  },
  ORDER_DELIVERED: {
    subject: 'Order {{ order.name }} delivered',
    title: 'Your order was delivered',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} was delivered. We hope you love it!</p>
<p style="${P}">If anything is not right, just reply to this email{% if shop.phone %} or call us at {{ shop.phone }}{% endif %}.</p>`,
    summary: 'short',
  },
  ORDER_CANCELLED: {
    subject: 'Order {{ order.name }} cancelled',
    title: 'Your order was cancelled',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, your order {{ order.name }} has been cancelled.</p>
{% if order.paid_amount > 0 %}<p style="${P}">You paid {{ order.paid_amount | money }} for this order. We will contact you about the refund.</p>{% endif %}
<p style="${P}">Questions? Reply to this email{% if shop.phone %} or call us at {{ shop.phone }}{% endif %}.</p>`,
    summary: 'short',
  },
  RETURN_INITIATED: {
    subject: 'Order {{ order.name }} is being returned',
    title: 'Your order is being returned',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, the parcel for order {{ order.name }} is on its way back to us.</p>
<p style="${P}">Questions? Reply to this email{% if shop.phone %} or call us at {{ shop.phone }}{% endif %}.</p>`,
    summary: 'none',
  },
  ORDER_RETURNED: {
    subject: 'Return received for order {{ order.name }}',
    title: 'We received your return',
    intro: `<p style="${P}">Hi {{ customer.first_name | default: "there" }}, the returned parcel for order {{ order.name }} has reached us.</p>
{% if order.paid_amount > 0 %}<p style="${P}">We will contact you about your payment of {{ order.paid_amount | money }}.</p>{% endif %}`,
    summary: 'none',
  },
}

const TD = 'padding:6px 0;font-size:14px;color:#374151;'
const ROW = (label: string, value: string, when?: string) =>
  `${when ? `{% if ${when} %}` : ''}<tr><td style="${TD}">${label}</td><td align="right" style="${TD}">${value}</td></tr>${when ? '{% endif %}' : ''}`

const SUMMARY_FULL = `<tr><td style="padding:8px 32px 0;">
<p style="margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Order summary</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
{% for item in order.line_items %}<tr>
<td width="56" style="padding:12px 12px 12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">{% if item.image_url %}<img src="{{ item.image_url }}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid #e5e7eb;">{% endif %}</td>
<td style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;line-height:1.4;color:#111827;vertical-align:top;">{{ item.title }}{% if item.variant_title %}<br><span style="color:#6b7280;font-size:13px;">{{ item.variant_title }}</span>{% endif %}<br><span style="color:#6b7280;font-size:13px;">Qty {{ item.quantity }}</span></td>
<td align="right" style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111827;vertical-align:top;white-space:nowrap;">{{ item.line_price | money }}</td>
</tr>{% endfor %}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
${ROW('Subtotal', '{{ order.subtotal_price | money }}')}
${ROW('Discount', '-{{ order.discount_price | money }}', 'order.discount_price > 0')}
${ROW('Delivery', '{{ order.delivery_price | money }}')}
<tr><td style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">Total</td><td align="right" style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">{{ order.total_price | money }}</td></tr>
${ROW('Paid', '{{ order.paid_amount | money }}', 'order.paid_amount > 0')}
${ROW('<strong>To pay on delivery</strong>', '<strong>{{ order.cod_amount | money }}</strong>', 'order.cod_amount > 0')}
</table>
</td></tr>
{% if order.shipping_address.address %}<tr><td style="padding:20px 32px 0;">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">Delivery address</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">{{ order.shipping_address.name }}<br>{{ order.shipping_address.address }}{% if order.shipping_address.area %}, {{ order.shipping_address.area }}{% endif %}{% if order.shipping_address.district %}, {{ order.shipping_address.district }}{% endif %}<br>{{ order.shipping_address.phone }}</p>
</td></tr>{% endif %}`

const SUMMARY_SHORT = `<tr><td style="padding:8px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
${ROW('Order', '{{ order.name }}')}
${ROW('Items', '{{ order.item_count }}')}
${ROW('Total', '{{ order.total_price | money }}')}
${ROW('To pay on delivery', '{{ order.cod_amount | money }}', 'order.cod_amount > 0')}
</table>
</td></tr>`

function emailHtml(part: EmailPart): string {
  const button = part.button
    ? `{% if ${part.button.when ?? 'true'} %}<tr><td style="padding:12px 32px 4px;">
<a href="${part.button.url}" style="display:inline-block;background:{{ accent }};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">${part.button.label}</a>
</td></tr>{% endif %}`
    : ''
  const summary = part.summary === 'full' ? SUMMARY_FULL : part.summary === 'short' ? SUMMARY_SHORT : ''
  return `{% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${part.title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td>{% if shop.logo_url %}<img src="{{ shop.logo_url }}" alt="{{ shop.name }}" height="36" style="display:block;height:36px;max-width:180px;border:0;">{% else %}<span style="font-size:20px;font-weight:700;color:#111827;">{{ shop.name }}</span>{% endif %}</td>
<td align="right" style="font-size:13px;color:#6b7280;">Order {{ order.name }}</td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 32px 4px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">${part.title}</h1>
${part.intro}
</td></tr>
${button}
${summary}
<tr><td style="padding:28px 32px 28px;">
<p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">{{ shop.name }}{% if shop.phone %} · {{ shop.phone }}{% endif %}{% if shop.email %} · {{ shop.email }}{% endif %}{% if shop.address %}<br>{{ shop.address }}{% endif %}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

export const EMAIL_DEFAULTS: Record<MessageEvent, { subject: string; template: string }> = Object.fromEntries(
  MESSAGE_EVENTS.map((e) => [e, { subject: EMAIL_PARTS[e].subject, template: emailHtml(EMAIL_PARTS[e]) }]),
) as Record<MessageEvent, { subject: string; template: string }>

// ------------------------------------------------------------------ WhatsApp
// Meta's rules for a message template: no placeholder at the very start or end, never two
// placeholders side by side, and enough words around them. These texts follow them.
export const WHATSAPP_DEFAULTS: Record<MessageEvent, string> = {
  ORDER_CREATED: 'Hi {{customer_first_name}}, thank you for your order {{order_number}} of {{total}}. We will call you shortly to confirm it.\n\nThank you for shopping with {{store_name}} today.',
  ORDER_CONFIRMED: 'Hi {{customer_first_name}}, your order {{order_number}} is confirmed and we are getting it ready. Amount to pay on delivery: {{cod_amount}}.\n\nThank you, the {{store_name}} team',
  PRE_ORDER_CONFIRMED: 'Hi {{customer_first_name}}, your pre-order {{order_number}} is confirmed. We will ship it as soon as it arrives in stock.\n\nThank you, the {{store_name}} team',
  ADVANCE_REQUIRED: 'Hi {{customer_first_name}}, to confirm order {{order_number}} please pay an advance of {{advance_amount}} here: {{track_order_url}} and we will ship it right away.\n\nThank you, the {{store_name}} team',
  PAYMENT_RECEIVED: 'Hi {{customer_first_name}}, we received your payment of {{payment_amount}} for order {{order_number}}. Thank you!\n\nThe {{store_name}} team',
  PAYMENT_FAILED: 'Hi {{customer_first_name}}, your payment of {{payment_amount}} for order {{order_number}} did not go through. You can try again here: {{track_order_url}} at any time.\n\nThe {{store_name}} team',
  ORDER_SHIPPED: 'Hi {{customer_first_name}}, your order {{order_number}} has been handed to {{courier_name}}. Tracking number: {{tracking_number}}. Track it here: {{tracking_url}} anytime.\n\nThe {{store_name}} team',
  OUT_FOR_DELIVERY: 'Hi {{customer_first_name}}, your order {{order_number}} is out for delivery today. Please keep {{cod_amount}} ready for the delivery person.\n\nThe {{store_name}} team',
  ORDER_DELIVERED: 'Hi {{customer_first_name}}, your order {{order_number}} was delivered. We hope you love it! Reply here if anything is not right.\n\nThe {{store_name}} team',
  ORDER_CANCELLED: 'Hi {{customer_first_name}}, your order {{order_number}} has been cancelled. Questions? Call us at {{store_phone}} or reply here.\n\nThe {{store_name}} team',
  RETURN_INITIATED: 'Hi {{customer_first_name}}, the parcel for order {{order_number}} is on its way back to us. Questions? Call us at {{store_phone}} or reply here.\n\nThe {{store_name}} team',
  ORDER_RETURNED: 'Hi {{customer_first_name}}, the returned parcel for order {{order_number}} has reached us. We will be in touch soon.\n\nThe {{store_name}} team',
}

// ------------------------------------------------------------------ placeholders
/** What an email can use, for the editor's list (Liquid paths). */
export const EMAIL_VARIABLES: Array<{ name: string; label: string }> = [
  { name: 'shop.name', label: 'Store name' }, { name: 'shop.phone', label: 'Store phone' }, { name: 'shop.email', label: 'Store email' },
  { name: 'shop.url', label: 'Store website' }, { name: 'shop.logo_url', label: 'Logo address' }, { name: 'shop.accent_color', label: 'Button colour' },
  { name: 'customer.name', label: 'Customer name' }, { name: 'customer.first_name', label: 'First name' }, { name: 'customer.phone', label: 'Customer phone' },
  { name: 'order.name', label: 'Order number' }, { name: 'order.created_at | date: "%d %b %Y"', label: 'Order date' },
  { name: 'order.total_price | money', label: 'Total' }, { name: 'order.subtotal_price | money', label: 'Subtotal' },
  { name: 'order.delivery_price | money', label: 'Delivery charge' }, { name: 'order.discount_price | money', label: 'Discount' },
  { name: 'order.paid_amount | money', label: 'Paid' }, { name: 'order.cod_amount | money', label: 'To pay on delivery' },
  { name: 'order.advance_amount | money', label: 'Advance due' }, { name: 'order.payment_method', label: 'Payment method' },
  { name: 'order.item_count', label: 'Number of items' }, { name: 'order.status_url', label: 'Order status page' },
  { name: 'order.shipping_address.address', label: 'Delivery address' }, { name: 'order.shipping_address.district', label: 'District' },
  { name: 'order.note', label: "Customer's note" }, { name: 'shipment.courier', label: 'Courier' },
  { name: 'shipment.tracking_number', label: 'Tracking number' }, { name: 'shipment.tracking_url', label: 'Tracking link' },
  { name: 'payment.amount | money', label: 'Payment amount' },
]

/** What a WhatsApp text can use (the same names as SMS). */
export const WHATSAPP_VARIABLES: Array<{ name: string; label: string; example: string }> = [
  { name: 'customer_first_name', label: 'First name', example: 'Rahim' },
  { name: 'customer_name', label: 'Customer name', example: 'Rahim Uddin' },
  { name: 'order_number', label: 'Order number', example: 'ISO-1042' },
  { name: 'total', label: 'Total', example: '৳1,250' },
  { name: 'cod_amount', label: 'To pay on delivery', example: '৳1,195' },
  { name: 'due_amount', label: 'Still to pay', example: '৳1,195' },
  { name: 'advance_amount', label: 'Advance due', example: '৳55' },
  { name: 'payment_amount', label: 'Payment amount', example: '৳55' },
  { name: 'courier_name', label: 'Courier', example: 'Steadfast' },
  { name: 'tracking_number', label: 'Tracking number', example: 'SF12345678' },
  { name: 'tracking_url', label: 'Tracking link', example: 'https://steadfast.com.bd/t/SF12345678' },
  { name: 'track_order_url', label: 'Order status page', example: 'https://isolation.com.bd/track-order?order=ISO-1042' },
  { name: 'store_name', label: 'Store name', example: 'Isolation' },
  { name: 'store_phone', label: 'Store phone', example: '01711-000000' },
]

/** A made-up order for previews when the store has none yet. */
export const SAMPLE_DATA: Record<string, unknown> = {
  shop: { name: 'Your Store', phone: '01711-000000', email: 'hello@yourstore.com', url: 'https://yourstore.com', logo_url: null, accent_color: '#111827', address: 'House 12, Road 5, Dhanmondi, Dhaka', currency_symbol: '৳' },
  customer: { name: 'Rahim Uddin', first_name: 'Rahim', phone: '01712-345678', email: 'rahim@example.com' },
  order: {
    name: 'ORD-1042', number: 'ORD-1042', created_at: '2026-10-23T09:30:00Z', status: 'CONFIRMED', payment_method: 'Cash on delivery',
    subtotal_price: 1250, discount_price: 0, delivery_price: 60, total_price: 1310, paid_amount: 55, due_amount: 1255, cod_amount: 1255, advance_amount: 0,
    note: null, item_count: 2, status_url: 'https://yourstore.com/track-order?order=ORD-1042',
    line_items: [
      { title: 'Cotton panjabi', variant_title: 'L / White', sku: 'PJ-L-W', quantity: 1, price: 950, line_price: 950, image_url: null },
      { title: 'Leather belt', variant_title: null, sku: 'BLT-01', quantity: 1, price: 300, line_price: 300, image_url: null },
    ],
    shipping_address: { name: 'Rahim Uddin', phone: '01712-345678', address: 'House 7, Road 3, Mirpur 10', area: 'Mirpur', city: null, district: 'Dhaka', postal_code: null },
  },
  shipment: { courier: 'Steadfast', tracking_number: 'SF12345678', tracking_url: 'https://steadfast.com.bd/t/SF12345678' },
  payment: { amount: 55 },
}
