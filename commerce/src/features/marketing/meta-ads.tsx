import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, CircleCheck, ImageOff, Megaphone, Pencil, PlugZap, Plus, RefreshCw, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { rangeFor } from '@/lib/dates'
import { formatDateTime, formatMoney, formatNumber, formatPercent, timeAgo, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  disconnectMetaAccount, financeAccounts, type MetaAccountInput, type MetaAdAccount, metaAdAccounts, metaPerformance, type MetaPerformanceRow,
  type MetaTestResult, saveMetaAccount, setMetaTax, syncMeta, testMetaAccount,
} from '@/services/marketing'

const SYNC_PROBLEM: Record<string, string> = {
  TOKEN_INVALID: 'The access token stopped working (expired or revoked). Edit the account and paste a new one.',
  RATE_LIMITED: 'Meta asked us to slow down. The next scheduled sync will try again.',
  NO_ACCESS: 'The token can no longer read this ad account. Give the system user ads_read access again.',
  FAILED: 'The last sync failed.',
}

/** Meta Ads: the connected ad accounts, and campaign → ad set → ad numbers next to the orders they brought. */
export function MetaAds() {
  return (
    <div className="space-y-4">
      <MetaAccounts />
      <MetaPerformance />
    </div>
  )
}

const statusDot = (a: MetaAdAccount) => !a.is_active || a.connection_status === 'DISCONNECTED' ? 'bg-zinc-400'
  : a.connection_status === 'FAILED' || (a.last_sync_status && a.last_sync_status !== 'OK') ? 'bg-amber-500' : 'bg-emerald-500'

