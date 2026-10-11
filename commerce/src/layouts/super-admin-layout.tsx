import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight, Eye, LogOut, Menu, Search, ShieldAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation, useMatches, useNavigate } from 'react-router'
import { EmptyState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/features/auth/auth-context'
import { PLATFORM_NAV } from '@/features/platform/nav'
import { NotificationsBell } from '@/features/platform/notifications-bell'
import { PlatformProvider, usePlatform } from '@/features/platform/platform-context'
import { initials, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { platformSearch } from '@/services/platform'
import { endSupportSession } from '@/services/support-center'

/** The Super Admin panel is always dark. */
function useDarkPanel() {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.add('admin', 'dark', 'platform')
    return () => root.classList.remove('admin', 'dark', 'platform')
  }, [])
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = usePlatform()
  return (
    <nav className="flex flex-col gap-0.5 px-2 py-3" aria-label="Super Admin">
      {PLATFORM_NAV.filter((item) => can(item.module)).map((item) => (
        <NavLink
          key={item.module}
          to={item.to}
          end={item.to === '/super-admin'}
          onClick={onNavigate}
          className={({ isActive }) => cn(
            'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
            isActive && 'bg-muted text-foreground',
          )}
        >
          <item.icon className="size-4 shrink-0" />
          <span className="truncate">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

/** One search across merchants, employees, stores, orders, errors, tickets and the audit log. */
function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const navigate = useNavigate()
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const results = useQuery({ queryKey: ['platform-search', debounced], enabled: debounced.length >= 2, queryFn: () => platformSearch(debounced) })
  const go = (to: string) => {
    onOpenChange(false)
    setQ('')
    navigate(to)
  }
  const r = results.data
  const groups: Array<{ title: string; items: Array<{ key: string; label: string; hint?: string; to: string }> }> = r ? [
    { title: 'Merchants', items: r.merchants.map((m) => ({ key: m.id, label: `#${m.number} ${m.name}`, hint: m.owner_email ?? m.status, to: `/super-admin/merchants/${m.id}` })) },
    { title: 'Orders', items: r.orders.map((o) => ({ key: o.id, label: o.order_number, hint: `${o.merchant} · ${o.status.toLowerCase()}`, to: `/super-admin/merchants/${o.merchant_id}` })) },
    { title: 'Stores', items: r.stores.map((s) => ({ key: s.id, label: s.shop_domain, hint: `${s.platform.toLowerCase()} · ${s.merchant}`, to: `/super-admin/merchants/${s.merchant_id}?tab=stores` })) },
    { title: 'Employees', items: r.employees.map((e) => ({ key: e.id, label: e.name, hint: e.email, to: `/super-admin/employees?focus=${e.id}` })) },
    { title: 'Support tickets', items: r.tickets.map((t) => ({ key: t.id, label: `#${t.number} ${t.subject}`, hint: t.merchant, to: `/super-admin/support?ticket=${t.id}` })) },
    { title: 'Errors', items: r.errors.map((e) => ({ key: String(e.id), label: e.message, hint: `${e.category.toLowerCase()} · ${timeAgo(e.last_seen_at)}`, to: `/super-admin/health?log=${e.id}` })) },
    { title: 'Audit log', items: r.audit.map((a) => ({ key: String(a.id), label: a.action, hint: a.actor_email ?? '', to: `/super-admin/audit?q=${encodeURIComponent(a.entity_id ?? a.action)}` })) },
  ].filter((g) => g.items.length) : []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Merchants, order numbers, stores, employees, tickets…"
            className="h-11 border-0 bg-transparent shadow-none focus-visible:ring-0" />
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {debounced.length < 2 ? <p className="px-2 py-6 text-center text-sm text-muted-foreground">Type at least two characters.</p>
            : results.isLoading ? <LoadingState />
              : results.error ? <p className="px-2 py-6 text-center text-sm text-destructive">{(results.error as Error).message}</p>
                : groups.length === 0 ? <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing found.</p>
                  : groups.map((g) => (
                    <div key={g.title} className="mb-2">
                      <p className="px-2 py-1 text-xs font-medium text-muted-foreground">{g.title}</p>
                      {g.items.map((i) => (
                        <button key={i.key} type="button" onClick={() => go(i.to)}
                          className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
                          <span className="truncate">{i.label}</span>
                          {i.hint && <span className="shrink-0 truncate text-xs text-muted-foreground">{i.hint}</span>}
                        </button>
                      ))}
                    </div>
                  ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Panel() {
  const { me, loading, error, can, refresh } = usePlatform()
  const { signOut, isStaff } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const matches = useMatches()
  const [menu, setMenu] = useState(false)
  const [search, setSearch] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearch(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (loading) return <LoadingState className="h-screen" />
  if (error) return <EmptyState className="h-screen" title="Could not load your access" description={(error as Error).message} />
  if (me?.session_expired) {
    return (
      <EmptyState className="h-screen" icon={<ShieldAlert />} title="Your Super Admin session has ended"
        description="For security, platform staff sign in again after a set time, or after being signed out by a security manager."
        action={<Button onClick={() => signOut().then(() => navigate(`/admin/login?next=${encodeURIComponent(location.pathname + location.search)}`))}>Sign in again</Button>} />
    )
  }
  if (!me) {
    return (
      <EmptyState className="h-screen" icon={<ShieldAlert />} title="This account is not on the platform team"
        description="The Super Admin panel is for the people who run the platform."
        action={<div className="flex gap-2">{isStaff && <Button asChild variant="outline"><Link to="/admin">Open your business</Link></Button>}
          <Button onClick={() => signOut().then(() => navigate('/admin/login'))}>Sign out</Button></div>} />
    )
  }

  // Each page names the module it belongs to; the database checks again on every call.
  const module = [...matches].reverse().map((m) => (m.handle as { module?: string } | undefined)?.module).find(Boolean)
  const allowed = !module || can(module)

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar lg:flex">
        <Link to="/super-admin" className="flex h-14 items-center gap-2 border-b px-4 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-foreground text-xs font-bold text-background">SA</span>
          Super Admin
        </Link>
        <div className="flex-1 overflow-y-auto"><Sidebar /></div>
        <div className="border-t p-3 text-xs text-muted-foreground">{me.role.name}{me.merchant_scope === 'ASSIGNED' && ' · assigned merchants'}</div>
      </aside>
      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="flex h-14 items-center border-b px-4">Super Admin</SheetTitle>
          <Sidebar onNavigate={() => setMenu(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur sm:px-5">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMenu(true)} aria-label="Menu"><Menu /></Button>
          <button type="button" onClick={() => setSearch(true)}
            className="flex h-9 w-full max-w-md items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground hover:bg-muted">
            <Search className="size-4" /> <span className="truncate">Search merchants, orders, stores…</span>
            <kbd className="ml-auto hidden rounded border px-1.5 text-[10px] sm:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <NotificationsBell />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-2">
                  <span className="grid size-7 place-items-center rounded-full bg-muted text-xs font-semibold">{initials(me.full_name || me.email)}</span>
                  <span className="hidden text-sm sm:inline">{me.full_name || me.email}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <p className="text-sm font-medium">{me.full_name || me.email}</p>
                  <p className="text-xs text-muted-foreground">{me.role.name}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {me.merchant_staff && <DropdownMenuItem onClick={() => navigate('/admin')}><ArrowLeftRight /> Open my business</DropdownMenuItem>}
                <DropdownMenuItem onClick={() => signOut().then(() => navigate('/admin/login'))}><LogOut /> Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {me.support_session && (
          <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs sm:px-5">
            <Eye className="size-4 text-amber-500" />
            <span>You have a read-only customer view of <b>#{me.support_session.merchant.number} {me.support_session.merchant.name}</b> until {new Date(me.support_session.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</span>
            <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => window.location.assign('/admin')}>Open it</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => void endSupportSession().then(() => refresh())}>End</Button>
          </div>
        )}
        <main key={location.pathname} className="mx-auto w-full max-w-7xl flex-1 px-3 py-5 sm:px-6">
          {allowed ? <Outlet /> : <EmptyState icon={<ShieldAlert />} title="Your role does not include this section" description="Ask a Super Admin if you need it." />}
        </main>
      </div>
      <GlobalSearch open={search} onOpenChange={setSearch} />
    </div>
  )
}

export default function SuperAdminLayout() {
  useDarkPanel()
  const { session, loading } = useAuth()
  const location = useLocation()
  if (loading) return <LoadingState className="h-screen" />
  if (!session) return <Navigate to={`/admin/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return (
    <PlatformProvider>
      <Panel />
    </PlatformProvider>
  )
}
