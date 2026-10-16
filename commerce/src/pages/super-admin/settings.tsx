import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, History, Rocket, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfigHistory } from '@/features/platform/config-history'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { savePlatformSetting } from '@/services/billing'
import { type GlobalSettings, globalSettings, saveStoreDomains } from '@/services/platform-data'

// Where each platform setting lives. Settings with their own page are changed
// there (they have their own checks); this page is the index.
const CATALOG: Array<{ key: string; label: string; what: string; to?: string; system?: boolean }> = [
  { key: 'signup', label: 'Public sign-up', what: 'Whether new businesses can open their own account and start a plan at /start' },
  { key: 'billing', label: 'Billing rules', what: 'Currency, invoice due days, grace period, expiry, the plan new merchants start on', to: '/super-admin/subscriptions?tab=rules' },
  { key: 'access_rules', label: 'Account states', what: 'What each subscription state allows (full, read-only, blocked)', to: '/super-admin/subscriptions?tab=rules' },
  { key: 'billing_gateways', label: 'Payments to the platform', what: 'bKash and PayStation accounts merchants pay into (credentials in the vault)', to: '/super-admin/subscriptions?tab=rules' },
  { key: 'credits', label: 'Credit adjustments', what: 'Adjustments above this many credits need a second person', to: '/super-admin/credits?tab=settings' },
  { key: 'sms', label: 'Platform SMS provider', what: 'Connection state and sender IDs (credentials in the vault)', to: '/super-admin/sms' },
  { key: 'usage.sms', label: 'SMS free use and charging', what: 'Free allowance, eligible plans and statuses, monthly cap, failed-message policy', to: '/super-admin/sms?tab=policy' },
  { key: 'bd_courier', label: 'Platform BD Courier account', what: 'Connection state (credentials in the vault)', to: '/super-admin/bd-courier' },
  { key: 'usage.bd_courier', label: 'BD Courier free use and limits', what: 'Free lookups, eligible plans and statuses, monthly cap', to: '/super-admin/bd-courier?tab=policy' },
  { key: 'support', label: 'Support', what: 'Response and resolution targets by priority, customer-view session length', to: '/super-admin/support?tab=settings' },
  { key: 'cost_assumptions', label: 'Cost assumptions', what: 'Estimated BD Courier cost per lookup and payment fee, used only where costs are not recorded', to: '/super-admin/usage?tab=revenue' },
  { key: 'voicedrive', label: 'VoiceDrive PBX', what: 'SIP/WebRTC addresses, call rate, VAT, top-up limits, maintenance window', to: '/super-admin/pbx?tab=gateway' },
  { key: 'security', label: 'Staff sessions', what: 'Platform staff sign in again after this many hours' },
  { key: 'retention', label: 'Retention', what: 'How long resolved log entries and read notifications are kept; wait before an approved erasure' },
  { key: 'integration_health', label: 'Integrations shown as unavailable', what: 'Set by open incidents', to: '/super-admin/incidents', system: true },
  { key: 'retention_state', label: 'Last retention run', what: 'Written by the daily job', to: '/super-admin/data', system: true },
  { key: 'storefront', label: 'Default storefront', what: 'The merchant whose shop answers on the main address', system: true },
]

function summary(v: Record<string, unknown> | undefined): string {
  if (!v) return 'not set'
  return Object.entries(v).filter(([k]) => !/hint|secret|token|password|key$|_at$|_id$/i.test(k)).slice(0, 4)
    .map(([k, x]) => `${k.replace(/_/g, ' ')}: ${typeof x === 'object' && x !== null ? (Array.isArray(x) ? x.length + ' item(s)' : '…') : String(x)}`).join(' · ')
}

