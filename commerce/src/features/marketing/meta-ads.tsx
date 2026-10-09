import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, CircleCheck, ImageOff, Megaphone, PlugZap, RefreshCw, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { rangeFor } from '@/lib/dates'
import { formatDateTime, formatMoney, formatNumber, formatPercent, timeAgo, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  connectMeta, disconnectMeta, type MetaAccountChoice, metaAccounts, type MetaPageChoice, metaPerformance, type MetaPerformanceRow,
  metaSettings, syncMeta, updateMetaSettings,
} from '@/services/marketing'

const SYNC_PROBLEM: Record<string, string> = {
  TOKEN_INVALID: 'The access token stopped working (expired or revoked). Connect again with a new token.',
  RATE_LIMITED: 'Meta asked us to slow down. The next scheduled sync will try again.',
  NO_ACCESS: 'The token can no longer read this ad account. Give it ads_read access again.',
  FAILED: 'The last sync failed.',
}

/** Meta Ads: connection, exchange rate / VAT, and campaign → ad set → ad numbers next to the orders they brought. */
export function MetaAds() {
  return (
    <div className="space-y-4">
      <MetaConnection />
      <MetaPerformance />
    </div>
  )
}

function MetaConnection() {
  const { can } = useAuth()
  const manage = can('marketing.manage')
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: ['meta', 'status'], queryFn: metaSettings })
  const s = status.data
  const [connectOpen, setConnectOpen] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const [rate, setRate] = useState('')
  const [tax, setTax] = useState('')
  useEffect(() => {
    if (s) { setRate(String(s.exchange_rate ?? 1)); setTax(String(s.tax_percent ?? 0)) }
  }, [s])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['meta'] })
    void queryClient.invalidateQueries({ queryKey: ['attribution'] })
    void queryClient.invalidateQueries({ queryKey: ['marketing'] })
  }
  const sync = useMutation({
    meta: { silent: true },
    mutationFn: () => syncMeta(7),
    onSuccess: (r) => { toast.success(`Synced ${formatNumber(r.insights ?? 0)} daily rows · ${formatMoney(r.cost ?? 0)}`); refresh() },
    onError: () => refresh(),
  })
  const saveRate = useMutation({
    mutationFn: () => updateMetaSettings(Number(rate), Number(tax)),
    onSuccess: () => { toast.success('Saved. Spend in reports and Finance was recalculated.'); refresh() },
  })
  const disconnect = useMutation({ mutationFn: disconnectMeta, onSuccess: () => { toast.success('Meta Ads disconnected'); refresh() } })
  const rateValid = Number(rate) > 0 && Number(tax) >= 0 && Number(tax) <= 100
  const rateChanged = s && (Number(rate) !== Number(s.exchange_rate) || Number(tax) !== Number(s.tax_percent))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Meta Ads account</CardTitle>
        <CardDescription>
          Spend, impressions, clicks and conversions for every campaign, ad set and ad, synced every 3 hours. Spend is posted to Advertising
          expenses in Finance. The access token stays on the server.
        </CardDescription>
        {manage && (
          <CardAction className="flex gap-2">
            {s?.connected && (
              <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
                {sync.isPending ? <Spinner /> : <RefreshCw />} Sync now
              </Button>
            )}
            <Button size="sm" variant={s?.connected ? 'outline' : 'default'} onClick={() => setConnectOpen(true)}><PlugZap /> {s?.connected ? 'Change' : 'Connect'}</Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {status.isLoading ? <LoadingState /> : status.error ? (
          <p className="text-sm text-red-700">{(status.error as Error).message}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
              <span className={cn('size-2.5 rounded-full', s?.connected ? (s.last_sync_status && s.last_sync_status !== 'OK' ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-zinc-400')} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {s?.connected ? `${s.ad_account_name ?? s.ad_account_id} · ${s.account_currency ?? ''}` : 'Not connected'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {s?.connected ? (
                    <>
                      {s.ad_account_id}{s.page_name ? ` · Page ${s.page_name}` : ''}{s.instagram_username ? ` · Instagram @${s.instagram_username}` : ''}
                      {s.hint ? ` · token ${s.hint}` : ''}
                      <br />
                      {s.last_sync_at ? <>Last sync {timeAgo(s.last_sync_at)} ({formatDateTime(s.last_sync_at)}) · {s.last_sync_since} → {s.last_sync_until}</> : 'Not synced yet'}
                    </>
                  ) : 'Connect to bring in spend, impressions, clicks and conversions. Orders are still attributed from tracking links without it.'}
                </p>
                {s?.connected && s.last_sync_status && s.last_sync_status !== 'OK' && (
                  <p className="mt-1 text-xs text-amber-700">{SYNC_PROBLEM[s.last_sync_status] ?? SYNC_PROBLEM.FAILED}{s.last_sync_error ? ` ${s.last_sync_error}` : ''}</p>
                )}
                {sync.error && <p className="mt-1 text-xs text-red-700" role="alert">{(sync.error as Error).message}</p>}
              </div>
              {s?.connected && manage && (
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirmOff(true)}><Unplug /> Disconnect</Button>
              )}
            </div>

            {s?.connected && (
              <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (rateValid) saveRate.mutate() }}>
                <Field label={`1 ${s.account_currency || 'unit'} in your currency`} htmlFor="meta-rate" hint="Meta bills in the ad account currency; spend is converted with this rate.">
                  <Input id="meta-rate" type="number" step="0.0001" min="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} disabled={!manage} />
                </Field>
                <Field label="VAT / tax on ad spend (%)" htmlFor="meta-tax" hint="Added on top of what Meta reports, e.g. 15 for VAT.">
                  <Input id="meta-tax" type="number" step="0.01" min="0" max="100" value={tax} onChange={(e) => setTax(e.target.value)} disabled={!manage} />
                </Field>
                {manage && <Button type="submit" variant="outline" disabled={!rateValid || !rateChanged || saveRate.isPending}>{saveRate.isPending && <Spinner />} Save</Button>}
              </form>
            )}
          </>
        )}
      </CardContent>
      <ConnectMetaDialog open={connectOpen} onOpenChange={setConnectOpen} onConnected={refresh} />
      <ConfirmDialog open={confirmOff} onOpenChange={setConfirmOff} title="Disconnect Meta Ads?" destructive confirmLabel="Disconnect"
        description="The access token is deleted from the server and syncing stops. Spend already synced stays in reports and Finance."
        onConfirm={() => disconnect.mutateAsync()} />
    </Card>
  )
}

