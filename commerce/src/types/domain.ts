// Shapes of JSON returned by database functions (jsonb results are typed as
// `Json` by the generator; these interfaces describe them precisely).
import type { OrderStage } from '@/lib/status'
import type { Enums, Tables } from '@/types/database'

export type OrderStatus = Enums<'order_status'>
export type PaymentMethod = Enums<'payment_method'>

// ---------------------------------------------------------------- storefront
export type StoreMode = 'OWN' | 'SHOPIFY' | 'WOOCOMMERCE' | 'OFF'

export interface ProductCard {
  id: string
  name: string
  slug: string
  brand: string | null
  tags: string[]
  category: { name: string; slug: string } | null
  price: number
  max_price: number
  compare_at_price: number | null
  image: { url: string; alt: string } | null
  in_stock: boolean
  is_featured: boolean
  created_at: string
}

export interface ProductVariantPublic {
  id: string
  sku: string
  title: string
  size: string | null
  color: string | null
  option_values: Record<string, string>
  price: number
  compare_at_price: number | null
  available: number | null
  in_stock: boolean
}

export interface ProductDetail extends ProductCard {
  description: string | null
  short_description?: string | null
  shipping_note?: string | null
  warranty?: string | null
  sku: string | null
  option_names: string[]
  seo_title: string | null
  seo_description: string | null
  track_inventory: boolean
  max_quantity: number
  images: Array<{ id: string; url: string; alt: string; variant_id: string | null }>
  variants: ProductVariantPublic[]
  related: ProductCard[]
}

export interface ProductList {
  total: number
  items: ProductCard[]
}

export interface CategoryPublic {
  id: string
  name: string
  slug: string
  description: string | null
  image_url: string | null
  parent_id: string | null
  product_count: number
}

export interface PaymentAccount {
  channel: string
  label: string
  number: string
}

export interface StoreConfig {
  store: {
    name: string
    tagline?: string
    email?: string
    phone?: string
    /** WhatsApp number customers can message (international or local format). */
    whatsapp?: string
    address?: string
    website_url?: string
    logo_url?: string | null
    currency: string
    currency_symbol: string
    locale?: string
    timezone: string
    order_prefix: string
    social?: Record<string, string>
  }
  storefront: {
    announcement?: string
    hero_title?: string
    hero_subtitle?: string
    hero_image_url?: string | null
    hero_cta_label?: string
    hero_cta_link?: string
    featured_category_slugs?: string[]
    footer_text?: string
    /** Theme builder: colours, font, home-page sections (see features/storefront/theme). */
    theme?: Record<string, unknown>
    /** OWN = this store takes orders; otherwise it is closed (enforced when an order is placed). */
    mode?: StoreMode
    redirect_url?: string | null
  }
  policies: Record<string, string>
  delivery: {
    methods: Array<{ code: string; name: string; extra_charge: number }>
    districts: string[]
    free_delivery_threshold: number | null
    zones: Array<{ name: string; charge: number; districts: string[]; estimated_days: string | null; is_default: boolean }>
  }
  payments: {
    cod_enabled: boolean
    advance_enabled: boolean
    full_payment_enabled: boolean
    providers: Array<{ code: string; label: string; type: 'manual' | 'redirect'; instructions: string | null; accounts: PaymentAccount[] }>
    voluntary_advance: { type: string; value: number } | null
  }
  phone_pattern: string
}

export interface QuoteLine {
  variant_id: string
  product_id: string
  product_name: string
  variant_title: string | null
  sku: string
  image_url: string | null
  unit_price: number
  quantity: number
  line_subtotal: number
  discount_amount: number
  line_total: number
  available: number | null
  track_inventory: boolean
}

export interface Quote {
  lines: QuoteLine[]
  subtotal: number
  coupon: { valid: boolean; code?: string; message: string; reason?: string; discount_amount?: number } | null
  coupon_discount: number
  discount_total: number
  delivery_zone: { id: string; name: string; charge: number; estimated_days: string | null } | null
  delivery_method: string
  delivery_charge: number
  delivery_discount: number
  return_charge: number
  total: number
  stock_errors: Array<{ variant_id: string; code: string; message: string; available: number }>
  cost_total?: number
}

export interface PaymentRequirement {
  mode: 'COD' | 'ADVANCE' | 'FULL' | 'REVIEW' | 'BLOCKED'
  amount: number
  cod_allowed: boolean
  remaining_cod?: number
  message: string | null
}