function NumberSettingCard({ title, description, settingKey, fields, value, canEdit }: {
  title: string; description: string; settingKey: 'security' | 'retention'; canEdit: boolean
  fields: Array<{ name: string; label: string; hint?: string; optional?: boolean }>; value: Record<string, unknown>
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Record<string, string> | null>(null)
  const [confirm, setConfirm] = useState(false)
  const f = form ?? Object.fromEntries(fields.map((x) => [x.name, value[x.name] == null ? '' : String(value[x.name])]))
  const save = useMutation({
    mutationFn: (reason: string) => savePlatformSetting(settingKey, Object.fromEntries(fields.map((x) => [x.name, f[x.name] === '' ? null : Number(f[x.name])])), reason),
    onSuccess: () => { toast.success('Saved'); setForm(null); void queryClient.invalidateQueries({ queryKey: ['platform-global-settings'] }); void queryClient.invalidateQueries({ queryKey: ['platform-config-history'] }) },
  })
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {fields.map((x) => (
            <Field key={x.name} label={x.label} hint={x.hint}>
              <Input type="number" min={1} disabled={!canEdit} value={f[x.name]} placeholder={x.optional ? 'no limit' : undefined} onChange={(e) => setForm({ ...f, [x.name]: e.target.value })} />
            </Field>
          ))}
        </div>
        {canEdit ? <Button size="sm" disabled={!form || save.isPending} onClick={() => setConfirm(true)}>Save</Button>
          : <p className="text-xs text-muted-foreground">Only {settingKey === 'security' ? 'security' : 'data'} managers can change this.</p>}
        {confirm && (
          <ConfirmDialog open onOpenChange={setConfirm} title={`Change ${title.toLowerCase()}?`} reason reasonRequired confirmLabel="Save"
            description="The previous value stays in the configuration history and can be restored." onConfirm={(r) => save.mutateAsync(r)} />
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The two ways to join on the public page (/start), each on or off: normal sign-up (own login,
 * business opens at once) and sign-up by WhatsApp (details sent to the team, who open it).
 * The database checks both on every request.
 */
function SignupCard({ d }: { d: GlobalSettings }) {
  const queryClient = useQueryClient()
  const value = (d.settings.signup?.value ?? {}) as { enabled?: boolean; whatsapp?: { enabled?: boolean; template?: string } }
  const onboarding = (d.settings.onboarding?.value ?? {}) as { whatsapp_number?: string | null }
  const server = { enabled: value.enabled !== false, whatsapp: value.whatsapp?.enabled === true, template: value.whatsapp?.template ?? '' }
  const [draft, setDraft] = useState(server)
  const [confirm, setConfirm] = useState(false)
  const save = useMutation({
    mutationFn: (reason: string) => savePlatformSetting('signup', { enabled: draft.enabled, whatsapp: { enabled: draft.whatsapp, template: draft.template } }, reason),
    onSuccess: () => {
      toast.success('Sign-up saved')
      void queryClient.invalidateQueries({ queryKey: ['platform-global-settings'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-config-history'] })
    },
  })
  const changed = draft.enabled !== server.enabled || draft.whatsapp !== server.whatsapp || draft.template !== server.template
  const url = `${window.location.origin}/start`
  const number = onboarding.whatsapp_number ? `+${onboarding.whatsapp_number}` : null
  const state = draft.enabled && draft.whatsapp ? 'Both open' : draft.enabled ? 'Sign-up open' : draft.whatsapp ? 'WhatsApp only' : 'Paused'
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          Public sign-up
          <Badge variant={server.enabled || server.whatsapp ? 'success' : 'neutral'}>{state}</Badge>
        </CardTitle>
        <CardDescription>How new businesses join from the sign-up page. With both on, visitors choose; with both off, the page says sign-ups are paused.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono">{url}</span>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success('Link copied'), () => toast.error('Could not copy'))}>Copy</Button>
        </div>
        <div className="flex items-start justify-between gap-3">
          <Label htmlFor="signup-open" className="grid gap-0.5 text-sm font-normal">
            Normal sign-up
            <span className="text-xs text-muted-foreground">They create their own login, choose a plan and the business opens at once (or after payment).</span>
          </Label>
          <Switch id="signup-open" checked={draft.enabled} disabled={!d.can.edit} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
        </div>
        <div className="flex items-start justify-between gap-3">
          <Label htmlFor="signup-whatsapp" className="grid gap-0.5 text-sm font-normal">
            Sign-up by WhatsApp
            <span className="text-xs text-muted-foreground">
              They only fill in their details and send them to {number ?? 'the official number'} on WhatsApp. Nothing is created until you open the business from the request (Subscriptions → Onboarding).
            </span>
          </Label>
          <Switch id="signup-whatsapp" checked={draft.whatsapp} disabled={!d.can.edit || (!number && !draft.whatsapp)} onCheckedChange={(v) => setDraft({ ...draft, whatsapp: v })} />
        </div>
        {!number && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">Set the official WhatsApp number in Subscriptions → Onboarding before turning on sign-up by WhatsApp.</p>}
        {draft.whatsapp && (
          <Field label="WhatsApp message" htmlFor="signup-template" hint="Empty: the standard message. Placeholders: {business} {name} {phone} {whatsapp} {email} {type} {sells_on} {orders} {plan} {ref}">
            <Textarea id="signup-template" rows={6} value={draft.template} disabled={!d.can.edit} onChange={(e) => setDraft({ ...draft, template: e.target.value })}
              placeholder={'Hello Fullfilio, I would like to open an account.\nBusiness: {business}\nName: {name}\nMobile: {phone}'} />
          </Field>
        )}
        {d.can.edit ? <Button size="sm" disabled={!changed || save.isPending} onClick={() => setConfirm(true)}>Save</Button>
          : <p className="text-xs text-muted-foreground">Only staff who can edit settings can change this.</p>}
        {confirm && (
          <ConfirmDialog open onOpenChange={setConfirm} title="Save public sign-up?" reason reasonRequired confirmLabel="Save"
            description={!draft.enabled && !draft.whatsapp ? 'Both ways will be off: the sign-up page will say sign-ups are paused. Existing businesses are not affected.'
              : `Visitors will see: ${[draft.enabled && 'normal sign-up', draft.whatsapp && 'sign-up by WhatsApp'].filter(Boolean).join(' and ')}.`}
            onConfirm={(r) => save.mutateAsync(r)} />
        )}
      </CardContent>
    </Card>
  )
}

/** The platform domain for store subdomains, and what the platform's own address shows. */
function StoreDomainsCard({ d }: { d: GlobalSettings }) {
  const queryClient = useQueryClient()
  const value = (d.settings.store_domains?.value ?? {}) as { root_domain?: string | null; main_site?: string }
  const [root, setRoot] = useState(value.root_domain ?? '')
  const [main, setMain] = useState<'store' | 'marketing'>(value.main_site === 'store' ? 'store' : 'marketing')
  const [confirm, setConfirm] = useState(false)
  const save = useMutation({
    mutationFn: (reason: string) => saveStoreDomains({ root_domain: root.trim() || null, main_site: main }, reason),
    onSuccess: () => {
      toast.success('Store addresses saved')
      void queryClient.invalidateQueries({ queryKey: ['platform-global-settings'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-config-history'] })
    },
  })
  const changed = (root.trim() || null) !== (value.root_domain ?? null) || main !== (value.main_site === 'store' ? 'store' : 'marketing')
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Store addresses</CardTitle>
        <CardDescription>Businesses with the online store get <span className="font-mono">name.{root.trim() || 'your-domain.com'}</span>. Point a wildcard record (<span className="font-mono">*.{root.trim() || 'domain'}</span>) at the hosting first. Every store also works at <span className="font-mono">/s/name</span>.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field label="Platform domain" htmlFor="sd-root" hint="e.g. fullfilio.com — empty: no subdomains yet">
          <Input id="sd-root" value={root} disabled={!d.can.edit} onChange={(e) => setRoot(e.target.value.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))} placeholder="fullfilio.com" />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="sd-main" className="text-sm font-normal text-muted-foreground">Main address shows the Fullfilio website</Label>
          <Switch id="sd-main" checked={main === 'marketing'} disabled={!d.can.edit} onCheckedChange={(on) => setMain(on ? 'marketing' : 'store')} />
        </div>
        {d.can.edit && <Button size="sm" disabled={!changed || save.isPending} onClick={() => setConfirm(true)}>Save</Button>}
        {confirm && (
          <ConfirmDialog open onOpenChange={setConfirm} title="Save store addresses?" reason reasonRequired confirmLabel="Save"
            description="Store links change for every business. Customers on old links keep working on /s/name." onConfirm={(r) => save.mutateAsync(r)} />
        )}
      </CardContent>
    </Card>
  )
}

function Index({ d }: { d: GlobalSettings }) {
  const known = new Set(CATALOG.map((c) => c.key))
  const others = Object.keys(d.settings).filter((k) => !known.has(k))
  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <SignupCard d={d} />
        <StoreDomainsCard d={d} />
        <NumberSettingCard title="Staff sessions" settingKey="security" canEdit={d.can.security} value={d.settings.security?.value ?? {}}
          description="Enforced on every Super Admin action in the database and the server functions. A staff member signed in longer than this is asked to sign in again."
          fields={[{ name: 'staff_session_hours', label: 'Sign in again after (hours)', hint: '1–720 · empty means no limit', optional: true }]} />
        <NumberSettingCard title="Retention" settingKey="retention" canEdit={d.can.data} value={d.settings.retention?.value ?? {}}
          description="Applied daily. Audit logs, orders, invoices, payments and ledgers are never removed."
          fields={[{ name: 'system_logs_days', label: 'Resolved log entries (days)', hint: '7–3650' }, { name: 'notifications_days', label: 'Read notifications (days)', hint: '7–3650' },
            { name: 'deletion_cooling_days', label: 'Wait before erasure (days)', hint: '1–90' }]} />
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-3"><CardTitle className="text-sm">All platform settings</CardTitle></CardHeader>
        <div className="overflow-x-auto"><Table>
          <TableHeader><TableRow><TableHead>Setting</TableHead><TableHead>Now</TableHead><TableHead>Last changed</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {[...CATALOG.filter((c) => d.settings[c.key] || !c.system), ...others.map((key) => ({ key, label: key, what: d.settings[key]?.description ?? '', to: undefined, system: false }))].map((c) => {
              const s = d.settings[c.key]
              return (
                <TableRow key={c.key}>
                  <TableCell className="max-w-xs whitespace-normal"><p className="text-sm font-medium">{c.label} {c.system && <Badge variant="neutral" className="ml-1 text-[10px]">set by the platform</Badge>}</p><p className="text-xs text-muted-foreground">{c.what}</p></TableCell>
                  <TableCell className="max-w-sm text-xs break-words whitespace-normal text-muted-foreground">{summary(s?.value)}</TableCell>
                  <TableCell className="max-w-56 text-xs whitespace-normal">{s?.last_change ? <>{timeAgo(s.last_change.at)} · {s.last_change.by ?? 'system'}{s.last_change.note && <p className="text-muted-foreground">“{s.last_change.note}”</p>}</> : s ? formatDateTime(s.updated_at) : '—'}</TableCell>
                  <TableCell className="text-right">{c.to && <Button size="sm" variant="ghost" asChild><Link to={c.to}>Open <ArrowRight /></Link></Button>}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table></div>
      </Card>
    </div>
  )
}

function Releases({ d }: { d: GlobalSettings }) {
  return (
    <div className="space-y-3">
      <Card className="gap-1 px-4 py-3 text-xs text-muted-foreground">
        <p><strong className="text-foreground">Gradual releases.</strong> Put a feature in <em>Internal</em> to try it on demo merchants ({d.demo_merchants} now), move it to <em>Beta</em> and enrol selected customers, then make it generally available. Stages and enrolment are set under Features & Access and enforced by the backend.</p>
      </Card>
      <Card className="gap-0 overflow-hidden py-0">
        {d.releases.length === 0 ? <EmptyState icon={<Rocket />} title="Every feature is generally available" description="Nothing is in internal testing or beta right now." /> : (
          <Table>
            <TableHeader><TableRow><TableHead>Feature</TableHead><TableHead>Stage</TableHead><TableHead className="text-right">Merchants enrolled</TableHead><TableHead className="text-right">of which demo</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{d.releases.map((r) => (
              <TableRow key={r.code}>
                <TableCell className="text-sm font-medium">{r.name}</TableCell>
                <TableCell><Badge variant={!r.globally_enabled ? 'neutral' : r.stage === 'BETA' ? 'info' : r.stage === 'INTERNAL' ? 'violet' : 'success'}>{!r.globally_enabled ? 'switched off' : r.stage.toLowerCase()}</Badge></TableCell>
                <TableCell className="text-right text-xs tabular-nums">{formatNumber(r.enrolled)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{formatNumber(r.enrolled_demo)}</TableCell>
                <TableCell className="text-right"><Button size="sm" variant="ghost" asChild><Link to="/super-admin/features">Manage <ArrowRight /></Link></Button></TableCell>
              </TableRow>))}</TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}

export default function GlobalSettingsPage() {
  const [state, update] = useUrlState({ tab: 'settings' })
  const q = useQuery({ queryKey: ['platform-global-settings'], queryFn: globalSettings })
  return (
    <div className="space-y-4">
      <PageHeader title="Global Settings" description="Every platform-wide setting in one place, the release stage of features, and the history of configuration changes with safe rollback." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="settings"><Settings2 /> Settings</TabsTrigger>
          <TabsTrigger value="releases"><Rocket /> Releases</TabsTrigger>
          <TabsTrigger value="history"><History /> Configuration history</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="mt-3">{q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <CardsSkeleton count={2} /> : <Index d={q.data} />}</TabsContent>
        <TabsContent value="releases" className="mt-3">{q.data && <Releases d={q.data} />}</TabsContent>
        <TabsContent value="history" className="mt-3"><ConfigHistory /></TabsContent>
      </Tabs>
    </div>
  )
}
