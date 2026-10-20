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
  // Our DNS check not answering says nothing about the domain itself.
  const errors = diag?.issues.filter((i) => i.severity === 'error' && i.code !== 'CHECK_FAILED') ?? []
  if (d.status === 'ERROR' || errors.length) return d.status === 'ACTIVE' ? 'warn' : 'error'
  if (d.status === 'ACTIVE') return diag?.issues.some((i) => i.severity === 'warning' || i.code === 'CHECK_FAILED') ? 'warn' : 'live'
  return 'pending'
}

const TONE: Record<Tone, { label: string; chip: string }> = {
  live: { label: 'Connected', chip: 'bg-blue-50 text-blue-700 ring-blue-600/15 dark:bg-blue-500/10 dark:text-blue-300' },
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

// The colour band behind the planet: red until connected, blue once it is.
const BAND: Record<Tone, { band: string; ring: string; title: string }> = {
  live: { band: 'from-blue-700 via-blue-500 to-blue-700', ring: 'text-blue-600', title: 'Connected' },
  warn: { band: 'from-blue-700 via-blue-500 to-blue-700', ring: 'text-blue-600', title: 'Connected, with something to review' },
  pending: { band: 'from-amber-600 via-amber-400 to-amber-600', ring: 'text-amber-600', title: 'Waiting for DNS' },
  error: { band: 'from-red-700 via-red-500 to-red-700', ring: 'text-red-600', title: 'Not connected' },
}

/** The status at a glance: a white globe with a pin for every region the DNS check asked,
 *  over a band that is red until the domain is connected and blue once it is. */
function StatusHero({ tone, regions, pointed, left }: { tone: Tone; regions: RegionCheck[] | null; pointed?: boolean; left?: 'txt' | 'hosting' }) {
  // DNS is done: say what is left (the TXT record, the hosting, or only the certificate).
  const b = tone === 'pending' && pointed
    ? { ...BAND.pending, title: left === 'txt' ? 'DNS is right · add the TXT record' : left === 'hosting' ? 'DNS is right · waiting for the hosting' : 'DNS is right · finishing HTTPS' }
    : BAND[tone]
  const ok = regions?.filter((r) => r.ok).length ?? 0
  return (
    <div className={cn('relative overflow-hidden bg-gradient-to-r', b.band)}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgb(255_255_255/.22)_0,transparent_60%)]" />
      <div className="relative px-4 pt-4 pb-3">
        <DomainGlobe regions={regions} label={`${b.title}${regions ? `: ${ok} of ${regions.length} regions see the domain` : ''}`} />
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

type RecordRow = { type: string; name: string; value: string; ok?: boolean; note?: string; why?: string }

/** ✓ / ✗ for a record found, a copy button for a record to add. */
function RecordMark({ r }: { r: RecordRow }) {
  if (r.ok === undefined) return <Button size="icon-sm" variant="ghost" aria-label={`Copy the ${r.type} value for ${r.name}`} onClick={() => copy(r.value)}><Copy /></Button>
  return r.ok ? <Check className="ml-auto size-3.5 text-blue-600" aria-label="Correct" /> : <X className="ml-auto size-3.5 text-red-600" aria-label="Wrong" />
}
const RecordNote = ({ r }: { r: RecordRow }) =>
  r.note || r.why ? <span className={cn('block text-[10.5px] [overflow-wrap:anywhere]', r.ok === false ? 'text-red-600' : 'text-muted-foreground')}>{r.note ?? r.why}</span> : null
/** A name to add can be copied too (a TXT name such as _fullfilio is easy to mistype). */
const RecordName = ({ r }: { r: RecordRow }) =>
  r.ok === undefined && r.name !== '@'
    ? <button type="button" className="break-all text-left hover:underline" title="Copy name" onClick={() => copy(r.name)}>{r.name}</button>
    : <>{r.name}</>

/** DNS records: a table from tablet width up; on a phone each record is a card, so long values stay readable. */
function RecordsTable({ rows }: { rows: RecordRow[] }) {
  return (
    <>
      <ul className="divide-y rounded-lg border sm:hidden">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-2 px-3 py-2 text-xs">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-mono text-[11px] text-muted-foreground break-all"><span className="font-medium text-foreground">{r.type}</span> · <RecordName r={r} /></p>
              <p className="font-mono text-[11px] break-all">{r.value}</p>
              <RecordNote r={r} />
            </div>
            <RecordMark r={r} />
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border sm:block">
        <table className="w-full text-xs">
          <thead><tr className="bg-muted/40 text-left text-[11px] text-muted-foreground"><th className="px-3 py-1.5 font-medium">Type</th><th className="px-3 py-1.5 font-medium">Name</th><th className="px-3 py-1.5 font-medium">Value</th><th className="w-10" /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t align-top">
                <td className="px-3 py-2 font-mono text-[11px]">{r.type}</td>
                <td className="px-3 py-2 font-mono text-[11px] break-all"><RecordName r={r} /></td>
                <td className="px-3 py-2">
                  <span className="font-mono text-[11px] break-all">{r.value}</span>
                  <RecordNote r={r} />
                </td>
                <td className="px-2 py-2 text-right"><RecordMark r={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Issues({ diag, active }: { diag: DomainDiagnosis; active: boolean }) {
  const shown = diag.issues.filter((i) => i.severity !== 'info')
  // "The last check could not confirm the store" only when nothing else listed says why.
  const list = shown.length > 1 ? shown.filter((i) => i.code !== 'UNCONFIRMED') : shown
  if (!list.length) return null
  // Our DNS check not answering is no fault of the domain.
  const blocking = list.some((i) => i.severity === 'error' && i.code !== 'CHECK_FAILED')
  // Said from where the domain really stands: live or not, and whether anything blocks it.
  const heading = blocking ? (active ? 'Your store opens on this domain, but fix the following:' : 'Fix the following to connect your domain:')
    : active ? 'Your domain is connected, but we recommend you review the following:'
    : diag.pointed ? 'Also review the following:' : 'Fix the following to connect your domain:'
  return (
    <div className={cn('rounded-lg p-2.5 text-xs leading-relaxed [overflow-wrap:anywhere]', blocking ? 'bg-red-50 text-red-900 dark:bg-red-500/15 dark:text-white' : 'bg-muted/70')}>
      <p>{heading}</p>
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
    { type: 'CNAME', name: '@', value: target, why: 'Proxy status: DNS only (grey cloud)' },
    { type: 'CNAME', name: 'www', value: target, why: 'Proxy status: DNS only (grey cloud)' },
  ]
  return (
    <ol className="list-decimal space-y-2 pl-4 text-xs text-muted-foreground">
      <li>Free account at {b('dash.cloudflare.com')} → {b('Add a domain')} → {name} → {b('Free')} plan.</li>
      <li>
        {b('DNS → Records')}: delete every {b('A')} and {b('AAAA')} record named {name} (Cloudflare copied the old ones). Then {b('Add record')} twice:
        {/* Cards on a phone (copy buttons in view), a table from tablet width up. */}
        <div className="mt-1.5"><RecordsTable rows={rows} /></div>
      </li>
      <li>Click the orange cloud on {b('every')} record so it turns {b('grey — DNS only')}. Email records (MX, autoconfig, autodiscover, …_domainkey) stop working when they are orange.</li>
      <li>Where you bought the domain (Hostinger → Domains → {name} → {b('Nameservers')}): choose custom nameservers and enter {b('only the two Cloudflare ones')} (…ns.cloudflare.com). Delete the old ones (Hostinger: …dns-parking.com).</li>
      <li>Wait until Cloudflare says the domain is {b('Active')} (15 minutes to a few hours). We check by ourselves and it turns Connected.</li>
    </ol>
  )
}

/** Who runs the domain's DNS, and where to make the change there. */
function DnsHost({ diag, aName, sub, hideTip }: { diag: DomainDiagnosis; aName?: string; sub?: string; hideTip?: boolean }) {
  const host = diag.dns_host
  if (!host || !host.nameservers.length) return null
  const known = host.provider ? PROVIDER_STEPS[host.provider] : undefined
  const grey = host.provider === 'Cloudflare' ? ' Set it to DNS only (grey cloud).' : ''
  // A domain on our proxy (the root, or its www) is a plain A record, which every DNS company
  // takes; another subdomain is one CNAME. The tips about a CNAME at the root do not apply to either.
  const steps = known && aName
    ? { where: known.where, tip: `For ${aName} use an A record with the address below; delete any ALIAS, CNAME or other A/AAAA record for ${aName} first.${grey}` }
    : known && diag.kind === 'subdomain' && sub
    ? { where: known.where, tip: `Add a CNAME record named ${sub} with the value below; delete any other A, AAAA or CNAME record named ${sub} first.${grey}` }
    : known
  return (
    <div className="space-y-1 rounded-lg border p-2.5 text-xs">
      <p>
        {host.mixed ? <span className="font-medium text-red-600">Two DNS companies answer for this domain</span>
          : <>DNS for this domain is managed at <b>{host.provider ?? host.nameservers[0]}</b></>}
      </p>
      <p className="font-mono text-[10.5px] break-all text-muted-foreground">Nameservers: {host.nameservers.join(', ')}</p>
      {host.moving_from && (
        <p className="text-amber-700 dark:text-amber-400">
          Just moved here from {host.moving_from.provider ?? host.moving_from.nameservers.join(', ')}: some DNS servers still use the old DNS for up to 48 hours. Only the records at {host.provider ?? 'the nameservers above'} count now.
        </p>
      )}
      {host.mixed
        ? <p className="text-muted-foreground">Where you bought the domain, open Nameservers and keep only one company&apos;s nameservers (the ones where you add the records below).</p>
        : steps && !hideTip && <p className="text-muted-foreground">Add the records at: {steps.where}.{steps.tip ? ` ${steps.tip}` : ''}</p>}
    </div>
  )
}

/** The full status of one domain: DNS records, regions, HTTPS, target and type. */
export function DomainDetail({ d, primary, canEdit, canChangeType = canEdit, checking, onCheck, onRemove, onMakePrimary, onUseWww, onBack, inDialog }: {
  d: StoreDomain; primary: string | null; canEdit: boolean; checking: boolean
  /** Primary / redirect can be changed here (Super Admin checks and removes, the store picks its primary). */
  canChangeType?: boolean
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
  const active = d.status === 'ACTIVE'
  // Nobody issues a certificate for a MANUAL / ERROR domain, and a live one already has it.
  const noCertComing = active || d.status === 'MANUAL' || d.status === 'ERROR'
  const notes = diag?.issues.filter((i) => i.severity === 'info' && !(i.code === 'TLS_PENDING' && noCertComing)) ?? []
  const unchecked = !!diag && !diag.pointed && diag.issues.some((i) => i.code === 'CHECK_FAILED')
  const pointing = !diag || unchecked ? 'wait' : diag.pointed || active ? (diag.pointed && !diag.issues.some((i) => i.severity !== 'info') ? 'ok' : 'warn') : 'bad'
  const sub = d.records.find((r) => r.type === 'CNAME')?.name
  // Not proven the store's yet: no certificate until the ownership TXT record is found.
  const waitingTxt = !active && d.records.some((r) => r.type === 'TXT' && r.name.startsWith('_fullfilio'))
  // The store's server answered with an error (HTTP 5xx through the proxy): not a pass.
  const storeDown = !!diag && diag.tls.ok && diag.tls.served_by_store !== true && (diag.tls.status ?? 0) >= 500
  // HTTPS: DNS already right means the certificate is only waiting to be issued; a live domain
  // has one, so a failed probe there is "not confirmed", never "being issued".
  const tlsState = !diag ? 'wait'
    : diag.tls.ok ? (diag.tls.served_by_store === false ? 'bad' : storeDown ? 'warn' : 'ok')
    : active ? 'warn' : waitingTxt || noCertComing || diag.pointed ? 'wait' : 'bad'
  const tlsTitle = !diag ? 'HTTPS not checked yet'
    : diag.tls.ok ? diag.tls.detail
    : active ? 'HTTPS could not be confirmed on the last check (the store still opens; it is checked again by itself)'
    : waitingTxt ? 'HTTPS starts once the TXT record below is found'
    : d.status === 'MANUAL' ? 'HTTPS starts once the domain is connected to the hosting'
    : d.status === 'ERROR' ? 'HTTPS starts once the domain is attached to the hosting'
    : diag.pointed ? 'DNS is right — the HTTPS certificate is being issued (usually a few minutes)' : diag.tls.detail
  // Waiting domains are checked every 10 minutes for 3 days after the last change, then hourly.
  const changed = Date.parse(d.status_changed_at ?? d.created_at)
  const cadence = Number.isFinite(changed) && Date.now() - changed > 3 * 86_400_000 ? 'every hour' : 'every 10 minutes'

  // min-w-0: inside the popup's grid, a wide table scrolls in its own box instead of widening the popup past the screen.
  return (
    <div className={cn('min-w-0', inDialog ? 'space-y-3.5' : 'space-y-6')}>
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
        <StatusHero tone={tone} regions={unchecked ? null : d.diagnostics?.regions ?? null} pointed={d.diagnostics?.pointed}
          left={waitingTxt ? 'txt' : d.status === 'MANUAL' ? 'hosting' : undefined} />
        <div className="divide-y">
          <Section icon={<StatusIcon state={pointing} />} badge={pointing === 'warn' ? <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">Issue</span> : undefined}
            title={!diag ? 'DNS not checked yet' : diag.pointed ? 'DNS records are pointing to Fullfilio'
              : unchecked ? 'DNS could not be checked right now' : active ? 'Your store opens here, but the DNS records need attention' : 'DNS records are not pointing to Fullfilio yet'}>
            {diag && <Issues diag={diag} active={active} />}
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
            {diag && d.status !== 'ACTIVE' && <DnsHost diag={diag} aName={d.records.find((r) => r.type === 'A')?.name} sub={sub} hideTip={needsCloudflare} />}
            {diag && diag.records.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Records found</p>
                <RecordsTable rows={diag.records} />
              </div>
            )}
            {(d.status !== 'ACTIVE' || (!diag?.pointed && !unchecked) || diag?.issues.some((i) => i.code === 'WWW_SETUP')) && d.records.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Add at your domain provider</p>
                <RecordsTable rows={d.records} />
              </div>
            )}
          </Section>
          {/* "Live" only for a domain the store opens on; before that it is the DNS being seen. */}
          <Section icon={<StatusIcon state={!diag || unchecked ? 'wait' : diag.live_everywhere ? 'ok' : okRegions > 0 ? 'warn' : 'bad'} />}
            title={!diag ? 'Regions not checked yet' : unchecked ? 'Regions could not be checked right now'
              : diag.live_everywhere ? (active ? <>Domain is live in <b>all regions</b> globally</> : <>DNS seen in <b>all regions</b></>)
              : <>{active ? 'Domain is live in' : 'DNS seen in'} <b>{okRegions} of {diag.regions.length}</b> regions</>}
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
          <Section icon={<StatusIcon state={tlsState} />}
            title={tlsTitle}
            sub={diag?.hosting && d.status !== 'ACTIVE' ? hostingText(diag.hosting) : undefined} />
          {notes.map((n) => (
            <Section key={n.code} icon={<Info className="size-4 text-muted-foreground" />} title={n.title} sub={n.detail} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="w-full min-w-0 sm:w-auto sm:flex-1 [overflow-wrap:anywhere]">
            {d.detail}
            {d.status !== 'ACTIVE' && d.status !== 'REMOVED' && d.status !== 'MANUAL' && (
              <span className="block">We keep checking by ourselves {cadence} — you can close this, the store goes live on its own.</span>
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
            {canChangeType && !d.is_primary && (active
              ? <Button size="sm" variant="secondary" onClick={() => setTypeOpen(true)}>Change</Button>
              : <span className="text-[11px] text-muted-foreground">Can be primary once connected</span>)}
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