/** Every Meta ad account: add, edit, sync, disconnect, plus VAT on ad spend. */
export function MetaAccounts() {
  const { can } = useAuth()
  const manage = can('marketing.manage')
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ['meta', 'accounts'], queryFn: metaAdAccounts })
  const [editing, setEditing] = useState<MetaAdAccount | 'new' | null>(null)
  const [removing, setRemoving] = useState<MetaAdAccount | null>(null)
  const [tax, setTax] = useState('')
  useEffect(() => { if (list.data) setTax(String(list.data.tax_percent ?? 0)) }, [list.data])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['meta'] })
    void queryClient.invalidateQueries({ queryKey: ['attribution'] })
    void queryClient.invalidateQueries({ queryKey: ['marketing'] })
    void queryClient.invalidateQueries({ queryKey: ['finance'] })
  }
  const sync = useMutation({
    meta: { silent: true },
    mutationFn: (id?: string) => syncMeta(7, id),
    onSuccess: (r) => {
      const failed = r.accounts.filter((a) => !a.ok)
      if (failed.length) toast.warning(`${failed.map((a) => a.name).join(', ')}: ${failed[0].error}`)
      else toast.success(`Synced ${formatNumber(r.insights)} daily rows · ${formatMoney(r.cost)}`)
      refresh()
    },
    onError: (e) => { toast.error((e as Error).message); refresh() },
  })
  const saveTax = useMutation({ mutationFn: () => setMetaTax(Number(tax)), onSuccess: () => { toast.success('Saved. Spend in reports and Finance was recalculated.'); refresh() } })
  const disconnect = useMutation({ mutationFn: (id: string) => disconnectMetaAccount(id), onSuccess: () => { toast.success('Disconnected'); refresh() } })

  const data = list.data
  const accounts = data?.accounts ?? []
  const taxValid = tax !== '' && Number(tax) >= 0 && Number(tax) <= 100

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">Meta Ads accounts</CardTitle>
        <CardDescription>
          Spend, impressions, clicks and conversions for every campaign, ad set and ad, synced every 3 hours and posted to Advertising
          expenses in Finance. Tokens and app secrets stay on the server.
        </CardDescription>
        {manage && (
          <CardAction className="flex gap-2">
            {accounts.some((a) => a.is_active) && (
              <Button size="sm" variant="outline" onClick={() => sync.mutate(undefined)} disabled={sync.isPending}>
                {sync.isPending ? <Spinner /> : <RefreshCw />} Sync all
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing('new')}><Plus /> Add account</Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {list.isLoading ? <LoadingState /> : list.error ? (
          <p className="text-sm text-red-700">{(list.error as Error).message}</p>
        ) : accounts.length === 0 ? (
          <EmptyState icon={<Megaphone className="size-5" />} title="No Meta Ads account yet"
            description="Add one to bring in spend, impressions, clicks and conversions. Orders are still attributed from tracking links without it."
            action={manage ? <Button size="sm" onClick={() => setEditing('new')}><Plus /> Add Meta Ads account</Button> : undefined} />
        ) : (
          <ul className="grid gap-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3">
                <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', statusDot(a))} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {a.name}
                    {!a.is_active && <Badge variant="neutral">{a.connection_status === 'DISCONNECTED' ? 'disconnected' : 'paused'}</Badge>}
                  </p>
                  <p className="text-xs break-words text-muted-foreground">
                    act_{a.ad_account_id}{a.meta_name && a.meta_name !== a.name ? ` · ${a.meta_name}` : ''}{a.currency ? ` · ${a.currency}` : ''}
                    {' · '}1 USD = {formatNumber(a.usd_rate, 2)} {data?.store_currency}
                    {a.token_hint ? ` · token ${a.token_hint}` : ''}{a.has_app_secret ? ' · signed' : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {a.payment_account_name ? <>Paid from <span className="text-foreground">{a.payment_account_name}</span>{a.payments_from ? ` since ${a.payments_from}` : ''}</> : 'Expense only — no payment account'}
                    {' · '}Last 30 days <Money value={a.cost_30d} />
                    {' · '}{a.last_sync_at ? <span title={formatDateTime(a.last_sync_at)}>synced {timeAgo(a.last_sync_at)}</span> : 'not synced yet'}
                  </p>
                  {a.is_active && a.connection_status === 'FAILED' && <p className="mt-1 text-xs text-amber-700">{a.connection_error ?? 'Connection failed.'}</p>}
                  {a.is_active && a.last_sync_status && a.last_sync_status !== 'OK' && (
                    <p className="mt-1 text-xs text-amber-700">{SYNC_PROBLEM[a.last_sync_status] ?? SYNC_PROBLEM.FAILED}{a.last_sync_error ? ` ${a.last_sync_error}` : ''}</p>
                  )}
                </div>
                {manage && (
                  <div className="flex shrink-0 gap-1">
                    {a.is_active && (
                      <Button size="sm" variant="ghost" onClick={() => sync.mutate(a.id)} disabled={sync.isPending} aria-label={`Sync ${a.name}`}><RefreshCw /></Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setEditing(a)}><Pencil /> Edit</Button>
                    {a.connection_status !== 'DISCONNECTED' && (
                      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setRemoving(a)} aria-label={`Disconnect ${a.name}`}><Unplug /></Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {accounts.length > 0 && (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (taxValid) saveTax.mutate() }}>
            <Field label="VAT / tax on ad spend (%)" htmlFor="meta-tax" hint="Added on top of what Meta reports for every account, e.g. 15 for VAT." className="w-64 max-w-full">
              <Input id="meta-tax" type="number" step="0.01" min="0" max="100" value={tax} onChange={(e) => setTax(e.target.value)} disabled={!manage} />
            </Field>
            {manage && <Button type="submit" variant="outline" disabled={!taxValid || Number(tax) === Number(data?.tax_percent) || saveTax.isPending}>{saveTax.isPending && <Spinner />} Save</Button>}
          </form>
        )}
      </CardContent>
      {editing && <MetaAccountDialog account={editing === 'new' ? null : editing} storeCurrency={data?.store_currency ?? 'BDT'}
        onClose={() => setEditing(null)} onSaved={refresh} />}
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={`Disconnect ${removing?.name}?`} destructive confirmLabel="Disconnect"
        description="Its access token and app secret are erased from the server and syncing stops. Spend already synced stays in reports, Finance and the payment account."
        onConfirm={() => disconnect.mutateAsync(removing!.id).then(() => setRemoving(null))} />
    </Card>
  )
}

type TestState = { kind: 'idle' } | { kind: 'ok'; result: MetaTestResult } | { kind: 'error'; message: string }

/** "Add Meta Ads Account" / edit: credentials, rate, payment account, active, with a connection test. */
function MetaAccountDialog({ account, storeCurrency, onClose, onSaved }: {
  account: MetaAdAccount | null; storeCurrency: string; onClose: () => void; onSaved: () => void
}) {
  const editing = !!account
  const payment = useQuery({ queryKey: ['finance', 'accounts'], queryFn: financeAccounts })
  const [form, setForm] = useState<MetaAccountInput>({
    id: account?.id, name: account?.name ?? '', appId: account?.app_id ?? '', appSecret: '', accessToken: '',
    adAccountId: account?.ad_account_id ?? '', usdRate: account?.usd_rate ?? 110,
    paymentAccountId: account?.payment_account_id ?? null, isActive: account?.is_active ?? true,
  })
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const set = <K extends keyof MetaAccountInput>(k: K, v: MetaAccountInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (['appId', 'appSecret', 'accessToken', 'adAccountId'].includes(k)) setTest({ kind: 'idle' })
  }

  const tester = useMutation({
    meta: { silent: true },
    mutationFn: () => testMetaAccount(form),
    onSuccess: (r) => setTest({ kind: 'ok', result: r }),
    onError: (e) => setTest({ kind: 'error', message: (e as Error).message }),
  })
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => saveMetaAccount(form),
    onSuccess: (r) => {
      if (r.sync && !r.sync.ok) toast.warning(`Saved ${r.account.name}, but the first sync failed: ${r.sync.error}`)
      else if (r.sync) toast.success(`Added ${r.account.name}. Synced the last 30 days (${formatMoney(r.sync.cost ?? 0)}).`)
      else toast.success(`Saved ${r.account.name}`)
      onSaved()
      onClose()
    },
  })

  const adIdValid = /^(act_)?[0-9]{3,32}$/.test(form.adAccountId.trim())
  const canSubmit = form.name.trim().length >= 2 && adIdValid && form.usdRate > 0 && (editing || form.accessToken.trim().length >= 20)
  const kept = (has: boolean) => (editing && has ? 'Saved — leave empty to keep it' : undefined)
  const sameCurrency = account?.currency && account.currency.toUpperCase() === storeCurrency.toUpperCase()

  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} wide
      title={editing ? `Edit ${account!.name}` : 'Add Meta Ads Account'}
      description="Enter your Meta Ads API credentials to track ad expenses. From Meta for Developers: the app's ID and secret (App settings → Basic), and a System User access token with ads_read."
      submitLabel={editing ? 'Save' : 'Create'} onSubmit={() => save.mutate()} busy={save.isPending} disabled={!canSubmit}>
      <Field label="Account Name" htmlFor="ma-name" required hint="A friendly name to identify this account">
        <Input id="ma-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Isolation main" maxLength={80} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="App ID" htmlFor="ma-app-id" hint="Your Meta App ID">
          <Input id="ma-app-id" inputMode="numeric" className="font-mono" value={form.appId} onChange={(e) => set('appId', e.target.value.trim())} placeholder="Meta App ID" />
        </Field>
        <Field label="App Secret" htmlFor="ma-app-secret" hint={kept(!!account?.has_app_secret) ?? 'Your Meta App Secret'}>
          <Input id="ma-app-secret" type="password" autoComplete="off" className="font-mono" value={form.appSecret} onChange={(e) => set('appSecret', e.target.value)}
            placeholder={editing && account?.has_app_secret ? '••••••••' : 'Meta App Secret'} />
        </Field>
      </div>
      <Field label="Access Token" htmlFor="ma-token" required={!editing} hint={kept(!!account?.token_hint) ?? 'Long-lived System User Access Token'}>
        <Input id="ma-token" type="password" autoComplete="off" className="font-mono text-xs" value={form.accessToken} onChange={(e) => set('accessToken', e.target.value)}
          placeholder={editing && account?.token_hint ? account.token_hint : 'System User Access Token'} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ad Account ID" htmlFor="ma-act" required hint={'Without the "act_" prefix'} error={form.adAccountId && !adIdValid ? 'Numbers only, e.g. 998877' : undefined}>
          <Input id="ma-act" inputMode="numeric" className="font-mono" value={form.adAccountId} onChange={(e) => set('adAccountId', e.target.value.trim())} placeholder="ID without act_" />
        </Field>
        <Field label={`USD to ${storeCurrency} Rate`} htmlFor="ma-rate" required
          hint={sameCurrency ? `This ad account bills in ${storeCurrency}, so no conversion is applied.` : 'Current conversion rate'}>
          <Input id="ma-rate" type="number" min="0" step="any" value={form.usdRate} onChange={(e) => set('usdRate', Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Payment Account" htmlFor="ma-pay"
        hint="This account's daily spend is withdrawn from here the day after, and kept in step if Meta later revises it. Leave empty to record the expense without moving any balance.">
        <Select value={form.paymentAccountId ?? 'none'} onValueChange={(v) => set('paymentAccountId', v === 'none' ? null : v)}>
          <SelectTrigger id="ma-pay" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No account selected</SelectItem>
            {(payment.data ?? []).filter((f) => f.is_active || f.id === form.paymentAccountId).map((f) => (
              <SelectItem key={f.id} value={f.id}>{f.name}{f.balance != null ? ` · ${formatMoney(f.balance)}` : ''}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {payment.data?.length === 0 && (
        <p className="-mt-2 text-xs text-muted-foreground">No payment accounts yet. Add your card or bank under <Link to="/admin/finance/accounts" className="underline">Finance → Payment Accounts</Link>.</p>
      )}
      <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <span><span className="block text-sm font-medium">Active Status</span><span className="block text-xs text-muted-foreground">Enable or disable this account</span></span>
        <Switch checked={form.isActive} onCheckedChange={(v) => set('isActive', v)} aria-label="Active" />
      </label>

      <div className="grid gap-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">Connection Status</span>
          <Button type="button" size="sm" variant="outline" onClick={() => tester.mutate()}
            disabled={tester.isPending || !adIdValid || (!editing && form.accessToken.trim().length < 20)}>
            {tester.isPending ? <Spinner /> : <PlugZap />} Test Connection
          </Button>
        </div>
        {test.kind === 'idle' && (
          <p className="text-xs text-muted-foreground">
            {editing && account?.connection_status === 'OK' ? `Connected${account.tested_at ? ` · checked ${timeAgo(account.tested_at)}` : ''}.` : 'Test your credentials before saving.'}
            {' '}Saving an active account tests it too.
          </p>
        )}
        {test.kind === 'ok' && (
          <div className="grid gap-1 text-xs">
            <p className="flex items-center gap-1.5 font-medium text-emerald-700"><CircleCheck className="size-4" /> Connected to {test.result.account.name} · {test.result.account.currency}</p>
            {test.result.token && (
              <p className="text-muted-foreground">
                Token from app {test.result.token.appId} · {test.result.token.expiresAt ? `expires ${test.result.token.expiresAt.slice(0, 10)}` : 'never expires'}
                {test.result.token.scopes.length ? ` · ${test.result.token.scopes.join(', ')}` : ''}
              </p>
            )}
            {test.result.warnings.map((w) => <p key={w} className="text-amber-700">{w}</p>)}
          </div>
        )}
        {test.kind === 'error' && <p className="text-xs text-red-700" role="alert">{test.message}</p>}
      </div>
      {save.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{(save.error as Error).message}</p>}
      {save.isPending && !editing && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Connecting and syncing the last 30 days…</p>}
    </FormDialog>
  )
}

const LEVEL_LABEL = { campaign: 'Campaign', adset: 'Ad set', ad: 'Ad' } as const
const ratio = (v: number | null) => (v === null || v === undefined ? '—' : `${formatNumber(v, 2)}×`)

function MetaPerformance() {
  const initial = rangeFor('30d')
  const [s, update] = useUrlState({ mfrom: initial.from, mto: initial.to, mcampaign: '', mcampaignName: '', madset: '', madsetName: '' })
  const level = s.madset ? 'ad' : s.mcampaign ? 'adset' : 'campaign'
  const parent = s.madset || s.mcampaign || undefined
  const perf = useQuery({
    queryKey: ['meta', 'performance', s.mfrom, s.mto, level, parent],
    placeholderData: keepPreviousData,
    queryFn: () => metaPerformance(s.mfrom, s.mto, level, parent),
  })
  const rows = perf.data ?? []
  const sum = (k: keyof MetaPerformanceRow) => rows.reduce((t, r) => t + toNumber(r[k]), 0)
  const spend = sum('spend')
  const revenue = sum('revenue')
  const clicks = sum('clicks')
  const impressions = sum('impressions')
  // CTR and CPC use link clicks, as Meta reports them per row.
  const linkClicks = rows.reduce((t, r) => t + (toNumber(r.ctr) / 100) * toNumber(r.impressions), 0)

  const columns: Column<MetaPerformanceRow>[] = [
    {
      key: 'name', header: LEVEL_LABEL[level], primary: true,
      cell: (r) => (
        <span className="flex items-center gap-2.5">
          {level === 'ad' && (r.thumbnail_url
            ? <img src={r.thumbnail_url} alt="" className="size-9 shrink-0 rounded-md border object-cover" loading="lazy" />
            : <span className="flex size-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground"><ImageOff className="size-4" /></span>)}
          <span className="min-w-0">
            <span className="flex items-center gap-1 font-medium">{r.name}{level !== 'ad' && <ChevronRight className="size-3.5 text-muted-foreground" />}</span>
            <span className="text-xs text-muted-foreground">
              {r.effective_status && <Badge variant={r.effective_status === 'ACTIVE' ? 'success' : 'neutral'} className="mr-1">{r.effective_status.toLowerCase().replace(/_/g, ' ')}</Badge>}
              {r.daily_budget ? `${formatMoney(r.daily_budget)}/day` : ''}
            </span>
          </span>
        </span>
      ),
    },
    { key: 'spend', header: 'Spend', align: 'right', cell: (r) => <Money value={r.spend} /> },
    { key: 'impressions', header: 'Impressions', align: 'right', hideOnMobile: true, cell: (r) => formatNumber(r.impressions) },
    { key: 'clicks', header: 'Clicks', align: 'right', hideOnMobile: true, cell: (r) => <span>{formatNumber(r.clicks)}<span className="block text-xs text-muted-foreground">link CTR {r.ctr === null ? '—' : formatPercent(r.ctr, 2)}</span></span> },
    { key: 'cpc', header: 'CPC / CPM', align: 'right', hideOnMobile: true, cell: (r) => <span>{r.cpc === null ? '—' : formatMoney(r.cpc)}<span className="block text-xs text-muted-foreground">{r.cpm === null ? '—' : formatMoney(r.cpm)} CPM</span></span> },
    { key: 'meta', header: 'Meta purchases', align: 'right', hideOnMobile: true, cell: (r) => <span title="What Meta reports (pixel / conversions API)">{formatNumber(r.meta_purchases)}</span> },
    { key: 'orders', header: 'Our orders', align: 'right', cell: (r) => <span title="Orders whose tracking link carried this id">{formatNumber(r.orders)}<span className="block text-xs text-muted-foreground">{formatNumber(r.delivered)} delivered</span></span> },
    { key: 'revenue', header: 'Delivered revenue', align: 'right', cell: (r) => <Money value={r.revenue} /> },
    { key: 'cpo', header: 'Cost / order', align: 'right', hideOnMobile: true, cell: (r) => (r.cost_per_order === null ? '—' : <Money value={r.cost_per_order} />) },
    { key: 'roas', header: 'ROAS', align: 'right', cell: (r) => ratio(r.roas) },
  ]

  const drill = (r: MetaPerformanceRow) => {
    if (level === 'campaign') update({ mcampaign: r.id, mcampaignName: r.name })
    else if (level === 'adset') update({ madset: r.id, madsetName: r.name })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeFilter value={{ from: s.mfrom, to: s.mto }} onChange={(r) => update({ mfrom: r.from, mto: r.to })} />
        <nav aria-label="Level" className="flex flex-wrap items-center gap-1 text-sm">
          <Button size="sm" variant={level === 'campaign' ? 'secondary' : 'ghost'} className="h-7 px-2"
            onClick={() => update({ mcampaign: '', mcampaignName: '', madset: '', madsetName: '' })}>All campaigns</Button>
          {s.mcampaign && (
            <>
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <Button size="sm" variant={level === 'adset' ? 'secondary' : 'ghost'} className="h-7 px-2" onClick={() => update({ madset: '', madsetName: '' })}>{s.mcampaignName || 'Campaign'}</Button>
            </>
          )}
          {s.madset && (<><ChevronRight className="size-3.5 text-muted-foreground" /><Button size="sm" variant="secondary" className="h-7 px-2">{s.madsetName || 'Ad set'}</Button></>)}
        </nav>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Meta spend" value={<Money value={spend} />} hint={`${formatNumber(impressions)} impressions`} />
        <StatCard label="Clicks" value={formatNumber(clicks)} hint={`Link CTR ${impressions > 0 ? formatPercent((100 * linkClicks) / impressions, 2) : '—'} · CPC ${linkClicks >= 1 ? formatMoney(spend / linkClicks) : '—'}`} />
        <StatCard label="Our orders" value={formatNumber(sum('orders'))} hint={`${formatNumber(sum('delivered'))} delivered · Meta reports ${formatNumber(sum('meta_purchases'))} purchases`} />
        <StatCard label="ROAS (delivered)" value={spend > 0 ? ratio(revenue / spend) : '—'} hint={<>on <Money value={revenue} /> delivered revenue</>} />
      </div>
      <DataTable columns={columns} rows={perf.data} rowKey={(r) => r.id} loading={perf.isFetching} error={perf.error} onRetry={() => perf.refetch()}
        onRowClick={level !== 'ad' ? drill : undefined}
        empty={<EmptyState icon={<Megaphone className="size-5" />} title="No Meta activity in this period"
          description="Connect the ad account above, or pick a longer date range." />} />
    </div>
  )
}
