import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Clock, Copy, Globe2, Info, Lock, RefreshCw, Store, Trash2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { formatDateTime, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { DomainDiagnosis, StoreDomain } from '@/services/website'

const copy = (v: string) => void navigator.clipboard.writeText(v).then(() => toast.success('Copied'))

export type Tone = 'live' | 'warn' | 'pending' | 'error'

/** One word for where a domain stands, from its status and last diagnosis. */
export function domainTone(d: StoreDomain): Tone {
  const diag = d.diagnostics
  if (d.status === 'ERROR' || diag?.issues.some((i) => i.severity === 'error')) return d.status === 'ACTIVE' ? 'warn' : 'error'
  if (d.status === 'ACTIVE') return diag?.issues.some((i) => i.severity === 'warning') ? 'warn' : 'live'
  return 'pending'
}

const TONE: Record<Tone, { label: string; chip: string }> = {
  live: { label: 'Connected', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300' },
  warn: { label: 'Connected · issue', chip: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300' },
  pending: { label: 'Pending', chip: 'bg-zinc-100 text-zinc-700 ring-zinc-500/15 dark:bg-white/10 dark:text-zinc-300' },
  error: { label: 'Not connected', chip: 'bg-red-50 text-red-700 ring-red-600/15 dark:bg-red-500/10 dark:text-red-300' },
}

export function DomainChip({ d }: { d: StoreDomain }) {
  const t = TONE[domainTone(d)]
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', t.chip)}>{t.label}</span>
}

/** The list of a store's domains, Shopify style. */
export function DomainList({ domains, onOpen }: { domains: StoreDomain[]; onOpen: (domain: string) => void }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground"><span>Domain</span><span>Status</span></div>
      <ul className="divide-y">
        {domains.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => onOpen(d.domain)} className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40">
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Globe2 className="size-4" /></span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{d.domain}</span>
                  <span className="block truncate text-xs text-muted-foreground">{d.is_primary ? 'Primary domain' : 'Redirects to primary'}{d.checked_at ? ` · checked ${timeAgo(d.checked_at)}` : ''}</span>
                </span>
              </span>
              <DomainChip d={d} />
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const HERO: Record<Tone, { bg: string; dot: string; ring: string; title: string; sub: string }> = {
  live: { bg: 'from-emerald-50 to-card dark:from-emerald-500/10', dot: 'bg-emerald-500', ring: 'bg-emerald-400/40', title: 'Your domain is connected', sub: 'Customers can open your store on this address.' },
  warn: { bg: 'from-amber-50 to-card dark:from-amber-500/10', dot: 'bg-amber-500', ring: 'bg-amber-400/40', title: 'Connected, with something to review', sub: 'The store opens here; fix the points below to keep it reliable.' },
  pending: { bg: 'from-sky-50 to-card dark:from-sky-500/10', dot: 'bg-sky-500', ring: 'bg-sky-400/40', title: 'Waiting for the domain', sub: 'DNS changes can take a few minutes to a few hours.' },
  error: { bg: 'from-red-50 to-card dark:from-red-500/10', dot: 'bg-red-500', ring: 'bg-red-400/40', title: 'Not connected yet', sub: 'Follow the steps below at your domain provider, then check again.' },
}

/** The status at a glance: a globe that pulses in the status colour. */
function StatusHero({ tone, domain }: { tone: Tone; domain: string }) {
  const h = HERO[tone]
  const ok = tone === 'live' || tone === 'warn'
  return (
    <div className={cn('relative flex flex-col items-center overflow-hidden bg-gradient-to-b px-6 pt-7 pb-5 text-center', h.bg)}>
      <div className="relative grid size-16 place-items-center">
        <span className={cn('absolute inset-0 animate-ping rounded-full motion-reduce:animate-none', h.ring)} style={{ animationDuration: '2.4s' }} />
        <span className={cn('absolute inset-2 rounded-full opacity-60', h.ring)} />
        <span className="relative grid size-12 place-items-center rounded-full border bg-card shadow-sm">
          <Globe2 className="size-6 animate-[spin_18s_linear_infinite] text-foreground/80 motion-reduce:animate-none" />
          <span className={cn('absolute -right-0.5 -bottom-0.5 grid size-5 place-items-center rounded-full text-white ring-2 ring-card', h.dot)}>
            {ok ? <Check className="size-3" strokeWidth={3} /> : tone === 'pending' ? <Clock className="size-3" strokeWidth={3} /> : <X className="size-3" strokeWidth={3} />}
          </span>
        </span>
      </div>
      <p className="mt-3 text-[15px] font-semibold tracking-[-0.01em]">{h.title}</p>
      <p className="mt-0.5 max-w-sm text-[13px] text-muted-foreground">{h.sub}</p>
      <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="mt-2 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">{domain}</a>
    </div>
  )
}

function StatusIcon({ state }: { state: 'ok' | 'warn' | 'bad' | 'wait' }) {
  if (state === 'ok') return <CircleCheck className="size-4 shrink-0 text-emerald-600" />
  if (state === 'warn') return <AlertTriangle className="size-4 shrink-0 text-amber-600" />
  if (state === 'wait') return <Clock className="size-4 shrink-0 text-muted-foreground" />
  return <CircleX className="size-4 shrink-0 text-red-600" />
}

function Section({ icon, title, sub, badge, children, defaultOpen = true }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; badge?: ReactNode; children?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="px-4 py-3.5">
      <button type="button" className="flex w-full items-start gap-2.5 text-left" onClick={() => children && setOpen(!open)} aria-expanded={children ? open : undefined}>
        <span className="mt-0.5">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          {sub && <span className="block text-xs text-muted-foreground">{sub}</span>}
        </span>
        {badge}
        {children && <ChevronDown className={cn('mt-0.5 size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />}
      </button>
      {children && open && <div className="mt-3 space-y-3 pl-6.5">{children}</div>}
    </div>
  )
}

function RecordsTable({ rows }: { rows: Array<{ type: string; name: string; value: string; ok?: boolean; note?: string; why?: string }> }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[420px] text-sm">
        <thead><tr className="bg-muted/40 text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Value</th><th className="w-10" /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t align-top">
              <td className="px-3 py-2.5 font-mono text-xs">{r.type}</td>
              <td className="px-3 py-2.5 font-mono text-xs">{r.name}</td>
              <td className="px-3 py-2.5">
                <span className="font-mono text-xs break-all">{r.value}</span>
                {(r.note || r.why) && <span className={cn('block text-[11px]', r.ok === false ? 'text-red-600' : 'text-muted-foreground')}>{r.note ?? r.why}</span>}
              </td>
              <td className="px-2 py-2 text-right">
                {r.ok === undefined
                  ? <Button size="icon-sm" variant="ghost" aria-label="Copy value" onClick={() => copy(r.value)}><Copy /></Button>
                  : r.ok ? <Check className="ml-auto size-4 text-emerald-600" aria-label="Correct" /> : <X className="ml-auto size-4 text-red-600" aria-label="Wrong" />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Issues({ diag }: { diag: DomainDiagnosis }) {
  const list = diag.issues.filter((i) => i.severity !== 'info')
  if (!list.length) return null
  return (
    <div className={cn('rounded-lg p-3 text-sm', list.some((i) => i.severity === 'error') ? 'bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-200' : 'bg-muted/70')}>
      <p>{diag.pointed ? 'Your domain is connected, but we recommend you review the following:' : 'Fix the following to connect your domain:'}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5">
        {list.map((i) => <li key={i.code}><span className="font-medium">{i.title}.</span> {i.detail}</li>)}
      </ul>
    </div>
  )
}

/** The full status of one domain: DNS records, regions, HTTPS, target and type. */
export function DomainDetail({ d, primary, canEdit, checking, onCheck, onRemove, onMakePrimary, onBack, inDialog }: {
  d: StoreDomain; primary: string | null; canEdit: boolean; checking: boolean
  onCheck: () => void; onRemove: () => void; onMakePrimary: () => Promise<unknown>; onBack: () => void
  /** Shown inside the domain popup: no back link, edge-to-edge sections. */
  inDialog?: boolean
}) {
  const diag = d.diagnostics
  const tone = domainTone(d)
  const [typeOpen, setTypeOpen] = useState(false)
  const [type, setType] = useState<'primary' | 'redirect'>(d.is_primary ? 'primary' : 'redirect')
  const [saving, setSaving] = useState(false)
  const okRegions = diag?.regions.filter((r) => r.ok).length ?? 0
  const notes = diag?.issues.filter((i) => i.severity === 'info') ?? []
  const pointing = diag ? (diag.pointed ? (diag.issues.some((i) => i.severity !== 'info') ? 'warn' : 'ok') : 'bad') : 'wait'

  return (
    <div className={cn(inDialog ? 'space-y-5' : 'space-y-6')}>
      {!inDialog && <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2"><ChevronRight className="rotate-180" /> Domains</Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
          <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="hover:underline">{d.domain}</a>
        </h2>
        <DomainChip d={d} />
      </div>}

      <div className={cn('overflow-hidden bg-card', inDialog ? 'border-b' : 'rounded-xl border')}>
        <StatusHero tone={tone} domain={d.domain} />
        <div className="divide-y">
          <Section icon={<StatusIcon state={pointing} />} badge={pointing === 'warn' ? <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">Issue</span> : undefined}
            title={!diag ? 'DNS not checked yet' : diag.pointed ? 'DNS records are pointing to Fullfilio' : 'DNS records are not pointing to Fullfilio yet'}>
            {diag && <Issues diag={diag} />}
            {diag && diag.records.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Records found</p>
                <RecordsTable rows={diag.records} />
              </div>
            )}
            {(!diag?.pointed || !d.records.length) && d.records.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Add at your domain provider</p>
                <RecordsTable rows={d.records} />
              </div>
            )}
          </Section>
          <Section icon={<StatusIcon state={!diag ? 'wait' : diag.live_everywhere ? 'ok' : okRegions > 0 ? 'warn' : 'bad'} />}
            title={!diag ? 'Regions not checked yet' : diag.live_everywhere ? <>Domain is live in <b>all regions</b> globally</> : <>Domain is live in <b>{okRegions} of {diag.regions.length}</b> regions</>}
            sub={diag ? `Last checked at ${formatDateTime(diag.checked_at)}` : undefined}>
            {diag && (
              <>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border p-3 sm:grid-cols-3">
                  {diag.regions.map((r) => (
                    <span key={r.code} className="flex items-center gap-2 text-sm" title={r.answers.join(', ') || 'No answer'}>
                      <span className={cn('size-2 rounded-full', r.ok ? 'bg-emerald-500' : 'bg-red-500')} />{r.name}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Public DNS: {diag.resolvers.map((r) => `${r.name} ${r.ok ? '✓' : '✗'}`).join(' · ')}
                </p>
              </>
            )}
          </Section>
          <Section icon={<StatusIcon state={!diag ? 'wait' : diag.tls.ok && diag.tls.served_by_store !== false ? 'ok' : diag.pointed ? 'wait' : 'bad'} />}
            title={diag?.tls.detail ?? 'HTTPS not checked yet'} />
          {notes.map((n) => (
            <Section key={n.code} icon={<Info className="size-4 text-muted-foreground" />} title={n.title} sub={n.detail} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <span className="w-full min-w-0 sm:w-auto sm:flex-1">{d.detail}</span>
          {canEdit && (
            <>
              <Button size="sm" variant="outline" onClick={onCheck} disabled={checking}><RefreshCw className={cn(checking && 'animate-spin')} /> Check again</Button>
              <Button size="sm" variant="ghost" onClick={onRemove}><Trash2 /> Remove</Button>
            </>
          )}
        </div>
      </div>

      <div className={cn('space-y-2', inDialog && 'px-5 pb-5')}>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">Domain target and type</h3>
        <div className="divide-y rounded-xl border bg-card">
          <div className="flex items-center gap-3 px-4 py-3">
            <Store className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">Target</p><p className="text-xs text-muted-foreground">Online Store</p></div>
          </div>
          <div className="flex items-center gap-3 px-4 py-3">
            <Lock className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Type</p>
              <p className="truncate text-xs text-muted-foreground">{d.is_primary ? 'Primary domain' : `Redirects to ${primary ?? 'the primary domain'}`}</p>
            </div>
            {canEdit && !d.is_primary && <Button size="sm" variant="secondary" onClick={() => setTypeOpen(true)}>Change</Button>}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Visitors on any other connected domain are sent to the primary domain once it is live.</p>
      </div>

      <Dialog open={typeOpen} onOpenChange={setTypeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Domain type</DialogTitle>
            <DialogDescription>Choose what {d.domain} does.</DialogDescription>
          </DialogHeader>
          <RadioGroup value={type} onValueChange={(v) => setType(v as typeof type)} className="gap-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 has-[[data-state=checked]]:border-foreground">
              <RadioGroupItem value="primary" className="mt-0.5" />
              <span><span className="block text-sm font-medium">Primary domain</span><span className="block text-xs text-muted-foreground">Customers see this address. {primary ? `${primary} will redirect here.` : ''}</span></span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 has-[[data-state=checked]]:border-foreground">
              <RadioGroupItem value="redirect" className="mt-0.5" />
              <span><span className="block text-sm font-medium">Redirect to {primary ?? 'primary'}</span><span className="block text-xs text-muted-foreground">Visitors are sent to the primary domain.</span></span>
            </label>
          </RadioGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTypeOpen(false)}>Cancel</Button>
            <Button disabled={saving || type === 'redirect'} onClick={async () => {
              setSaving(true)
              try { await onMakePrimary(); setTypeOpen(false) } finally { setSaving(false) }
            }}>{saving && <Spinner />} Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