export interface PublicOrder {
  id: string
  order_number: string
  status: OrderStatus
  payment_status: Enums<'payment_status'>
  payment_method: PaymentMethod
  created_at: string
  customer_name: string
  shipping_address: string
  shipping_area: string | null
  shipping_district: string
  subtotal: number
  discount_total: number
  delivery_charge: number
  total_amount: number
  advance_required: number
  amount_paid: number
  amount_due_now: number
  cod_amount: number
  advance_due_at: string | null
  items: Array<{ product_name: string; variant_title: string | null; sku: string; image_url: string | null; quantity: number; unit_price: number; line_total: number }>
  timeline: Array<{ event: string; status: OrderStatus | null; message: string | null; created_at: string }>
  shipment: { courier: string; tracking_number: string | null; tracking_url: string | null; status: Enums<'shipment_status'> } | null
  pending_payment_verification: boolean
  payment_requirement?: PaymentRequirement
}

export interface MyOrdersPage {
  total: number
  items: Array<{ id: string; order_number: string; status: OrderStatus; payment_status: Enums<'payment_status'>; total_amount: number; created_at: string; item_count: number }>
}

export interface PaymentInitResponse {
  payment: { reference: string | null; amount: number; currency: string }
  type: 'redirect' | 'manual'
  redirectUrl?: string
  instructions?: string
  accounts?: PaymentAccount[]
}

// ---------------------------------------------------------------- admin
export interface OrderListItem {
  id: string
  order_number: string
  status: OrderStatus
  payment_status: Enums<'payment_status'>
  payment_method: PaymentMethod
  fraud_status: Enums<'fraud_status'>
  risk_level: Enums<'risk_level'> | null
  source: Enums<'order_source'>
  /** Shopify / WooCommerce store the order came from, with its own order number. */
  sales_channel?: { id: string; platform: 'SHOPIFY' | 'WOOCOMMERCE'; name: string; number: string | null } | null
  customer_id: string
  customer_name: string
  customer_phone: string
  shipping_district: string
  total_amount: number
  amount_paid: number
  cod_amount: number
  advance_required: number
  created_at: string
  item_count: number
  courier_name: string | null
  tracking_number: string | null
  label_printed_at: string | null
  label_print_count: number
  duplicate_status: 'SUSPECTED' | 'DISMISSED' | 'MERGED' | null
  duplicate_of_number: string | null
  /** APPROVED = the customer already has an order in Approved Orders. */
  duplicate_reason?: 'APPROVED' | 'PHONE' | 'ADDRESS' | null
  duplicate_of_status?: string | null
  merged_count: number
  merged_into_number: string | null
  stage: OrderStage | 'WEB'
  confirmed_at: string | null
  review_status: string
  review_note: string | null
  follow_up_at: string | null
  contact_attempts: number
  last_contact_at: string | null
  partial_return_amount: number
  items_preview: string | null
  updated_at?: string
  shipping_address?: string
  customer_note?: string | null
  tags?: string[]
  customer_total_orders?: number | null
  handled_by?: string | null
  lines?: Array<{ name: string; variant: string | null; sku: string | null; quantity: number; image_url: string | null }> | null
  shipment?: {
    courier: string; provider: string; tracking_number: string | null; consignment_id: string | null; status: string
    booked_at: string; uploaded: boolean; tracking_url: string | null
  } | null
  attribution: { source: string; channel: string; is_paid: boolean | null; campaign: string | null } | null
  courier_history: {
    delivered: number; completed: number; score: number | null
    /** Parcels on record (courier network + this store) and how many failed. */
    total?: number; cancelled?: number
    /** The rate the checkout check used, 0–100, and its tier (GOOD / MID / LOW / NEW). */
    rate?: number | null; tier?: string | null
    /** Couriers that report only a range, e.g. "SteadFast 50+". */
    ranges?: string[] | null
    verdict?: string | null; checked_at?: string
  } | null
}

export type ReviewStatus = Tables<'order_review_statuses'>
export type CheckoutLead = Tables<'checkout_leads'>

export interface QueueCounts {
  web: Record<string, number>
  approved: Partial<Record<OrderStage, number>>
  follow_up_due: number
  incomplete: number
}

export type ScanAction = 'READY_TO_SHIP' | 'SHIPPED' | 'RETURNED' | 'LOOKUP'

export interface ScanResult {
  result: 'OK' | 'ALREADY' | 'ERROR' | 'NOT_FOUND'
  message: string
  code: string
  from_status?: OrderStatus
  order: {
    id: string
    order_number: string
    status: OrderStatus
    customer_name: string
    customer_phone: string
    shipping_district: string
    cod_amount: number
    total_amount: number
    item_count: number
    label_printed_at: string | null
    courier_name: string | null
    tracking_number: string | null
  } | null
}

