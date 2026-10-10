import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink, KeyRound, Lightbulb, Link2, PlugZap, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { rangeFor } from '@/lib/dates'
import { formatDate, formatDateTime, formatMoney, formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type AdAccount, adAuthUrl, type AdCampaignRow, type AdDayRow, type AdPlatform, adPlatformOverview, adPlatformReport, adRedirectUri,
  disconnectAdConnection, saveAdApp, syncAdPlatform, updateAdAccount,
} from '@/services/ad-platforms'

const INFO: Record<AdPlatform, {
  name: string; description: string; docs: string; docsLabel: string
  tabs: Array<{ key: string; label: string }>
  utm: string; utmNote: string
}> = {
  tiktok: {
    name: 'TikTok Ads',
    description: 'Connect your TikTok advertiser accounts and see campaigns, expenses and actual results — all in one place.',
    docs: 'https://business-api.tiktok.com/portal/docs', docsLabel: 'Open TikTok Business API docs',
    tabs: [{ key: 'instructions', label: 'Instructions' }, { key: 'connection', label: 'Connection' }, { key: 'campaigns', label: 'Campaigns' }, { key: 'expenses', label: 'Expenses' }, { key: 'results', label: 'Actual Results' }],
    utm: 'utm_source=tiktok&utm_medium=paid&utm_campaign=__CAMPAIGN_NAME__&campaign_id=__CAMPAIGN_ID__&adset_id=__AID__&ad_id=__CID__',
    utmNote: 'Keep ttclid on the landing URL. Orders without campaign_id appear as TikTok (no campaign) or Unattributed — never guessed.',
  },
  google: {
    name: 'Google Ads',
    description: 'Reporting, expenses and actual results for the Google Ads customer accounts you choose.',
    docs: 'https://developers.google.com/google-ads/api/docs/get-started/introduction', docsLabel: 'Open Google Ads API docs',
    tabs: [{ key: 'overview', label: 'Overview' }, { key: 'campaigns', label: 'Ads Data' }, { key: 'results', label: 'Actual Results' }, { key: 'expenses', label: 'Expenses' }, { key: 'connection', label: 'Settings' }],
    utm: '{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&campaign_id={campaignid}&adset_id={adgroupid}&ad_id={creative}',
    utmNote: 'Put this in the account\'s Tracking template and keep auto-tagging (gclid) on. Orders without campaign_id stay Unattributed.',
  },
}

const SYNC_PROBLEM: Record<string, string> = {
  TOKEN_INVALID: 'The authorisation stopped working (revoked or expired). Connect again.',
  RATE_LIMITED: 'The platform asked us to slow down; the next sync will try again.',
  FAILED: 'The last sync failed.',
}

