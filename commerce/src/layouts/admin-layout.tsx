import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgePercent, Bell, Boxes, ClipboardCheck, Globe, LogOut, Menu, Monitor, MonitorSmartphone, Moon, Plus, RefreshCw, ScanBarcode, Search, ShieldAlert, Sun,
  UserCog,
} from 'lucide-react'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, Outlet, useLocation, useMatches, useNavigate } from 'react-router'
import { toast } from '@/lib/toast'
import { BrandLoader, Logo, LogoMark } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { PhoneProvider } from '@/features/voicedrive/phone-context'
import { PhoneWidget } from '@/features/voicedrive/phone-widget'
import { useAuth } from '@/features/auth/auth-context'
import { AccountRestricted, ReadOnlyBanner } from '@/features/billing/account-restricted'
import { SupportViewBanner } from '@/features/support/support-view-banner'
import { CommandPalette } from '@/features/shell/command-palette'
import { GO_SHORTCUTS, type NavCounts } from '@/features/shell/nav-config'
import { type ShellAction, SidebarNav } from '@/features/shell/sidebar'
import { ContactDialog, HelpDialog, ReportIssueDialog } from '@/features/shell/support-dialogs'
import { AnnouncementBanner, AnnouncementsButton } from '@/features/shell/platform-announcements'
import { WhatsNew } from '@/features/shell/whats-new'
import { type AdminTheme, setAdminTheme, useAdminTheme, useAdminThemePreference } from '@/hooks/use-admin-theme'
import { useStoreConfig } from '@/hooks/use-store-config'
import { deviceLabel } from '@/lib/device'
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

/** Signs staff out after the inactivity time set in Settings → Advanced (0 = never). */
function useIdleSignOut(minutes: number, signOut: () => Promise<void>) {
  const navigate = useNavigate()
  useEffect(() => {
    if (!minutes || minutes <= 0) return
    const KEY = 'admin-last-activity'
    const mark = () => { try { localStorage.setItem(KEY, String(Date.now())) } catch { /* private mode */ } }
    const last = () => { try { return Number(localStorage.getItem(KEY)) || Date.now() } catch { return Date.now() } }
    mark()
    let lastMark = Date.now()
    // Activity in any tab counts; marks are throttled to once every 15 s.
    const onActivity = () => { if (Date.now() - lastMark > 15_000) { lastMark = Date.now(); mark() } }
    const events = ['pointerdown', 'keydown', 'scroll', 'visibilitychange'] as const
    for (const e of events) window.addEventListener(e, onActivity, { passive: true })
    const timer = window.setInterval(() => {
      if (Date.now() - last() > minutes * 60_000) {
        void signOut().then(() => {
          toast.info('Signed out after inactivity', { description: 'Sign in again to continue.' })
          navigate('/admin/login')
        })
      }
    }, 30_000)
    return () => { for (const e of events) window.removeEventListener(e, onActivity); window.clearInterval(timer) }
  }, [minutes, signOut, navigate])
}

