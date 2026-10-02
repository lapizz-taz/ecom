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
  CONFIRMATION_REQUIRED: { label: 'Needs confirmation', variant: 'warning', customer: 'Being confirmed' },
  CONFIRMED: { label: 'Confirmed', variant: 'info', customer: 'Confirmed' },
  PROCESSING: { label: 'Processing', variant: 'info', customer: 'Preparing' },
  PRODUCTION: { label: 'In production', variant: 'violet', customer: 'Preparing' },
  QUALITY_CHECK: { label: 'Quality check', variant: 'violet', customer: 'Preparing' },
  PACKING: { label: 'Packing', variant: 'violet', customer: 'Packing' },
  READY_TO_SHIP: { label: 'Ready to ship', variant: 'info', customer: 'Ready to ship' },
  SHIPPED: { label: 'Shipped', variant: 'info', customer: 'On the way' },
  DELIVERED: { label: 'Delivered', variant: 'success', customer: 'Delivered' },
  CANCELLED: { label: 'Cancelled', variant: 'neutral', customer: 'Cancelled' },
  RETURN_REQUESTED: { label: 'Return requested', variant: 'warning', customer: 'Return requested' },
  RETURNED: { label: 'Returned', variant: 'neutral', customer: 'Returned' },
  FAILED_DELIVERY: { label: 'Failed delivery', variant: 'danger', customer: 'Delivery failed' },
  REJECTED_FRAUD: { label: 'Rejected', variant: 'danger', customer: 'Cancelled' },
}

/** Customer-facing progress steps for tracking pages. */
export const CUSTOMER_STEPS: Array<{ label: string; statuses: OrderStatus[] }> = [
  { label: 'Placed', statuses: ['PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED'] },
  { label: 'Confirmed', statuses: ['CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP'] },
  { label: 'Shipped', statuses: ['SHIPPED', 'FAILED_DELIVERY'] },
  { label: 'Delivered', statuses: ['DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] },
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
  PENDING: [{ to: 'CONFIRMED', label: 'Confirm order' }],
  CONFIRMATION_REQUIRED: [{ to: 'CONFIRMED', label: 'Confirm order' }],
  CONFIRMED: [{ to: 'PROCESSING', label: 'Start processing' }],
  PROCESSING: [{ to: 'PACKING', label: 'Move to packing' }, { to: 'PRODUCTION', label: 'Send to production' }],
  PRODUCTION: [{ to: 'QUALITY_CHECK', label: 'Send to quality check' }],
  QUALITY_CHECK: [{ to: 'PACKING', label: 'Approve → packing' }, { to: 'PRODUCTION', label: 'Back to production' }],
  PACKING: [{ to: 'READY_TO_SHIP', label: 'Mark ready to ship' }],
  READY_TO_SHIP: [{ to: 'SHIPPED', label: 'Mark shipped' }],
  SHIPPED: [{ to: 'DELIVERED', label: 'Mark delivered' }, { to: 'FAILED_DELIVERY', label: 'Delivery failed' }],
  DELIVERED: [{ to: 'RETURN_REQUESTED', label: 'Customer return' }],
  FAILED_DELIVERY: [{ to: 'SHIPPED', label: 'Re-attempt delivery' }],
  RETURN_REQUESTED: [{ to: 'DELIVERED', label: 'Cancel return' }],
}

export const CANCELLABLE: OrderStatus[] = [
  'PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED', 'CONFIRMED',
  'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP',
]

export const EDITABLE = CANCELLABLE

/** Admin sidebar order status shortcuts. */
export const ORDER_STATUS_FILTERS: Array<{ key: string; label: string; statuses: OrderStatus[] }> = [
  { key: 'all', label: 'All', statuses: [] },
  { key: 'pending', label: 'Pending', statuses: ['PENDING', 'FRAUD_CHECK', 'CONFIRMATION_REQUIRED', 'ADVANCE_REQUIRED'] },
  { key: 'confirmed', label: 'Confirmed', statuses: ['CONFIRMED'] },
  { key: 'processing', label: 'Processing', statuses: ['PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING'] },
  { key: 'ready', label: 'Ready to ship', statuses: ['READY_TO_SHIP'] },
  { key: 'shipped', label: 'Shipped', statuses: ['SHIPPED'] },
  { key: 'delivered', label: 'Delivered', statuses: ['DELIVERED'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['CANCELLED'] },
  { key: 'returned', label: 'Returned', statuses: ['RETURN_REQUESTED', 'RETURNED'] },
  { key: 'failed', label: 'Failed delivery', statuses: ['FAILED_DELIVERY'] },
  { key: 'fraud', label: 'Fraud / Review', statuses: ['FRAUD_REVIEW', 'REJECTED_FRAUD'] },
]
