import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, ArrowRight, CheckCircle2, ExternalLink, FileCode2, Globe, Info, Link2, RefreshCw, Search, Sparkles, Trash2, TriangleAlert,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { SeoEditorDialog } from '@/features/seo/seo-editor'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  deleteSeoRedirect, getSeoAudit, getSeoSettings, listSeoRedirects, runSeoBulk, saveSeoRedirect, saveSeoSettings, SEO_MODES,
  type SeoAudit, type SeoAuditItem, type SeoBulkAction, type SeoItemType, type SeoMode, type SeoSettings, type SeoSettingsState,
  type SeoSeverity, type SeoSource,
} from '@/services/seo'

// The store's SEO: an audit of what needs attention (from checks the store can make itself),
// every product / collection / page with where its title comes from, the settings (mode,
// templates, indexing, sitemap, structured data) and redirects. Bulk changes ask first.

type Target = { type: SeoItemType; key: string; name: string }

export default function StoreSeoPage() {
  const [state, update] = useUrlState({ tab: 'overview' })
  const settings = useQuery({ queryKey: ['seo-settings'], queryFn: getSeoSettings })
  const audit = useQuery({ queryKey: ['seo-audit'], queryFn: getSeoAudit })
  const [editing, setEditing] = useState<Target | null>(null)
  const base = settings.data?.base_url ?? audit.data?.base_url ?? null

  return (
    <div className="space-y-4">
      <PageHeader title="SEO" icon={<Search />}
        description="How your online store shows in Google and other search engines, and when its links are shared."
        actions={<>
          {base && <Button size="sm" variant="outline" asChild><a href={`${base}/sitemap.xml`} target="_blank" rel="noreferrer"><FileCode2 /> Sitemap</a></Button>}
          <Button size="sm" variant="outline" onClick={() => { void audit.refetch(); void settings.refetch() }} disabled={audit.isFetching}>
            {audit.isFetching ? <Spinner /> : <RefreshCw />} Recheck
          </Button>
        </>} />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab }, { resetPage: false })}>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="items">Products, collections & pages</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="redirects">Redirects</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="animate-in fade-in-0 duration-300">
          {audit.isLoading ? <LoadingState label="Checking your store…" /> : audit.error || !audit.data
            ? <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
            : <Overview audit={audit.data} onEdit={setEditing} onSettings={() => update({ tab: 'settings' }, { resetPage: false })} />}
        </TabsContent>
        <TabsContent value="items" className="animate-in fade-in-0 duration-300">
          {audit.isLoading ? <LoadingState /> : audit.error || !audit.data
            ? <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
            : <Items audit={audit.data} onEdit={setEditing} />}
        </TabsContent>
        <TabsContent value="settings" className="animate-in fade-in-0 duration-300">
          {settings.isLoading ? <LoadingState /> : settings.error || !settings.data
            ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
            : <SettingsForm state={settings.data} />}
        </TabsContent>
        <TabsContent value="redirects" className="animate-in fade-in-0 duration-300"><Redirects /></TabsContent>
      </Tabs>
      <SeoEditorDialog type={editing?.type ?? 'product'} itemKey={editing?.key ?? null} name={editing?.name} open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)} aiAvailable={settings.data?.ai_available} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Overview: health, technical SEO, what needs attention
// ---------------------------------------------------------------------------------------------

const SEVERITY: Record<SeoSeverity, { label: string; tone: 'danger' | 'warning' | 'neutral'; icon: ReactNode }> = {
  error: { label: 'Error', tone: 'danger', icon: <AlertCircle /> },
  warning: { label: 'Warning', tone: 'warning', icon: <TriangleAlert /> },
  info: { label: 'Note', tone: 'neutral', icon: <Info /> },
}
const TYPE_LABEL: Record<string, string> = { product: 'Product', collection: 'Collection', page: 'Page', theme: 'Theme', store: 'Store' }
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const editable = (t: string): t is SeoItemType => t === 'product' || t === 'collection' || t === 'page'

