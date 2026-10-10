import type { BadgeVariant } from '@/components/ui/badge'
import type { Enums } from '@/types/database'

export type OrderStatus = Enums<'order_status'>
export type PaymentStatus = Enums<'payment_status'>
export type FraudStatus = Enums<'fraud_status'>
export type RiskLevel = Enums<'risk_level'>
export type ProductionStatus = Enums<'production_status'>
export type ShipmentStatus = Enums<'shipment_status'>

interface Meta {
  label: string
  variant: BadgeVariant
}

export const ORDER_STATUS: Record<OrderStatus, Meta & { customer: string }> = {
  PENDING: { label: 'Pending', variant: 'neutral', customer: 'Received' },
  FRAUD_CHECK: { label: 'Risk check', variant: 'neutral', customer: 'Received' },
  ADVANCE_REQUIRED: { label: 'Advance required', variant: 'warning', customer: 'Awaiting payment' },
  FRAUD_REVIEW: { label: 'Fraud review', variant: 'danger', customer: 'Being confirmed' },
  CONFIRMATION_REQUIRED: { label: 'Awaiting approval', variant: 'warning', customer: 'Being confirmed' },
  CONFIRMED: { label: 'Approved', variant: 'info', customer: 'Confirmed' },
  PRE_ORDER: { label: 'Pre-order', variant: 'violet', customer: 'Pre-order — ships when stock arrives' },
  PROCESSING: { label: 'Processing', variant: 'info', customer: 'Preparing' },
  PRODUCTION: { label: 'In production', variant: 'violet', customer: 'Preparing' },
  QUALITY_CHECK: { label: 'Quality check', variant: 'violet', customer: 'Preparing' },
  PACKING: { label: 'Packing', variant: 'violet', customer: 'Packing' },
  READY_TO_SHIP: { label: 'Ready to ship', variant: 'info', customer: 'Ready to ship' },
  SHIPPED: { label: 'Shipped', variant: 'info', customer: 'On the way' },
  PENDING_CANCEL: { label: 'Cancelling', variant: 'warning', customer: 'Being cancelled' },
  DELIVERED: { label: 'Delivered', variant: 'success', customer: 'Delivered' },
  PARTIALLY_DELIVERED: { label: 'Partly delivered', variant: 'success', customer: 'Partly delivered' },
  CANCELLED: { label: 'Cancelled', variant: 'neutral', customer: 'Cancelled' },
  RETURN_REQUESTED: { label: 'Return requested', variant: 'warning', customer: 'Return requested' },
  RETURNING: { label: 'Returning', variant: 'warning', customer: 'Returning' },
  RETURNED: { label: 'Returned', variant: 'neutral', customer: 'Returned' },
  FAILED_DELIVERY: { label: 'Failed delivery', variant: 'danger', customer: 'Delivery failed' },
  LOST: { label: 'Lost by courier', variant: 'danger', customer: 'Courier problem — we will contact you' },
  REJECTED_FRAUD: { label: 'Rejected', variant: 'danger', customer: 'Cancelled' },
}

