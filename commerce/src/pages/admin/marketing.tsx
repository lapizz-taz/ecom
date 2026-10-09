import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Can } from '@/components/common/permission-gate'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, EmptyState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { AttributionReport } from '@/features/marketing/attribution-report'
import { MetaAccounts, MetaAds } from '@/features/marketing/meta-ads'
import { TrackingSetup } from '@/features/marketing/tracking-setup'
import { BarsChart } from '@/features/reports/charts'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatNumber, isoDateToday, toNumber } from '@/lib/format'
import {
  type CampaignPerformance, campaignPerformance, deleteSpend, listCampaigns, listSpend, saveCampaign, saveSpend, type SpendRow,
} from '@/services/marketing'
import type { Enums, Tables } from '@/types/database'

const PLATFORMS: Record<Enums<'marketing_platform'>, string> = { META: 'Meta (Facebook / Instagram)', GOOGLE: 'Google', TIKTOK: 'TikTok', OTHER: 'Other' }
const STATUS_VARIANT = { ACTIVE: 'success', PAUSED: 'warning', ENDED: 'neutral' } as const

const ratio = (v: number | null) => (v === null ? '—' : `${formatNumber(v, 2)}×`)

export default function MarketingPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'overview', campaign: '' })
  const performance = useQuery({ queryKey: ['marketing', 'performance'], queryFn: campaignPerformance })
  const campaigns = useQuery({ queryKey: ['marketing', 'campaigns'], queryFn: listCampaigns })
  const [editingCampaign, setEditingCampaign] = useState<Partial<Tables<'marketing_campaigns'>> | null>(null)
  const [editingSpend, setEditingSpend] = useState<Partial<SpendRow> | null>(null)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['marketing'] })

  const rows = performance.data ?? []
  const total = (k: keyof CampaignPerformance) => rows.reduce((s, r) => s + toNumber(r[k]), 0)
  const spend = total('spend')
  const reportedOrders = total('reported_orders')

  const columns: Column<CampaignPerformance>[] = [
    {
      key: 'name', header: 'Campaign', primary: true,
      cell: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-muted-foreground">{c.platform ? PLATFORMS[c.platform] : ''}{c.utm_campaign ? ` · utm: ${c.utm_campaign}` : ''}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (c) => c.status && <Badge variant={STATUS_VARIANT[c.status]}>{c.status.toLowerCase()}</Badge> },
    { key: 'spend', header: 'Spend', align: 'right', cell: (c) => <Money value={c.spend} /> },
    { key: 'orders', header: 'Orders', align: 'right', cell: (c) => <span title="Reported by the ad platform / attributed via UTM">{formatNumber(c.reported_orders)} / {formatNumber(c.attributed_orders)}</span> },
    { key: 'revenue', header: 'Revenue', align: 'right', hideOnMobile: true, cell: (c) => <Money value={c.reported_revenue} /> },
    { key: 'roas', header: 'ROAS', align: 'right', cell: (c) => ratio(c.roas) },
    { key: 'cpa', header: 'CPA', align: 'right', hideOnMobile: true, cell: (c) => (c.cpa === null ? '—' : <Money value={c.cpa} />) },
    { key: 'cpo', header: 'Cost / order', align: 'right', hideOnMobile: true, cell: (c) => (c.cost_per_order === null ? '—' : <Money value={c.cost_per_order} />) },
    {
      key: 'profit', header: 'Profit after ads', align: 'right',
      cell: (c) => <Money value={c.profit_after_ad_spend} className={toNumber(c.profit_after_ad_spend) < 0 ? 'text-red-600' : 'text-emerald-700'} />,
    },
    {
      key: 'edit', header: '', align: 'right',
      cell: (c) => can('marketing.manage') ? (
        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`}
          onClick={(e) => { e.stopPropagation(); setEditingCampaign(campaigns.data?.find((x) => x.id === c.campaign_id) ?? null) }}><Pencil /></Button>
      ) : null,
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ads & Marketing"
        description="Where orders come from and what they earn after ad spend, product cost and courier charges — from real orders and deliveries, not clicks."
        actions={state.tab === 'campaigns' && (
          <Can permission="marketing.manage">
            <Button size="sm" variant="outline" onClick={() => setEditingCampaign({ platform: 'META', status: 'ACTIVE' })}><Plus /> Campaign</Button>
            <Button size="sm" onClick={() => setEditingSpend({ spend_date: isoDateToday() })} disabled={!campaigns.data?.length}><Plus /> Add spend</Button>
          </Can>
        )}
      />

      <Tabs value={state.tab === 'spend' ? 'campaigns' : state.tab} onValueChange={(v) => update({ tab: v })}>
        <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
          <TabsList>
            <TabsTrigger value="overview">Attribution & profit</TabsTrigger>
            <TabsTrigger value="meta">Meta Ads</TabsTrigger>
            <TabsTrigger value="campaigns">Campaigns & spend</TabsTrigger>
            <TabsTrigger value="tracking">Tracking setup</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview" className="pt-2"><AttributionReport /></TabsContent>
        <TabsContent value="meta" className="pt-2"><MetaAds /></TabsContent>
        <TabsContent value="tracking" className="space-y-4 pt-2"><MetaAccounts /><TrackingSetup /></TabsContent>
        <TabsContent value="campaigns" className="space-y-4 pt-2">
          <p className="text-sm text-muted-foreground">
            Campaigns from other platforms (Google, TikTok…) and spend you enter by hand. Meta campaigns appear here by themselves once Meta Ads
            is connected. Spend is posted to Advertising expenses; the order and revenue figures below are what each platform reports.
          </p>
          {!performance.data ? <CardsSkeleton count={4} /> : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Ad spend (all time)" value={<Money value={spend} />} />
              <StatCard label="Reported ROAS" value={spend > 0 ? ratio(total('reported_revenue') / spend) : '—'} hint={<>on <Money value={total('reported_revenue')} /> platform-reported revenue</>} />
              <StatCard label="Cost per reported order" value={reportedOrders > 0 ? <Money value={spend / reportedOrders} /> : '—'} hint={`${formatNumber(reportedOrders)} reported orders`} />
              <StatCard label="Profit after ad spend" value={<Money value={total('profit_after_ad_spend')} />} tone={total('profit_after_ad_spend') < 0 ? 'negative' : 'positive'}
                hint="gross profit of attributed delivered orders − spend" />
            </div>
          )}
          {rows.some((r) => toNumber(r.spend) > 0) && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Spend vs reported revenue by campaign</CardTitle></CardHeader>
              <CardContent>
                <BarsChart format="money" xKey="name" data={rows.filter((r) => toNumber(r.spend) > 0).slice(0, 12).map((r) => ({ name: r.name, spend: toNumber(r.spend), revenue: toNumber(r.reported_revenue) }))}
                  series={[{ key: 'spend', label: 'Spend', slot: 1 }, { key: 'revenue', label: 'Reported revenue', slot: 2 }]} />
              </CardContent>
            </Card>
          )}
          <DataTable columns={columns} rows={performance.data} rowKey={(c) => c.campaign_id ?? c.name ?? ''} loading={performance.isFetching} error={performance.error}
            onRetry={() => performance.refetch()} onRowClick={(c) => update({ tab: 'spend', campaign: c.campaign_id ?? '' })}
            empty={<EmptyState icon={<Megaphone className="size-5" />} title="No campaigns yet" description="Create a campaign, then log its daily spend." />} />
          {(state.tab === 'spend' || state.campaign) && <SpendList campaigns={campaigns.data ?? []} onEdit={setEditingSpend} onChanged={refresh} />}
          {state.tab !== 'spend' && !state.campaign && (
            <Button variant="outline" size="sm" onClick={() => update({ tab: 'spend' })}>Show daily spend</Button>
          )}
        </TabsContent>
      </Tabs>

      <CampaignDialog value={editingCampaign} onClose={() => setEditingCampaign(null)} onSaved={refresh} />
      <SpendDialog value={editingSpend} campaigns={campaigns.data ?? []} onClose={() => setEditingSpend(null)} onSaved={refresh} />
    </div>
  )
}

function SpendList({ campaigns, onEdit, onChanged }: { campaigns: Tables<'marketing_campaigns'>[]; onEdit: (s: SpendRow) => void; onChanged: () => void }) {
  const { can } = useAuth()
  const [state, update] = useUrlState({ campaign: '' })
  const spend = useQuery({ queryKey: ['marketing', 'spend', state.campaign], queryFn: () => listSpend(state.campaign || undefined) })
  const remove = useMutation({
    mutationFn: (id: string) => deleteSpend(id),
    onSuccess: () => { toast.success('Spend entry deleted; the advertising expense was corrected'); onChanged() },
  })
  const columns: Column<SpendRow>[] = [
    { key: 'date', header: 'Date', cell: (s) => formatDate(s.spend_date) },
    { key: 'campaign', header: 'Campaign', primary: true, cell: (s) => <span className="font-medium">{s.marketing_campaigns?.name}</span> },
    { key: 'spend', header: 'Spend', align: 'right', cell: (s) => <Money value={s.spend} /> },
    { key: 'impr', header: 'Impressions', align: 'right', hideOnMobile: true, cell: (s) => formatNumber(s.impressions) },
    { key: 'clicks', header: 'Clicks', align: 'right', hideOnMobile: true, cell: (s) => formatNumber(s.clicks) },
    { key: 'orders', header: 'Orders', align: 'right', cell: (s) => formatNumber(s.orders) },
    { key: 'revenue', header: 'Revenue', align: 'right', cell: (s) => <Money value={s.revenue} /> },
    { key: 'roas', header: 'ROAS', align: 'right', hideOnMobile: true, cell: (s) => (toNumber(s.spend) > 0 ? ratio(toNumber(s.revenue) / toNumber(s.spend)) : '—') },
    {
      key: 'actions', header: '', align: 'right',
      cell: (s) => can('marketing.manage') ? (
        <div className="flex justify-end gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => onEdit(s)}><Pencil /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={() => confirm('Delete this spend entry? The advertising expense will be reversed.') && remove.mutate(s.id)}><Trash2 /></Button>
        </div>
      ) : null,
    },
  ]
  return (
    <div className="space-y-3">
      <Select value={state.campaign || 'all'} onValueChange={(v) => update({ campaign: v === 'all' ? '' : v })}>
        <SelectTrigger size="sm" className="w-56"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All campaigns</SelectItem>
          {campaigns.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <DataTable columns={columns} rows={spend.data} rowKey={(s) => s.id} loading={spend.isFetching} error={spend.error} onRetry={() => spend.refetch()}
        empty={<EmptyState title="No spend logged" description="Add each day's spend from the ad platform's dashboard." />} />
    </div>
  )
}

const campaignSchema = z.object({
  platform: z.enum(['META', 'GOOGLE', 'TIKTOK', 'OTHER']),
  name: z.string().trim().min(2, 'Name is required'),
  utm_campaign: z.string().trim().max(120).regex(/^[\w.-]*$/, 'Letters, numbers, dots, dashes and underscores only'),
  status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']),
  start_date: z.string(),
  end_date: z.string(),
  budget: z.union([z.literal(''), z.coerce.number<string>().min(0)]),
  notes: z.string(),
}).refine((v) => !v.start_date || !v.end_date || v.end_date >= v.start_date, { path: ['end_date'], message: 'End date is before the start date' })

function CampaignDialog({ value, onClose, onSaved }: { value: Partial<Tables<'marketing_campaigns'>> | null; onClose: () => void; onSaved: () => void }) {
  type V = z.input<typeof campaignSchema>
  const form = useForm<V, unknown, z.output<typeof campaignSchema>>({ resolver: zodResolver(campaignSchema) })
  useEffect(() => {
    if (value) form.reset({
      platform: value.platform ?? 'META', name: value.name ?? '', utm_campaign: value.utm_campaign ?? '', status: value.status ?? 'ACTIVE',
      start_date: value.start_date ?? '', end_date: value.end_date ?? '', budget: value.budget === null || value.budget === undefined ? '' : String(value.budget), notes: value.notes ?? '',
    })
  }, [value, form])
  const save = useMutation({
    mutationFn: (v: z.output<typeof campaignSchema>) => saveCampaign({
      id: value?.id, platform: v.platform, name: v.name, utm_campaign: v.utm_campaign || null, status: v.status,
      start_date: v.start_date || null, end_date: v.end_date || null, budget: v.budget === '' ? null : v.budget, notes: v.notes.trim() || null,
    }),
    onSuccess: () => { toast.success('Campaign saved'); onClose(); onSaved() },
  })
  const e = form.formState.errors
  return (
    <FormDialog open={value !== null} onOpenChange={(o) => !o && onClose()} title={value?.id ? 'Edit campaign' : 'New campaign'} submitLabel="Save"
      busy={save.isPending} onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Platform">
          <Controller control={form.control} name="platform" render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(PLATFORMS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
            </Select>
          )} />
        </Field>
        <Field label="Status">
          <Controller control={form.control} name="status" render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="ACTIVE">Active</SelectItem><SelectItem value="PAUSED">Paused</SelectItem><SelectItem value="ENDED">Ended</SelectItem></SelectContent>
            </Select>
          )} />
        </Field>
      </div>
      <Field label="Name" htmlFor="cmp-name" required error={e.name?.message}><Input id="cmp-name" {...form.register('name')} /></Field>
      <Field label="UTM campaign" htmlFor="cmp-utm" error={e.utm_campaign?.message}
        hint="Use this value as utm_campaign in ad links. Orders placed from those links are attributed to this campaign.">
        <Input id="cmp-utm" placeholder="eid-sale-2026" {...form.register('utm_campaign')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Start" htmlFor="cmp-start"><Input id="cmp-start" type="date" {...form.register('start_date')} /></Field>
        <Field label="End" htmlFor="cmp-end" error={e.end_date?.message}><Input id="cmp-end" type="date" {...form.register('end_date')} /></Field>
        <Field label="Budget" htmlFor="cmp-budget" error={e.budget?.message}><Input id="cmp-budget" type="number" min="0" step="0.01" {...form.register('budget')} /></Field>
      </div>
      <Field label="Notes" htmlFor="cmp-notes"><Textarea id="cmp-notes" rows={2} {...form.register('notes')} /></Field>
    </FormDialog>
  )
}

const optionalInt = z.union([z.literal(''), z.coerce.number<string>().int().min(0)])
const spendSchema = z.object({
  campaign_id: z.string().min(1, 'Choose a campaign'),
  spend_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'),
  spend: z.coerce.number<string>().min(0, 'Spend cannot be negative'),
  impressions: optionalInt,
  clicks: optionalInt,
  orders: z.coerce.number<string>().int().min(0),
  revenue: z.coerce.number<string>().min(0),
  notes: z.string(),
})

function SpendDialog({ value, campaigns, onClose, onSaved }: { value: Partial<SpendRow> | null; campaigns: Tables<'marketing_campaigns'>[]; onClose: () => void; onSaved: () => void }) {
  type V = z.input<typeof spendSchema>
  const form = useForm<V, unknown, z.output<typeof spendSchema>>({ resolver: zodResolver(spendSchema) })
  const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))
  useEffect(() => {
    if (value) form.reset({
      campaign_id: value.campaign_id ?? campaigns.find((c) => c.status === 'ACTIVE')?.id ?? '', spend_date: value.spend_date ?? isoDateToday(),
      spend: str(value.spend), impressions: str(value.impressions), clicks: str(value.clicks), orders: str(value.orders ?? 0), revenue: str(value.revenue ?? 0), notes: value.notes ?? '',
    })
  }, [value, campaigns, form])
  const save = useMutation({
    mutationFn: (v: z.output<typeof spendSchema>) => saveSpend({
      campaign_id: v.campaign_id, spend_date: v.spend_date, spend: v.spend, orders: v.orders, revenue: v.revenue,
      impressions: v.impressions === '' ? null : v.impressions, clicks: v.clicks === '' ? null : v.clicks, notes: v.notes.trim() || null,
    }),
    onSuccess: () => { toast.success('Spend saved and posted to Advertising expenses'); onClose(); onSaved() },
  })
  const e = form.formState.errors
  return (
    <FormDialog open={value !== null} onOpenChange={(o) => !o && onClose()} title={value?.id ? 'Edit spend' : 'Log ad spend'} submitLabel="Save"
      description="One entry per campaign per day — saving the same day again updates it." busy={save.isPending} onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Campaign" required error={e.campaign_id?.message}>
          <Controller control={form.control} name="campaign_id" render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange} disabled={!!value?.id}>
              <SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
              <SelectContent>{campaigns.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          )} />
        </Field>
        <Field label="Date" htmlFor="sp-date" required error={e.spend_date?.message}><Input id="sp-date" type="date" max={isoDateToday()} disabled={!!value?.id} {...form.register('spend_date')} /></Field>
        <Field label="Spend" htmlFor="sp-spend" required error={e.spend?.message}><Input id="sp-spend" type="number" min="0" step="0.01" {...form.register('spend')} /></Field>
        <Field label="Revenue reported" htmlFor="sp-rev" error={e.revenue?.message}><Input id="sp-rev" type="number" min="0" step="0.01" {...form.register('revenue')} /></Field>
        <Field label="Orders reported" htmlFor="sp-orders" error={e.orders?.message}><Input id="sp-orders" type="number" min="0" step="1" {...form.register('orders')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Impressions" htmlFor="sp-impr"><Input id="sp-impr" type="number" min="0" {...form.register('impressions')} /></Field>
          <Field label="Clicks" htmlFor="sp-clicks"><Input id="sp-clicks" type="number" min="0" {...form.register('clicks')} /></Field>
        </div>
      </div>
      <Field label="Notes" htmlFor="sp-notes"><Textarea id="sp-notes" rows={2} {...form.register('notes')} /></Field>
    </FormDialog>
  )
}