function Overview({ audit, onEdit, onSettings }: { audit: SeoAudit; onEdit: (t: Target) => void; onSettings: () => void }) {
  const [severity, setSeverity] = useState<'all' | SeoSeverity>('all')
  const [type, setType] = useState('all')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const h = audit.health
  const issues = audit.issues.filter((i) => (severity === 'all' || i.severity === severity) && (type === 'all' || i.type === type)
    && (!q || `${i.name} ${i.path} ${i.message}`.toLowerCase().includes(q.toLowerCase())))
  const order: Record<SeoSeverity, number> = { error: 0, warning: 1, info: 2 }
  issues.sort((a, b) => order[a.severity] - order[b.severity])
  const id = (i: { type: string; key: string; code: string }) => `${i.type}:${i.key}:${i.code}`
  const targets = [...new Map(audit.issues.filter((i) => picked.has(id(i)) && editable(i.type)).map((i) => [`${i.type}:${i.key}`, { type: i.type as SeoItemType, key: i.key }])).values()]
  const technical = audit.technical

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">SEO health</p>
                <p className="text-4xl font-semibold tracking-tight tabular-nums">{h.score}<span className="text-lg text-muted-foreground">/100</span></p>
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge variant="danger">{plural(h.errors, 'error')}</Badge>
                <Badge variant="warning">{plural(h.warnings, 'warning')}</Badge>
                <Badge variant="neutral">{plural(h.notes, 'note')}</Badge>
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${h.score} out of 100`}>
              <div className={cn('h-full rounded-full transition-[width]', h.score >= 80 ? 'bg-emerald-500' : h.score >= 50 ? 'bg-amber-500' : 'bg-red-500')} style={{ width: `${h.score}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {h.checks - h.failed} of {h.checks} checks pass across {audit.counts.products} products, {audit.counts.collections} collections and {audit.counts.pages} pages
              ({audit.counts.indexable} open to search engines). The score is the share of these checks that pass; it is not a Google ranking.
              Checked {formatDateTime(audit.checked_at)} · {SEO_MODES[audit.mode].label} mode.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2.5 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Technical SEO</p>
            <TechRow ok={technical.sitemap.enabled} label="Sitemap"
              detail={technical.sitemap.enabled ? `${technical.sitemap.urls} addresses` : 'Switched off'} href={technical.sitemap.url} />
            <TechRow ok={technical.robots.store_indexable} label="robots.txt"
              detail={technical.robots.store_indexable ? 'Search engines allowed; admin, cart and checkout kept out' : 'Asks search engines to stay out of the whole store'} href={technical.robots.url} />
            <TechRow ok={!!audit.base_url} label="Canonical addresses" detail={audit.base_url ? `Every page names its address on ${audit.base_url.replace(/^https?:\/\//, '')}` : 'No published store address yet'} />
            <TechRow ok={Object.values(technical.structured_data).some(Boolean)} label="Structured data"
              detail={Object.entries(technical.structured_data).filter(([, on]) => on).map(([k]) => ({ product: 'Product & offer', breadcrumbs: 'Breadcrumbs', organization: 'Organization', website: 'Website' }[k] ?? k)).join(', ') || 'Off'} />
            <TechRow ok label="Rendering" detail="Title, description, canonical and structured data are in the page's HTML before any script runs" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm font-semibold">Needs attention <span className="font-normal text-muted-foreground">({audit.issues.length})</span></p>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8 w-full sm:w-48" aria-label="Search issues" />
            <Select value={severity} onValueChange={(v) => setSeverity(v as typeof severity)}>
              <SelectTrigger size="sm" className="w-32" aria-label="Severity"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All severities</SelectItem><SelectItem value="error">Errors</SelectItem><SelectItem value="warning">Warnings</SelectItem><SelectItem value="info">Notes</SelectItem></SelectContent>
            </Select>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger size="sm" className="w-32" aria-label="Type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everything</SelectItem>
                {Object.entries(TYPE_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}s</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {targets.length > 0 && <BulkBar targets={targets} onDone={() => setPicked(new Set())} />}
          {issues.length === 0 ? (
            <EmptyState icon={<CheckCircle2 />} title={audit.issues.length ? 'Nothing matches these filters' : 'Nothing needs attention'}
              description={audit.issues.length ? undefined : 'Every check the store can make passes. Keep an eye on Search Console for what only Google knows.'} />
          ) : (
            <ul className="divide-y rounded-lg border">
              {issues.slice(0, 300).map((i) => {
                const s = SEVERITY[i.severity]
                const k = id(i)
                return (
                  <li key={k} className="flex items-start gap-3 px-3 py-2.5">
                    {editable(i.type)
                      ? <Checkbox className="mt-1" checked={picked.has(k)} aria-label={`Select ${i.name}`}
                          onCheckedChange={(on) => setPicked((cur) => { const n = new Set(cur); if (on) n.add(k); else n.delete(k); return n })} />
                      : <span className="w-4 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={s.tone}>{s.icon}{s.label}</Badge>
                        <span className="text-xs text-muted-foreground">{TYPE_LABEL[i.type] ?? i.type}</span>
                        <span className="truncate text-sm font-medium">{i.name}</span>
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">{i.message}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{i.path}</p>
                    </div>
                    {editable(i.type)
                      ? <Button size="sm" variant="outline" onClick={() => onEdit({ type: i.type as SeoItemType, key: i.key, name: i.name })}>Fix</Button>
                      : i.type === 'theme'
                        ? <Button size="sm" variant="outline" asChild><Link to="/admin/store/theme">Open theme</Link></Button>
                        : i.code === 'no_address'
                          ? <Button size="sm" variant="outline" asChild><Link to="/admin/store/website">Domains</Link></Button>
                          : <Button size="sm" variant="outline" onClick={onSettings}>Settings</Button>}
                  </li>
                )
              })}
            </ul>
          )}
          {issues.length > 300 && <p className="text-xs text-muted-foreground">Showing the first 300 of {issues.length}; narrow the filters to see the rest.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs font-medium text-muted-foreground">Outside this check</p>
          <p className="text-muted-foreground">These depend on search engines and are checked in their own tools (free, after you verify your domain there):</p>
          <ul className="grid gap-1.5 sm:grid-cols-3">
            {audit.external.map((e, n) => {
              const href = ['https://search.google.com/search-console', 'https://search.google.com/test/rich-results', 'https://pagespeed.web.dev/'][n]
              return (
                <li key={e} className="rounded-md border px-3 py-2">
                  {href ? <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-start gap-1.5 hover:underline">{e}<ExternalLink className="mt-0.5 size-3 shrink-0" /></a> : e}
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-muted-foreground">These settings apply to your Fullfilio online store. A Shopify or WooCommerce store keeps its SEO in that platform.</p>
        </CardContent>
      </Card>
    </div>
  )
}

function TechRow({ ok, label, detail, href }: { ok: boolean; label: string; detail: string; href?: string | null }) {
  return (
    <div className="flex items-start gap-2">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />}
      <div className="min-w-0 flex-1">
        <span className="font-medium">{label}</span> <span className="text-muted-foreground">— {detail}</span>
      </div>
      {href && <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-muted-foreground hover:text-foreground" aria-label={`Open ${label}`}><ExternalLink className="size-3.5" /></a>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Bulk changes (always confirmed; fields the merchant wrote are left alone unless asked)
// ---------------------------------------------------------------------------------------------

const BULK: Record<SeoBulkAction, { label: string; title: string; detail: string }> = {
  generate: {
    label: 'Generate titles & descriptions', title: 'Generate and store titles and descriptions?',
    detail: 'Each item gets the title and description your templates make now, stored so they stay as they are when the item changes later.',
  },
  reset: {
    label: 'Reset to automatic', title: 'Reset titles and descriptions to automatic?',
    detail: 'Stored generated values are cleared, so each item follows your templates again.',
  },
  alt_text: {
    label: 'Fill empty alt text', title: 'Fill empty image alt text?',
    detail: 'Product images without alt text get one made from the product name, colour and size. Alt text you wrote is not changed.',
  },
  index: {
    label: 'Allow indexing', title: 'Let search engines index these items?',
    detail: 'Turns “Hide from search engines” off for these items.',
  },
}

function BulkBar({ targets, onDone, actions = ['generate', 'reset', 'alt_text', 'index'] }: {
  targets: Array<{ type: SeoItemType; key: string }> | null; onDone: () => void; actions?: SeoBulkAction[]
}) {
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const [action, setAction] = useState<SeoBulkAction | null>(null)
  const [includeManual, setIncludeManual] = useState(false)
  if (!can('settings.manage') || !can('products.manage')) return null
  const count = targets ? `${targets.length} selected item${targets.length === 1 ? '' : 's'}` : 'every product, collection and page'
  const run = async () => {
    if (!action) return
    try {
      const r = await runSeoBulk(action, targets, includeManual)
      toast.success(`${r.changed} item${r.changed === 1 ? '' : 's'} updated${r.skipped_manual ? ` · ${r.skipped_manual} kept as you wrote them` : ''}`)
      void queryClient.invalidateQueries({ queryKey: ['seo-audit'] })
      void queryClient.invalidateQueries({ queryKey: ['seo-item'] })
      void queryClient.invalidateQueries({ queryKey: ['storefront-seo'] })
      onDone()
    } catch (e) {
      toast.error(toUserMessage(e))
      throw e
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
      <span className="mr-auto text-sm">{targets ? `${targets.length} selected` : 'All items'}</span>
      {actions.map((a) => <Button key={a} size="sm" variant="outline" onClick={() => { setIncludeManual(false); setAction(a) }}>{BULK[a].label}</Button>)}
      <ConfirmDialog open={!!action} onOpenChange={(o) => !o && setAction(null)} title={action ? BULK[action].title : ''}
        description={action ? `${BULK[action].detail} Applies to ${count}.` : undefined}
        confirmLabel={action ? BULK[action].label : 'Confirm'} destructive={includeManual} onConfirm={run}>
        {(action === 'generate' || action === 'reset') && (
          <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
            <Checkbox checked={includeManual} onCheckedChange={(v) => setIncludeManual(v === true)} className="mt-0.5" />
            <span>
              <span className="block font-medium">Also replace titles and descriptions you wrote yourself</span>
              <span className="block text-xs text-muted-foreground">Off: fields you wrote stay exactly as they are (recommended).</span>
            </span>
          </label>
        )}
      </ConfirmDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Every item with where its title and description come from
// ---------------------------------------------------------------------------------------------

const SOURCE_LABEL: Record<SeoSource, string> = { auto: 'Automatic', generated: 'Generated', manual: 'Written', missing: 'Missing' }

function SourceTag({ source }: { source: SeoSource }) {
  return <Badge variant={source === 'missing' ? 'warning' : source === 'manual' ? 'neutral' : source === 'generated' ? 'violet' : 'info'}>{SOURCE_LABEL[source]}</Badge>
}

function Items({ audit, onEdit }: { audit: SeoAudit; onEdit: (t: Target) => void }) {
  const [type, setType] = useState('all')
  const [source, setSource] = useState('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(100)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const rows = audit.items.filter((i) => (type === 'all' || i.type === type)
    && (source === 'all' || (source === 'noindex' ? i.robots.startsWith('noindex') : i.title_source === source || i.description_source === source))
    && (!q || `${i.name} ${i.path} ${i.title}`.toLowerCase().includes(q.toLowerCase())))
  const id = (i: SeoAuditItem) => `${i.type}:${i.key}`
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(id(r)))
  const targets = audit.items.filter((i) => picked.has(id(i))).map((i) => ({ type: i.type, key: i.key }))
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, address or title" className="h-8 w-full sm:mr-auto sm:w-64" aria-label="Search items" />
          <Select value={type} onValueChange={setType}>
            <SelectTrigger size="sm" className="w-36" aria-label="Type"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All items</SelectItem><SelectItem value="product">Products</SelectItem><SelectItem value="collection">Collections</SelectItem><SelectItem value="page">Pages</SelectItem></SelectContent>
          </Select>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger size="sm" className="w-40" aria-label="Source"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any source</SelectItem><SelectItem value="missing">Something missing</SelectItem><SelectItem value="auto">Automatic</SelectItem>
              <SelectItem value="generated">Generated (stored)</SelectItem><SelectItem value="manual">Written by you</SelectItem><SelectItem value="noindex">Hidden from search</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {targets.length > 0 && <BulkBar targets={targets} onDone={() => setPicked(new Set())} />}
        {rows.length === 0 ? <EmptyState title="No items match" /> : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-2"><Checkbox checked={allPicked} aria-label="Select all shown"
                    onCheckedChange={(on) => setPicked((cur) => { const n = new Set(cur); for (const r of rows) { if (on) n.add(id(r)); else n.delete(id(r)) } return n })} /></th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">SEO title</th>
                  <th className="px-3 py-2 font-medium">Meta description</th>
                  <th className="px-3 py-2 font-medium">Search engines</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.slice(0, limit).map((i) => (
                  <tr key={id(i)} className="align-top">
                    <td className="px-3 py-2.5"><Checkbox checked={picked.has(id(i))} aria-label={`Select ${i.name}`}
                      onCheckedChange={(on) => setPicked((cur) => { const n = new Set(cur); if (on) n.add(id(i)); else n.delete(id(i)); return n })} /></td>
                    <td className="max-w-[200px] px-3 py-2.5">
                      <p className="truncate font-medium">{i.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{TYPE_LABEL[i.type]} · {i.path}</p>
                    </td>
                    <td className="max-w-[240px] px-3 py-2.5"><p className="line-clamp-2">{i.title}</p><div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"><SourceTag source={i.title_source} /><span className={cn('tabular-nums', i.title.length > 60 && 'text-amber-600')}>{i.title.length}</span></div></td>
                    <td className="max-w-[280px] px-3 py-2.5"><p className={cn('line-clamp-2', !i.description && 'text-muted-foreground italic')}>{i.description ?? 'None'}</p><div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"><SourceTag source={i.description_source} /><span className="tabular-nums">{i.description?.length ?? 0}</span></div></td>
                    <td className="px-3 py-2.5"><Badge variant={i.robots.startsWith('index') ? 'success' : 'warning'}>{i.robots.startsWith('index') ? 'Indexed' : 'Hidden'}</Badge></td>
                    <td className="px-3 py-2.5 text-right"><Button size="sm" variant="ghost" onClick={() => onEdit({ type: i.type, key: i.key, name: i.name })}>Edit <ArrowRight /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > limit && <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + 200)}>Show more ({rows.length - limit} left)</Button>}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

const TEMPLATE_GROUPS: Array<{ label: string; title: keyof SeoSettings['templates']; description: keyof SeoSettings['templates']; example: Record<string, string> }> = [
  { label: 'Products', title: 'product_title', description: 'product_description', example: { name: 'Linen Shirt', price: '৳1,290', brand: 'Atheron', category: 'Shirts', short_description: 'Breathable linen for hot days.', description: 'Breathable linen for hot days, cut for a relaxed fit.' } },
  { label: 'Collections', title: 'collection_title', description: 'collection_description', example: { name: 'Summer Shirts', description: 'Light shirts for the hot months.' } },
  { label: 'Store pages', title: 'page_title', description: 'page_description', example: { name: 'Contact' } },
  { label: 'Home page', title: 'home_title', description: 'home_description', example: {} },
]

/** The same rule as the server's _seo_render: {{a|b}} takes the first value that is not empty. */
function render(tpl: string, vars: Record<string, string | null | undefined>) {
  return tpl.replace(/\{\{\s*([a-z_]+(?:\|[a-z_]+)*)\s*\}\}/g, (_, keys: string) => {
    for (const k of keys.split('|')) { const v = (vars[k] ?? '').trim(); if (v) return v }
    return ''
  }).replace(/\s+/g, ' ').trim()
}

/** Values in a template the store does not know (the server refuses them too). */
function unknownVars(tpl: string, known: string[]) {
  const bad: string[] = []
  for (const m of tpl.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) for (const k of m[1].split('|')) if (!known.includes(k.trim())) bad.push(k.trim())
  return bad
}

function SettingsForm({ state }: { state: SeoSettingsState }) {
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const canEdit = can('settings.manage')
  const [draft, setDraft] = useState<SeoSettings>(state.settings)
  const [modeAsk, setModeAsk] = useState<SeoMode | null>(null)
  const [bulk, setBulk] = useState(false)
  useEffect(() => { setDraft(state.settings) }, [state.settings])
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings)
  // Leaving the page with unsaved settings asks first.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const vars = state.template_vars
  const problems = useMemo(() => {
    const p: Record<string, string> = {}
    for (const [k, v] of Object.entries(draft.templates)) {
      const bad = unknownVars(v, vars)
      if (bad.length) p[k] = `{{${bad[0]}}} is not a value templates can use`
      else if (v.length > 300) p[k] = 'At most 300 characters'
    }
    if (unknownVars(draft.title_suffix, vars).length) p.title_suffix = `{{${unknownVars(draft.title_suffix, vars)[0]}}} is not a value templates can use`
    if (draft.title_suffix.length > 80) p.title_suffix = 'At most 80 characters'
    if (draft.social.og_image && !/^(https?:\/\/|\/)\S+$/.test(draft.social.og_image)) p.og_image = 'A web address of an image'
    if (draft.social.twitter_site && !/^@?[A-Za-z0-9_]{1,15}$/.test(draft.social.twitter_site)) p.twitter_site = 'A handle like @yourstore'
    return p
  }, [draft, vars])

  const save = useMutation({
    mutationFn: (value: SeoSettings) => saveSeoSettings(value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['seo-settings'] })
      void queryClient.invalidateQueries({ queryKey: ['seo-audit'] })
      void queryClient.invalidateQueries({ queryKey: ['seo-item'] })
      void queryClient.invalidateQueries({ queryKey: ['storefront-seo'] })
    },
  })
  const set = <K extends keyof SeoSettings>(k: K, v: SeoSettings[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const group = <K extends 'generate' | 'structured_data' | 'sitemap' | 'indexing' | 'social' | 'new_items' | 'ai' | 'templates'>(k: K, patch: Partial<SeoSettings[K]>) =>
    setDraft((d) => ({ ...d, [k]: { ...d[k], ...patch } }))
  const storeVars = Object.fromEntries(Object.entries(state.store).map(([k, v]) => [k, v ?? '']))

  return (
    <div className="space-y-4 pb-20">
      <Card>
        <CardContent className="space-y-3">
          <div>
            <p className="text-sm font-semibold">SEO mode</p>
            <p className="text-xs text-muted-foreground">Decides who writes each page's title and meta description. Changing it applies at once to the whole store.</p>
          </div>
          <div className="grid gap-2 md:grid-cols-3" role="radiogroup" aria-label="SEO mode">
            {(['hybrid', 'automatic', 'manual'] as const).map((m) => {
              const on = state.settings.mode === m
              return (
                <button key={m} type="button" role="radio" aria-checked={on} disabled={!canEdit || save.isPending}
                  onClick={() => !on && setModeAsk(m)}
                  className={cn('flex flex-col justify-start rounded-lg border p-3 text-left transition-colors disabled:opacity-60', on ? 'border-foreground bg-muted/40 ring-1 ring-foreground' : 'hover:bg-muted/40')}>
                  <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                    {SEO_MODES[m].label}{m === 'hybrid' && <Badge variant="neutral">Recommended</Badge>}
                  </span>
                  <span className="mt-1 block text-xs font-medium">{SEO_MODES[m].summary}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{SEO_MODES[m].detail}</span>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <fieldset disabled={!canEdit} className="min-w-0 space-y-4">
        <Section title="Templates" detail={<>Generated titles and descriptions are made from these. Values: {vars.map((v) => <code key={v} className="mx-0.5 rounded bg-muted px-1 text-[11px]">{`{{${v}}}`}</code>)} — <code className="text-[11px]">{'{{a|b}}'}</code> uses b when a is empty.</>}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Toggle label="Generate titles" checked={draft.generate.title} onChange={(v) => group('generate', { title: v })} />
            <Toggle label="Generate descriptions" checked={draft.generate.description} onChange={(v) => group('generate', { description: v })} />
            <Toggle label="Suggest image alt text" checked={draft.generate.alt_text} onChange={(v) => group('generate', { alt_text: v })} />
          </div>
          {TEMPLATE_GROUPS.map((g) => {
            const ex = { ...storeVars, ...g.example, ...(g.label === 'Home page' ? { name: storeVars.store } : {}) }
            const t = render(draft.templates[g.title], ex)
            const suffix = g.label !== 'Home page' && t && storeVars.store && !t.toLowerCase().includes(storeVars.store.toLowerCase()) ? render(draft.title_suffix, ex) : ''
            return (
              <div key={g.label} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                <Field label={`${g.label}: title`} error={problems[g.title]}><Input value={draft.templates[g.title]} onChange={(e) => group('templates', { [g.title]: e.target.value })} /></Field>
                <Field label={`${g.label}: description`} error={problems[g.description]}><Input value={draft.templates[g.description]} onChange={(e) => group('templates', { [g.description]: e.target.value })} placeholder="Empty: no generated description" /></Field>
                <p className="text-xs text-muted-foreground sm:col-span-2">Example: <b className="font-medium text-foreground">{`${t}${suffix ? ` ${suffix}` : ''}` || '—'}</b>{render(draft.templates[g.description], ex) && <> · {render(draft.templates[g.description], ex).slice(0, 160)}</>}</p>
              </div>
            )
          })}
          <Field label="Title suffix" error={problems.title_suffix} hint="Added to generated titles of inner pages that do not already name the store">
            <Input value={draft.title_suffix} onChange={(e) => set('title_suffix', e.target.value)} className="max-w-sm" />
          </Field>
        </Section>

        <Section title="Search engines" detail="What search engines may index. Private pages (cart, checkout, account, admin) are never indexed.">
          <Toggle label="Allow search engines to index the store" detail={draft.indexing.store ? 'On' : 'Off: every page says noindex and robots.txt asks search engines to stay out'}
            checked={draft.indexing.store} onChange={(v) => group('indexing', { store: v })} warn={!draft.indexing.store} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle label="Products" checked={draft.indexing.products} onChange={(v) => group('indexing', { products: v })} />
            <Toggle label="Collections" checked={draft.indexing.collections} onChange={(v) => group('indexing', { collections: v })} />
            <Toggle label="Store pages (contact, policies, …)" checked={draft.indexing.pages} onChange={(v) => group('indexing', { pages: v })} />
            <Toggle label="Search results pages" detail="Usually off: they repeat other pages" checked={draft.indexing.search} onChange={(v) => group('indexing', { search: v })} />
          </div>
        </Section>

        <Section title="Sitemap" detail={state.base_url ? <>Listed at <a href={`${state.base_url}/sitemap.xml`} target="_blank" rel="noreferrer" className="break-all underline">{state.base_url}/sitemap.xml</a> and named in robots.txt. Hidden and unpublished items are always left out.</> : 'Served at /sitemap.xml on your store address.'}>
          <Toggle label="Publish a sitemap" checked={draft.sitemap.enabled} onChange={(v) => group('sitemap', { enabled: v })} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Toggle label="Products" checked={draft.sitemap.products} onChange={(v) => group('sitemap', { products: v })} disabled={!draft.sitemap.enabled} />
            <Toggle label="Collections" checked={draft.sitemap.collections} onChange={(v) => group('sitemap', { collections: v })} disabled={!draft.sitemap.enabled} />
            <Toggle label="Store pages" checked={draft.sitemap.pages} onChange={(v) => group('sitemap', { pages: v })} disabled={!draft.sitemap.enabled} />
          </div>
        </Section>

        <Section title="Structured data" detail="Schema.org data in each page, from your real catalogue only (no invented ratings, reviews or stock).">
          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle label="Product and offer" detail="Name, images, price, currency and stock when known" checked={draft.structured_data.product} onChange={(v) => group('structured_data', { product: v })} />
            <Toggle label="Breadcrumbs" checked={draft.structured_data.breadcrumbs} onChange={(v) => group('structured_data', { breadcrumbs: v })} />
            <Toggle label="Organization" detail="Store name, logo and address" checked={draft.structured_data.organization} onChange={(v) => group('structured_data', { organization: v })} />
            <Toggle label="Website" checked={draft.structured_data.website} onChange={(v) => group('structured_data', { website: v })} />
          </div>
        </Section>

        <Section title="Sharing" detail="Used when a link to the store is shared and a page has no image of its own.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Default sharing image" error={problems.og_image} hint="1200 × 630 works best; empty uses the store logo">
              <Input value={draft.social.og_image} onChange={(e) => group('social', { og_image: e.target.value })} placeholder="https://…" />
            </Field>
            <Field label="X (Twitter) account" error={problems.twitter_site}>
              <Input value={draft.social.twitter_site} onChange={(e) => group('social', { twitter_site: e.target.value })} placeholder="@yourstore" />
            </Field>
          </div>
        </Section>

        <Section title="New items" detail="What happens to products and collections added later (by hand or by an import).">
          <div className="grid gap-3 sm:grid-cols-2">
            {(['products', 'collections'] as const).map((k) => (
              <Field key={k} label={k === 'products' ? 'New products' : 'New collections'}>
                <Select value={draft.new_items[k]} onValueChange={(v) => group('new_items', { [k]: v as 'auto' | 'fill' })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Follow the mode (worked out when shown)</SelectItem>
                    <SelectItem value="fill">Store generated title and description at once</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ))}
          </div>
        </Section>

        <Section title="AI suggestions" detail="Writing titles and descriptions with an AI model.">
          <Toggle label="Allow “Generate with AI”" checked={draft.ai.enabled && state.ai_available} disabled={!state.ai_available} onChange={(v) => group('ai', { enabled: v })}
            detail={state.ai_available ? 'Suggestions are shown for you to accept; nothing is saved without you.' : 'Not available: no AI provider is connected to Fullfilio yet. Templates and your own writing work as usual.'} />
        </Section>
      </fieldset>

      {canEdit && (
        <Section title="Apply to every item" detail="Store-wide changes. Each asks you to confirm first, and fields you wrote stay as they are unless you say otherwise.">
          {bulk ? <BulkBar targets={null} onDone={() => setBulk(false)} actions={['generate', 'reset', 'alt_text']} />
            : <Button variant="outline" size="sm" onClick={() => setBulk(true)}><Sparkles /> Show store-wide actions</Button>}
        </Section>
      )}

      {canEdit && dirty && (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
          <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span>
          {save.error && <span className="text-sm text-destructive" role="alert">{toUserMessage(save.error)}</span>}
          <Button variant="ghost" onClick={() => setDraft(state.settings)} disabled={save.isPending}>Discard</Button>
          <Button disabled={save.isPending || Object.keys(problems).length > 0}
            onClick={() => save.mutate(draft, { onSuccess: () => toast.success('SEO settings saved') })}>{save.isPending && <Spinner />} Save settings</Button>
        </div>
      )}

      <ConfirmDialog open={!!modeAsk} onOpenChange={(o) => !o && setModeAsk(null)} title={modeAsk ? `Switch to ${SEO_MODES[modeAsk].label}?` : ''}
        confirmLabel={modeAsk ? `Use ${SEO_MODES[modeAsk].label}` : 'Confirm'}
        description={modeAsk && (
          <span className="block space-y-2">
            <span className="block">{SEO_MODES[modeAsk].detail}</span>
            {modeAsk === 'automatic' && state.counts.manual_titles > 0 && <span className="block font-medium text-foreground">{state.counts.manual_titles} title{state.counts.manual_titles === 1 ? '' : 's'} you wrote will not be shown while Automatic is on. They are kept, and come back if you switch to Hybrid or Manual.</span>}
            {modeAsk === 'manual' && <span className="block font-medium text-foreground">Pages without a written description will have none; the Overview lists them.</span>}
            <span className="block">This changes every page of the store at once. Nothing you wrote is deleted.</span>
          </span>
        )}
        onConfirm={async () => {
          if (!modeAsk) return
          // The mode on its own: the saved settings with the new mode (unsaved edits stay in the form).
          await save.mutateAsync({ ...state.settings, mode: modeAsk })
          setDraft((d) => ({ ...d, mode: modeAsk }))
          toast.success(`${SEO_MODES[modeAsk].label} mode is on`)
        }} />
    </div>
  )
}

function Section({ title, detail, children }: { title: string; detail?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

function Toggle({ label, detail, checked, onChange, disabled, warn }: { label: string; detail?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; warn?: boolean }) {
  return (
    <label className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5', disabled && 'cursor-not-allowed opacity-60', warn && 'border-amber-400 bg-amber-50/60 dark:bg-amber-950/20')}>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  )
}

// ---------------------------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------------------------

function Redirects() {
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const list = useQuery({ queryKey: ['seo-redirects'], queryFn: listSeoRedirects })
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [removing, setRemoving] = useState<{ id: string; from_path: string } | null>(null)
  const done = (rows: Awaited<ReturnType<typeof listSeoRedirects>>) => {
    queryClient.setQueryData(['seo-redirects'], rows)
    void queryClient.invalidateQueries({ queryKey: ['storefront-seo'] })
  }
  const add = useMutation({
    mutationFn: () => saveSeoRedirect(from.trim(), to.trim()),
    onSuccess: (rows) => { done(rows); setFrom(''); setTo(''); toast.success('Redirect saved') },
  })
  const pathOk = (p: string) => /^\/[^\s?#]*$/.test(p.trim())
  return (
    <div className="space-y-4">
      {can('settings.manage') && (
        <Card>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm font-semibold">Add a redirect</p>
              <p className="text-xs text-muted-foreground">Send visitors (and search engines, with a permanent 301) from an old address to a page of your store. Chains are shortened and loops refused. Changing a product or collection address adds one by itself.</p>
            </div>
            <form className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); add.mutate() }}>
              <Field label="Old address" error={from && !pathOk(from) ? 'A path like /old-page' : undefined}><Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="/old-page" /></Field>
              <ArrowRight className="mb-2.5 hidden size-4 text-muted-foreground sm:block" />
              <Field label="New address" error={to && !pathOk(to) ? 'A path like /shop' : undefined}><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="/shop" /></Field>
              <Button type="submit" disabled={!pathOk(from) || !pathOk(to) || add.isPending}>{add.isPending && <Spinner />} Add</Button>
            </form>
            {add.error && <p className="text-sm text-destructive" role="alert">{toUserMessage(add.error)}</p>}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent>
          {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} />
            : !list.data?.length ? <EmptyState icon={<Link2 />} title="No redirects yet" description="When you change a product's or collection's address, the old one is redirected here automatically." />
            : (
              <ul className="divide-y">
                {list.data.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                    <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs">{r.from_path}</code>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                    <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs">{r.to_path}</code>
                    <Badge variant="neutral" className="ml-1">{r.source === 'manual' ? 'Added by you' : 'Address changed'}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(r.created_at)}</span>
                    {can('settings.manage') && <Button size="icon-sm" variant="ghost" aria-label={`Delete redirect from ${r.from_path}`} onClick={() => setRemoving(r)}><Trash2 /></Button>}
                  </li>
                ))}
              </ul>
            )}
        </CardContent>
      </Card>
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} destructive confirmLabel="Delete redirect"
        title="Delete this redirect?" description={removing ? `Visitors to ${removing.from_path} will get “page not found” unless a page lives there.` : undefined}
        onConfirm={async () => { if (removing) done(await deleteSeoRedirect(removing.id)) }} />
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Globe className="size-3.5" /> Redirects apply on every address of your store (domain and store subdomain).</p>
    </div>
  )
}
