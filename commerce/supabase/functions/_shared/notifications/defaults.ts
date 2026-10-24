// The default customer messages for every event, in English and Bangla: the emails (HTML +
// Liquid), the WhatsApp texts and the SMS texts; the owner's daily summary email; the sample order
// the editor previews with, and the placeholders the editors offer.
// The messaging migrations store these same texts in public.notification_defaults (a test keeps
// the two equal), so "Reset to default", the message language switch and every new store use them.

export const MESSAGE_EVENTS = [
  'ORDER_CREATED', 'ORDER_CONFIRMED', 'PRE_ORDER_CONFIRMED', 'ADVANCE_REQUIRED', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED',
  'ORDER_SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'RETURN_INITIATED', 'ORDER_RETURNED',
  'CART_REMINDER', 'REVIEW_REQUEST',
] as const
export type MessageEvent = (typeof MESSAGE_EVENTS)[number]

export const LANGUAGES = ['en', 'bn'] as const
export type Lang = (typeof LANGUAGES)[number]

export type EventGroup = 'Order processing' | 'Payments' | 'Order exceptions' | 'Marketing'

/** Where each event shows in the Email and WhatsApp lists (like Shopify's groups), with its description. */
export const EVENT_INFO: Record<MessageEvent, { group: EventGroup; title: string; when: string }> = {
  ORDER_CREATED: { group: 'Order processing', title: 'Order confirmation', when: 'Sent when a customer places an order' },
  ORDER_CONFIRMED: { group: 'Order processing', title: 'Order approved', when: 'Sent when your team approves the order' },
  PRE_ORDER_CONFIRMED: { group: 'Order processing', title: 'Pre-order confirmed', when: 'Sent when a pre-order is approved' },
  ORDER_SHIPPED: { group: 'Order processing', title: 'Shipping confirmation', when: 'Sent when the parcel is handed to the courier' },
  OUT_FOR_DELIVERY: { group: 'Order processing', title: 'Out for delivery', when: 'Sent when the courier is on the way: asks the customer to keep the cash ready' },
  ORDER_DELIVERED: { group: 'Order processing', title: 'Order delivered', when: 'Sent when the courier delivers the parcel' },
  ADVANCE_REQUIRED: { group: 'Payments', title: 'Advance payment needed', when: 'Sent when an order needs an advance before it ships' },
  PAYMENT_RECEIVED: { group: 'Payments', title: 'Payment received', when: 'Sent for every payment you receive for an order' },
  PAYMENT_FAILED: { group: 'Payments', title: 'Payment failed', when: "Sent when a customer's online payment doesn't go through" },
  DELIVERY_FAILED: { group: 'Order exceptions', title: 'Courier could not reach you', when: 'Sent when the courier puts the parcel on hold or a delivery attempt fails' },
  ORDER_CANCELLED: { group: 'Order exceptions', title: 'Order cancelled', when: 'Sent when an order is cancelled' },
  RETURN_INITIATED: { group: 'Order exceptions', title: 'Return started', when: 'Sent when a parcel is on its way back to you' },
  ORDER_RETURNED: { group: 'Order exceptions', title: 'Return received', when: 'Sent when a returned parcel reaches you' },
  CART_REMINDER: { group: 'Marketing', title: 'Abandoned cart reminder', when: 'Sent when a customer leaves checkout without ordering (timing in Settings → Customer messages)' },
  REVIEW_REQUEST: { group: 'Marketing', title: 'Review request', when: 'Sent a few days after delivery, with your review link' },
}

/** The order events, as opposed to the cart reminder (a cart, not an order). */
export const ORDER_EVENTS = MESSAGE_EVENTS.filter((e) => e !== 'CART_REMINDER')

// ------------------------------------------------------------------ email
interface EmailPart {
  subject: string
  title: string
  intro: string
  button?: { label: string; url: string; when?: string }
  summary?: 'full' | 'short' | 'cart' | 'none'
  /** The order confirmation: "Confirm your order" (and a cancel link) when the store asks customers to confirm. */
  confirm?: boolean
}

interface EmailLabels {
  html: string; order: string; summary: string; subtotal: string; discount: string; delivery: string; total: string; paid: string
  toPay: string; address: string; items: string; qty: string; confirm: string; cantTake: string; cancelHere: string; viewOrder: string
}

const LABELS: Record<Lang, EmailLabels> = {
  en: {
    html: 'en', order: 'Order', summary: 'Order summary', subtotal: 'Subtotal', discount: 'Discount', delivery: 'Delivery', total: 'Total', paid: 'Paid',
    toPay: 'To pay on delivery', address: 'Delivery address', items: 'Items', qty: 'Qty', confirm: 'Confirm your order',
    cantTake: "Can't take this order?", cancelHere: 'Cancel it here', viewOrder: 'View your order',
  },
  bn: {
    html: 'bn', order: 'অর্ডার', summary: 'অর্ডারের বিবরণ', subtotal: 'সাবটোটাল', discount: 'ছাড়', delivery: 'ডেলিভারি চার্জ', total: 'মোট', paid: 'পরিশোধিত',
    toPay: 'ডেলিভারিতে পরিশোধ', address: 'ডেলিভারি ঠিকানা', items: 'পণ্য', qty: 'পরিমাণ', confirm: 'অর্ডার কনফার্ম করুন',
    cantTake: 'অর্ডারটি নিতে পারছেন না?', cancelHere: 'এখানে বাতিল করুন', viewOrder: 'অর্ডার দেখুন',
  },
}

const P = 'margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;'
const HI = { en: 'Hi {{ customer.first_name | default: "there" }}', bn: 'প্রিয় {{ customer.first_name | default: "গ্রাহক" }}' }
const VIEW = (lang: Lang) => ({ label: LABELS[lang].viewOrder, url: '{{ order.status_url }}', when: 'order.status_url' })
const TRACK = (label: string) => ({ label, url: '{{ shipment.tracking_url | default: order.status_url }}', when: 'shipment.tracking_url or order.status_url' })

