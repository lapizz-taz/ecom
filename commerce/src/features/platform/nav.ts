import {
  Activity, BarChart3, CreditCard, Database, LayoutDashboard, LifeBuoy, type LucideIcon, Megaphone, MessageSquare, PhoneCall, Plug, ScrollText,
  Radio, Settings2, ShieldCheck, Siren, Store, ToggleRight, Truck, UsersRound, Wallet, Workflow,
} from 'lucide-react'

export interface PlatformNavItem {
  module: string
  label: string
  to: string
  icon: LucideIcon
}

/** The Super Admin sidebar, in the agreed order. */
export const PLATFORM_NAV: PlatformNavItem[] = [
  { module: 'overview', label: 'Overview', to: '/super-admin', icon: LayoutDashboard },
  { module: 'merchants', label: 'Merchants', to: '/super-admin/merchants', icon: Store },
  { module: 'merchants', label: 'Live & Capacity', to: '/super-admin/live', icon: Radio },
  { module: 'employees', label: 'Employees & Roles', to: '/super-admin/employees', icon: UsersRound },
  { module: 'subscriptions', label: 'Subscriptions & Plans', to: '/super-admin/subscriptions', icon: CreditCard },
  { module: 'credits', label: 'Credits & Wallets', to: '/super-admin/credits', icon: Wallet },
  { module: 'sms', label: 'SMS Management', to: '/super-admin/sms', icon: MessageSquare },
  { module: 'bd_courier', label: 'BD Courier Integration', to: '/super-admin/bd-courier', icon: Truck },
  { module: 'integrations', label: 'Other Integrations', to: '/super-admin/integrations', icon: Plug },
  { module: 'features', label: 'Features & Access', to: '/super-admin/features', icon: ToggleRight },
  { module: 'support', label: 'Support & Issues', to: '/super-admin/support', icon: LifeBuoy },
  { module: 'pbx', label: 'PBX Setup', to: '/super-admin/pbx', icon: PhoneCall },
  { module: 'usage', label: 'Usage & Analytics', to: '/super-admin/usage', icon: BarChart3 },
  { module: 'automation', label: 'Automation Rules', to: '/super-admin/automation', icon: Workflow },
  { module: 'health', label: 'System Health', to: '/super-admin/health', icon: Activity },
  { module: 'incidents', label: 'Incident Management', to: '/super-admin/incidents', icon: Siren },
  { module: 'notifications', label: 'Notifications', to: '/super-admin/notifications', icon: Megaphone },
  { module: 'audit', label: 'Audit Logs', to: '/super-admin/audit', icon: ScrollText },
  { module: 'security', label: 'Security Center', to: '/super-admin/security', icon: ShieldCheck },
  { module: 'data', label: 'Data Management', to: '/super-admin/data', icon: Database },
  { module: 'settings', label: 'Global Settings', to: '/super-admin/settings', icon: Settings2 },
]

export const MERCHANT_STATUS = {
  ONBOARDING: { label: 'Onboarding', variant: 'info' },
  ACTIVE: { label: 'Active', variant: 'success' },
  SUSPENDED: { label: 'Suspended', variant: 'warning' },
  CLOSED: { label: 'Closed', variant: 'neutral' },
} as const
