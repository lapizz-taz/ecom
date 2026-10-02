import { useQueryClient } from '@tanstack/react-query'
import {
  BadgePercent, BarChart3, Bell, Boxes, ChevronDown, ClipboardList, Factory, LayoutDashboard, LogOut, Megaphone, Menu,
  Package, ScanBarcode, ScrollText, Search, Settings, ShieldAlert, ShoppingCart, Truck, UserCog, Users, Wallet, Warehouse,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation, useMatches, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/features/auth/auth-context'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatMoney, initials } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

interface NavItem {
  label: string
  to: string
  icon?: ReactNode
  permission?: string
  children?: Array<{ label: string; to: string; permission?: string }>
}

const NAV: NavItem[] = [
  { label: 'Dashboard', to: '/admin', icon: <LayoutDashboard />, permission: 'dashboard.view' },
  {
    label: 'Orders', to: '/admin/orders', icon: <ShoppingCart />, permission: 'orders.view',
    children: [
      { label: 'All orders', to: '/admin/orders' },
      { label: 'Pending', to: '/admin/orders?tab=pending' },
      { label: 'Confirmed', to: '/admin/orders?tab=confirmed' },
      { label: 'Processing', to: '/admin/orders?tab=processing' },
      { label: 'Ready to ship', to: '/admin/orders?tab=ready' },
      { label: 'Shipped', to: '/admin/orders?tab=shipped' },
      { label: 'Delivered', to: '/admin/orders?tab=delivered' },
      { label: 'Cancelled', to: '/admin/orders?tab=cancelled' },
      { label: 'Returned', to: '/admin/orders?tab=returned' },
      { label: 'Failed delivery', to: '/admin/orders?tab=failed' },
      { label: 'Possible duplicates', to: '/admin/orders?tab=duplicates' },
      { label: 'Fraud / Review', to: '/admin/orders/fraud', permission: 'fraud.view' },
    ],
  },
  {
    label: 'Fulfilment', to: '/admin/scan', icon: <ScanBarcode />, permission: 'orders.fulfill',
    children: [
      { label: 'Scan parcels', to: '/admin/scan' },
      { label: 'Labels to print', to: '/admin/orders?tab=to_print' },
      { label: 'Ready to ship', to: '/admin/orders?tab=ready' },
    ],
  },
  { label: 'Products', to: '/admin/products', icon: <Package />, permission: 'products.view' },
  {
    label: 'Inventory', to: '/admin/inventory', icon: <Warehouse />, permission: 'inventory.view',
    children: [
      { label: 'Stock overview', to: '/admin/inventory' },
      { label: 'Low stock', to: '/admin/inventory?status=LOW_STOCK' },
      { label: 'Out of stock', to: '/admin/inventory?status=OUT_OF_STOCK' },
      { label: 'Stock movements', to: '/admin/inventory/movements' },
      { label: 'Stock adjustments', to: '/admin/inventory/adjustments' },
      { label: 'Purchases', to: '/admin/purchases', permission: 'purchases.view' },
    ],
  },
  {
    label: 'Production', to: '/admin/production', icon: <Factory />, permission: 'production.view',
    children: [
      { label: 'Production queue', to: '/admin/production' },
      { label: 'In production', to: '/admin/production?status=IN_PRODUCTION' },
      { label: 'Quality check', to: '/admin/production?status=QUALITY_CHECK' },
      { label: 'Ready', to: '/admin/production?status=READY' },
    ],
  },
  { label: 'Customers', to: '/admin/customers', icon: <Users />, permission: 'customers.view' },
  { label: 'Couriers', to: '/admin/couriers', icon: <Truck />, permission: 'couriers.view' },
  {
    label: 'Finance', to: '/admin/finance', icon: <Wallet />, permission: 'finance.view',
    children: [
      { label: 'Overview', to: '/admin/finance' },
      { label: 'Income', to: '/admin/finance/income' },
      { label: 'Expenses', to: '/admin/finance/expenses' },
      { label: 'Refunds', to: '/admin/finance/refunds' },
      { label: 'Profit & Loss', to: '/admin/finance/profit-loss' },
      { label: 'Cash flow', to: '/admin/finance/cash-flow' },
    ],
  },
  {
    label: 'Marketing', to: '/admin/marketing', icon: <Megaphone />, permission: 'marketing.view',
    children: [
      { label: 'Campaigns & ad spend', to: '/admin/marketing' },
      { label: 'Coupons', to: '/admin/coupons', permission: 'coupons.manage' },
    ],
  },
  { label: 'Reports', to: '/admin/reports', icon: <BarChart3 />, permission: 'reports.view' },
  { label: 'Settings', to: '/admin/settings', icon: <Settings />, permission: 'settings.view' },
  { label: 'Users & roles', to: '/admin/users', icon: <UserCog />, permission: 'users.manage' },
  { label: 'Audit log', to: '/admin/audit-logs', icon: <ScrollText />, permission: 'audit.view' },
]

function isActive(pathname: string, search: string, to: string): boolean {
  const [path, query] = to.split('?')
  if (query) return pathname === path && search.includes(query)
  if (path === '/admin') return pathname === '/admin'
  return pathname === path && !search.includes('tab=') && !search.includes('status=')
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth()
  const { pathname, search } = useLocation()
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  return (
    <nav className="grid gap-0.5 px-3 py-2 text-sm" aria-label="Admin">
      {NAV.filter((item) => !item.permission || can(item.permission)).map((item) => {
        const inGroup = pathname.startsWith(item.to) && item.to !== '/admin'
        const expanded = item.children && (openGroup === item.label || (openGroup === null && inGroup))
        return (
          <div key={item.label}>
            <div className="flex items-center">
              <NavLink
                to={item.to}
                end={item.to === '/admin'}
                onClick={onNavigate}
                className={({ isActive: active }) => cn(
                  'flex flex-1 items-center gap-3 rounded-lg px-3 py-2 text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground [&_svg]:size-4',
                  (active || inGroup) && 'bg-brand font-medium text-brand-foreground hover:bg-brand hover:text-brand-foreground',
                )}
              >
                {item.icon}
                {item.label}
              </NavLink>
              {item.children && (
                <button type="button" className="ml-0.5 rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground" aria-label={`Toggle ${item.label}`}
                  onClick={() => setOpenGroup(expanded ? '' : item.label)}>
                  <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
                </button>
              )}
            </div>
            {expanded && (
              <div className="my-1 ml-[22px] grid border-l border-sidebar-border pl-3">
                {item.children!.filter((c) => !c.permission || can(c.permission)).map((child) => (
                  <Link key={child.to} to={child.to} onClick={onNavigate}
                    className={cn('rounded-md px-2 py-1.5 text-[13px] text-sidebar-muted hover:text-sidebar-foreground',
                      isActive(pathname, search, child.to) && 'font-medium text-brand')}>
                    {child.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}

/** New storefront orders appear as they arrive (Supabase Realtime). */
function useNewOrderAlerts(enabled: boolean) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [unseen, setUnseen] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const channel = supabase
      .channel('admin-new-orders')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, (payload) => {
        const order = payload.new as { id: string; order_number: string; customer_name: string; total_amount: number }
        setUnseen((n) => n + 1)
        toast.success(`New order ${order.order_number}`, {
          description: `${order.customer_name} · ${formatMoney(order.total_amount)}`,
          action: { label: 'Open', onClick: () => navigate(`/admin/orders/${order.id}`) },
        })
        void queryClient.invalidateQueries({ queryKey: ['orders'] })
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, () => {
        void queryClient.invalidateQueries({ queryKey: ['orders'] })
      })
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [enabled, navigate, queryClient])
  return { unseen, reset: () => setUnseen(0) }
}

function PermissionDenied() {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <ShieldAlert className="mx-auto mb-3 size-8 text-muted-foreground" />
      <h2 className="font-semibold">You don't have access to this page</h2>
      <p className="mt-1 text-sm text-muted-foreground">Ask an owner or admin to update your role if you need it.</p>
    </div>
  )
}

export default function AdminLayout() {
  const { session, loading, access, accessLoading, can, signOut } = useAuth()
  const { data: config } = useStoreConfig()
  const location = useLocation()
  const navigate = useNavigate()
  const matches = useMatches()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [q, setQ] = useState('')
  const alerts = useNewOrderAlerts(Boolean(access && can('orders.view')))

  useEffect(() => {
    document.title = `Admin · ${config?.store.name ?? 'Store'}`
  }, [config?.store.name])

  if (loading || accessLoading) return <LoadingState label="Loading your workspace…" className="min-h-dvh" />
  if (!session) return <Navigate to={`/admin/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (!access) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <ShieldAlert className="size-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">No staff access</h1>
        <p className="text-sm text-muted-foreground">Your account ({session.user.email}) is not a staff account or has been deactivated.</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => signOut()}>Sign out</Button>
          <Button asChild><Link to="/">Go to store</Link></Button>
        </div>
      </div>
    )
  }

  const required = [...matches].reverse().map((m) => (m.handle as { permission?: string } | undefined)?.permission).find(Boolean)
  const allowed = !required || can(required)

  const search = (e: React.FormEvent) => {
    e.preventDefault()
    navigate(`/admin/orders?q=${encodeURIComponent(q.trim())}`)
    setQ('')
  }

  const sidebar = (
    <div className="flex h-full flex-col text-sidebar-foreground">
      <div className="flex h-16 items-center gap-2.5 px-6">
        <div className="flex size-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
          {initials(config?.store.name ?? 'S')}
        </div>
        <span className="truncate text-[15px] font-semibold tracking-tight">{config?.store.name ?? 'Store'}</span>
      </div>
      <div className="flex-1 overflow-y-auto pb-4"><SidebarNav onNavigate={() => setMobileOpen(false)} /></div>
      <div className="border-t border-sidebar-border p-3">
        <Link to="/admin/account" onClick={() => setMobileOpen(false)} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-sidebar-accent">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold">{initials(access.full_name || access.email)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{access.full_name || access.email}</span>
            <span className="block truncate text-xs text-sidebar-muted">{access.role_name}</span>
          </span>
        </Link>
      </div>
    </div>
  )

  return (
    <div className="flex min-h-dvh bg-background">
      <aside className="no-print sticky top-0 hidden h-dvh w-64 shrink-0 flex-col bg-sidebar lg:flex">{sidebar}</aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 gap-0 border-0 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></Button>
          {can('orders.view') && (
            <form onSubmit={search} className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search orders, phone, tracking, SKU…" className="h-10 rounded-full border-transparent bg-card pl-10 shadow-xs" aria-label="Search orders" />
            </form>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {can('orders.fulfill') && (
              <Button size="sm" variant="outline" asChild className="hidden rounded-full sm:inline-flex"><Link to="/admin/scan"><ScanBarcode /> Scan</Link></Button>
            )}
            {can('orders.create') && (
              <Button size="sm" asChild className="hidden rounded-full sm:inline-flex"><Link to="/admin/orders/new"><ClipboardList /> New order</Link></Button>
            )}
            {can('orders.view') && (
              <Button variant="ghost" size="icon" className="relative" aria-label="New orders"
                onClick={() => { alerts.reset(); navigate('/admin/orders') }}>
                <Bell />
                {alerts.unseen > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-red-500" />}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[11px] font-medium">{initials(access.full_name || access.email)}</span>
                  <span className="hidden max-w-32 truncate sm:inline">{access.full_name || access.email}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <p className="truncate text-sm font-medium">{access.full_name || access.email}</p>
                  <p className="text-xs text-muted-foreground">{access.role_name}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild><Link to="/admin/account"><UserCog /> My account</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><a href="/" target="_blank" rel="noreferrer"><BadgePercent /> View store</a></DropdownMenuItem>
                <DropdownMenuItem asChild><Link to="/admin/inventory?status=LOW_STOCK"><Boxes /> Low stock</Link></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => signOut().then(() => navigate('/admin/login'))}><LogOut /> Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="print-area mx-auto w-full max-w-[1400px] flex-1 p-3 sm:p-6">
          {allowed ? <Outlet /> : <PermissionDenied />}
        </main>
      </div>
    </div>
  )
}
