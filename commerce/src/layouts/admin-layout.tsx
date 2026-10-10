import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgePercent, Bell, Boxes, ClipboardCheck, Globe, LogOut, Menu, Monitor, Moon, Plus, ScanBarcode, Search, ShieldAlert, Sun, UserCog,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, Outlet, useLocation, useMatches, useNavigate } from 'react-router'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/features/auth/auth-context'
import { CommandPalette } from '@/features/shell/command-palette'
import { GO_SHORTCUTS, type NavCounts } from '@/features/shell/nav-config'
import { type ShellAction, SidebarNav } from '@/features/shell/sidebar'
import { ContactDialog, HelpDialog, ReportIssueDialog } from '@/features/shell/support-dialogs'
import { WhatsNew } from '@/features/shell/whats-new'
import { type AdminTheme, setAdminTheme, useAdminTheme, useAdminThemePreference } from '@/hooks/use-admin-theme'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatMoney, initials } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { queueCounts, statusCounts } from '@/services/orders'

const COLLAPSED_KEY = 'admin-sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** Live counts for the menu badges. */
function useNavCounts(enabled: boolean, canFraud: boolean): NavCounts {
  const queue = useQuery({ queryKey: ['orders', 'queue-counts'], queryFn: queueCounts, enabled, staleTime: 30_000, refetchInterval: 120_000 })
  const status = useQuery({ queryKey: ['orders', 'status-counts'], queryFn: statusCounts, enabled: enabled && canFraud, staleTime: 30_000, refetchInterval: 120_000 })
  return { queue: queue.data, status: status.data }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

/** Ctrl/Cmd+K search, Ctrl/Cmd+B menu, ? help, and "G then a letter" to jump. */
function useShortcuts(handlers: { search: () => void; toggleMenu: () => void; help: () => void }, can: (p: string) => boolean) {
  const navigate = useNavigate()
  const pendingG = useRef(0)
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current.search(); return }
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); ref.current.toggleMenu(); return }
      if (mod || e.altKey || isTyping(e.target)) return
      if (e.key === '?') { e.preventDefault(); ref.current.help(); return }
      const key = e.key.toLowerCase()
      if (key === 'g') { pendingG.current = Date.now(); return }
      if (Date.now() - pendingG.current < 1200 && GO_SHORTCUTS[key]) {
        pendingG.current = 0
        const target = GO_SHORTCUTS[key]
        if (!target.permission || can(target.permission)) { e.preventDefault(); navigate(target.to) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, can])
}