const EMAIL_PARTS: Record<Lang, Record<MessageEvent, EmailPart>> = {
  en: {
    ORDER_CREATED: {
      subject: 'Order {{ order.name }} received',
      title: 'Thank you for your order!',
      intro: `<p style="${P}">${HI.en}, we have received your order {{ order.name }}.{% if order.reply_url %} Please confirm it below so we can send it quickly.{% else %} We will call you shortly to confirm it before it ships.{% endif %}</p>`,
      button: VIEW('en'),
      summary: 'full',
      confirm: true,
    },
    ORDER_CONFIRMED: {
      subject: 'Order {{ order.name }} confirmed',
      title: 'Your order is confirmed',
      intro: `<p style="${P}">${HI.en}, your order {{ order.name }} is confirmed and we are getting it ready.</p>
{% if order.cod_amount > 0 %}<p style="${P}">Please keep <strong>{{ order.cod_amount | money }}</strong> ready to pay on delivery.</p>{% endif %}`,
      button: VIEW('en'),
      summary: 'full',
    },
    PRE_ORDER_CONFIRMED: {
      subject: 'Pre-order {{ order.name }} confirmed',
      title: 'Your pre-order is confirmed',
      intro: `<p style="${P}">${HI.en}, your pre-order {{ order.name }} is confirmed. We will ship it as soon as it arrives in stock.</p>`,
      button: VIEW('en'),
      summary: 'full',
    },
    ADVANCE_REQUIRED: {
      subject: 'Advance payment needed for order {{ order.name }}',
      title: 'One more step to confirm your order',
      intro: `<p style="${P}">${HI.en}, to confirm order {{ order.name }} please pay an advance of <strong>{{ order.advance_amount | money }}</strong>. The rest is paid on delivery.</p>`,
      button: { label: 'Pay the advance', url: '{{ order.status_url }}', when: 'order.status_url' },
      summary: 'full',
    },
    PAYMENT_RECEIVED: {
      subject: 'Payment received for order {{ order.name }}',
      title: 'We received your payment',
      intro: `<p style="${P}">${HI.en}, we received <strong>{{ payment.amount | money }}</strong> for order {{ order.name }}. Thank you!</p>
{% if order.due_amount > 0 %}<p style="${P}">Still to pay on delivery: <strong>{{ order.due_amount | money }}</strong>.</p>{% endif %}`,
      summary: 'short',
    },
    PAYMENT_FAILED: {
      subject: 'Payment for order {{ order.name }} did not go through',
      title: "Your payment didn't go through",
      intro: `<p style="${P}">${HI.en}, your payment of <strong>{{ payment.amount | money }}</strong> for order {{ order.name }} did not go through. No money was taken. You can try again below.</p>`,
      button: { label: 'Try again', url: '{{ order.status_url }}', when: 'order.status_url' },
      summary: 'short',
    },
    ORDER_SHIPPED: {
      subject: 'Order {{ order.name }} is on the way',
      title: 'Your order is on the way',
      intro: `<p style="${P}">${HI.en}, your order {{ order.name }} has been handed to {{ shipment.courier | default: "the courier" }}.</p>
{% if shipment.tracking_number %}<p style="${P}">Tracking number: <strong>{{ shipment.tracking_number }}</strong></p>{% endif %}
{% if order.cod_amount > 0 %}<p style="${P}">Please keep <strong>{{ order.cod_amount | money }}</strong> ready to pay on delivery.</p>{% endif %}`,
      button: TRACK('Track your parcel'),
      summary: 'short',
    },
    OUT_FOR_DELIVERY: {
      subject: 'Order {{ order.name }} is out for delivery',
      title: 'Your order arrives today',
      intro: `<p style="${P}">${HI.en}, your order {{ order.name }} is out for delivery today{% if shipment.courier %} with {{ shipment.courier }}{% endif %}.</p>
{% if order.cod_amount > 0 %}<p style="${P}">Please keep <strong>{{ order.cod_amount | money }}</strong> ready for the delivery person.</p>{% endif %}`,
      button: TRACK('Track your parcel'),
      summary: 'none',
    },
    DELIVERY_FAILED: {
      subject: 'We could not deliver order {{ order.name }}',
      title: 'The courier could not reach you',
      intro: `<p style="${P}">${HI.en}, the courier tried to deliver your order {{ order.name }} but could not reach you.</p>
<p style="${P}">To get it delivered, {% if shop.phone %}call us at {{ shop.phone }} or {% endif %}reply to this email.</p>`,
      button: TRACK('Track your parcel'),
      summary: 'none',
    },
    ORDER_DELIVERED: {
      subject: 'Order {{ order.name }} delivered',
      title: 'Your order was delivered',
      intro: `<p style="${P}">${HI.en}, your order {{ order.name }} was delivered. We hope you love it!</p>
<p style="${P}">If anything is not right, just reply to this email{% if shop.phone %} or call us at {{ shop.phone }}{% endif %}.</p>`,
      summary: 'short',
    },
    ORDER_CANCELLED: {
      subject: 'Order {{ order.name }} cancelled',
      title: 'Your order was cancelled',
      intro: `<p style="${P}">${HI.en}, your order {{ order.name }} has been cancelled.</p>
{% if order.paid_amount > 0 %}<p style="${P}">You paid {{ order.paid_amount | money }} for this order. We will contact you about the refund.</p>{% endif %}
<p style="${P}">Questions? Reply to this email{% if shop.phone %} or call us at {{ shop.phone }}{% endif %}.</p>`,
      summary: 'short',
    },
    RETURN_INITIATED: {
      subject: 'Order {{ order.name }} is being returned',
      title: 'Your order is being returned',
      intro: `<p style="${P}">${HI.en}, the parcel for order {{ order.name }} is on its way back to us.</p>
<p style="${P}">Questions? Reply to this email{% if shop.phone %} or call us at {{ shop.phone }}{% endif %}.</p>`,
      summary: 'none',
    },
    ORDER_RETURNED: {
      subject: 'Return received for order {{ order.name }}',
      title: 'We received your return',
      intro: `<p style="${P}">${HI.en}, the returned parcel for order {{ order.name }} has reached us.</p>
{% if order.paid_amount > 0 %}<p style="${P}">We will contact you about your payment of {{ order.paid_amount | money }}.</p>{% endif %}`,
      summary: 'none',
    },
    CART_REMINDER: {
      subject: 'You left something in your cart',
      title: 'Your cart is waiting',
      intro: `<p style="${P}">${HI.en}, you left these items in your cart at {{ shop.name }}. Finish your order in a minute and pay on delivery.</p>`,
      button: { label: 'Finish your order', url: '{{ cart.url }}', when: 'cart.url' },
      summary: 'cart',
    },
    REVIEW_REQUEST: {
      subject: 'How was your order {{ order.name }}?',
      title: 'How did we do?',
      intro: `<p style="${P}">${HI.en}, we hope you love your order {{ order.name }}. A one-minute review helps other shoppers, and it helps us a lot.</p>`,
      button: { label: 'Write a review', url: '{{ shop.review_url }}', when: 'shop.review_url' },
      summary: 'short',
    },
  },
  bn: {
    ORDER_CREATED: {
      subject: 'অর্ডার {{ order.name }} পেয়েছি',
      title: 'অর্ডারের জন্য ধন্যবাদ!',
      intro: `<p style="${P}">${HI.bn}, আপনার অর্ডার {{ order.name }} আমরা পেয়েছি।{% if order.reply_url %} দ্রুত পাঠানোর জন্য নিচে অর্ডারটি কনফার্ম করুন।{% else %} শিপ করার আগে আমরা ফোন করে কনফার্ম করে নেব।{% endif %}</p>`,
      button: VIEW('bn'),
      summary: 'full',
      confirm: true,
    },
    ORDER_CONFIRMED: {
      subject: 'অর্ডার {{ order.name }} কনফার্ম হয়েছে',
      title: 'আপনার অর্ডার কনফার্ম হয়েছে',
      intro: `<p style="${P}">${HI.bn}, আপনার অর্ডার {{ order.name }} কনফার্ম হয়েছে, আমরা প্রস্তুত করছি।</p>
{% if order.cod_amount > 0 %}<p style="${P}">ডেলিভারির সময় <strong>{{ order.cod_amount | money }}</strong> প্রস্তুত রাখুন।</p>{% endif %}`,
      button: VIEW('bn'),
      summary: 'full',
    },
    PRE_ORDER_CONFIRMED: {
      subject: 'প্রি-অর্ডার {{ order.name }} কনফার্ম হয়েছে',
      title: 'আপনার প্রি-অর্ডার কনফার্ম হয়েছে',
      intro: `<p style="${P}">${HI.bn}, আপনার প্রি-অর্ডার {{ order.name }} কনফার্ম হয়েছে। পণ্য স্টকে আসার সাথে সাথে আমরা পাঠিয়ে দেব।</p>`,
      button: VIEW('bn'),
      summary: 'full',
    },
    ADVANCE_REQUIRED: {
      subject: 'অর্ডার {{ order.name }} এর জন্য অগ্রিম পেমেন্ট প্রয়োজন',
      title: 'অর্ডার কনফার্ম করতে আর এক ধাপ',
      intro: `<p style="${P}">${HI.bn}, অর্ডার {{ order.name }} কনফার্ম করতে <strong>{{ order.advance_amount | money }}</strong> অগ্রিম পরিশোধ করুন। বাকি টাকা দেবেন ডেলিভারির সময়।</p>`,
      button: { label: 'অগ্রিম পরিশোধ করুন', url: '{{ order.status_url }}', when: 'order.status_url' },
      summary: 'full',
    },
    PAYMENT_RECEIVED: {
      subject: 'অর্ডার {{ order.name }} এর পেমেন্ট পেয়েছি',
      title: 'আপনার পেমেন্ট পেয়েছি',
      intro: `<p style="${P}">${HI.bn}, অর্ডার {{ order.name }} এর জন্য <strong>{{ payment.amount | money }}</strong> পেয়েছি। ধন্যবাদ!</p>
{% if order.due_amount > 0 %}<p style="${P}">ডেলিভারিতে বাকি: <strong>{{ order.due_amount | money }}</strong>।</p>{% endif %}`,
      summary: 'short',
    },
    PAYMENT_FAILED: {
      subject: 'অর্ডার {{ order.name }} এর পেমেন্ট সম্পন্ন হয়নি',
      title: 'আপনার পেমেন্ট সম্পন্ন হয়নি',
      intro: `<p style="${P}">${HI.bn}, অর্ডার {{ order.name }} এর জন্য <strong>{{ payment.amount | money }}</strong> পেমেন্ট সম্পন্ন হয়নি। কোনো টাকা কাটা হয়নি। নিচে আবার চেষ্টা করতে পারেন।</p>`,
      button: { label: 'আবার চেষ্টা করুন', url: '{{ order.status_url }}', when: 'order.status_url' },
      summary: 'short',
    },
    ORDER_SHIPPED: {
      subject: 'অর্ডার {{ order.name }} পাঠানো হয়েছে',
      title: 'আপনার অর্ডার পথে আছে',
      intro: `<p style="${P}">${HI.bn}, আপনার অর্ডার {{ order.name }} {{ shipment.courier | default: "কুরিয়ার" }} এর কাছে দেওয়া হয়েছে।</p>
{% if shipment.tracking_number %}<p style="${P}">ট্র্যাকিং নম্বর: <strong>{{ shipment.tracking_number }}</strong></p>{% endif %}
{% if order.cod_amount > 0 %}<p style="${P}">ডেলিভারির সময় <strong>{{ order.cod_amount | money }}</strong> প্রস্তুত রাখুন।</p>{% endif %}`,
      button: TRACK('পার্সেল ট্র্যাক করুন'),
      summary: 'short',
    },
    OUT_FOR_DELIVERY: {
      subject: 'অর্ডার {{ order.name }} আজ ডেলিভারি হবে',
      title: 'আপনার অর্ডার আজ পৌঁছাবে',
      intro: `<p style="${P}">${HI.bn}, আপনার অর্ডার {{ order.name }} আজ ডেলিভারির জন্য বের হয়েছে{% if shipment.courier %} ({{ shipment.courier }}){% endif %}। ফোন খোলা রাখুন।</p>
{% if order.cod_amount > 0 %}<p style="${P}">ডেলিভারি ম্যানের জন্য <strong>{{ order.cod_amount | money }}</strong> প্রস্তুত রাখুন।</p>{% endif %}`,
      button: TRACK('পার্সেল ট্র্যাক করুন'),
      summary: 'none',
    },
    DELIVERY_FAILED: {
      subject: 'অর্ডার {{ order.name }} ডেলিভারি দেওয়া যায়নি',
      title: 'কুরিয়ার আপনাকে পায়নি',
      intro: `<p style="${P}">${HI.bn}, কুরিয়ার আপনার অর্ডার {{ order.name }} ডেলিভারি দিতে গিয়ে আপনাকে পায়নি।</p>
<p style="${P}">আবার পাঠাতে {% if shop.phone %}{{ shop.phone }} নম্বরে কল করুন বা {% endif %}এই ইমেইলের উত্তর দিন।</p>`,
      button: TRACK('পার্সেল ট্র্যাক করুন'),
      summary: 'none',
    },
    ORDER_DELIVERED: {
      subject: 'অর্ডার {{ order.name }} ডেলিভারি হয়েছে',
      title: 'আপনার অর্ডার ডেলিভারি হয়েছে',
      intro: `<p style="${P}">${HI.bn}, আপনার অর্ডার {{ order.name }} ডেলিভারি হয়েছে। আশা করি পছন্দ হয়েছে!</p>
<p style="${P}">কোনো সমস্যা হলে এই ইমেইলের উত্তর দিন{% if shop.phone %} বা {{ shop.phone }} নম্বরে কল করুন{% endif %}।</p>`,
      summary: 'short',
    },
    ORDER_CANCELLED: {
      subject: 'অর্ডার {{ order.name }} বাতিল হয়েছে',
      title: 'আপনার অর্ডার বাতিল হয়েছে',
      intro: `<p style="${P}">${HI.bn}, আপনার অর্ডার {{ order.name }} বাতিল করা হয়েছে।</p>
{% if order.paid_amount > 0 %}<p style="${P}">এই অর্ডারের জন্য আপনি {{ order.paid_amount | money }} পরিশোধ করেছিলেন। রিফান্ডের বিষয়ে আমরা যোগাযোগ করব।</p>{% endif %}
<p style="${P}">প্রশ্ন থাকলে এই ইমেইলের উত্তর দিন{% if shop.phone %} বা {{ shop.phone }} নম্বরে কল করুন{% endif %}।</p>`,
      summary: 'short',
    },
    RETURN_INITIATED: {
      subject: 'অর্ডার {{ order.name }} ফেরত আসছে',
      title: 'আপনার অর্ডার ফেরত আসছে',
      intro: `<p style="${P}">${HI.bn}, অর্ডার {{ order.name }} এর পার্সেল আমাদের কাছে ফেরত আসছে।</p>
<p style="${P}">প্রশ্ন থাকলে এই ইমেইলের উত্তর দিন{% if shop.phone %} বা {{ shop.phone }} নম্বরে কল করুন{% endif %}।</p>`,
      summary: 'none',
    },
    ORDER_RETURNED: {
      subject: 'অর্ডার {{ order.name }} এর ফেরত পেয়েছি',
      title: 'ফেরত পার্সেল পেয়েছি',
      intro: `<p style="${P}">${HI.bn}, অর্ডার {{ order.name }} এর ফেরত পার্সেল আমাদের কাছে পৌঁছেছে।</p>
{% if order.paid_amount > 0 %}<p style="${P}">আপনার {{ order.paid_amount | money }} পেমেন্টের বিষয়ে আমরা যোগাযোগ করব।</p>{% endif %}`,
      summary: 'none',
    },
    CART_REMINDER: {
      subject: 'আপনার কার্টে পণ্য রয়ে গেছে',
      title: 'আপনার কার্ট অপেক্ষা করছে',
      intro: `<p style="${P}">${HI.bn}, {{ shop.name }} এ আপনার কার্টে এই পণ্যগুলো রয়ে গেছে। এক মিনিটে অর্ডার শেষ করুন, টাকা দেবেন ডেলিভারির সময়।</p>`,
      button: { label: 'অর্ডার শেষ করুন', url: '{{ cart.url }}', when: 'cart.url' },
      summary: 'cart',
    },
    REVIEW_REQUEST: {
      subject: 'অর্ডার {{ order.name }} কেমন লাগলো?',
      title: 'আপনার মতামত জানান',
      intro: `<p style="${P}">${HI.bn}, আশা করি অর্ডার {{ order.name }} এর পণ্য পছন্দ হয়েছে। এক মিনিটের একটি রিভিউ অন্য ক্রেতাদের এবং আমাদের অনেক সাহায্য করবে।</p>`,
      button: { label: 'রিভিউ দিন', url: '{{ shop.review_url }}', when: 'shop.review_url' },
      summary: 'short',
    },
  },
}