export interface FulfillmentSummary {
  to_confirm: number
  advance_pending: number
  to_print: number
  printed: number
  ready_to_ship: number
  shipped_today: number
  duplicates: number
  merged_today: number
}

export interface Paged<T> {
  total: number
  items: T[]
}

export interface FraudQueueItem {
  id: string
  order_number: string
  status: OrderStatus
  created_at: string
  customer_id: string
  customer_name: string
  customer_phone: string
  shipping_district: string
  total_amount: number
  payment_method: PaymentMethod
  risk_level: Enums<'risk_level'> | null
  risk_score: number | null
  courier_score: number | null
  cancellation_rate: number | null
  return_rate: number | null
  failed_delivery_rate: number | null
  previous_orders: number | null
  delivered_orders: number | null
  recommendation: string | null
  fraud_decision: Enums<'fraud_decision'> | null
  fraud_status: Enums<'fraud_status'>
  advance_required: number
  amount_paid: number
  advance_due_at: string | null
  provider: string | null
  check_status: string | null
  matched_rules: Array<{ name: string; decision: string; advance_amount: number }> | null
}

export interface ProfitLoss {
  from: string
  to: string
  product_revenue: number
  delivery_income: number
  revenue: number
  refunds: number
  net_revenue: number
  cogs: number
  gross_profit: number
  gross_margin_pct: number | null
  operating_expenses: number
  other_income: number
  net_profit: number
  lines: Array<{ code: string; name: string; group: Enums<'pnl_group'>; type: Enums<'finance_type'>; amount: number }>
}

export interface CashFlow {
  cash_in: number
  cash_out: number
  net_cash_flow: number
  series: Array<{ bucket: string; cash_in: number; cash_out: number; net: number }>
  by_category: Array<{ name: string; type: Enums<'finance_type'>; amount: number }>
}

export interface FinanceOverview extends ProfitLoss {
  total_expenses: number
  cash_in: number
  cash_out: number
  net_cash_flow: number
  cash_series: CashFlow['series']
  delivery_costs: number
  advance_payments: number
  cod_receivable: number
  outstanding_amount: number
  supplier_payables: number
  unresolved_advances: number
  // Cost and collection breakdown
  courier_charges: number
  courier_cod_fees: number
  return_charges: number
  marketing_costs: number
  sms_costs: number
  payment_fees: number
  other_expenses: number
  discounts: number
  gross_sales: number
  order_value: number
  cod_collected: number
  online_collected: number
}

export interface DashboardOverview {
  from: string
  to: string
  orders: number
  gross_sales: number
  average_order_value: number
  cancelled: number
  rejected_fraud: number
  delivered: number
  returned: number
  failed: number
  shipped: number
  cod_orders: number
  advance_orders: number
  storefront_orders: number
  status_distribution: Record<string, number>
  payment_method_distribution: Record<string, number>
  orders_today: number
  orders_this_week: number
  orders_this_month: number
  cancellation_rate: number
  return_rate: number
  failed_delivery_rate: number
  cod_percentage: number
  advance_percentage: number
  fraud_rejection_rate: number
  sessions: number
  conversion_rate: number | null
  top_products: Array<{ product_id: string; product_name: string; quantity: number; revenue: number }>
  top_customers: Array<{ customer_id: string; customer_name: string; customer_phone: string; orders: number; total: number }>
  low_stock: Array<{ variant_id: string; product_id: string; product_name: string; variant_title: string; sku: string; available: number; low_stock_threshold: number; stock_status: string }>
  action_items: Record<'fraud_review' | 'advance_pending' | 'payments_to_verify' | 'confirmation_required' | 'ready_to_ship' | 'low_stock' | 'production_overdue', number>
  finance?: ProfitLoss
}

export interface TimeseriesPoint {
  bucket: string
  orders: number
  gross_sales: number
  cancelled: number
  returned: number
  failed: number
  new_customers: number
  revenue: number | null
  expenses: number | null
  profit: number | null
}

export interface StaffMember {
  id: string
  full_name: string
  email: string
  role: string
  is_active: boolean
}

export interface MyAccess {
  user_id: string
  email: string
  full_name: string
  role: string
  role_name: string
  permissions: string[]
}

export interface CodReceivableItem {
  shipment_id: string
  order_id: string
  order_number: string
  customer_name: string
  courier_id: string
  courier_name: string
  tracking_number: string | null
  delivered_at: string
  total_amount: number
  amount_paid: number
  due: number
  shipping_cost: number
}