const THEMES: Array<{ value: AdminTheme; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

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
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [dialog, setDialog] = useState<ShellAction | null>(null)
  const alerts = useNewOrderAlerts(Boolean(access && can('orders.view')))
  const counts = useNavCounts(Boolean(access && can('orders.view')), Boolean(access && can('fraud.view')))
  const theme = useAdminThemePreference()
  useAdminTheme()

  const toggleCollapsed = useCallback(() => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1') } catch { /* private mode */ }
    return !c
  }), [])
  useShortcuts({ search: () => setDialog('search'), toggleMenu: toggleCollapsed, help: () => setDialog('help') }, can)

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
  const onAction = (action: ShellAction) => { setMobileOpen(false); setDialog(action) }
  const ThemeIcon = THEMES.find((t) => t.value === theme)?.icon ?? Moon

  const sidebar = (rail: boolean) => (
    <div className="flex h-full flex-col text-sidebar-foreground">
      <div className={cn('flex h-16 shrink-0 items-center gap-2.5', rail ? 'justify-center px-2' : 'px-5')}>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
          {initials(config?.store.name ?? 'S')}
        </div>
        {!rail && (
          <span className="min-w-0">
            <span className="block truncate text-[15px] leading-tight font-semibold tracking-tight">{config?.store.name ?? 'Store'}</span>
            <span className="block truncate text-[11px] text-sidebar-muted">{access.role_name}</span>
          </span>
        )}
      </div>
      {!rail && (
        <div className="px-3 pb-1">
          <button type="button" onClick={() => onAction('search')}
            className="flex h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border px-3 text-[13px] text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <Search className="size-3.5" /> Quick Search
            <kbd className="ml-auto rounded border border-sidebar-border px-1.5 text-[10px]">Ctrl K</kbd>
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto pb-4">
        <SidebarNav counts={counts} collapsed={rail} onAction={onAction}
          onToggleCollapsed={mobileOpen ? undefined : toggleCollapsed} onNavigate={() => setMobileOpen(false)} />
      </div>
    </div>
  )

  return (
    <div className="flex min-h-dvh bg-background">
      <aside className={cn('no-print sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out lg:flex',
        collapsed ? 'w-16' : 'w-64')}>
        {sidebar(collapsed)}
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 gap-0 border-0 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar(false)}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-1 border-b bg-background/90 px-2 backdrop-blur sm:gap-1.5 sm:px-4">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setDialog('search')} aria-label="Quick search (Ctrl K)">
            <Search /> <span className="hidden sm:inline">Search</span>
            <kbd className="ml-1 hidden rounded border px-1 text-[10px] md:inline">Ctrl K</kbd>
          </Button>
          <nav className="hidden items-center gap-0.5 md:flex" aria-label="Shortcuts">
            {can('orders.create') && <Button variant="ghost" size="sm" asChild><Link to="/admin/orders/new"><Plus /> New Order</Link></Button>}
            {can('orders.view') && <Button variant="ghost" size="sm" asChild><Link to="/admin/orders/web"><Globe /> Web Order List</Link></Button>}
            {can('orders.view') && <Button variant="ghost" size="sm" asChild><Link to="/admin/orders/approved"><ClipboardCheck /> Order List</Link></Button>}
            {can('orders.fulfill') && <Button variant="ghost" size="sm" asChild className="hidden xl:inline-flex"><Link to="/admin/scan"><ScanBarcode /> Scan</Link></Button>}
          </nav>
          <div className="ml-auto flex items-center gap-0.5">
            {can('orders.create') && (
              <Button size="icon" variant="ghost" asChild className="md:hidden" aria-label="New order"><Link to="/admin/orders/new"><Plus /></Link></Button>
            )}
            <WhatsNew />
            {can('orders.view') && (
              <Button variant="ghost" size="icon" className="relative" aria-label={alerts.unseen ? `${alerts.unseen} new orders` : 'New orders'}
                onClick={() => { alerts.reset(); navigate('/admin/orders/web') }}>
                <Bell />
                {alerts.unseen > 0 && (
                  <span className="absolute top-1 right-1 min-w-4 rounded-full bg-red-500 px-1 text-[10px] leading-4 font-medium text-white">{alerts.unseen > 9 ? '9+' : alerts.unseen}</span>
                )}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Colour mode: ${theme}`}><ThemeIcon /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Colour mode</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setAdminTheme(v as AdminTheme)}>
                  {THEMES.map((t) => <DropdownMenuRadioItem key={t.value} value={t.value}><t.icon /> {t.label}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2 pl-1.5">
                  <span className="flex size-7 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">{initials(access.full_name || access.email)}</span>
                  <span className="hidden max-w-32 truncate lg:inline">{access.full_name || access.email}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <p className="truncate text-sm font-medium">{access.full_name || access.email}</p>
                  <p className="text-xs text-muted-foreground">{access.role_name} · {config?.store.name ?? 'Store'}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild><Link to="/admin/account"><UserCog /> My account</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><a href="/" target="_blank" rel="noreferrer"><BadgePercent /> View store</a></DropdownMenuItem>
                {can('inventory.view') && <DropdownMenuItem asChild><Link to="/admin/inventory?status=LOW_STOCK"><Boxes /> Low stock</Link></DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => signOut().then(() => navigate('/admin/login'))}><LogOut /> Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="print-area w-full min-w-0 flex-1 p-3 sm:px-5 sm:py-5">
          {/* Each page fades in when you move between menu items. */}
          <div key={location.pathname} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none">
            {allowed ? <Outlet /> : <PermissionDenied />}
          </div>
        </main>
      </div>

      <CommandPalette open={dialog === 'search'} onOpenChange={(o) => setDialog(o ? 'search' : null)} />
      <HelpDialog open={dialog === 'help'} onOpenChange={(o) => setDialog(o ? 'help' : null)} />
      <ContactDialog open={dialog === 'contact'} onOpenChange={(o) => setDialog(o ? 'contact' : null)} />
      <ReportIssueDialog open={dialog === 'report'} onOpenChange={(o) => setDialog(o ? 'report' : null)} />
    </div>
  )
}