const TD = 'padding:6px 0;font-size:14px;color:#374151;'
const ROW = (label: string, value: string, when?: string) =>
  `${when ? `{% if ${when} %}` : ''}<tr><td style="${TD}">${label}</td><td align="right" style="${TD}">${value}</td></tr>${when ? '{% endif %}' : ''}`
const HEADING = 'margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;'
const BUTTON = 'display:inline-block;background:{{ accent }};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;'

const itemRows = (list: string, l: EmailLabels) => `{% for item in ${list} %}<tr>
<td width="56" style="padding:12px 12px 12px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">{% if item.image_url %}<img src="{{ item.image_url }}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid #e5e7eb;">{% endif %}</td>
<td style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;line-height:1.4;color:#111827;vertical-align:top;">{{ item.title }}{% if item.variant_title %}<br><span style="color:#6b7280;font-size:13px;">{{ item.variant_title }}</span>{% endif %}<br><span style="color:#6b7280;font-size:13px;">${l.qty} {{ item.quantity }}</span></td>
<td align="right" style="padding:12px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111827;vertical-align:top;white-space:nowrap;">{{ item.line_price | money }}</td>
</tr>{% endfor %}`

const summaryFull = (l: EmailLabels) => `<tr><td style="padding:8px 32px 0;">
<p style="${HEADING}">${l.summary}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
${itemRows('order.line_items', l)}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
${ROW(l.subtotal, '{{ order.subtotal_price | money }}')}
${ROW(l.discount, '-{{ order.discount_price | money }}', 'order.discount_price > 0')}
${ROW(l.delivery, '{{ order.delivery_price | money }}')}
<tr><td style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">${l.total}</td><td align="right" style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;">{{ order.total_price | money }}</td></tr>
${ROW(l.paid, '{{ order.paid_amount | money }}', 'order.paid_amount > 0')}
${ROW(`<strong>${l.toPay}</strong>`, '<strong>{{ order.cod_amount | money }}</strong>', 'order.cod_amount > 0')}
</table>
</td></tr>
{% if order.shipping_address.address %}<tr><td style="padding:20px 32px 0;">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">${l.address}</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">{{ order.shipping_address.name }}<br>{{ order.shipping_address.address }}{% if order.shipping_address.area %}, {{ order.shipping_address.area }}{% endif %}{% if order.shipping_address.district %}, {{ order.shipping_address.district }}{% endif %}<br>{{ order.shipping_address.phone }}</p>
</td></tr>{% endif %}`

