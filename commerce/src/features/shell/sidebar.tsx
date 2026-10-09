import { ChevronDown, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/features/auth/auth-context'
import { cn } from '@/lib/utils'
import { linkMatches, NAV, type NavCounts, type NavItem } from './nav-config'

export type ShellAction = NonNullable<NavItem['action']>

/**
 * Picks the one link that is current, across the whole menu: the longest
 * link matching the address (query included) wins; for pages without their
 * own link (an order, a product) the closest parent path is used.
 */
function useCurrentLink(): string | null {
  const { pathname, search } = useLocation()
  return useMemo(() => {
    const links = NAV.flatMap((s) => s.items.flatMap((i) => [i.to, ...(i.children ?? []).map((c) => c.to)])).filter((t): t is string => !!t)
    const exact = links.filter((to) => linkMatches(to, pathname, search)).sort((a, b) => b.length - a.length)[0]
    if (exact) return exact
    const parent = links
      .filter((to) => !to.includes('?') && to !== '/admin' && pathname.startsWith(`${to}/`))
      .sort((a, b) => b.length - a.length)[0]
    return parent ?? null
  }, [pathname, search])
}

function Badge({ value, className }: { value?: number; className?: string }) {
  if (!value) return null
  return (
    <span className={cn('ml-auto min-w-5 rounded-full bg-brand-soft px-1.5 text-center text-[11px] leading-5 font-medium text-brand tabular-nums', className)}>
      {value > 999 ? '999+' : value}
    </span>
  )
}

interface SidebarProps {
  counts: NavCounts
  collapsed: boolean
  onToggleCollapsed?: () => void
  onNavigate?: () => void
  onAction: (action: ShellAction) => void
}

export function SidebarNav({ counts, collapsed, onToggleCollapsed, onNavigate, onAction }: SidebarProps) {
  const { can } = useAuth()
  const current = useCurrentLink()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState('')

  const sections = useMemo(() => NAV.map((section) => ({
    ...section,
    items: section.items
      .filter((item) => !item.permission || can(item.permission))
      .map((item) => ({ ...item, children: item.children?.filter((c) => !c.permission || can(c.permission)) })),
  })).filter((s) => s.items.length), [can])

  // Menu search: a flat list of every page whose name matches.
  const term = filter.trim().toLowerCase()
  const results = term
    ? sections.flatMap((s) => s.items.flatMap((item) => [
      ...(item.label.toLowerCase().includes(term) ? [{ label: item.label, to: item.to, action: item.action, parent: s.label }] : []),
      ...(item.children ?? []).filter((c) => c.label.toLowerCase().includes(term)).map((c) => ({ label: c.label, to: c.to, action: undefined, parent: item.label })),
    ]))
    : []

  const itemClass = (active: boolean) => cn(
    'group/item flex w-full items-center gap-3 rounded-lg px-3 py-[7px] text-left text-sidebar-muted transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground [&_svg]:size-4 [&_svg]:shrink-0',
    collapsed && 'justify-center px-0',
    active && 'bg-brand-soft font-medium text-brand hover:bg-brand-soft hover:text-brand',
  )

  return (
    <nav className={cn('grid gap-4 py-2 text-sm', collapsed ? 'px-2' : 'px-3')} aria-label="Admin">
      {!collapsed && (
        <div className="relative px-0.5">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-sidebar-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setFilter('') }}
            placeholder="Find in menu"
            aria-label="Find a page in the menu"
            className="h-8 w-full rounded-lg border border-sidebar-border bg-transparent pr-7 pl-8 text-[13px] text-sidebar-foreground placeholder:text-sidebar-muted focus:border-ring focus:outline-none"
          />
          {filter && (
            <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-sidebar-muted hover:text-sidebar-foreground" onClick={() => setFilter('')} aria-label="Clear">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {term ? (
        <div className="grid gap-0.5">
          {results.length === 0 && <p className="px-3 py-2 text-[13px] text-sidebar-muted">No page called “{filter}”</p>}
          {results.map((r) => r.to ? (
            <Link key={`${r.parent}-${r.label}`} to={r.to} onClick={() => { setFilter(''); onNavigate?.() }} className={itemClass(false)}>
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              {r.parent && <span className="truncate text-[11px] text-sidebar-muted/70">{r.parent}</span>}
            </Link>
          ) : (
            <button key={r.label} type="button" onClick={() => { setFilter(''); if (r.action) onAction(r.action) }} className={itemClass(false)}>{r.label}</button>
          ))}
        </div>
      ) : sections.map((section, i) => (
        <div key={section.label ?? i} className="grid gap-0.5">
          {section.label && !collapsed && <p className="px-3 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-sidebar-muted/70 uppercase">{section.label}</p>}
          {section.label && collapsed && i > 0 && <div className="mx-2 mb-1 border-t border-sidebar-border" />}
          {section.items.map((item) => {
            const childActive = item.children?.some((c) => c.to === current) ?? false
            const active = item.to === current || childActive
            const expanded = !collapsed && !!item.children?.length && (open[item.label] ?? childActive)
            const badge = item.badge?.(counts)
            const inner = (
              <>
                {item.icon}
                {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                {!collapsed && <Badge value={badge} />}
                {collapsed && badge ? <span className="absolute top-1 right-1 size-1.5 rounded-full bg-brand" /> : null}
              </>
            )
            const control = item.to ? (
              <Link to={item.to} onClick={onNavigate} className={cn(itemClass(active), 'relative')} aria-current={item.to === current ? 'page' : undefined}>{inner}</Link>
            ) : (
              <button type="button" onClick={() => onAction(item.action!)} className={cn(itemClass(false), 'relative')}>{inner}</button>
            )
            return (
              <div key={item.label}>
                <div className="flex items-center">
                  {collapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{control}</TooltipTrigger>
                      <TooltipContent side="right">{item.label}{badge ? ` · ${badge}` : ''}{item.shortcut ? ` (${item.shortcut})` : ''}</TooltipContent>
                    </Tooltip>
                  ) : control}
                  {!collapsed && !!item.children?.length && (
                    <button type="button" className="ml-0.5 rounded-md p-1.5 text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.label}`} aria-expanded={expanded}
                      onClick={() => setOpen((o) => ({ ...o, [item.label]: !expanded }))}>
                      <ChevronDown className={cn('size-3.5 transition-transform duration-200 ease-out', expanded && 'rotate-180')} />
                    </button>
                  )}
                </div>
                {expanded && (
                  <div className="enter my-1 ml-[21px] grid border-l border-sidebar-border pl-3">
                    {item.children!.map((child) => (
                      <Fragment key={child.to}>
                        <Link to={child.to} onClick={onNavigate} aria-current={child.to === current ? 'page' : undefined}
                          className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-sidebar-muted transition-colors hover:text-sidebar-foreground',
                            child.to === current && 'bg-sidebar-accent font-medium text-sidebar-foreground')}>
                          <span className="min-w-0 flex-1 truncate">{child.label}</span>
                          <Badge value={child.badge?.(counts)} className="bg-sidebar-accent text-sidebar-muted" />
                        </Link>
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}

      {onToggleCollapsed && (
        <button type="button" onClick={onToggleCollapsed} className={cn(itemClass(false), 'mt-1')} aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'}>
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          {!collapsed && <span className="flex-1">Collapse menu</span>}
          {!collapsed && <kbd className="text-[10px] text-sidebar-muted/70">Ctrl B</kbd>}
        </button>
      )}
    </nav>
  )
}
