import {
  BarChart3, Boxes, ClipboardCheck, Globe, HelpCircle, LayoutDashboard, LifeBuoy, Megaphone, MessageSquare, Search, Settings,
  ShieldCheck, ShoppingBag, Store, TrendingUp, UserCog, Users, Wallet,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { QueueCounts } from '@/types/domain'

/** Counts shown as badges next to menu items (refreshed while the admin is open). */
export interface NavCounts {
  queue?: QueueCounts
  status?: Record<string, number>
}

export interface NavChild {
  label: string
  to: string
  permission?: string
  badge?: (c: NavCounts) => number | undefined
}

export interface NavItem {
  label: string
  icon: ReactNode
  /** Where the item itself goes; omitted for action-only items. */
  to?: string
  /** Opens a dialog or palette instead of navigating. */
  action?: 'search' | 'help' | 'contact' | 'report'
  permission?: string
  shortcut?: string
  badge?: (c: NavCounts) => number | undefined
  children?: NavChild[]
}

export interface NavSection {
  label?: string
  items: NavItem[]
}

/**
 * The admin menu. Web Orders (new orders waiting for a decision) and Approved
 * Orders (fulfilment and couriers) are separate sections. Only pages that
 * exist are listed — nothing here is a placeholder.
 */
export const NAV: NavSection[] = [
  {
    items: [
      { label: 'Dashboard', to: '/admin', icon: <LayoutDashboard />, permission: 'dashboard.view', shortcut: 'G D' },
      { label: 'Search', action: 'search', icon: <Search />, shortcut: 'Ctrl K' },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        label: 'Web Orders', to: '/admin/orders/web', icon: <Globe />, permission: 'orders.view', shortcut: 'G W',
        badge: (c) => c.queue?.web?.PROCESSING,
        children: [
          { label: 'New Order', to: '/admin/orders/new', permission: 'orders.create' },
          { label: 'Web Order List', to: '/admin/orders/web' },
          { label: 'Auto Pick Orders', to: '/admin/orders/auto-pick' },
          { label: 'Auto Call Center', to: '/admin/orders/call-center', badge: (c) => c.queue?.follow_up_due },
          { label: 'Order Block List', to: '/admin/orders/block-list' },
        ],
      },
      {
        label: 'Approved Orders', to: '/admin/orders/approved', icon: <ClipboardCheck />, permission: 'orders.view', shortcut: 'G A',
        badge: (c) => c.queue?.approved?.PENDING,
        children: [
          { label: 'Order List', to: '/admin/orders/approved' },
          { label: 'Orders Dashboard', to: '/admin/orders/dashboard' },
          { label: 'Preorders', to: '/admin/orders/approved?tab=PRE_ORDER', badge: (c) => c.queue?.approved?.PRE_ORDER },
          { label: 'Super Edit', to: '/admin/orders/super-edit', permission: 'orders.override' },
          { label: 'Scan To Update', to: '/admin/scan', permission: 'orders.fulfill' },
          { label: 'Courier Invoice Upload', to: '/admin/courier-invoices', permission: 'couriers.view' },
          { label: 'Courier Management', to: '/admin/courier-management', permission: 'couriers.view' },
        ],
      },
      {
        label: 'Inventory', to: '/admin/inventory', icon: <Boxes />, permission: 'inventory.view', shortcut: 'G I',
        children: [
          { label: 'Stock', to: '/admin/inventory' },
          { label: 'Low Stock', to: '/admin/inventory?status=LOW_STOCK' },
          { label: 'Products', to: '/admin/products', permission: 'products.view' },
          { label: 'Stock Movements', to: '/admin/inventory/movements' },
          { label: 'Adjustments', to: '/admin/inventory/adjustments' },
          { label: 'Production', to: '/admin/production', permission: 'production.view' },
        ],
      },
      {
        label: 'Store', to: '/admin/channels', icon: <Store />, permission: 'settings.view',
        children: [
          { label: 'Sales Channels', to: '/admin/channels' },
          { label: 'Channel Imports', to: '/admin/channels?imports=FAILED', permission: 'orders.view' },
          { label: 'Theme', to: '/admin/store/theme', permission: 'settings.manage' },
        ],
      },
      {
        label: 'Messages', to: '/admin/sms', icon: <MessageSquare />, permission: 'sms.view',
        children: [
          { label: 'Overview', to: '/admin/sms' },
          { label: 'Message Log', to: '/admin/sms?tab=messages' },
          { label: 'Automations', to: '/admin/sms?tab=automations' },
        ],
      },
      {
        label: 'Purchase', to: '/admin/purchases', icon: <ShoppingBag />, permission: 'purchases.view',
        children: [
          { label: 'Purchase List', to: '/admin/purchases' },
          { label: 'New Purchase', to: '/admin/purchases/new', permission: 'purchases.manage' },
        ],
      },
    ],
  },
  {
    label: 'Growth',
    items: [
      {
        label: 'Ads', to: '/admin/ads', icon: <Megaphone />, permission: 'marketing.view',
        children: [
          { label: 'Ads Dashboard', to: '/admin/ads' },
          { label: 'Campaign Quality', to: '/admin/ads?tab=quality' },
          { label: 'Ad Profit Analysis', to: '/admin/ads?tab=profit' },
          { label: 'Meta Ads', to: '/admin/marketing?tab=meta' },
          { label: 'TikTok Ads', to: '/admin/marketing/tiktok' },
          { label: 'Google Ads', to: '/admin/marketing/google' },
          { label: 'Ad Spend', to: '/admin/ads?tab=spend' },
          { label: 'Attribution', to: '/admin/marketing' },
          { label: 'Tracking Setup', to: '/admin/marketing?tab=tracking' },
        ],
      },
      {
        label: 'Marketing', to: '/admin/coupons', icon: <TrendingUp />, permission: 'coupons.manage',
        children: [
          { label: 'Coupons', to: '/admin/coupons' },
          { label: 'SMS Automations', to: '/admin/sms?tab=automations', permission: 'sms.view' },
        ],
      },
      { label: 'Customers', to: '/admin/customers', icon: <Users />, permission: 'customers.view', shortcut: 'G C' },
    ],
  },
  {
    label: 'Business Control',
    items: [
      { label: 'HRM', to: '/admin/users', icon: <UserCog />, permission: 'users.manage', children: [{ label: 'Users & Roles', to: '/admin/users' }] },
      {
        label: 'Finance', to: '/admin/finance', icon: <Wallet />, permission: 'finance.view',
        children: [
          { label: 'Finance Dashboard', to: '/admin/finance' },
          { label: 'Income & Expense', to: '/admin/finance/income-expense' },
          { label: 'Accounts & Bank', to: '/admin/finance/accounts' },
          { label: 'Courier Settlement', to: '/admin/couriers?tab=cod', permission: 'couriers.view' },
          { label: 'Cash Flow', to: '/admin/finance/cash-flow' },
          { label: 'Profit & Loss', to: '/admin/finance/profit-loss' },
          { label: 'Refunds', to: '/admin/finance/refunds' },
        ],
      },
      { label: 'Reports', to: '/admin/reports', icon: <BarChart3 />, permission: 'reports.view', shortcut: 'G R' },
    ],
  },
  {
    label: 'System',
    items: [
      {
        label: 'Settings', to: '/admin/settings', icon: <Settings />, permission: 'settings.view',
        children: [
          { label: 'Business Profile', to: '/admin/settings?tab=store' },
          { label: 'Courier Integration', to: '/admin/couriers', permission: 'couriers.view' },
          { label: 'Messaging Channels', to: '/admin/sms', permission: 'sms.view' },
          { label: 'Payments', to: '/admin/settings?tab=payments' },
          { label: 'Delivery Charges', to: '/admin/settings?tab=delivery' },
          { label: 'Fraud & Advance', to: '/admin/settings?tab=fraud' },
          { label: 'Order Settings', to: '/admin/settings?tab=operations' },
          { label: 'Label & Invoice Builder', to: '/admin/label-builder' },
          { label: 'Templates', to: '/admin/settings?tab=notifications' },
          { label: 'Finance Categories', to: '/admin/settings?tab=finance', permission: 'finance.view' },
        ],
      },
      {
        label: 'Logs', to: '/admin/audit-logs', icon: <ShieldCheck />, permission: 'audit.view',
        children: [
          { label: 'Audit Log', to: '/admin/audit-logs' },
          { label: 'Deletion Logs', to: '/admin/audit-logs?view=deletions' },
          { label: 'System Log', to: '/admin/system-logs' },
        ],
      },
    ],
  },
  {
    label: 'Support',
    items: [
      { label: 'Help Center', action: 'help', icon: <HelpCircle />, shortcut: '?' },
      { label: 'Contact Support', action: 'contact', icon: <LifeBuoy /> },
      { label: 'Report Issue', action: 'report', icon: <MessageSquare /> },
    ],
  },
]

