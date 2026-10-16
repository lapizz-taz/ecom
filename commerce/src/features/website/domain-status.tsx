import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Clock, Copy, Globe2, Info, Lock, RefreshCw, Store, Trash2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { formatDateTime, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { DomainGlobe } from '@/features/website/domain-globe'
import type { DomainDiagnosis, RegionCheck, StoreDomain } from '@/services/website'

const copy = (v: string) => void navigator.clipboard.writeText(v).then(() => toast.success('Copied'))

export type Tone = 'live' | 'warn' | 'pending' | 'error'

/** One word for where a domain stands, from its status and last diagnosis. */
function domainTone(d: StoreDomain): Tone {
  const diag = d.diagnostics
  if (d.status === 'ERROR' || diag?.issues.some((i) => i.severity === 'error')) return d.status === 'ACTIVE' ? 'warn' : 'error'
  if (d.status === 'ACTIVE') return diag?.issues.some((i) => i.severity === 'warning') ? 'warn' : 'live'
  return 'pending'
}

const TONE: Record<Tone, { label: string; chip: string }> = {
  live: { label: 'Connected', chip: 'bg-blue-50 text-blue-700 ring-blue-600/15 dark:bg-blue-500/10 dark:text-blue-300' },
  warn: { label: 'Connected · issue', chip: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300' },
  pending: { label: 'Pending', chip: 'bg-zinc-100 text-zinc-700 ring-zinc-500/15 dark:bg-white/10 dark:text-zinc-300' },
  error: { label: 'Not connected', chip: 'bg-red-50 text-red-700 ring-red-600/15 dark:bg-red-500/10 dark:text-red-300' },
}

function DomainChip({ d }: { d: StoreDomain }) {
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

// The colour band behind the planet: red until connected, blue once it is.
const BAND: Record<Tone, { band: string; ring: string; title: string }> = {
  live: { band: 'from-blue-700 via-blue-500 to-blue-700', ring: 'text-blue-600', title: 'Connected' },
  warn: { band: 'from-blue-700 via-blue-500 to-blue-700', ring: 'text-blue-600', title: 'Connected, with something to review' },
  pending: { band: 'from-amber-600 via-amber-400 to-amber-600', ring: 'text-amber-600', title: 'Waiting for DNS' },
  error: { band: 'from-red-700 via-red-500 to-red-700', ring: 'text-red-600', title: 'Not connected' },
}

/** The status at a glance: a dark globe with a pin for every region the DNS check asked,
 *  over a band that is red until the domain is connected and blue once it is. */
function StatusHero({ tone, regions, pointed }: { tone: Tone; regions: RegionCheck[] | null; pointed?: boolean }) {
  // DNS is done; only the hosting's confirmation and the certificate are left.
  const b = tone === 'pending' && pointed ? { ...BAND.pending, title: 'DNS is right · finishing HTTPS' } : BAND[tone]
  const ok = regions?.filter((r) => r.ok).length ?? 0
  return (
    <div className={cn('relative overflow-hidden bg-gradient-to-r', b.band)}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_55%,rgb(9_9_11/.92)_0,rgb(9_9_11/.92)_38%,transparent_72%)]" />
      <div className="relative px-4 pt-4 pb-3">
        <DomainGlobe tone={tone} regions={regions} label={`${b.title}${regions ? `: ${ok} of ${regions.length} regions see the domain` : ''}`} />
        <p className="mt-1 text-center text-[11px] font-medium text-white/90">
          {b.title}{regions ? ` · ${ok} of ${regions.length} regions` : ''}
        </p>
      </div>
    </div>
  )
}

function StatusIcon({ state }: { state: 'ok' | 'warn' | 'bad' | 'wait' }) {
  if (state === 'ok') return <CircleCheck className="size-4 shrink-0 text-blue-600" />
  if (state === 'warn') return <AlertTriangle className="size-4 shrink-0 text-amber-600" />
  if (state === 'wait') return <Clock className="size-4 shrink-0 text-muted-foreground" />
  return <CircleX className="size-4 shrink-0 text-red-600" />
}

function Section({ icon, title, sub, badge, children, defaultOpen = true }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; badge?: ReactNode; children?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="px-4 py-3">
      <button type="button" className="flex w-full items-start gap-2.5 text-left" onClick={() => children && setOpen(!open)} aria-expanded={children ? open : undefined}>
        <span className="mt-px [&_svg]:size-3.5">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{title}</span>
          {sub && <span className="block text-[11px] text-muted-foreground">{sub}</span>}
        </span>
        {badge}
        {children && <ChevronDown className={cn('mt-px size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />}
      </button>
      {children && open && <div className="mt-2.5 space-y-2.5 pl-6">{children}</div>}
    </div>
  )
}

function RecordsTable({ rows }: { rows: Array<{ type: string; name: string; value: string; ok?: boolean; note?: string; why?: string }> }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[400px] text-xs">
        <thead><tr className="bg-muted/40 text-left text-[11px] text-muted-foreground"><th className="px-3 py-1.5 font-medium">Type</th><th className="px-3 py-1.5 font-medium">Name</th><th className="px-3 py-1.5 font-medium">Value</th><th className="w-10" /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t align-top">
              <td className="px-3 py-2 font-mono text-[11px]">{r.type}</td>
              <td className="px-3 py-2 font-mono text-[11px]">
                {r.ok === undefined && r.name !== '@'
                  ? <button type="button" className="break-all text-left hover:underline" title="Copy name" onClick={() => copy(r.name)}>{r.name}</button>
                  : r.name}
              </td>
              <td className="px-3 py-2">
                <span className="font-mono text-[11px] break-all">{r.value}</span>
                {(r.note || r.why) && <span className={cn('block text-[10.5px]', r.ok === false ? 'text-red-600' : 'text-muted-foreground')}>{r.note ?? r.why}</span>}
              </td>
              <td className="px-2 py-2 text-right">
                {r.ok === undefined
                  ? <Button size="icon-sm" variant="ghost" aria-label="Copy value" onClick={() => copy(r.value)}><Copy /></Button>
                  : r.ok ? <Check className="ml-auto size-3.5 text-blue-600" aria-label="Correct" /> : <X className="ml-auto size-3.5 text-red-600" aria-label="Wrong" />}
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
    <div className={cn('rounded-lg p-2.5 text-xs leading-relaxed', list.some((i) => i.severity === 'error') ? 'bg-red-50 text-red-900 dark:bg-red-500/15 dark:text-white' : 'bg-muted/70')}>
      <p>{diag.pointed ? 'Your domain is connected, but we recommend you review the following:' : 'Fix the following to connect your domain:'}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5">
        {list.map((i) => <li key={i.code}><span className="font-medium">{i.title}.</span> {i.detail}</li>)}
      </ul>
    </div>
  )
}

/** Where each DNS company keeps the records, and what trips people up there. */
const PROVIDER_STEPS: Record<string, { where: string; tip?: string }> = {
  Hostinger: { where: 'hPanel → Domains → your domain → DNS / Nameservers → DNS records',
    tip: 'The root (@) cannot connect at Hostinger. To keep your-domain.com, move its DNS to Cloudflare (free) and use a CNAME for @ there; or use www (a CNAME for www to the address below) and forward the root to it under Domains → Domain forwarding.' },
  Namecheap: { where: 'Domain List → Manage → Advanced DNS → Host records', tip: 'For @ pick ALIAS Record. Delete the URL Redirect / parking records for @.' },
  GoDaddy: { where: 'My Products → your domain → DNS → Manage DNS', tip: 'GoDaddy has no ALIAS at @: delete the A record for @ and use www, or move DNS to Cloudflare.' },
  Cloudflare: { where: 'dash.cloudflare.com → your domain → DNS → Records', tip: 'For the root use a CNAME for @ to the address below (Cloudflare flattens it); set records to DNS only (grey cloud).' },
  Porkbun: { where: 'Domain Management → your domain → DNS', tip: 'For @ pick type ALIAS.' },
  'Name.com': { where: 'My Domains → your domain → Manage DNS Records', tip: 'For @ pick type ANAME.' },
  Google: { where: 'Squarespace Domains → your domain → DNS → DNS Settings' },
  Squarespace: { where: 'Domains → your domain → DNS → DNS Settings', tip: 'Delete the Squarespace Defaults records first.' },
  Wix: { where: 'Wix → Domains → your domain → Manage DNS Records' },
  'Amazon Route 53': { where: 'Route 53 → Hosted zones → your domain', tip: 'Route 53 has no CNAME at @: use www for the store.' },
}

/** The hosting's own progress, in plain words. */
function hostingText(h: NonNullable<DomainDiagnosis['hosting']>): string {
  const owner = h.status === 'active' ? 'Domain confirmed' : 'Confirming the domain is yours'
  const cert = h.ssl_status === 'active' ? 'certificate ready'
    : h.ssl_status === 'pending_validation' || h.ssl_status === 'initializing' || h.ssl_status === 'pending_issuance' || h.ssl_status === 'pending_deployment' ? 'certificate being issued'
    : h.ssl_status ? `certificate: ${h.ssl_status.replace(/_/g, ' ')}` : 'certificate waiting'
  return `Hosting: ${owner} · ${cert}`
}

/** Moving a domain's DNS to Cloudflare (free), so the main domain (shop.com) can connect. */
export function CloudflareSteps({ domain, target = 'stores.fullfilio.com' }: { domain?: string; target?: string }) {
  const name = domain ?? 'your-domain.com'
  const b = (t: ReactNode) => <b className="text-foreground">{t}</b>
  const rows = [
    { type: 'CNAME', name: '@', value: target },
    { type: 'CNAME', name: 'www', value: target },
  ]
  return (
    <ol className="list-decimal space-y-2 pl-4 text-xs text-muted-foreground">
      <li>Free account at {b('dash.cloudflare.com')} → {b('Add a domain')} → {name} → {b('Free')} plan.</li>
      <li>
        {b('DNS → Records')}: delete every {b('A')} and {b('AAAA')} record named {name} (Cloudflare copied the old ones). Then {b('Add record')} twice:
        <div className="mt-1.5 overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[320px] text-[11px]">
            <thead><tr className="bg-muted/40 text-left text-muted-foreground"><th className="px-2 py-1 font-medium">Type</th><th className="px-2 py-1 font-medium">Name</th><th className="px-2 py-1 font-medium">Target</th><th className="px-2 py-1 font-medium">Proxy status</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-t">
                  <td className="px-2 py-1 font-mono">{r.type}</td>
                  <td className="px-2 py-1 font-mono">{r.name}</td>
                  <td className="px-2 py-1 font-mono break-all">{r.value}</td>
                  <td className="px-2 py-1">DNS only (grey)</td>
                  <td className="px-1 py-1 text-right"><Button size="icon-sm" variant="ghost" aria-label="Copy target" onClick={() => copy(r.value)}><Copy /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </li>
      <li>Click the orange cloud on {b('every')} record so it turns {b('grey — DNS only')}. Email records (MX, autoconfig, autodiscover, …_domainkey) stop working when they are orange.</li>
      <li>Where you bought the domain (Hostinger → Domains → {name} → {b('Nameservers')}): choose custom nameservers and enter {b('only the two Cloudflare ones')} (…ns.cloudflare.com). Delete the old ones (Hostinger: …dns-parking.com).</li>
      <li>Wait until Cloudflare says the domain is {b('Active')} (15 minutes to a few hours). We check by ourselves and it turns Connected.</li>
    </ol>
  )
}

/** Who runs the domain's DNS, and where to make the change there. */
function DnsHost({ diag, rootA, hideTip }: { diag: DomainDiagnosis; rootA?: boolean; hideTip?: boolean }) {
  const host = diag.dns_host
  if (!host || !host.nameservers.length) return null
  const known = host.provider ? PROVIDER_STEPS[host.provider] : undefined
  // A root domain on our proxy is a plain A record, which every DNS company takes.
  const steps = known && rootA
    ? { where: known.where, tip: 'For @ use an A record with the address below; delete any ALIAS, CNAME or other A/AAAA record for @ first.' }
    : known
  return (
    <div className="space-y-1 rounded-lg border p-2.5 text-xs">
      <p>
        {host.mixed ? <span className="font-medium text-red-600">Two DNS companies answer for this domain</span>
          : <>DNS for this domain is managed at <b>{host.provider ?? host.nameservers[0]}</b></>}
      </p>
      <p className="font-mono text-[10.5px] break-all text-muted-foreground">Nameservers: {host.nameservers.join(', ')}</p>
      {host.mixed
        ? <p className="text-muted-foreground">Where you bought the domain, open Nameservers and keep only one company&apos;s nameservers (the ones where you add the records below).</p>
        : steps && !hideTip && <p className="text-muted-foreground">Add the records at: {steps.where}.{steps.tip ? ` ${steps.tip}` : ''}</p>}
    </div>
  )
}

/** The full status of one domain: DNS records, regions, HTTPS, target and type. */
export function DomainDetail({ d, primary, canEdit, checking, onCheck, onRemove, onMakePrimary, onUseWww, onBack, inDialog }: {
  d: StoreDomain; primary: string | null; canEdit: boolean; checking: boolean
  onCheck: () => void; onRemove: () => void; onMakePrimary: () => Promise<unknown>; onBack: () => void
  /** The root cannot connect at this DNS company: connect www.<domain> and make it primary. */
  onUseWww?: () => Promise<unknown>
  /** Shown inside the domain popup: no back link, edge-to-edge sections. */
  inDialog?: boolean
}) {
  const diag = d.diagnostics
  const tone = domainTone(d)
  const [typeOpen, setTypeOpen] = useState(false)
  const [type, setType] = useState<'primary' | 'redirect'>(d.is_primary ? 'primary' : 'redirect')
  const [saving, setSaving] = useState(false)
  const [switching, setSwitching] = useState(false)
  const needsCloudflare = !!diag?.issues.some((i) => i.code === 'NEEDS_CLOUDFLARE')
  const useWww = needsCloudflare && canEdit && onUseWww
  const okRegions = diag?.regions.filter((r) => r.ok).length ?? 0
  const notes = diag?.issues.filter((i) => i.severity === 'info') ?? []
  const pointing = diag ? (diag.pointed ? (diag.issues.some((i) => i.severity !== 'info') ? 'warn' : 'ok') : 'bad') : 'wait'

  return (
    <div className={cn(inDialog ? 'space-y-3.5' : 'space-y-6')}>
      {!inDialog && <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2"><ChevronRight className="rotate-180" /> Domains</Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
          <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="hover:underline">{d.domain}</a>
        </h2>
        <DomainChip d={d} />
      </div>}
      {inDialog && <div className="flex items-center gap-2 px-5 pt-4 pr-12">
        <span className="text-xs text-muted-foreground">Domains</span>
        <ChevronRight className="size-3 text-muted-foreground" />
        <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm font-semibold hover:underline">{d.domain}</a>
        <DomainChip d={d} />
      </div>}

      <div className={cn('overflow-hidden bg-card', inDialog ? 'border-y' : 'rounded-xl border')}>
        <StatusHero tone={tone} regions={d.diagnostics?.regions ?? null} pointed={d.diagnostics?.pointed} />
        <div className="divide-y">
          <Section icon={<StatusIcon state={pointing} />} badge={pointing === 'warn' ? <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">Issue</span> : undefined}
            title={!diag ? 'DNS not checked yet' : diag.pointed ? 'DNS records are pointing to Fullfilio' : 'DNS records are not pointing to Fullfilio yet'}>
            {diag && <Issues diag={diag} />}
            {needsCloudflare && (
              <div className="space-y-1.5 rounded-lg border p-2.5">
                <p className="text-xs font-medium">Connect {d.domain} to Cloudflare</p>
                <CloudflareSteps domain={d.domain} target={d.records.find((r) => r.type === 'CNAME')?.value} />
              </div>
            )}
            {useWww && (
              <Button size="sm" variant="outline" disabled={switching} onClick={async () => {
                setSwitching(true)
                try { await onUseWww() } finally { setSwitching(false) }
              }}>{switching && <Spinner />} Or use www.{d.domain} instead</Button>
            )}
            {diag && d.status !== 'ACTIVE' && <DnsHost diag={diag} rootA={d.records.some((r) => r.type === 'A' && r.name === '@')} hideTip={needsCloudflare} />}
            {diag && diag.records.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Records found</p>
                <RecordsTable rows={diag.records} />
              </div>
            )}
            {(d.status !== 'ACTIVE' || !diag?.pointed) && d.records.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Add at your domain provider</p>
                <RecordsTable rows={d.records} />
              </div>
            )}
          </Section>
          <Section icon={<StatusIcon state={!diag ? 'wait' : diag.live_everywhere ? 'ok' : okRegions > 0 ? 'warn' : 'bad'} />}
            title={!diag ? 'Regions not checked yet' : diag.live_everywhere ? <>Domain is live in <b>all regions</b> globally</> : <>Domain is live in <b>{okRegions} of {diag.regions.length}</b> regions</>}
            sub={diag ? `Last checked at ${formatDateTime(diag.checked_at)}` : undefined}>
            {diag && (
              <>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border p-2.5 sm:grid-cols-3">
                  {diag.regions.map((r) => (
                    <span key={r.code} className="flex items-center gap-2 text-xs" title={r.answers.join(', ') || 'No answer'}>
                      <span className={cn('size-1.5 rounded-full', r.ok ? 'bg-blue-500' : 'bg-red-500')} />{r.name}
                    </span>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Public DNS: {diag.resolvers.map((r) => `${r.name} ${r.ok ? '✓' : '✗'}`).join(' · ')}
                </p>
              </>
            )}
          </Section>
          <Section icon={<StatusIcon state={!diag ? 'wait' : diag.tls.ok && diag.tls.served_by_store !== false ? 'ok' : diag.pointed ? 'wait' : 'bad'} />}
            title={diag?.tls.detail ?? 'HTTPS not checked yet'}
            sub={diag?.hosting && d.status !== 'ACTIVE' ? hostingText(diag.hosting) : undefined} />
          {notes.map((n) => (
            <Section key={n.code} icon={<Info className="size-4 text-muted-foreground" />} title={n.title} sub={n.detail} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="w-full min-w-0 sm:w-auto sm:flex-1">
            {d.detail}
            {d.status !== 'ACTIVE' && d.status !== 'REMOVED' && d.status !== 'MANUAL' && (
              <span className="block">We keep checking by ourselves every 10 minutes — you can close this, the store goes live on its own.</span>
            )}
          </span>
          {canEdit && (
            <>
              <Button size="sm" variant="outline" onClick={onCheck} disabled={checking}><RefreshCw className={cn(checking && 'animate-spin')} /> Check again</Button>
              <Button size="sm" variant="ghost" onClick={onRemove}><Trash2 /> Remove</Button>
            </>
          )}
        </div>
      </div>

      <div className={cn('space-y-2', inDialog && 'px-5 pb-5')}>
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">Domain target and type</h3>
        <div className="divide-y rounded-xl border bg-card">
          <div className="flex items-center gap-3 px-4 py-3">
            <Store className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">Target</p><p className="text-[11px] text-muted-foreground">Online Store</p></div>
          </div>
          <div className="flex items-center gap-3 px-4 py-3">
            <Lock className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">Type</p>
              <p className="truncate text-[11px] text-muted-foreground">{d.is_primary ? 'Primary domain' : `Redirects to ${primary ?? 'the primary domain'}`}</p>
            </div>
            {canEdit && !d.is_primary && <Button size="sm" variant="secondary" onClick={() => setTypeOpen(true)}>Change</Button>}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">Visitors on any other connected domain are sent to the primary domain once it is live.</p>
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