function ConnectMetaDialog({ open, onOpenChange, onConnected }: { open: boolean; onOpenChange: (o: boolean) => void; onConnected: () => void }) {
  const [token, setToken] = useState('')
  const [choices, setChoices] = useState<{ accounts: MetaAccountChoice[]; pages: MetaPageChoice[] } | null>(null)
  const [account, setAccount] = useState('')
  const [page, setPage] = useState('')
  useEffect(() => {
    if (!open) { setToken(''); setChoices(null); setAccount(''); setPage('') }
  }, [open])

  const find = useMutation({
    meta: { silent: true },
    mutationFn: () => metaAccounts(token.trim()),
    onSuccess: (r) => { setChoices(r); setAccount(r.accounts[0]?.id ?? ''); setPage(r.pages[0]?.id ?? '') },
  })
  const connect = useMutation({
    meta: { silent: true },
    mutationFn: () => {
      const p = choices?.pages.find((x) => x.id === page)
      return connectMeta({ accessToken: token.trim(), adAccountId: account, pageId: p?.id ?? null, instagramId: p?.instagram?.id ?? null })
    },
    onSuccess: (r) => {
      if (r.sync.ok) toast.success(`Connected ${r.account.name}. Synced the last 30 days (${formatMoney(r.sync.cost ?? 0)}).`)
      else toast.warning(`Connected ${r.account.name}, but the first sync failed: ${r.sync.error}`)
      onConnected()
      onOpenChange(false)
    },
  })
  const step = choices ? 'choose' : 'token'
  const error = (find.error ?? connect.error) as Error | null

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Connect Meta Ads" wide
      description={step === 'token'
        ? 'Paste a long-lived access token (Business Settings → System users → Generate token) with ads_read, and pages_show_list for Page and Instagram details.'
        : 'Choose the ad account to sync. The token is saved encrypted on the server and never shown again.'}
      submitLabel={step === 'token' ? 'Find ad accounts' : 'Connect and sync 30 days'}
      onSubmit={() => (step === 'token' ? find.mutate() : connect.mutate())}
      busy={find.isPending || connect.isPending}
      disabled={step === 'token' ? token.trim().length < 20 : !account}>
      {step === 'token' ? (
        <Field label="Access token" htmlFor="meta-token" required>
          <Input id="meta-token" type="password" autoComplete="off" className="font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
      ) : (
        <>
          <Field label="Ad account" htmlFor="meta-account" required>
            <Select value={account} onValueChange={setAccount}>
              <SelectTrigger id="meta-account" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {choices!.accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} · {a.currency} · {a.id}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Facebook Page" htmlFor="meta-page" hint={choices!.pages.length ? 'Its linked Instagram account is picked up too.' : 'This token cannot list Pages (needs pages_show_list). You can still connect.'}>
            <Select value={page || 'none'} onValueChange={(v) => setPage(v === 'none' ? '' : v)} disabled={!choices!.pages.length}>
              <SelectTrigger id="meta-page" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Page</SelectItem>
                {choices!.pages.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.instagram?.username ? ` · @${p.instagram.username}` : ''}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <button type="button" className="w-fit text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => { setChoices(null); find.reset() }}>Use a different token</button>
        </>
      )}
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error.message}</p>}
      {connect.isPending && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Connecting and syncing the last 30 days…</p>}
      {connect.isSuccess && <p className="flex items-center gap-2 text-sm text-emerald-700"><CircleCheck className="size-4" /> Connected</p>}
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