/**
 * Pages kept out of the menu to keep it short, still found by menu search and
 * the command palette (each also has a link on its parent page).
 */
export const MORE_PAGES: (NavChild & { parent: string })[] = [
  { parent: 'Web Orders', label: 'Call-backs due', to: '/admin/orders/web?tab=FOLLOW_UP&due=1', permission: 'orders.view' },
  { parent: 'Web Orders', label: 'Incomplete Orders', to: '/admin/orders/web?tab=incomplete', permission: 'orders.view' },
  { parent: 'Web Orders', label: 'Customer Verification', to: '/admin/orders/fraud', permission: 'fraud.view' },
  { parent: 'Web Orders', label: 'All Orders', to: '/admin/orders', permission: 'orders.view' },
  { parent: 'Approved Orders', label: 'Labels to Print', to: '/admin/orders/approved?print=1', permission: 'orders.fulfill' },
  { parent: 'Approved Orders', label: 'Label & Invoice Builder', to: '/admin/label-builder', permission: 'settings.view' },
  { parent: 'Approved Orders', label: 'Pending Returns', to: '/admin/orders/approved?tab=PENDING_RETURN', permission: 'orders.view' },
  { parent: 'Approved Orders', label: 'Webhook Logs', to: '/admin/couriers?tab=webhooks', permission: 'couriers.view' },
]