/** Customer-facing progress steps for tracking pages. */
export const CUSTOMER_STEPS: Array<{ label: string; statuses: OrderStatus[] }> = [
  { label: 'Placed', statuses: ['PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED'] },
  { label: 'Confirmed', statuses: ['CONFIRMED', 'PRE_ORDER', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP'] },
  { label: 'Shipped', statuses: ['SHIPPED', 'PENDING_CANCEL', 'FAILED_DELIVERY', 'RETURNING', 'LOST'] },
  { label: 'Delivered', statuses: ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] },
]

export const PAYMENT_STATUS: Record<PaymentStatus, Meta> = {
  UNPAID: { label: 'Unpaid', variant: 'neutral' },
  PARTIALLY_PAID: { label: 'Partially paid', variant: 'warning' },
  PAID: { label: 'Paid', variant: 'success' },
  PARTIALLY_REFUNDED: { label: 'Partially refunded', variant: 'warning' },
  REFUNDED: { label: 'Refunded', variant: 'neutral' },
}

export const FRAUD_STATUS: Record<FraudStatus, Meta> = {
  NOT_CHECKED: { label: 'Not checked', variant: 'neutral' },
  PASSED: { label: 'Passed', variant: 'success' },
  REVIEW: { label: 'Review', variant: 'danger' },
  ADVANCE_REQUIRED: { label: 'Advance', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'danger' },
  ERROR: { label: 'Check failed', variant: 'warning' },
}

export const RISK_LEVEL: Record<RiskLevel, Meta> = {
  LOW: { label: 'Low', variant: 'success' },
  MEDIUM: { label: 'Medium', variant: 'warning' },
  HIGH: { label: 'High', variant: 'danger' },
  CRITICAL: { label: 'Critical', variant: 'destructive' },
}

export const PRODUCTION_STATUS: Record<ProductionStatus, Meta> = {
  WAITING: { label: 'Waiting', variant: 'neutral' },
  IN_PRODUCTION: { label: 'In production', variant: 'violet' },
  PAUSED: { label: 'Paused', variant: 'warning' },
  QUALITY_CHECK: { label: 'Quality check', variant: 'info' },
  PACKING: { label: 'Packing', variant: 'info' },
  READY: { label: 'Ready', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'neutral' },
}

export const SHIPMENT_STATUS: Record<ShipmentStatus, Meta> = {
  PENDING: { label: 'Pending', variant: 'neutral' },
  BOOKED: { label: 'Booked', variant: 'info' },
  PICKED_UP: { label: 'Picked up', variant: 'info' },
  IN_TRANSIT: { label: 'In transit', variant: 'info' },
  OUT_FOR_DELIVERY: { label: 'Out for delivery', variant: 'info' },
  DELIVERED: { label: 'Delivered', variant: 'success' },
  PARTIALLY_DELIVERED: { label: 'Partly delivered', variant: 'warning' },
  FAILED: { label: 'Failed', variant: 'danger' },
  RETURNING: { label: 'Returning', variant: 'warning' },
  RETURNED: { label: 'Returned', variant: 'neutral' },
  CANCELLED: { label: 'Cancelled', variant: 'neutral' },
  ON_HOLD: { label: 'On hold', variant: 'warning' },
}

export const PAYMENT_METHOD: Record<Enums<'payment_method'>, string> = {
  COD: 'Cash on delivery',
  ADVANCE: 'Advance + COD',
  FULL_PAYMENT: 'Full payment',
}

export const PAYMENT_CHANNEL: Record<Enums<'payment_channel'>, string> = {
  CASH: 'Cash',
  BKASH: 'bKash',
  NAGAD: 'Nagad',
  ROCKET: 'Rocket',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  GATEWAY: 'Payment gateway',
  COURIER_COD: 'Courier COD',
  OTHER: 'Other',
}

export const FRAUD_DECISION: Record<Enums<'fraud_decision'>, Meta> = {
  ALLOW: { label: 'Allow', variant: 'success' },
  REVIEW: { label: 'Review', variant: 'danger' },
  ADVANCE_REQUIRED: { label: 'Advance required', variant: 'warning' },
  BLOCK: { label: 'Block', variant: 'destructive' },
}

export const ADVANCE_TYPE: Record<Enums<'advance_type'>, string> = {
  NONE: 'No advance',
  FIXED: 'Fixed amount',
  DELIVERY_CHARGE: 'Delivery charge',
  DELIVERY_PLUS_RETURN: 'Delivery + return charge',
  PERCENTAGE: 'Percentage of order',
  FULL: 'Full payment',
}

export const SEGMENT: Record<Enums<'customer_segment'>, Meta> = {
  NEW: { label: 'New', variant: 'info' },
  REGULAR: { label: 'Regular', variant: 'neutral' },
  VIP: { label: 'VIP', variant: 'violet' },
  HIGH_RISK: { label: 'High risk', variant: 'danger' },
  BLOCKED: { label: 'Blocked', variant: 'destructive' },
}

export const MOVEMENT_TYPE: Record<Enums<'inventory_movement_type'>, Meta> = {
  PURCHASE: { label: 'Purchase', variant: 'success' },
  SALE: { label: 'Sale', variant: 'info' },
  RETURN: { label: 'Return', variant: 'success' },
  ADJUSTMENT: { label: 'Adjustment', variant: 'neutral' },
  DAMAGE: { label: 'Damage', variant: 'danger' },
  LOSS: { label: 'Loss', variant: 'danger' },
  TRANSFER: { label: 'Transfer', variant: 'violet' },
  RESERVATION: { label: 'Reserved', variant: 'warning' },
  RELEASE: { label: 'Released', variant: 'neutral' },
}

/** Next steps offered as one-click actions on an order. */
export const NEXT_ACTIONS: Partial<Record<OrderStatus, Array<{ to: OrderStatus; label: string }>>> = {
  PENDING: [{ to: 'CONFIRMED', label: 'Approve' }],
  CONFIRMATION_REQUIRED: [{ to: 'CONFIRMED', label: 'Approve' }],
  CONFIRMED: [{ to: 'PROCESSING', label: 'Start processing' }, { to: 'PRE_ORDER', label: 'Pre-order' }],
  PRE_ORDER: [{ to: 'PROCESSING', label: 'Stock arrived' }],
  PROCESSING: [{ to: 'PACKING', label: 'Move to packing' }, { to: 'PRODUCTION', label: 'Send to production' }],
  PRODUCTION: [{ to: 'QUALITY_CHECK', label: 'Send to quality check' }],
  QUALITY_CHECK: [{ to: 'PACKING', label: 'Approve → packing' }, { to: 'PRODUCTION', label: 'Back to production' }],
  PACKING: [{ to: 'READY_TO_SHIP', label: 'Mark ready to ship' }],
  READY_TO_SHIP: [{ to: 'SHIPPED', label: 'Mark shipped' }],
  SHIPPED: [{ to: 'DELIVERED', label: 'Mark delivered' }, { to: 'FAILED_DELIVERY', label: 'Delivery failed' }],
  FAILED_DELIVERY: [{ to: 'SHIPPED', label: 'Re-attempt delivery' }, { to: 'RETURNING', label: 'Coming back' }],
  RETURN_REQUESTED: [{ to: 'RETURNING', label: 'Coming back' }, { to: 'DELIVERED', label: 'Cancel return' }],
  PENDING_CANCEL: [{ to: 'CANCELLED', label: 'Courier cancelled it' }],
  LOST: [{ to: 'DELIVERED', label: 'Found — delivered' }],
}

/** Statuses that need a reason before moving there. */
export const NEEDS_REASON: OrderStatus[] = ['CANCELLED', 'PENDING_CANCEL', 'FAILED_DELIVERY', 'LOST']

export const CANCELLABLE: OrderStatus[] = [
  'PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED', 'CONFIRMED', 'PRE_ORDER',
  'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP',
]

/** Parcels the courier may have: cancelling means asking the courier first. */
export const CANCEL_VIA_COURIER: OrderStatus[] = ['READY_TO_SHIP', 'SHIPPED']
/** Parcels on their way back (or found) that can be received into stock. */
export const RECEIVABLE: OrderStatus[] = ['FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING', 'LOST', 'PENDING_CANCEL', 'PARTIALLY_DELIVERED']
export const LOSABLE: OrderStatus[] = ['SHIPPED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING', 'PENDING_CANCEL']

/** Approved Orders stages (derived from the order status on the server). */
export type OrderStage = 'PENDING' | 'RTS' | 'SHIPPED' | 'DELIVERED' | 'PARTIAL'
  | 'RETURN_PENDING' | 'RETURNED' | 'CANCELLED' | 'LOST' | 'PRE_ORDER'

export const ORDER_STAGES: Array<{ key: OrderStage; label: string; variant: BadgeVariant; hint: string; moves: Array<{ to: OrderStatus; label: string }> }> = [
  { key: 'PENDING', label: 'Pending', variant: 'info', hint: 'Approved and being prepared',
    moves: [{ to: 'READY_TO_SHIP', label: 'RTS' }, { to: 'PRE_ORDER', label: 'Pre-order' }, { to: 'CANCELLED', label: 'Cancelled' }] },
  { key: 'RTS', label: 'RTS', variant: 'info', hint: 'Packed and ready for the courier',
    moves: [{ to: 'SHIPPED', label: 'Shipped' }, { to: 'PENDING_CANCEL', label: 'Cancel (ask courier)' }] },
  { key: 'SHIPPED', label: 'Shipped', variant: 'info', hint: 'With the courier',
    moves: [{ to: 'DELIVERED', label: 'Delivered' }, { to: 'RETURNING', label: 'Return pending' },
      { to: 'PENDING_CANCEL', label: 'Cancel (ask courier)' }, { to: 'LOST', label: 'Lost' }] },
  { key: 'DELIVERED', label: 'Delivered', variant: 'success', hint: 'The customer received it — final, it cannot become a return', moves: [] },
  { key: 'PARTIAL', label: 'Partial', variant: 'success', hint: 'The customer kept part of the order', moves: [] },
  { key: 'RETURN_PENDING', label: 'Return pending', variant: 'warning', hint: 'Refused or not delivered (the courier sends it here) and on its way back to you',
    moves: [{ to: 'RETURNED', label: 'Returned' }, { to: 'LOST', label: 'Lost' }] },
  { key: 'RETURNED', label: 'Returned', variant: 'neutral', hint: 'Received back', moves: [] },
  { key: 'CANCELLED', label: 'Cancelled', variant: 'neutral', hint: 'Cancelled after approval. Rows marked "Cancelling" are still waiting on the courier to confirm', moves: [] },
  { key: 'LOST', label: 'Lost', variant: 'danger', hint: 'Lost by the courier',
    moves: [{ to: 'DELIVERED', label: 'Delivered' }, { to: 'RETURNED', label: 'Returned' }] },
  { key: 'PRE_ORDER', label: 'Pre-order', variant: 'violet', hint: 'Waiting for stock to arrive',
    moves: [{ to: 'PROCESSING', label: 'Pending' }, { to: 'READY_TO_SHIP', label: 'RTS' }, { to: 'CANCELLED', label: 'Cancelled' }] },
]

export const STAGE: Record<OrderStage | 'WEB', Meta> = {
  WEB: { label: 'Web order', variant: 'neutral' },
  ...Object.fromEntries(ORDER_STAGES.map((s) => [s.key, { label: s.label, variant: s.variant }])) as Record<OrderStage, Meta>,
}

export const EDITABLE = CANCELLABLE

/** Same rule as the database's order_stage(). */
export function stageOf(status: OrderStatus, confirmedAt: string | null | undefined): OrderStage | 'WEB' {
  if (!confirmedAt) return 'WEB'
  switch (status) {
    case 'PRE_ORDER': return 'PRE_ORDER'
    case 'READY_TO_SHIP': return 'RTS'
    case 'SHIPPED': return 'SHIPPED'
    case 'DELIVERED': return 'DELIVERED'
    case 'PARTIALLY_DELIVERED': return 'PARTIAL'
    case 'FAILED_DELIVERY': case 'RETURN_REQUESTED': case 'RETURNING': return 'RETURN_PENDING'
    case 'RETURNED': return 'RETURNED'
    case 'LOST': return 'LOST'
    case 'CONFIRMED': case 'PROCESSING': case 'PRODUCTION': case 'QUALITY_CHECK': case 'PACKING': return 'PENDING'
    default: return 'CANCELLED'
  }
}

export const COURIER_INVOICE_STATUS: Record<Enums<'courier_invoice_status'>, Meta> = {
  NEEDS_REVIEW: { label: 'Needs review', variant: 'warning' },
  DISCREPANCY: { label: 'Discrepancy', variant: 'danger' },
  VERIFIED: { label: 'Verified', variant: 'success' },
  PAID: { label: 'Paid', variant: 'neutral' },
}

export const WEBHOOK_RESULT: Record<'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'UNMATCHED' | 'FAILED', Meta> = {
  RECEIVED: { label: 'Received', variant: 'neutral' },
  PROCESSED: { label: 'Applied', variant: 'success' },
  IGNORED: { label: 'No change', variant: 'neutral' },
  UNMATCHED: { label: 'No parcel yet', variant: 'warning' },
  FAILED: { label: 'Failed', variant: 'danger' },
}

export const CHARGE_KIND: Record<Enums<'shipment_charge_kind'>, string> = {
  DELIVERY: 'Delivery fee',
  RETURN: 'Return charge',
  COD_FEE: 'COD fee',
  OTHER: 'Other fees',
}

export const CHARGE_SOURCE: Record<Enums<'charge_source'>, string> = {
  ESTIMATE: 'Estimate',
  COURIER_API: 'Courier API',
  WEBHOOK: 'Courier update',
  INVOICE: 'Statement',
  MANUAL: 'Manual',
}

export const MESSAGE_STATUS: Record<Enums<'notification_status'>, Meta> = {
  QUEUED: { label: 'Waiting', variant: 'info' },
  SENDING: { label: 'Sending', variant: 'info' },
  SENT: { label: 'Sent', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'danger' },
  SKIPPED: { label: 'Not sent', variant: 'neutral' },
}

export const SMS_DELIVERY: Record<'PENDING' | 'DELIVERED' | 'FAILED' | 'UNKNOWN', string> = {
  PENDING: 'Waiting for delivery report',
  DELIVERED: 'Delivered to the phone',
  FAILED: 'Not delivered',
  UNKNOWN: 'Delivery not reported',
}
