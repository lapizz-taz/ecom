import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { formatNumber } from '@/lib/format'
import { listOrderSources, type OrderSource, orderSourceStats, saveOrderSource, SOURCE_CHANNELS } from '@/services/orders'

const channelLabel = (c: string) => SOURCE_CHANNELS.find((x) => x.value === c)?.label ?? (c === 'unknown' ? 'Unknown' : c.replace(/_/g, ' '))
const PERIODS = [{ v: '30', l: '30 days' }, { v: '90', l: '90 days' }, { v: '365', l: '12 months' }, { v: '0', l: 'All time' }]

export function OrderSourcesSettings() {
  const { can } = useAuth()
  const canEdit = can('settings.manage')
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ['order-sources', 'all'], queryFn: () => listOrderSources(true) })
  const [label, setLabel] = useState('')
  const [channel, setChannel] = useState('messaging')
  const save = useMutation({
    mutationFn: saveOrderSource,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['order-sources'] }),
  })
  const add = () => save.mutate({ label: label.trim(), channel }, { onSuccess: () => { toast.success(`${label.trim()} added`); setLabel('') } })
  const rows = list.data ?? []
  const move = (i: number, dir: -1 | 1) => {
    const a = rows[i]
    const b = rows[i + dir]
    if (!a || !b) return
    // Swap positions; give distinct values when two share a number.
    const [pa, pb] = a.sort_order === b.sort_order ? [b.sort_order + dir, a.sort_order] : [b.sort_order, a.sort_order]
    save.mutate({ code: a.code, sort_order: pa })
    save.mutate({ code: b.code, sort_order: pb })
  }

  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Order sources</CardTitle>
          <CardDescription>What staff choose for "where did this order come from" on phone, chat and walk-in orders. Website and Shopify orders are tracked automatically.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : (
            <ul className="divide-y rounded-lg border">
              {rows.map((s, i) => <SourceRow key={s.code} s={s} first={i === 0} last={i === rows.length - 1} canEdit={canEdit} busy={save.isPending}
                onMove={(d) => move(i, d)} onSave={(p) => save.mutate({ code: s.code, ...p })} />)}
            </ul>
          )}
          {canEdit && (
            <form className="grid gap-2 sm:grid-cols-[1fr_180px_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (label.trim().length >= 2) add() }}>
              <Field label="New source" htmlFor="src-label"><Input id="src-label" value={label} maxLength={40} placeholder="e.g. TikTok Live, Daraz, Pop-up shop" onChange={(e) => setLabel(e.target.value)} /></Field>
              <Field label="Counts as">
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{SOURCE_CHANNELS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Button type="submit" disabled={label.trim().length < 2 || save.isPending}>{save.isPending ? <Spinner /> : <Plus />} Add</Button>
            </form>
          )}
        </CardContent>
      </Card>
      <SourcePerformance />
    </div>
  )
}

function SourceRow({ s, first, last, canEdit, busy, onMove, onSave }: {
  s: OrderSource; first: boolean; last: boolean; canEdit: boolean; busy: boolean; onMove: (d: -1 | 1) => void; onSave: (p: Partial<OrderSource>) => void
}) {
  const [label, setLabel] = useState(s.label)
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <div className="flex flex-col">
        <button type="button" disabled={!canEdit || first || busy} onClick={() => onMove(-1)} aria-label={`Move ${s.label} up`} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
        <button type="button" disabled={!canEdit || last || busy} onClick={() => onMove(1)} aria-label={`Move ${s.label} down`} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowDown className="size-3.5" /></button>
      </div>
      <Input value={label} disabled={!canEdit} onChange={(e) => setLabel(e.target.value)} aria-label="Source name"
        onBlur={() => { if (label.trim().length >= 2 && label.trim() !== s.label) onSave({ label: label.trim() }) }}
        className={`h-8 min-w-36 flex-1 ${s.is_active ? '' : 'text-muted-foreground line-through'}`} />
      <Select value={s.channel} disabled={!canEdit} onValueChange={(v) => onSave({ channel: v })}>
        <SelectTrigger className="h-8 w-40" aria-label="Counts as"><SelectValue /></SelectTrigger>
        <SelectContent>{SOURCE_CHANNELS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
      </Select>
      <Switch checked={s.is_active} disabled={!canEdit} onCheckedChange={(v) => onSave({ is_active: v })} aria-label={s.is_active ? `Hide ${s.label}` : `Show ${s.label}`} />
    </li>
  )
}

function SourcePerformance() {
  const [days, setDays] = useState('30')
  const stats = useQuery({ queryKey: ['order-source-stats', days], queryFn: () => orderSourceStats(Number(days)) })
  const rows = stats.data ?? []
  const total = rows.reduce((n, r) => n + r.orders, 0)
  const KIND = { manual: { label: 'Staff', variant: 'neutral' }, tracked: { label: 'Tracked', variant: 'info' }, none: { label: 'Unattributed', variant: 'warning' } } as const
  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Orders by source</CardTitle>
          <CardDescription>Staff-picked sources, tracked website visits, and orders with no source data (shown as Unattributed — never guessed).</CardDescription>
        </div>
        <Tabs value={days} onValueChange={setDays}>
          <TabsList>{PERIODS.map((p) => <TabsTrigger key={p.v} value={p.v}>{p.l}</TabsTrigger>)}</TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {stats.isLoading ? <LoadingState /> : stats.error ? <ErrorState error={stats.error} onRetry={() => stats.refetch()} /> : !rows.length ? (
          <EmptyState title="No orders in this period" />
        ) : (
          <div className="-mx-2 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Source</TableHead><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">Delivered</TableHead>
                  <TableHead className="text-right">Returned</TableHead><TableHead className="text-right">Cancelled</TableHead><TableHead className="text-right">Delivered value</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const done = r.delivered + r.returned
                  return (
                    <TableRow key={`${r.kind}-${r.label}-${r.channel}`}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{r.label}</span>
                          {r.kind === 'tracked' && r.channel === 'unknown'
                            ? <Badge variant="warning" title="A website visit was recorded but it carried no source">No source data</Badge>
                            : <Badge variant={KIND[r.kind].variant}>{KIND[r.kind].label}</Badge>}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-brand" style={{ width: `${total ? (r.orders / total) * 100 : 0}%` }} /></span>
                          {channelLabel(r.channel)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(r.orders)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(r.delivered)}{done > 0 && <span className="block text-xs text-muted-foreground">{Math.round((r.delivered / done) * 100)}% success</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(r.returned)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(r.cancelled)}</TableCell>
                      <TableCell className="text-right"><Money value={r.delivered_value} /></TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