/** Two-key shortcuts ("G" then a letter) shown in the help sheet. */
export const GO_SHORTCUTS: Record<string, { to: string; label: string; permission?: string }> = {
  d: { to: '/admin', label: 'Dashboard', permission: 'dashboard.view' },
  w: { to: '/admin/orders/web', label: 'Web Orders', permission: 'orders.view' },
  a: { to: '/admin/orders/approved', label: 'Approved Orders', permission: 'orders.view' },
  n: { to: '/admin/orders/new', label: 'New Order', permission: 'orders.create' },
  s: { to: '/admin/scan', label: 'Scan To Update', permission: 'orders.fulfill' },
  i: { to: '/admin/inventory', label: 'Inventory', permission: 'inventory.view' },
  c: { to: '/admin/customers', label: 'Customers', permission: 'customers.view' },
  r: { to: '/admin/reports', label: 'Reports', permission: 'reports.view' },
}

/** True when the link (path plus any query it names) matches the current location. */
export function linkMatches(to: string, pathname: string, search: string): boolean {
  const [path, query] = to.split('?')
  if (pathname !== path) return false
  if (!query) return true
  const want = new URLSearchParams(query)
  const have = new URLSearchParams(search)
  for (const [k, v] of want) if (have.get(k) !== v) return false
  return true
}