/** Shown instead of the admin while this browser waits for an admin to approve it. */
function DeviceGate({ status, email, onSignOut }: { status: string | null | undefined; email: string; onSignOut: () => void }) {
  const queryClient = useQueryClient()
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const t = window.setInterval(() => void queryClient.invalidateQueries({ queryKey: ['my-access'] }), 20_000)
    return () => window.clearInterval(t)
  }, [queryClient])
  const blocked = status === 'REJECTED' || status === 'REVOKED'
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <LogoMark className="mb-4 size-10" />
      <span className="flex size-12 items-center justify-center rounded-xl border bg-card shadow-xs"><MonitorSmartphone className="size-6 text-muted-foreground" /></span>
      <h1 className="text-lg font-semibold">{blocked ? 'This device is blocked' : 'Waiting for approval'}</h1>
      <p className="text-sm text-muted-foreground">
        {blocked
          ? 'An admin blocked this device for your account. Ask them to approve it again, or sign in from your approved device.'
          : <>You signed in as {email} on a new device (<span className="font-medium text-foreground">{deviceLabel()}</span>). An owner or admin needs to approve it in Settings → Device Approvals. This page opens by itself once approved.</>}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onSignOut}><LogOut /> Sign out</Button>
        <Button disabled={checking} onClick={() => { setChecking(true); void queryClient.invalidateQueries({ queryKey: ['my-access'] }).finally(() => setChecking(false)) }}>
          <RefreshCw className={cn(checking && 'animate-spin')} /> Check again
        </Button>
      </div>
    </div>
  )
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
  const platformMember = useQuery({
    queryKey: ['is-platform-staff', session?.user.id],
    enabled: Boolean(session),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('is_platform_staff')
      if (error) throw error
      return data === true
    },
  })
  const alerts = useNewOrderAlerts(Boolean(access && can('orders.view')))
  const counts = useNavCounts(Boolean(access && can('orders.view')), Boolean(access && can('fraud.view')))
  const theme = useAdminThemePreference()
  useAdminTheme()
  useIdleSignOut(access?.idle_logout_minutes ?? 0, signOut)

  const toggleCollapsed = useCallback(() => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1') } catch { /* private mode */ }
    return !c
  }), [])
  useShortcuts({ search: () => setDialog('search'), toggleMenu: toggleCollapsed, help: () => setDialog('help') }, can)

  useEffect(() => {
    document.title = `${config?.store.name ?? 'Store'} · Fullfilio`
  }, [config?.store.name])

  if (loading || accessLoading || (!access && platformMember.isLoading)) return <BrandLoader label="Loading your workspace…" />
  if (!session) return <Navigate to={`/admin/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  // Platform team members without a business of their own work in the Super Admin panel.
  if (!access && platformMember.data) return <Navigate to="/super-admin" replace />
  if (!access) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <LogoMark className="mb-4 size-10" />
        <ShieldAlert className="size-7 text-muted-foreground" />
        <h1 className="text-lg font-semibold">No business on this account yet</h1>
        <p className="text-sm text-muted-foreground">{session.user.email} is not part of a business, or the account was deactivated. Open your own business in a few steps, or ask your owner to invite you.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={() => signOut()}>Sign out</Button>
          <Button asChild><Link to="/start/finish">Open my business</Link></Button>
        </div>
      </div>
    )
  }

  if (access.device_blocked) {
    return <DeviceGate status={access.device?.status} email={access.email} onSignOut={() => void signOut().then(() => navigate('/admin/login'))} />
  }

  if (access.access_mode === 'BLOCKED') {
    return <AccountRestricted email={access.email} onSignOut={() => void signOut().then(() => navigate('/admin/login'))} />
  }

  const required = [...matches].reverse().map((m) => (m.handle as { permission?: string } | undefined)?.permission).find(Boolean)
  const allowed = !required || can(required)
  const onAction = (action: ShellAction) => { setMobileOpen(false); setDialog(action) }
  const ThemeIcon = THEMES.find((t) => t.value === theme)?.icon ?? Moon

  const sidebar = (rail: boolean) => (
    <div className="flex h-full flex-col text-sidebar-foreground">
      <div className={cn('flex h-16 shrink-0 items-center', rail ? 'justify-center px-2' : 'px-4')}>
        <Link to="/admin" onClick={() => setMobileOpen(false)} aria-label="Fullfilio — dashboard" className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none">
          {rail ? <LogoMark /> : <Logo />}
        </Link>
      </div>
      {!rail && (
        <div className="px-3 pb-1">
          <div className="flex items-center gap-2.5 rounded-xl border border-sidebar-border bg-sidebar-active px-2.5 py-2 shadow-xs">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-[11px] font-semibold text-foreground">{initials(config?.store.name ?? 'S')}</span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[13px] font-medium">{config?.store.name ?? 'Store'}</span>
              <span className="block truncate text-[11px] text-sidebar-muted">{access.role_name}</span>
            </span>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto pb-4">
        <SidebarNav counts={counts} collapsed={rail} onAction={onAction}
          onToggleCollapsed={mobileOpen ? undefined : toggleCollapsed} onNavigate={() => setMobileOpen(false)} />
      </div>
    </div>
  )

  return (
    <PhoneProvider>
    <div className="flex min-h-dvh bg-shell" style={{ '--shell-menu': collapsed ? '4.25rem' : '16rem' } as CSSProperties}>
      <aside className={cn('no-print sticky top-0 hidden h-dvh shrink-0 flex-col bg-sidebar transition-[width] duration-200 ease-out lg:flex',
        collapsed ? 'w-[4.25rem]' : 'w-64')}>
        {sidebar(collapsed)}
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 border-0 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar(false)}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col lg:py-2 lg:pr-2">
        {/* Keeps the panel's top edge in place while the page scrolls under it. */}
        {!access.support_session && <div aria-hidden className="no-print fixed inset-x-0 top-0 z-30 hidden h-2 bg-shell lg:block" />}
        <div className="flex min-h-dvh min-w-0 flex-1 flex-col bg-background lg:min-h-[calc(100dvh-1rem)] lg:rounded-2xl lg:border lg:shadow-xs print:border-0 print:shadow-none">
        {access.support_session && <SupportViewBanner access={access} />}
        <header className={cn('no-print sticky z-30 flex h-14 items-center gap-1 border-b bg-background/85 px-2 backdrop-blur-md sm:gap-1.5 sm:px-4 lg:rounded-t-2xl',
          access.support_session ? 'top-10' : 'top-0 lg:top-2')}>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground lg:hidden" onClick={() => setDialog('search')} aria-label="Quick search (Ctrl K)">
            <Search /> <span className="hidden sm:inline">Search</span>
          </Button>
          <nav className="hidden items-center gap-0.5 md:flex [&_[data-slot=button]]:text-foreground/75 [&_[data-slot=button]:hover]:text-foreground" aria-label="Shortcuts">
            {can('orders.create') && <Button variant="ghost" size="sm" asChild><Link to="/admin/orders/new"><Plus /> New Order</Link></Button>}
            {can('orders.view') && <Button variant="ghost" size="sm" asChild><Link to="/admin/orders/web"><Globe /> Web Order List</Link></Button>}
            {can('orders.view') && <Button variant="ghost" size="sm" asChild><Link to="/admin/orders/approved"><ClipboardCheck /> Order List</Link></Button>}
            {can('orders.fulfill') && <Button variant="ghost" size="sm" asChild className="hidden xl:inline-flex"><Link to="/admin/scan"><ScanBarcode /> Scan</Link></Button>}
          </nav>
          <div className="ml-auto flex items-center gap-0.5 [&>[data-slot=button][data-size=icon]]:rounded-full">
            {can('orders.create') && (
              <Button size="icon" variant="ghost" asChild className="md:hidden" aria-label="New order"><Link to="/admin/orders/new"><Plus /></Link></Button>
            )}
            <AnnouncementsButton />
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
                  <span className="flex size-7 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background">{initials(access.full_name || access.email)}</span>
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
                {can('inventory.view') && <DropdownMenuItem asChild><Link to="/admin/inventory?view=alerts"><Boxes /> Low stock</Link></DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => signOut().then(() => navigate('/admin/login'))}><LogOut /> Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <AnnouncementBanner />
        <main className="print-area w-full min-w-0 flex-1 p-3 pb-24 sm:px-6 sm:py-6 sm:pb-24">
          {/* Each page fades in when you move between menu items. */}
          <div key={location.pathname} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none">
            {access.access_mode === 'READ_ONLY' && <ReadOnlyBanner />}
            {allowed ? <Outlet /> : <PermissionDenied />}
          </div>
        </main>
        </div>
      </div>

      <CommandPalette open={dialog === 'search'} onOpenChange={(o) => setDialog(o ? 'search' : null)} />
      <HelpDialog open={dialog === 'help'} onOpenChange={(o) => setDialog(o ? 'help' : null)} />
      <ContactDialog open={dialog === 'contact'} onOpenChange={(o) => setDialog(o ? 'contact' : null)} />
      <ReportIssueDialog open={dialog === 'report'} onOpenChange={(o) => setDialog(o ? 'report' : null)} />
      {can('pbx.call') && <PhoneWidget />}
    </div>
    </PhoneProvider>
  )
}