const summaryShort = (l: EmailLabels) => `<tr><td style="padding:8px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
${ROW(l.order, '{{ order.name }}')}
${ROW(l.items, '{{ order.item_count }}')}
${ROW(l.total, '{{ order.total_price | money }}')}
${ROW(l.toPay, '{{ order.cod_amount | money }}', 'order.cod_amount > 0')}
</table>
</td></tr>`

const summaryCart = (l: EmailLabels) => `<tr><td style="padding:8px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
${itemRows('cart.line_items', l)}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
<tr><td style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;">${l.total}</td><td align="right" style="padding:10px 0 6px;font-size:16px;font-weight:700;color:#111827;">{{ cart.total | money }}</td></tr>
</table>
</td></tr>`

function emailHtml(part: EmailPart, lang: Lang): string {
  const l = LABELS[lang]
  const plain = part.button
    ? `{% if ${part.button.when ?? 'true'} %}<tr><td style="padding:12px 32px 4px;">
<a href="${part.button.url}" style="${BUTTON}">${part.button.label}</a>
</td></tr>{% endif %}`
    : ''
  // The order confirmation asks the customer to confirm (a page with Confirm and Cancel) when the store uses it.
  const button = part.confirm
    ? `{% if order.reply_url %}<tr><td style="padding:12px 32px 4px;">
<a href="{{ order.reply_url }}" style="${BUTTON}">${l.confirm}</a>
<p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">${l.cantTake} <a href="{{ order.reply_url }}?action=cancel" style="color:#6b7280;">${l.cancelHere}</a></p>
</td></tr>{% else %}${plain}{% endif %}`
    : plain
  const summary = part.summary === 'full' ? summaryFull(l) : part.summary === 'short' ? summaryShort(l) : part.summary === 'cart' ? summaryCart(l) : ''
  return `{% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="${l.html}">
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
<td align="right" style="font-size:13px;color:#6b7280;">{% if order.name %}${l.order} {{ order.name }}{% endif %}</td>
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

type EmailDefaults = Record<MessageEvent, { subject: string; template: string }>
const emailDefaults = (lang: Lang): EmailDefaults => Object.fromEntries(
  MESSAGE_EVENTS.map((e) => [e, { subject: EMAIL_PARTS[lang][e].subject, template: emailHtml(EMAIL_PARTS[lang][e], lang) }]),
) as EmailDefaults

export const EMAIL_DEFAULTS: EmailDefaults = emailDefaults('en')
export const EMAIL_DEFAULTS_BN: EmailDefaults = emailDefaults('bn')

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
  DELIVERY_FAILED: 'Hi {{customer_first_name}}, the courier could not reach you with your order {{order_number}}. Please call us at {{store_phone}} or reply here so we can send it again.\n\nThe {{store_name}} team',
  ORDER_DELIVERED: 'Hi {{customer_first_name}}, your order {{order_number}} was delivered. We hope you love it! Reply here if anything is not right.\n\nThe {{store_name}} team',
  ORDER_CANCELLED: 'Hi {{customer_first_name}}, your order {{order_number}} has been cancelled. Questions? Call us at {{store_phone}} or reply here.\n\nThe {{store_name}} team',
  RETURN_INITIATED: 'Hi {{customer_first_name}}, the parcel for order {{order_number}} is on its way back to us. Questions? Call us at {{store_phone}} or reply here.\n\nThe {{store_name}} team',
  ORDER_RETURNED: 'Hi {{customer_first_name}}, the returned parcel for order {{order_number}} has reached us. We will be in touch soon.\n\nThe {{store_name}} team',
  CART_REMINDER: 'Hi {{customer_first_name}}, you left items worth {{cart_total}} in your cart. Finish your order here: {{cart_url}} and pay on delivery.\n\nThe {{store_name}} team',
  REVIEW_REQUEST: 'Hi {{customer_first_name}}, how do you like your order {{order_number}}? A quick review would help us a lot: {{review_url}} Thank you!\n\nThe {{store_name}} team',
}

export const WHATSAPP_DEFAULTS_BN: Record<MessageEvent, string> = {
  ORDER_CREATED: 'প্রিয় {{customer_first_name}}, আপনার অর্ডার {{order_number}} আমরা পেয়েছি, মোট মূল্য {{total}}। শিপ করার আগে আমরা আপনার সাথে কনফার্ম করে নেব।\n\n{{store_name}} থেকে কেনাকাটার জন্য ধন্যবাদ।',
  ORDER_CONFIRMED: 'প্রিয় {{customer_first_name}}, আপনার অর্ডার {{order_number}} কনফার্ম হয়েছে, আমরা প্রস্তুত করছি। ডেলিভারির সময় পরিশোধ করবেন {{cod_amount}}।\n\nধন্যবাদ, {{store_name}} টিম',
  PRE_ORDER_CONFIRMED: 'প্রিয় {{customer_first_name}}, আপনার প্রি-অর্ডার {{order_number}} কনফার্ম হয়েছে। পণ্য স্টকে আসার সাথে সাথে আমরা পাঠিয়ে দেব।\n\nধন্যবাদ, {{store_name}} টিম',
  ADVANCE_REQUIRED: 'প্রিয় {{customer_first_name}}, অর্ডার {{order_number}} কনফার্ম করতে {{advance_amount}} অগ্রিম পরিশোধ করুন এই লিংকে: {{track_order_url}} এরপরই আমরা পাঠিয়ে দেব।\n\nধন্যবাদ, {{store_name}} টিম',
  PAYMENT_RECEIVED: 'প্রিয় {{customer_first_name}}, অর্ডার {{order_number}} এর জন্য আপনার {{payment_amount}} পেমেন্ট আমরা পেয়েছি। ধন্যবাদ!\n\n{{store_name}} টিম',
  PAYMENT_FAILED: 'প্রিয় {{customer_first_name}}, অর্ডার {{order_number}} এর জন্য আপনার {{payment_amount}} পেমেন্ট সম্পন্ন হয়নি। এই লিংকে আবার চেষ্টা করুন: {{track_order_url}} যেকোনো সময়।\n\n{{store_name}} টিম',
  ORDER_SHIPPED: 'প্রিয় {{customer_first_name}}, আপনার অর্ডার {{order_number}} পাঠানো হয়েছে, কুরিয়ার: {{courier_name}}। ট্র্যাকিং নম্বর: {{tracking_number}}। ট্র্যাক করুন এখানে: {{tracking_url}} যেকোনো সময়।\n\n{{store_name}} টিম',
  OUT_FOR_DELIVERY: 'প্রিয় {{customer_first_name}}, আপনার অর্ডার {{order_number}} আজ ডেলিভারির জন্য বের হয়েছে। ডেলিভারি ম্যানের জন্য {{cod_amount}} প্রস্তুত রাখুন এবং ফোন খোলা রাখুন।\n\n{{store_name}} টিম',
  DELIVERY_FAILED: 'প্রিয় {{customer_first_name}}, কুরিয়ার আপনার অর্ডার {{order_number}} ডেলিভারি দিতে গিয়ে আপনাকে পায়নি। আবার পাঠাতে {{store_phone}} নম্বরে কল করুন বা এখানে উত্তর দিন।\n\n{{store_name}} টিম',
  ORDER_DELIVERED: 'প্রিয় {{customer_first_name}}, আপনার অর্ডার {{order_number}} ডেলিভারি হয়েছে। আশা করি পছন্দ হয়েছে! কোনো সমস্যা হলে এখানে জানান।\n\n{{store_name}} টিম',
  ORDER_CANCELLED: 'প্রিয় {{customer_first_name}}, আপনার অর্ডার {{order_number}} বাতিল করা হয়েছে। কোনো প্রশ্ন থাকলে {{store_phone}} নম্বরে কল করুন বা এখানে উত্তর দিন।\n\n{{store_name}} টিম',
  RETURN_INITIATED: 'প্রিয় {{customer_first_name}}, অর্ডার {{order_number}} এর পার্সেল আমাদের কাছে ফেরত আসছে। কোনো প্রশ্ন থাকলে {{store_phone}} নম্বরে কল করুন বা এখানে উত্তর দিন।\n\n{{store_name}} টিম',
  ORDER_RETURNED: 'প্রিয় {{customer_first_name}}, অর্ডার {{order_number}} এর ফেরত পার্সেল আমরা পেয়েছি। শীঘ্রই আপনার সাথে যোগাযোগ করব।\n\n{{store_name}} টিম',
  CART_REMINDER: 'প্রিয় {{customer_first_name}}, আপনার কার্টে {{cart_total}} মূল্যের পণ্য রয়ে গেছে। অর্ডার শেষ করুন এখানে: {{cart_url}} টাকা দেবেন ডেলিভারির সময়।\n\n{{store_name}} টিম',
  REVIEW_REQUEST: 'প্রিয় {{customer_first_name}}, অর্ডার {{order_number}} কেমন লাগলো? আপনার একটি রিভিউ আমাদের অনেক সাহায্য করবে: {{review_url}} ধন্যবাদ!\n\n{{store_name}} টিম',
}

/** The two quick-reply buttons under the order confirmation (Meta: up to 25 characters each). */
export const WHATSAPP_BUTTONS: Record<Lang, { confirm: string; cancel: string }> = {
  en: { confirm: 'Confirm order', cancel: 'Cancel order' },
  bn: { confirm: 'অর্ডার কনফার্ম', cancel: 'অর্ডার বাতিল' },
}

/**
 * The order confirmation's WhatsApp text when it carries those buttons: it asks for a tap instead of
 * promising a call. The editor switches a still-default text to this one (and back) with the buttons.
 */
export const WHATSAPP_CONFIRM_TEXT: Record<Lang, string> = {
  en: 'Hi {{customer_first_name}}, thank you for your order {{order_number}} of {{total}}. Please tap *Confirm order* below so we can send it quickly, or *Cancel order* if you changed your mind.\n\nThank you for shopping with {{store_name}} today.',
  bn: 'প্রিয় {{customer_first_name}}, আপনার অর্ডার {{order_number}} আমরা পেয়েছি, মোট মূল্য {{total}}। দ্রুত পাঠানোর জন্য নিচের *অর্ডার কনফার্ম* বাটনে চাপ দিন, মত বদলালে *অর্ডার বাতিল* চাপুন।\n\n{{store_name}} থেকে কেনাকাটার জন্য ধন্যবাদ।',
}

/** What the customer gets in the chat after tapping a button (the chat is open, so it is free). */
export const REPLY_TEXTS: Record<Lang, Record<'confirmed' | 'cancelled' | 'cancel_requested' | 'closed', string>> = {
  en: {
    confirmed: 'Thank you! Your order {{order_number}} is confirmed. We will send it soon.',
    cancelled: 'Your order {{order_number}} is cancelled. Message us here any time if you change your mind.',
    cancel_requested: 'We got your request to cancel order {{order_number}}. Our team will contact you shortly.',
    closed: 'Your order {{order_number}} can no longer be changed here. Please message us and we will help.',
  },
  bn: {
    confirmed: 'ধন্যবাদ! আপনার অর্ডার {{order_number}} কনফার্ম হয়েছে। শীঘ্রই পাঠিয়ে দেব।',
    cancelled: 'আপনার অর্ডার {{order_number}} বাতিল করা হয়েছে। মত বদলালে যেকোনো সময় এখানে মেসেজ দিন।',
    cancel_requested: 'অর্ডার {{order_number}} বাতিলের অনুরোধ পেয়েছি। আমাদের টিম শীঘ্রই যোগাযোগ করবে।',
    closed: 'অর্ডার {{order_number}} এখন আর এখান থেকে বদলানো যাবে না। মেসেজ দিন, আমরা সাহায্য করব।',
  },
}

// ------------------------------------------------------------------ SMS
// English: the texts every store started with. Bangla SMS are Unicode (70 characters a part), so
// they are kept short.
export const SMS_DEFAULTS: Record<MessageEvent, string> = {
  ORDER_CREATED: 'Hi {{customer_name}}, thanks for your order {{order_number}} ({{total}}). We will confirm it shortly. - {{store_name}}',
  ORDER_CONFIRMED: 'Your order {{order_number}} is confirmed and being prepared. Total due on delivery: {{cod_amount}}. - {{store_name}}',
  PRE_ORDER_CONFIRMED: 'Your pre-order {{order_number}} is confirmed. We will ship it as soon as it arrives in stock. - {{store_name}}',
  ADVANCE_REQUIRED: 'To confirm order {{order_number}}, please pay an advance of {{advance_amount}}. Pay here: {{track_order_url}} - {{store_name}}',
  PAYMENT_RECEIVED: 'We received {{payment_amount}} for order {{order_number}}. Thank you! - {{store_name}}',
  PAYMENT_FAILED: 'Your payment of {{payment_amount}} for order {{order_number}} did not go through. Try again: {{track_order_url}} - {{store_name}}',
  ORDER_SHIPPED: 'Your order {{order_number}} has been handed to {{courier_name}}. Tracking: {{tracking_number}} {{tracking_url}} - {{store_name}}',
  OUT_FOR_DELIVERY: 'Your order {{order_number}} is out for delivery today. Please keep {{cod_amount}} ready. - {{store_name}}',
  DELIVERY_FAILED: 'The courier could not reach you with order {{order_number}}. Please call {{store_phone}} to get it delivered. - {{store_name}}',
  ORDER_DELIVERED: 'Your order {{order_number}} was delivered. We hope you love it! - {{store_name}}',
  ORDER_CANCELLED: 'Your order {{order_number}} has been cancelled. Questions? Call {{store_phone}}. - {{store_name}}',
  RETURN_INITIATED: 'Your order {{order_number}} is being returned to us. Questions? Call {{store_phone}}. - {{store_name}}',
  ORDER_RETURNED: 'We have received the return for order {{order_number}}. - {{store_name}}',
  CART_REMINDER: 'You left items in your cart ({{cart_total}}). Finish your order: {{cart_url}} - {{store_name}}',
  REVIEW_REQUEST: 'How was your order {{order_number}}? Please leave a quick review: {{review_url}} - {{store_name}}',
}

export const SMS_DEFAULTS_BN: Record<MessageEvent, string> = {
  ORDER_CREATED: 'আপনার অর্ডার {{order_number}} ({{total}}) পেয়েছি। শীঘ্রই কনফার্ম করা হবে। - {{store_name}}',
  ORDER_CONFIRMED: 'আপনার অর্ডার {{order_number}} কনফার্ম হয়েছে। ডেলিভারিতে পরিশোধ: {{cod_amount}} - {{store_name}}',
  PRE_ORDER_CONFIRMED: 'আপনার প্রি-অর্ডার {{order_number}} কনফার্ম হয়েছে। স্টকে এলেই পাঠানো হবে। - {{store_name}}',
  ADVANCE_REQUIRED: 'অর্ডার {{order_number}} কনফার্ম করতে {{advance_amount}} অগ্রিম দিন: {{track_order_url}} - {{store_name}}',
  PAYMENT_RECEIVED: 'অর্ডার {{order_number}} এর {{payment_amount}} পেমেন্ট পেয়েছি। ধন্যবাদ! - {{store_name}}',
  PAYMENT_FAILED: 'অর্ডার {{order_number}} এর {{payment_amount}} পেমেন্ট হয়নি। আবার চেষ্টা করুন: {{track_order_url}} - {{store_name}}',
  ORDER_SHIPPED: 'অর্ডার {{order_number}} পাঠানো হয়েছে ({{courier_name}})। ট্র্যাকিং: {{tracking_number}} - {{store_name}}',
  OUT_FOR_DELIVERY: 'অর্ডার {{order_number}} আজ ডেলিভারি হবে। {{cod_amount}} প্রস্তুত রাখুন। - {{store_name}}',
  DELIVERY_FAILED: 'কুরিয়ার আপনাকে পায়নি (অর্ডার {{order_number}})। ডেলিভারির জন্য কল করুন {{store_phone}} - {{store_name}}',
  ORDER_DELIVERED: 'অর্ডার {{order_number}} ডেলিভারি হয়েছে। ধন্যবাদ! - {{store_name}}',
  ORDER_CANCELLED: 'অর্ডার {{order_number}} বাতিল হয়েছে। প্রশ্ন থাকলে কল করুন {{store_phone}} - {{store_name}}',
  RETURN_INITIATED: 'অর্ডার {{order_number}} ফেরত আসছে। প্রশ্ন থাকলে কল করুন {{store_phone}} - {{store_name}}',
  ORDER_RETURNED: 'অর্ডার {{order_number}} এর ফেরত পার্সেল পেয়েছি। - {{store_name}}',
  CART_REMINDER: 'আপনার কার্টে পণ্য রয়ে গেছে ({{cart_total}})। অর্ডার করুন: {{cart_url}} - {{store_name}}',
  REVIEW_REQUEST: 'অর্ডার {{order_number}} কেমন লাগলো? রিভিউ দিন: {{review_url}} - {{store_name}}',
}

/** Every default text of one language, as notification_defaults keeps them. */
export function messageDefaults(lang: Lang): { email: EmailDefaults; whatsapp: Record<MessageEvent, string>; sms: Record<MessageEvent, string> } {
  return lang === 'bn'
    ? { email: EMAIL_DEFAULTS_BN, whatsapp: WHATSAPP_DEFAULTS_BN, sms: SMS_DEFAULTS_BN }
    : { email: EMAIL_DEFAULTS, whatsapp: WHATSAPP_DEFAULTS, sms: SMS_DEFAULTS }
}

// ------------------------------------------------------------------ the owner's daily summary
const SUMMARY_LABELS: Record<Lang, Record<string, string>> = {
  en: {
    subject: '{{ shop.name }}: yesterday in numbers ({{ summary.date }})', title: 'Yesterday at {{ shop.name }}', orders: 'New orders',
    approved: 'Approved', shipped: 'Handed to couriers', delivered: 'Delivered', returned: 'Returned', cancelled: 'Cancelled',
    ads: 'Ad spend', profit: 'Profit (delivered orders)', waiting: 'Web orders still waiting for a call', open: 'Open the dashboard',
    note: 'Profit is sales of what was delivered yesterday minus product, courier, ad and other costs recorded in Finance.',
    why: 'You get this email because the daily summary is on in Settings → Customer messages.',
  },
  bn: {
    subject: '{{ shop.name }}: গতকালের হিসাব ({{ summary.date }})', title: 'গতকাল {{ shop.name }} এ', orders: 'নতুন অর্ডার',
    approved: 'অনুমোদিত', shipped: 'কুরিয়ারে পাঠানো', delivered: 'ডেলিভারি হয়েছে', returned: 'ফেরত এসেছে', cancelled: 'বাতিল',
    ads: 'বিজ্ঞাপন খরচ', profit: 'লাভ (ডেলিভারি হওয়া অর্ডার)', waiting: 'কলের অপেক্ষায় থাকা ওয়েব অর্ডার', open: 'ড্যাশবোর্ড খুলুন',
    note: 'লাভ = গতকাল ডেলিভারি হওয়া অর্ডারের বিক্রি থেকে পণ্য, কুরিয়ার, বিজ্ঞাপন ও অন্যান্য খরচ বাদে (Finance এর হিসাব অনুযায়ী)।',
    why: 'Settings → Customer messages এ দৈনিক সারাংশ চালু আছে বলে এই ইমেইল পাচ্ছেন।',
  },
}

function summaryEmail(lang: Lang): { subject: string; template: string } {
  const t = SUMMARY_LABELS[lang]
  const line = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#374151;">${label}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:${strong ? 16 : 14}px;${strong ? 'font-weight:700;' : ''}color:#111827;white-space:nowrap;">${value}</td></tr>`
  return {
    subject: t.subject,
    template: `{% assign accent = shop.accent_color | default: "#111827" %}<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td style="padding:28px 32px 4px;">
<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">{{ summary.date }}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;">${t.title}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
${line(t.orders, '{{ summary.orders }} · {{ summary.orders_value | money }}')}
${line(t.approved, '{{ summary.approved }}')}
${line(t.shipped, '{{ summary.shipped }}')}
${line(t.delivered, '{{ summary.delivered }} · {{ summary.delivered_value | money }}')}
${line(t.returned, '{{ summary.returned }}')}
${line(t.cancelled, '{{ summary.cancelled }}')}
${line(t.ads, '{{ summary.ad_spend | money }}')}
${line(t.profit, '{{ summary.profit | money }}', true)}
${line(t.waiting, '{{ summary.waiting }}')}
</table>
<p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">${t.note}</p>
</td></tr>
{% if summary.admin_url %}<tr><td style="padding:16px 32px 4px;">
<a href="{{ summary.admin_url }}" style="${BUTTON}">${t.open}</a>
</td></tr>{% endif %}
<tr><td style="padding:24px 32px 28px;">
<p style="margin:0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;">${t.why}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`,
  }
}