/** TikTok Ads / Google Ads: developer app, OAuth connection, accounts, campaigns, expenses and actual results. */
export function AdPlatformPage({ platform }: { platform: AdPlatform }) {
  const info = INFO[platform]
  const queryClient = useQueryClient()
  const initial = rangeFor('30d')
  const [state, update] = useUrlState({ tab: info.tabs[0].key, from: initial.from, to: initial.to, connected: '', error: '' })
  const overview = useQuery({ queryKey: ['ads', platform, 'overview'], queryFn: () => adPlatformOverview(platform) })

  // Back from the platform's consent screen.
  useEffect(() => {
    if (state.connected) {
      toast.success(`${info.name} connected. Choose the accounts to sync; the last 30 days are on their way.`)
      void queryClient.invalidateQueries({ queryKey: ['ads', platform] })
      update({ connected: '', tab: 'connection' })
    } else if (state.error) {
      toast.error(state.error)
      update({ error: '', tab: 'connection' })
    }
  }, [state.connected, state.error, info.name, platform, queryClient, update])

  return (
    <div className="space-y-4">
      <PageHeader title={info.name} description={info.description} />
      <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
        <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
          <TabsList>{info.tabs.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}</TabsList>
        </div>
        <TabsContent value="instructions" className="pt-2"><Instructions platform={platform} /></TabsContent>
        <TabsContent value="connection" className="space-y-4 pt-2">
          {platform === 'google' && <Instructions platform={platform} compact />}
          <Connection platform={platform} overview={overview.data} loading={overview.isLoading} error={overview.error as Error | null} />
        </TabsContent>
        {(['overview', 'campaigns', 'results', 'expenses'] as const).map((tab) => (
          <TabsContent key={tab} value={tab} className="space-y-4 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <DateRangeFilter value={{ from: state.from, to: state.to }} onChange={(r) => update({ from: r.from, to: r.to })} />
              {!!overview.data?.accounts.some((a) => a.is_selected) && <SyncButton platform={platform} />}
            </div>
            {overview.data && !overview.data.accounts.some((a) => a.is_selected) ? (
              <Card><CardContent>
                <EmptyState icon={<Link2 className="size-5" />} title={`No ${info.name} account chosen yet`}
                  description="Connect and choose the accounts to sync on the Connection tab."
                  action={<Button size="sm" onClick={() => update({ tab: 'connection' })}>Open {platform === 'google' ? 'Settings' : 'Connection'}</Button>} />
              </CardContent></Card>
            ) : <Report platform={platform} tab={tab} from={state.from} to={state.to} />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function CopyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => { void navigator.clipboard.writeText(value); toast.success('Copied') }}><Copy /> Copy</Button>
      </div>
      <code className="mt-1 block font-mono text-xs break-all select-all">{value}</code>
    </div>
  )
}

function Instructions({ platform, compact }: { platform: AdPlatform; compact?: boolean }) {
  const info = INFO[platform]
  const redirect = adRedirectUri(platform)
  if (compact) {
    return (
      <Card className="min-w-0">
        <CardContent className="grid gap-3 lg:grid-cols-2">
          <CopyLine label="Authorised redirect URI (OAuth client)" value={redirect} />
          <CopyLine label="Tracking template" value={info.utm} />
        </CardContent>
      </Card>
    )
  }
  const steps = platform === 'tiktok'
    ? {
      before: [
        'Create an app at TikTok API for Business (Developer → My Apps) with the Ad Account Management and Reporting permissions.',
        `Set the app's Advertiser redirect URL to the address below.`,
        'Copy the App ID and Secret into the Connection tab.',
        'For Actual Results, use the ID-based landing URL tags below so orders map back to campaigns, ad groups and ads.',
      ],
      flow: [
        'Click Connect TikTok on the Connection tab.',
        'Approve the advertiser authorisation in TikTok.',
        'Back here, the app exchanges the code, keeps the token on the server and lists every advertiser it covers.',
        'Campaigns sync every 3 hours (and on Sync now). Open Campaigns for TikTok\'s numbers.',
        'Open Actual Results to compare TikTok\'s reported conversions with real orders, deliveries and revenue.',
      ],
    }
    : {
      before: [
        'In Google Cloud, create an OAuth client (Web application) and add the redirect URI below.',
        'In Google Ads (manager account) → Tools → API Center, copy the developer token (Basic access for live accounts).',
        'Enter the client ID, client secret and developer token in Settings; add the manager account ID if your accounts sit under one.',
        'Add the tracking template below so orders carry the campaign ID.',
      ],
      flow: [
        'Click Connect Google Ads in Settings and sign in with a Google account that can open your Ads accounts.',
        'Choose the customer accounts to sync.',
        'Cost, clicks, impressions and conversions per campaign and day sync every 3 hours.',
        'Expenses post to Advertising in Finance with the account\'s rate and VAT.',
        'Actual Results compares Google\'s conversions with your real orders and deliveries.',
      ],
    }
  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-xl border border-brand/30 bg-brand-soft p-4">
        <Lightbulb className="mt-0.5 size-5 shrink-0 text-brand" />
        <div>
          <p className="font-medium text-brand">{info.name} integration</p>
          <p className="text-sm text-muted-foreground">Uses your own developer app: you authorise access once, the token stays on the server, and spend and campaigns sync automatically.</p>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4" /> Before you connect</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">{steps.before.map((s) => <li key={s}>{s}</li>)}</ol>
            <CopyLine label="Redirect URI" value={adRedirectUri(platform)} />
            <Button variant="outline" asChild><a href={info.docs} target="_blank" rel="noreferrer"><ExternalLink /> {info.docsLabel}</a></Button>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Link2 className="size-4" /> Connect flow</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">{steps.flow.map((s) => <li key={s}>{s}</li>)}</ol>
            <CopyLine label={platform === 'tiktok' ? 'Recommended TikTok landing URL tags' : 'Tracking template'} value={info.utm} />
            <p className="text-xs text-muted-foreground">{info.utmNote}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Connection({ platform, overview, loading, error }: {
  platform: AdPlatform; overview: Awaited<ReturnType<typeof adPlatformOverview>> | undefined; loading: boolean; error: Error | null
}) {
  const { can } = useAuth()
  const manage = can('marketing.manage')
  const info = INFO[platform]
  const queryClient = useQueryClient()
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['ads', platform] })
  const [removing, setRemoving] = useState<string | null>(null)
  const connect = useMutation({
    meta: { silent: true },
    mutationFn: () => adAuthUrl(platform, `${window.location.origin}/admin/marketing/${platform}?tab=connection`),
    onSuccess: (r) => { window.location.href = r.url },
    onError: (e) => toast.error((e as Error).message),
  })
  const disconnect = useMutation({
    mutationFn: (id: string) => disconnectAdConnection(platform, id),
    onSuccess: () => { toast.success('Disconnected'); refresh() },
  })

  if (loading) return <LoadingState />
  if (error || !overview) return <p className="text-sm text-red-700">{error?.message ?? 'Could not load'}</p>
  const app = overview.app ?? {}
  const accounts = overview.accounts
  const selected = accounts.filter((a) => a.is_selected)

  return (
    <div className="space-y-4">
      <AppCredentials platform={platform} app={app} manage={manage} onSaved={refresh} />

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Link2 className="size-4" /> {platform === 'google' ? 'Google Ads OAuth Connection' : 'TikTok connection'}</CardTitle>
          <CardDescription>
            {overview.connections.length ? `${info.name} is connected.` : `${info.name} is not connected. Connect, then choose accounts before numbers and expenses are synced.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground uppercase">Status</p><p className="font-medium">{overview.connections.some((c) => c.status === 'CONNECTED') ? 'Connected' : overview.connections.length ? 'Needs attention' : 'Not connected'}</p></div>
            <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground uppercase">{platform === 'google' ? 'Connected Google emails' : 'Authorisations'}</p><p className="font-medium">{overview.connections.length}</p></div>
            <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground uppercase">Selected accounts</p><p className="font-medium">{selected.length}</p></div>
          </div>
          {overview.connections.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
              <span className={cn('size-2.5 rounded-full', c.status === 'CONNECTED' ? 'bg-emerald-500' : 'bg-amber-500')} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-all">{c.display_name ?? c.external_user}</p>
                <p className="text-xs text-muted-foreground">token {c.token_hint ?? '—'} · connected {timeAgo(c.connected_at)}{c.connected_by_name ? ` by ${c.connected_by_name}` : ''}</p>
                {c.status === 'FAILED' && <p className="text-xs text-amber-700">{c.last_error ?? 'The authorisation stopped working. Connect again.'}</p>}
              </div>
              {manage && <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setRemoving(c.id)}><Unplug /> Disconnect</Button>}
            </div>
          ))}
          {manage && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => connect.mutate()} disabled={!app.configured || connect.isPending}>
                {connect.isPending ? <Spinner /> : <PlugZap />} {overview.connections.length ? 'Connect another' : `Connect ${platform === 'google' ? 'Google Ads' : 'TikTok'}`}
              </Button>
              {!app.configured && <p className="self-center text-xs text-muted-foreground">Save your developer app above first.</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">{platform === 'google' ? 'Customer accounts' : 'Advertiser accounts'}</CardTitle>
          <CardDescription>Switch on the accounts to sync. Spend is converted with the account's rate when it bills in another currency, plus VAT %, and posted to Advertising in Finance.</CardDescription>
          {manage && selected.length > 0 && <CardAction><SyncButton platform={platform} /></CardAction>}
        </CardHeader>
        <CardContent>
          {accounts.length === 0 ? (
            <EmptyState title={platform === 'google' ? 'No Google Ads accounts found' : 'No advertiser accounts yet'} description="Connect to discover the accounts this authorisation can open." />
          ) : (
            <ul className="grid gap-2">
              {accounts.map((a) => <AccountRow key={a.id} account={a} platform={platform} storeCurrency={overview.store_currency} manage={manage} onChanged={refresh} />)}
            </ul>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={`Disconnect ${info.name}?`} destructive confirmLabel="Disconnect"
        description="The token is erased from the server and its accounts stop syncing. Numbers already synced stay in reports and Finance."
        onConfirm={() => disconnect.mutateAsync(removing!).then(() => setRemoving(null))} />
    </div>
  )
}

function AppCredentials({ platform, app, manage, onSaved }: { platform: AdPlatform; app: NonNullable<Awaited<ReturnType<typeof adPlatformOverview>>['app']>; manage: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({ app_id: app.app_id ?? '', secret: '', client_id: app.client_id ?? '', client_secret: '', developer_token: '', login_customer_id: app.login_customer_id ?? '' })
  useEffect(() => { setForm((f) => ({ ...f, app_id: app.app_id ?? f.app_id, client_id: app.client_id ?? f.client_id, login_customer_id: app.login_customer_id ?? f.login_customer_id })) }, [app.app_id, app.client_id, app.login_customer_id])
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => saveAdApp(platform === 'tiktok'
      ? { platform, app_id: form.app_id.trim(), secret: form.secret.trim() }
      : { platform, client_id: form.client_id.trim(), client_secret: form.client_secret.trim(), developer_token: form.developer_token.trim(), login_customer_id: form.login_customer_id.trim() }),
    onSuccess: () => { toast.success('Developer app saved'); setForm((f) => ({ ...f, secret: '', client_secret: '', developer_token: '' })); onSaved() },
  })
  const kept = app.configured ? 'Saved — leave empty to keep it' : undefined
  const valid = platform === 'tiktok'
    ? /^\d{6,}$/.test(form.app_id.trim()) && (!!app.configured || form.secret.trim().length >= 20)
    : /\.apps\.googleusercontent\.com$/.test(form.client_id.trim()) && (!!app.configured || (form.client_secret.trim().length >= 10 && form.developer_token.trim().length >= 15))
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" /> Developer app</CardTitle>
        <CardDescription>
          {app.configured ? <>Saved{app.hint ? ` · ${app.hint}` : ''}. Secrets are stored encrypted on the server and never shown again.</> : 'Your own app on the platform. The secret is stored encrypted on the server.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate() }}>
          <fieldset disabled={!manage || save.isPending} className="contents">
            {platform === 'tiktok' ? (
              <>
                <Field label="App ID" htmlFor="tt-app"><Input id="tt-app" inputMode="numeric" className="font-mono" value={form.app_id} onChange={(e) => setForm({ ...form, app_id: e.target.value })} placeholder="7123456789012345678" /></Field>
                <Field label="Secret" htmlFor="tt-secret" hint={kept}><Input id="tt-secret" type="password" autoComplete="off" className="font-mono" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder={app.configured ? '••••••••' : ''} /></Field>
              </>
            ) : (
              <>
                <Field label="OAuth client ID" htmlFor="g-client" className="sm:col-span-2"><Input id="g-client" className="font-mono text-xs" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} placeholder="1234567890-abc.apps.googleusercontent.com" /></Field>
                <Field label="OAuth client secret" htmlFor="g-secret" hint={kept}><Input id="g-secret" type="password" autoComplete="off" className="font-mono" value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} placeholder={app.configured ? '••••••••' : 'GOCSPX-…'} /></Field>
                <Field label="Developer token" htmlFor="g-dev" hint={kept ?? 'Google Ads → Tools → API Center'}><Input id="g-dev" type="password" autoComplete="off" className="font-mono" value={form.developer_token} onChange={(e) => setForm({ ...form, developer_token: e.target.value })} placeholder={app.configured ? '••••••••' : ''} /></Field>
                <Field label="Manager account ID (optional)" htmlFor="g-mcc" hint="When your accounts are reached through a manager (MCC) account"><Input id="g-mcc" className="font-mono" value={form.login_customer_id} onChange={(e) => setForm({ ...form, login_customer_id: e.target.value })} placeholder="123-456-7890" /></Field>
              </>
            )}
            <div className="grid gap-2 sm:col-span-2">
              <CopyLine label="Redirect URI to register on the app" value={adRedirectUri(platform)} />
              {save.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{(save.error as Error).message}</p>}
              {manage && <Button type="submit" className="w-fit" disabled={!valid || save.isPending}>{save.isPending && <Spinner />} Save developer app</Button>}
            </div>
          </fieldset>
        </form>
      </CardContent>
    </Card>
  )
}

function AccountRow({ account: a, platform, storeCurrency, manage, onChanged }: { account: AdAccount; platform: AdPlatform; storeCurrency: string; manage: boolean; onChanged: () => void }) {
  const [rate, setRate] = useState(String(a.usd_rate))
  const [tax, setTax] = useState(String(a.tax_percent))
  const toggle = useMutation({ mutationFn: (v: boolean) => updateAdAccount(a.id, { is_selected: v }), onSuccess: onChanged, onError: (e) => toast.error((e as Error).message) })
  const save = useMutation({
    mutationFn: () => updateAdAccount(a.id, { usd_rate: Number(rate), tax_percent: Number(tax) }),
    onSuccess: () => { toast.success('Saved. Synced days were recalculated.'); onChanged() },
  })
  const foreign = !!a.currency && a.currency.toUpperCase() !== storeCurrency.toUpperCase()
  const changed = Number(rate) !== Number(a.usd_rate) || Number(tax) !== Number(a.tax_percent)
  const id = platform === 'google' ? a.external_id.replace(/(\d{3})(\d{3})(\d+)/, '$1-$2-$3') : a.external_id
  return (
    <li className={cn('grid gap-3 rounded-xl border px-4 py-3', !a.is_selected && 'bg-muted/30')}>
      <div className="flex flex-wrap items-center gap-3">
        <Switch checked={a.is_selected} disabled={!manage || a.is_manager || toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-label={`Sync ${a.name ?? id}`} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{a.name ?? 'Unnamed account'} {a.is_manager && <Badge variant="neutral">manager</Badge>}</p>
          <p className="text-xs break-words text-muted-foreground">
            {id}{a.currency ? ` · ${a.currency}` : ''}{a.timezone ? ` · ${a.timezone}` : ''}{a.login_customer_id ? ` · via ${a.login_customer_id}` : ''}
            {' · '}last 30 days <Money value={a.cost_30d} />
            {' · '}{a.last_sync_at ? <span title={formatDateTime(a.last_sync_at)}>synced {timeAgo(a.last_sync_at)}</span> : 'not synced yet'}
          </p>
          {a.last_sync_status && a.last_sync_status !== 'OK' && <p className="text-xs text-amber-700">{SYNC_PROBLEM[a.last_sync_status] ?? SYNC_PROBLEM.FAILED} {a.last_sync_error}</p>}
        </div>
      </div>
      {a.is_selected && manage && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (Number(rate) > 0) save.mutate() }}>
          {foreign && (
            <Field label={`1 ${a.currency} in ${storeCurrency}`} htmlFor={`rate-${a.id}`} className="w-40">
              <Input id={`rate-${a.id}`} type="number" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
            </Field>
          )}
          <Field label="VAT on ad spend (%)" htmlFor={`tax-${a.id}`} className="w-40">
            <Input id={`tax-${a.id}`} type="number" min="0" max="100" step="any" value={tax} onChange={(e) => setTax(e.target.value)} />
          </Field>
          <Button type="submit" size="sm" variant="outline" disabled={!changed || save.isPending}>{save.isPending && <Spinner />} Save</Button>
        </form>
      )}
    </li>
  )
}

function SyncButton({ platform }: { platform: AdPlatform }) {
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const sync = useMutation({
    meta: { silent: true },
    mutationFn: () => syncAdPlatform(platform, 7),
    onSuccess: (r) => {
      const failed = r.accounts.filter((a) => !a.ok)
      if (failed.length) toast.warning(`${failed.map((a) => a.name).join(', ')}: ${failed[0].error}`)
      else toast.success(`Synced ${formatNumber(r.rows)} daily rows · ${formatMoney(r.cost)}`)
      void queryClient.invalidateQueries({ queryKey: ['ads', platform] })
      void queryClient.invalidateQueries({ queryKey: ['marketing'] })
      void queryClient.invalidateQueries({ queryKey: ['attribution'] })
    },
    onError: (e) => toast.error((e as Error).message),
  })
  if (!can('marketing.manage')) return null
  return <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? <Spinner /> : <RefreshCw />} Sync now</Button>
}

const ratio = (v: number | null) => (v === null || v === undefined ? '—' : `${formatNumber(v, 2)}×`)

function Report({ platform, tab, from, to }: { platform: AdPlatform; tab: 'overview' | 'campaigns' | 'results' | 'expenses'; from: string; to: string }) {
  const report = useQuery({ queryKey: ['ads', platform, 'report', from, to], placeholderData: keepPreviousData, queryFn: () => adPlatformReport(platform, from, to) })
  const campaigns = report.data?.campaigns ?? []
  const days = report.data?.days ?? []
  const sum = (k: keyof AdCampaignRow) => campaigns.reduce((s, c) => s + Number(c[k] ?? 0), 0)
  const cost = sum('cost')
  const revenue = sum('revenue')

  if (tab === 'overview') {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Spend" value={<Money value={cost} />} hint={`${formatNumber(sum('clicks'))} clicks · ${formatNumber(sum('impressions'))} impressions`} />
          <StatCard label={`${INFO[platform].name.split(' ')[0]} conversions`} value={formatNumber(sum('conversions'), 1)} hint="As the platform reports them" />
          <StatCard label="Orders with its links" value={formatNumber(sum('orders'))} hint={`${formatNumber(sum('delivered'))} delivered`} />
          <StatCard label="Delivered revenue" value={<Money value={revenue} />} hint={cost > 0 ? `ROAS ${ratio(Math.round((revenue / cost) * 100) / 100)}` : undefined} tone={cost > 0 && revenue >= cost ? 'positive' : undefined} />
        </div>
        <CampaignTable rows={campaigns.slice(0, 10)} mode="results" loading={report.isFetching} error={report.error} />
      </div>
    )
  }
  if (tab === 'expenses') return <ExpensesTable rows={days} loading={report.isFetching} error={report.error} />
  return <CampaignTable rows={campaigns} mode={tab === 'campaigns' ? 'platform' : 'results'} loading={report.isFetching} error={report.error} />
}

const STATUS_VARIANT = { ACTIVE: 'success', PAUSED: 'warning', ENDED: 'neutral' } as const

function CampaignTable({ rows, mode, loading, error }: { rows: AdCampaignRow[]; mode: 'platform' | 'results'; loading: boolean; error: unknown }) {
  const name: Column<AdCampaignRow> = {
    key: 'name', header: 'Campaign', primary: true,
    cell: (c) => (
      <div className="min-w-0">
        <p className="font-medium break-words">{c.name}</p>
        <p className="text-xs text-muted-foreground"><Badge variant={STATUS_VARIANT[c.status]} className="mr-1">{c.status.toLowerCase()}</Badge>{c.account} · {c.id}</p>
      </div>
    ),
  }
  const columns: Column<AdCampaignRow>[] = mode === 'platform'
    ? [
      name,
      { key: 'cost', header: 'Spend', align: 'right', cell: (c) => <span><Money value={c.cost} />{c.currency && c.spend_account !== c.cost && <span className="block text-xs text-muted-foreground">{formatNumber(c.spend_account, 2)} {c.currency}</span>}</span> },
      { key: 'impressions', header: 'Impressions', align: 'right', hideOnMobile: true, cell: (c) => formatNumber(c.impressions) },
      { key: 'clicks', header: 'Clicks', align: 'right', cell: (c) => formatNumber(c.clicks) },
      { key: 'ctr', header: 'CTR', align: 'right', hideOnMobile: true, cell: (c) => (c.ctr === null ? '—' : `${formatNumber(c.ctr, 2)}%`) },
      { key: 'cpc', header: 'CPC', align: 'right', hideOnMobile: true, cell: (c) => (c.cpc === null ? '—' : <Money value={c.cpc} />) },
      { key: 'conversions', header: 'Conversions', align: 'right', cell: (c) => formatNumber(c.conversions, 1) },
    ]
    : [
      name,
      { key: 'cost', header: 'Spend', align: 'right', cell: (c) => <Money value={c.cost} /> },
      { key: 'conversions', header: 'Platform conv.', align: 'right', hideOnMobile: true, cell: (c) => formatNumber(c.conversions, 1) },
      { key: 'orders', header: 'Orders', align: 'right', cell: (c) => formatNumber(c.orders) },
      { key: 'delivered', header: 'Delivered', align: 'right', cell: (c) => <span className="text-emerald-700">{formatNumber(c.delivered)}</span> },
      { key: 'returned', header: 'Cancelled / returned', align: 'right', hideOnMobile: true, cell: (c) => `${formatNumber(c.cancelled)} / ${formatNumber(c.returned)}` },
      { key: 'revenue', header: 'Delivered revenue', align: 'right', cell: (c) => <Money value={c.revenue} /> },
      { key: 'cpo', header: 'Cost / order', align: 'right', hideOnMobile: true, cell: (c) => (c.cost_per_order === null ? '—' : <Money value={c.cost_per_order} />) },
      { key: 'roas', header: 'ROAS', align: 'right', cell: (c) => ratio(c.roas) },
    ]
  return (
    <div className="space-y-2">
      <DataTable columns={columns} rows={rows} rowKey={(c) => c.id} loading={loading} error={error}
        empty={<EmptyState title="No campaigns in this period" description="Sync, or choose a longer period." />} />
      {mode === 'results' && <p className="text-xs text-muted-foreground">Orders count only when their link carried the campaign's ID. Everything else stays Unattributed on Attribution & profit.</p>}
    </div>
  )
}

function ExpensesTable({ rows, loading, error }: { rows: AdDayRow[]; loading: boolean; error: unknown }) {
  const total = rows.reduce((s, r) => s + Number(r.cost), 0)
  const columns: Column<AdDayRow>[] = [
    { key: 'date', header: 'Day', primary: true, cell: (r) => <span className="font-medium">{formatDate(r.date)}</span> },
    { key: 'account', header: 'Account', cell: (r) => r.account ?? '—' },
    { key: 'spend', header: 'Billed', align: 'right', hideOnMobile: true, cell: (r) => `${formatNumber(r.spend_account, 2)} ${r.currency ?? ''}` },
    { key: 'cost', header: 'Expense', align: 'right', cell: (r) => <Money value={r.cost} className="font-medium" /> },
    { key: 'clicks', header: 'Clicks', align: 'right', hideOnMobile: true, cell: (r) => formatNumber(r.clicks) },
  ]
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Posted to Advertising in Finance · total <Money value={total} className="font-medium text-foreground" /></p>
      <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.date}-${r.account_id}`} loading={loading} error={error}
        empty={<EmptyState title="No spend in this period" />} />
    </div>
  )
}
