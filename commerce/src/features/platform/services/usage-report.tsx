import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { Link } from 'react-router'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { usePlatform } from '@/features/platform/platform-context'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { rangeFor } from '@/lib/dates'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { type Service, usageReport } from '@/services/credits'

const STATUS = { RESERVED: 'info', SUCCEEDED: 'success', FAILED: 'danger', DENIED: 'warning' } as const
const REASON: Record<string, string> = {
  NO_CREDITS: 'No credits', LIMIT_REACHED: 'Monthly cap reached', FEATURE_OFF: 'Feature off', ACCOUNT_RESTRICTED: 'Account restricted',
  FREE_LIMIT_REACHED: 'Free allowance used up',
}

/**
 * Attempted (allowed and sent to the provider), refused by policy, done,
 * failed (refunded), delivered (SMS), free, paid in credits — kept apart.
 */
export function UsageReportPanel({ service, merchant }: { service: Service; merchant?: string }) {
  const { can } = usePlatform()
  const initial = rangeFor('30d')
  const [range, setRange] = useUrlState({ from: initial.from, to: initial.to })
  const report = useQuery({
    queryKey: ['platform-usage', service, range.from, range.to, merchant ?? null], placeholderData: keepPreviousData,
    queryFn: () => usageReport(service, range.from, range.to, merchant),
  })
  const sms = service === 'SMS'
  const unit = sms ? 'SMS' : 'lookups'
  const exportCsv = () => report.data && downloadCsv(`${service.toLowerCase()}-usage-${range.from}-${range.to}.csv`, report.data.merchants, [
    { header: 'Merchant', value: (m) => `#${m.number} ${m.name}` },
    { header: 'Attempted', value: (m) => m.attempted },
    { header: 'Refused', value: (m) => m.denied },
    { header: 'Succeeded', value: (m) => m.succeeded },
    { header: 'Failed (refunded)', value: (m) => m.failed },
    ...(sms ? [{ header: 'Delivered', value: (m: { delivered: number }) => m.delivered }, { header: 'Undelivered', value: (m: { undelivered: number }) => m.undelivered }] : []),
    { header: 'Units used', value: (m) => m.units },
    { header: 'Free', value: (m) => m.free_units },
    { header: 'Unmetered', value: (m) => m.plan_units },
    { header: 'Credits charged', value: (m) => m.credits },
    { header: 'Provider cost (reported)', value: (m) => m.provider_cost },
    { header: 'Provider cost (estimated)', value: (m) => m.estimated_cost },
  ])
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DateRangeFilter value={range} onChange={(r) => setRange({ from: r.from, to: r.to })} />
        {(can('usage', 'export') || can(sms ? 'sms' : 'bd_courier', 'export')) && report.data && (
          <Button size="sm" variant="outline" onClick={exportCsv}><Download /> Export CSV</Button>
        )}
      </div>
      {report.error ? <ErrorState error={report.error} onRetry={() => report.refetch()} /> : !report.data ? <LoadingState /> : (() => {
        const t = report.data.totals
        return (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label={`Attempted ${unit}`} value={formatNumber(t.attempted ?? 0)} hint={`${formatNumber(t.denied ?? 0)} refused by policy (not attempted)`} />
              <StatCard label="Succeeded" value={formatNumber(t.succeeded ?? 0)} hint={`${formatNumber(t.failed ?? 0)} failed and refunded · ${formatNumber(t.in_progress ?? 0)} in progress`} />
              {sms
                ? <StatCard label="Delivered" value={formatNumber(t.delivered ?? 0)} hint={`${formatNumber(t.undelivered ?? 0)} reported undelivered; others had no report`} />
                : <StatCard label="Merchants using it" value={formatNumber(t.merchants ?? 0)} />}
              <StatCard label="Billable" value={`${formatNumber(t.credits ?? 0)} credits`}
                hint={`${formatNumber(t.free_units ?? 0)} free · ${formatNumber(t.plan_units ?? 0)} unmetered · ${formatNumber(t.credits_refunded ?? 0)} credits refunded`} />
              <StatCard label="Provider cost" value={formatMoney((t.provider_cost ?? 0) + (t.estimated_cost ?? 0))}
                hint={`${formatMoney(t.provider_cost ?? 0)} reported by the provider + ${formatMoney(t.estimated_cost ?? 0)} estimated${sms ? ' (parts × cost per part)' : ''}`} />
            </div>
            {Object.keys(report.data.denied_reasons).length > 0 && (
              <p className="text-xs text-muted-foreground">Refused: {Object.entries(report.data.denied_reasons).map(([k, v]) => `${REASON[k] ?? k} ${v}`).join(' · ')}</p>
            )}
            <Card>
              <CardHeader><CardTitle className="text-sm">By day</CardTitle></CardHeader>
              <CardContent className="h-56">
                {report.data.daily.length === 0 ? <EmptyState title="Nothing in this range" /> : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={report.data.daily} margin={{ left: -20, right: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
                      <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip cursor={{ fill: 'rgba(127,127,127,0.12)' }} contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="succeeded" name="Succeeded" stackId="a" fill="#10b981" />
                      <Bar dataKey="failed" name="Failed" stackId="a" fill="#ef4444" />
                      <Bar dataKey="denied" name="Refused" stackId="a" fill="#f59e0b" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            {!merchant && (
              <Card className="gap-0 overflow-hidden py-0">
                <p className="border-b px-4 py-2 text-sm font-medium">By merchant</p>
                {report.data.merchants.length === 0 ? <EmptyState title="No use in this range" /> : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Merchant</TableHead><TableHead className="text-right">Attempted</TableHead><TableHead className="text-right">Refused</TableHead>
                        <TableHead className="text-right">Failed</TableHead>{sms && <TableHead className="text-right">Delivered</TableHead>}
                        <TableHead className="text-right">Free</TableHead><TableHead className="text-right">Credits</TableHead><TableHead className="text-right">Provider cost</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {report.data.merchants.map((m) => (
                          <TableRow key={m.merchant_id}>
                            <TableCell className="text-xs"><Link className="underline" to={`/super-admin/merchants/${m.merchant_id}?tab=credits`}>#{m.number} {m.name}</Link></TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(m.attempted)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(m.denied)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(m.failed)}</TableCell>
                            {sms && <TableCell className="text-right tabular-nums">{formatNumber(m.delivered)}</TableCell>}
                            <TableCell className="text-right tabular-nums">{formatNumber(m.free_units)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(m.credits)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatMoney(Number(m.provider_cost) + Number(m.estimated_cost))}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Card>
            )}
            <Card className="gap-0 overflow-hidden py-0">
              <p className="border-b px-4 py-2 text-sm font-medium">{sms ? 'Recent messages' : 'Request history'} <span className="font-normal text-muted-foreground">(last 100; numbers masked)</span></p>
              {report.data.recent.length === 0 ? <EmptyState title="Nothing yet" /> : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>When</TableHead>{!merchant && <TableHead>Merchant</TableHead>}<TableHead>{sms ? 'To' : 'Number'}</TableHead><TableHead>Result</TableHead><TableHead>Paid with</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {report.data.recent.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.created_at)}</TableCell>
                          {!merchant && <TableCell className="text-xs">#{r.merchant.number} {r.merchant.name}</TableCell>}
                          <TableCell className="font-mono text-xs">{r.reference ?? '—'}</TableCell>
                          <TableCell>
                            <Badge variant={STATUS[r.status as keyof typeof STATUS] ?? 'neutral'}>{r.status === 'DENIED' ? 'refused' : r.status === 'RESERVED' ? 'in progress' : r.status.toLowerCase()}</Badge>
                            {r.outcome && <Badge variant={r.outcome === 'DELIVERED' ? 'success' : 'warning'} className="ml-1">{r.outcome.toLowerCase()}</Badge>}
                          </TableCell>
                          <TableCell className="text-xs">{r.status === 'DENIED' ? '—' : r.charge === 'CREDITS' ? `${r.credits} credits${r.refunded ? ' (refunded)' : ''}` : r.charge === 'PLAN' ? 'unmetered' : r.charge.toLowerCase()}</TableCell>
                          <TableCell className="max-w-64 truncate text-xs text-muted-foreground">{r.reason ? REASON[r.reason] ?? r.reason : r.error ?? ''}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          </>
        )
      })()}
    </div>
  )
}