export const SUMMARY_EMAIL: Record<Lang, { subject: string; template: string }> = { en: summaryEmail('en'), bn: summaryEmail('bn') }

// ------------------------------------------------------------------ placeholders
/** What an email can use, for the editor's list (Liquid paths); `events` limits one to the events that have it. */
export const EMAIL_VARIABLES: Array<{ name: string; label: string; events?: MessageEvent[] }> = [
  { name: 'shop.name', label: 'Store name' }, { name: 'shop.phone', label: 'Store phone' }, { name: 'shop.email', label: 'Store email' },
  { name: 'shop.url', label: 'Store website' }, { name: 'shop.logo_url', label: 'Logo address' }, { name: 'shop.accent_color', label: 'Button colour' },
  { name: 'customer.name', label: 'Customer name' }, { name: 'customer.first_name', label: 'First name' }, { name: 'customer.phone', label: 'Customer phone' },
  { name: 'order.name', label: 'Order number', events: [...ORDER_EVENTS] }, { name: 'order.created_at | date: "%d %b %Y"', label: 'Order date', events: [...ORDER_EVENTS] },
  { name: 'order.total_price | money', label: 'Total', events: [...ORDER_EVENTS] }, { name: 'order.subtotal_price | money', label: 'Subtotal', events: [...ORDER_EVENTS] },
  { name: 'order.delivery_price | money', label: 'Delivery charge', events: [...ORDER_EVENTS] }, { name: 'order.discount_price | money', label: 'Discount', events: [...ORDER_EVENTS] },
  { name: 'order.paid_amount | money', label: 'Paid', events: [...ORDER_EVENTS] }, { name: 'order.cod_amount | money', label: 'To pay on delivery', events: [...ORDER_EVENTS] },
  { name: 'order.advance_amount | money', label: 'Advance due', events: [...ORDER_EVENTS] }, { name: 'order.payment_method', label: 'Payment method', events: [...ORDER_EVENTS] },
  { name: 'order.item_count', label: 'Number of items', events: [...ORDER_EVENTS] }, { name: 'order.status_url', label: 'Order status page', events: [...ORDER_EVENTS] },
  { name: 'order.reply_url', label: 'Confirm / cancel page', events: ['ORDER_CREATED'] },
  { name: 'order.shipping_address.address', label: 'Delivery address', events: [...ORDER_EVENTS] }, { name: 'order.shipping_address.district', label: 'District', events: [...ORDER_EVENTS] },
  { name: 'order.note', label: "Customer's note", events: [...ORDER_EVENTS] }, { name: 'shipment.courier', label: 'Courier', events: [...ORDER_EVENTS] },
  { name: 'shipment.tracking_number', label: 'Tracking number', events: [...ORDER_EVENTS] }, { name: 'shipment.tracking_url', label: 'Tracking link', events: [...ORDER_EVENTS] },
  { name: 'payment.amount | money', label: 'Payment amount', events: ['PAYMENT_RECEIVED', 'PAYMENT_FAILED'] },
  { name: 'cart.url', label: 'Cart link', events: ['CART_REMINDER'] }, { name: 'cart.total | money', label: 'Cart total', events: ['CART_REMINDER'] },
  { name: 'cart.item_count', label: 'Items in the cart', events: ['CART_REMINDER'] },
  { name: 'shop.review_url', label: 'Review link', events: ['REVIEW_REQUEST'] },
  { name: 'unsubscribe_url', label: 'Unsubscribe link', events: ['CART_REMINDER', 'REVIEW_REQUEST'] },
]

/** The emails a customer can unsubscribe from: offers and reminders, never order updates. */
export const UNSUBSCRIBE_EVENTS: MessageEvent[] = ['CART_REMINDER', 'REVIEW_REQUEST']

/** The line added under a cart reminder or review request that has no unsubscribe link of its own. */
export const UNSUBSCRIBE_TEXT: Record<Lang, { line: string; link: string }> = {
  en: { line: 'Don’t want these emails?', link: 'Unsubscribe' },
  bn: { line: 'এমন ইমেইল আর চান না?', link: 'আনসাবস্ক্রাইব করুন' },
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The email with an unsubscribe line at the bottom, unless its template already links to the page. */
export function withUnsubscribeFooter(html: string, url: string, lang: Lang = 'en'): string {
  if (html.includes(url)) return html
  const t = UNSUBSCRIBE_TEXT[lang] ?? UNSUBSCRIBE_TEXT.en
  const footer = `<div style="text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#6b7280;padding:4px 12px 28px;">${t.line} <a href="${attr(url)}" style="color:#6b7280;text-decoration:underline;">${t.link}</a></div>`
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : html + footer
}

/** What a WhatsApp or SMS text can use (the same names in both). */
export const WHATSAPP_VARIABLES: Array<{ name: string; label: string; example: string; events?: MessageEvent[] }> = [
  { name: 'customer_first_name', label: 'First name', example: 'Rahim' },
  { name: 'customer_name', label: 'Customer name', example: 'Rahim Uddin' },
  { name: 'order_number', label: 'Order number', example: 'ISO-1042', events: [...ORDER_EVENTS] },
  { name: 'total', label: 'Total', example: '৳1,250', events: [...ORDER_EVENTS] },
  { name: 'cod_amount', label: 'To pay on delivery', example: '৳1,195', events: [...ORDER_EVENTS] },
  { name: 'due_amount', label: 'Still to pay', example: '৳1,195', events: [...ORDER_EVENTS] },
  { name: 'advance_amount', label: 'Advance due', example: '৳55', events: [...ORDER_EVENTS] },
  { name: 'payment_amount', label: 'Payment amount', example: '৳55', events: ['PAYMENT_RECEIVED', 'PAYMENT_FAILED'] },
  { name: 'courier_name', label: 'Courier', example: 'Steadfast', events: [...ORDER_EVENTS] },
  { name: 'tracking_number', label: 'Tracking number', example: 'SF12345678', events: [...ORDER_EVENTS] },
  { name: 'tracking_url', label: 'Tracking link', example: 'https://steadfast.com.bd/t/SF12345678', events: [...ORDER_EVENTS] },
  { name: 'track_order_url', label: 'Order status page', example: 'https://isolation.com.bd/track-order?order=ISO-1042', events: [...ORDER_EVENTS] },
  { name: 'cart_total', label: 'Cart total', example: '৳1,250', events: ['CART_REMINDER'] },
  { name: 'cart_url', label: 'Cart link', example: 'https://isolation.com.bd/cart?restore=8f3a2c', events: ['CART_REMINDER'] },
  { name: 'review_url', label: 'Review link', example: 'https://www.facebook.com/isolation/reviews', events: ['REVIEW_REQUEST'] },
  { name: 'store_name', label: 'Store name', example: 'Isolation' },
  { name: 'store_phone', label: 'Store phone', example: '01711-000000' },
]

/** A made-up order (and cart) for previews when the store has none yet. */
export const SAMPLE_DATA: Record<string, unknown> = {
  shop: { name: 'Your Store', phone: '01711-000000', email: 'hello@yourstore.com', url: 'https://yourstore.com', logo_url: null, accent_color: '#111827', address: 'House 12, Road 5, Dhanmondi, Dhaka', currency_symbol: '৳', review_url: 'https://www.facebook.com/yourstore/reviews' },
  customer: { name: 'Rahim Uddin', first_name: 'Rahim', phone: '01712-345678', email: 'rahim@example.com' },
  order: {
    name: 'ORD-1042', number: 'ORD-1042', created_at: '2026-10-23T09:30:00Z', status: 'CONFIRMED', payment_method: 'Cash on delivery',
    subtotal_price: 1250, discount_price: 0, delivery_price: 60, total_price: 1310, paid_amount: 55, due_amount: 1255, cod_amount: 1255, advance_amount: 0,
    note: null, item_count: 2, status_url: 'https://yourstore.com/track-order?order=ORD-1042', reply_url: 'https://fullfilio.com/order-confirm/sample',
    line_items: [
      { title: 'Cotton panjabi', variant_title: 'L / White', sku: 'PJ-L-W', quantity: 1, price: 950, line_price: 950, image_url: null },
      { title: 'Leather belt', variant_title: null, sku: 'BLT-01', quantity: 1, price: 300, line_price: 300, image_url: null },
    ],
    shipping_address: { name: 'Rahim Uddin', phone: '01712-345678', address: 'House 7, Road 3, Mirpur 10', area: 'Mirpur', city: null, district: 'Dhaka', postal_code: null },
  },
  shipment: { courier: 'Steadfast', tracking_number: 'SF12345678', tracking_url: 'https://steadfast.com.bd/t/SF12345678' },
  payment: { amount: 55 },
  cart: {
    url: 'https://yourstore.com/cart?restore=sample', total: 1250, item_count: 2,
    line_items: [
      { title: 'Cotton panjabi', variant_title: 'L / White', quantity: 1, price: 950, line_price: 950, image_url: null },
      { title: 'Leather belt', variant_title: null, quantity: 1, price: 300, line_price: 300, image_url: null },
    ],
  },
}

/** A made-up day for the daily summary preview. */
export const SAMPLE_SUMMARY: Record<string, unknown> = {
  shop: SAMPLE_DATA.shop,
  summary: {
    date: '22 Oct 2026', orders: 64, orders_value: 81250, approved: 51, shipped: 47, delivered: 39, delivered_value: 49870,
    returned: 6, cancelled: 9, ad_spend: 6400, profit: 11230, waiting: 12, admin_url: 'https://fullfilio.com/admin',
  },
}
