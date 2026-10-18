// Super Admin → Income & Expenses: Fullfilio's own books, like a store's
// Income & Expense page. Money merchants pay the platform comes in by itself
// (from billing), Meta ad spend comes in from connected ad accounts, and the
// team records everything else by hand.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart3, CheckCircle2, CircleAlert, Link2, Megaphone, Pencil, Plus, RefreshCw, Search, Settings2, Store, Trash2, TrendingDown, TrendingUp, Unplug, Wallet,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { COLOR_NAMES, colorOf } from '@/features/finance/category-colors'
import { usePlatform } from '@/features/platform/platform-context'
import { BarsChart } from '@/features/reports/charts'
import { useDateRange } from '@/hooks/use-date-range'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatDateTime, formatMoney, formatNumber, toNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  type AdAccountInput, deleteEntry, disconnectAdAccount, type EntryInput, type EntrySource, type FinanceType, platformAdAccounts, type PlatformAdAccount,
  platformCategories, type PlatformCategory, platformEntries, type PlatformEntry, type PlatformLedger, platformLedger, platformOverview, saveAdAccount,
  saveCategory, saveEntry, syncAdAccounts, testAdAccount,
} from '@/services/platform-finance'

type Tab = 'overview' | 'expense' | 'income' | 'ads' | 'categories'
const TABS: Array<{ key: Tab; label: string; icon: typeof Wallet }> = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'expense', label: 'Expenses', icon: TrendingDown },
  { key: 'income', label: 'Income', icon: TrendingUp },
  { key: 'ads', label: 'Ad accounts', icon: Megaphone },
  { key: 'categories', label: 'Categories', icon: Settings2 },
]
const PAGE_SIZE = 25
const SOURCE_LABEL: Record<EntrySource, string> = { MANUAL: 'Recorded', META_ADS: 'Meta ads', BILLING: 'Merchant payment' }
const usd = (v: number | null | undefined, currency = 'USD') =>
  v == null ? '—' : `${currency === 'USD' ? '$' : `${currency} `}${toNumber(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date())
const fail = (e: unknown) => toast.error((e as Error).message)

export default function PlatformFinancePage() {
  const { can } = usePlatform()
  const create = can('finance', 'create')
  const [range, setRange] = useDateRange('30d')
  const [state, update] = useUrlState({ tab: 'overview', cat: '', source: '', q: '', page: '1', voided: '' })
  const tab = (TABS.some((t) => t.key === state.tab) ? state.tab : 'overview') as Tab
  const [dialog, setDialog] = useState<{ type: FinanceType; entry?: PlatformEntry } | null>(null)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Income & Expenses"
        description="Fullfilio's own money. Merchant payments and Meta ad spend come in by themselves (marked Auto); record salaries, servers and everything else here."
        actions={create && (
          <>
            <Button size="sm" variant={tab === 'income' ? 'outline' : 'default'} onClick={() => setDialog({ type: 'EXPENSE' })}><Plus /> New expense</Button>
            <Button size="sm" variant={tab === 'income' ? 'default' : 'outline'} onClick={() => setDialog({ type: 'INCOME' })}><Plus /> New income</Button>
          </>
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border bg-card p-1" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              onClick={() => update({ tab: t.key, cat: '', source: '', page: '1' })}
              className={cn('press flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
                tab === t.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              <t.icon className="size-3.5" /> {t.label}
            </button>
          ))}
        </div>
        {tab !== 'categories' && tab !== 'ads' && <DateRangeFilter value={range} onChange={setRange} />}
      </div>

      {tab === 'overview' && <OverviewTab from={range.from} to={range.to} onTab={(t) => update({ tab: t, page: '1' })} />}
      {(tab === 'expense' || tab === 'income') && (
        <LedgerTab type={tab === 'income' ? 'INCOME' : 'EXPENSE'} from={range.from} to={range.to} state={state} update={update}
          onEdit={(entry) => setDialog({ type: entry.type, entry })} />
      )}
      {tab === 'ads' && <AdAccountsTab />}
      {tab === 'categories' && <CategoriesTab />}

      {dialog && <EntryDialog type={dialog.type} entry={dialog.entry} onClose={() => setDialog(null)} />}
    </div>
  )
}

// ------------------------------------------------------------------ overview
function OverviewTab({ from, to, onTab }: { from: string; to: string; onTab: (t: Tab) => void }) {
  const overview = useQuery({ queryKey: ['platform-finance', 'overview', from, to], queryFn: () => platformOverview(from, to), placeholderData: keepPreviousData })
  const o = overview.data
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
  if (!o) return <CardsSkeleton count={4} />
  const net = toNumber(o.income) - toNumber(o.expense)
  const top = (t: FinanceType) => o.by_category.filter((c) => c.type === t).slice(0, 8)
  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 lg:grid-cols-5 [&>*]:min-w-0">
        <Kpi label="Income" value={<Money value={o.income} />} hint={`${formatNumber(o.income_count)} entries`} tone="text-emerald-600" icon={TrendingUp} onClick={() => onTab('income')} />
        <Kpi label="Expenses" value={<Money value={o.expense} />} hint={`${formatNumber(o.expense_count)} entries`} tone="text-red-600" icon={TrendingDown} onClick={() => onTab('expense')} />
        <Kpi label="Net" value={<Money value={net} signed />} hint="income − expenses" tone={net < 0 ? 'text-red-600' : 'text-emerald-600'} icon={Wallet} />
        <Kpi label="From merchants" value={<Money value={o.merchant_income} />} hint="subscriptions, credits, PBX" icon={Store} onClick={() => onTab('income')} />
        <Kpi label="Ad spend" value={<Money value={o.ads} />} hint={o.ads_usd ? `${usd(o.ads_usd)} on Meta` : 'connect an ad account'} icon={Megaphone} onClick={() => onTab('ads')} />
      </section>
      <Card>
        <CardHeader><CardTitle className="text-sm">Income and expenses by day</CardTitle></CardHeader>
        <CardContent>
          <BarsChart data={o.series} xKey="date" dateAxis format="money" height={260}
            series={[{ key: 'income', label: 'Income', slot: 2 }, { key: 'expense', label: 'Expenses', slot: 4 }]} />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        {(['EXPENSE', 'INCOME'] as const).map((t) => (
          <Card key={t}>
            <CardHeader><CardTitle className="text-sm">Top {t === 'EXPENSE' ? 'expenses' : 'income'}</CardTitle></CardHeader>
            <CardContent className="space-y-2.5">
              {top(t).length === 0 ? <p className="text-sm text-muted-foreground">Nothing in this period.</p> : top(t).map((c) => {
                const max = toNumber(top(t)[0].total) || 1
                const tone = colorOf(c.color)
                return (
                  <div key={c.name} className="grid gap-1">
                    <div className="flex justify-between gap-2 text-sm"><span className="flex min-w-0 items-center gap-1.5 truncate"><span className={cn('size-2 shrink-0 rounded-full', tone.dot)} />{c.name}</span><Money value={c.total} className="tabular-nums" /></div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', tone.dot)} style={{ width: `${(100 * toNumber(c.total)) / max}%` }} /></div>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader><CardTitle className="text-sm">By month</CardTitle></CardHeader>
          <CardContent className="p-0">
            {o.by_month.length === 0 ? <p className="px-6 pb-4 text-sm text-muted-foreground">Nothing in this period.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-xs text-muted-foreground"><th className="px-4 py-2 text-left font-medium">Month</th><th className="px-4 py-2 text-right font-medium">Income</th><th className="px-4 py-2 text-right font-medium">Expenses</th><th className="px-4 py-2 text-right font-medium">Net</th></tr></thead>
                  <tbody>
                    {o.by_month.map((m) => {
                      const n = toNumber(m.income) - toNumber(m.expense)
                      return (
                        <tr key={m.month} className="border-t">
                          <td className="px-4 py-2 whitespace-nowrap">{new Date(`${m.month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatMoney(m.income)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatMoney(m.expense)}</td>
                          <td className={cn('px-4 py-2 text-right font-medium tabular-nums', n < 0 ? 'text-red-600' : 'text-emerald-600')}>{formatMoney(n)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Kpi({ label, value, hint, tone, icon: Icon, onClick }: { label: string; value: React.ReactNode; hint: string; tone?: string; icon: typeof Wallet; onClick?: () => void }) {
  const body = (
    <>
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"><Icon className="size-3.5" />{label}</p>
      <p className={cn('mt-1 truncate text-xl font-semibold tabular-nums', tone)}>{value}</p>
      <p className="truncate text-xs text-muted-foreground">{hint}</p>
    </>
  )
  return onClick
    ? <button type="button" onClick={onClick} className="press rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/25">{body}</button>
    : <div className="rounded-xl border bg-card p-4">{body}</div>
}

// ------------------------------------------------------------------ expenses / income
type LedgerState = Record<'cat' | 'source' | 'q' | 'page' | 'voided', string>
type Update = (patch: Partial<Record<string, string>>, opts?: { resetPage?: boolean }) => void

function LedgerTab({ type, from, to, state, update, onEdit }: {
  type: FinanceType; from: string; to: string; state: LedgerState; update: Update; onEdit: (e: PlatformEntry) => void
}) {
  const ledger = useQuery({ queryKey: ['platform-finance', 'ledger', type, from, to], queryFn: () => platformLedger(type, from, to), placeholderData: keepPreviousData })
  const L = ledger.data
  const active = useMemo(() => (L?.categories ?? []).filter((c) => toNumber(c.total) !== 0), [L])
  const [day, setDay] = useState<string | null>(null)
  if (ledger.error) return <ErrorState error={ledger.error} onRetry={() => ledger.refetch()} />
  if (!L) return <CardsSkeleton count={8} />
  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 [&>*]:min-w-0">
        <SummaryCard label={type === 'EXPENSE' ? 'Total spent' : 'Total received'} value={<Money value={L.total} />}
          hint={`${formatNumber(L.count)} entries${L.usd_total ? ` · ${usd(L.usd_total)}` : ''}`} icon={type === 'EXPENSE' ? TrendingDown : TrendingUp}
          active={!state.cat} onClick={() => update({ cat: '' })} strong />
        {active.map((c) => (
          <SummaryCard key={c.id} label={c.name} value={<Money value={c.total} />} hint={`${c.count} entr${c.count === 1 ? 'y' : 'ies'}${c.manual ? '' : ' · auto'}`}
            dot={colorOf(c.color).dot} active={state.cat === c.id} onClick={() => update({ cat: state.cat === c.id ? '' : c.id })} />
        ))}
      </section>
      <Matrix ledger={L} categories={active} selectedCat={state.cat} onCell={(date, cat) => { setDay(date); update({ cat: cat ?? '' }) }} />
      <Entries type={type} from={day ?? from} to={day ?? to} day={day} onClearDay={() => setDay(null)} categories={L.categories}
        state={state} update={update} onEdit={onEdit} />
    </div>
  )
}

function SummaryCard({ label, value, hint, icon: Icon, dot, active, onClick, strong }: {
  label: string; value: React.ReactNode; hint: string; icon?: typeof Wallet; dot?: string; active: boolean; onClick: () => void; strong?: boolean
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('press grid gap-1 rounded-xl border bg-card p-3 text-left transition-colors hover:border-foreground/25',
        active && 'border-foreground/50 ring-1 ring-foreground/20', strong && 'bg-foreground/[0.03]')}>
      <span className="flex items-center gap-1.5 truncate text-xs font-medium text-muted-foreground">
        {Icon ? <Icon className="size-3.5" /> : <span className={cn('size-2 shrink-0 rounded-full', dot)} />}
        <span className="truncate uppercase tracking-wide">{label}</span>
      </span>
      <span className={cn('truncate font-semibold tabular-nums', strong ? 'text-lg' : 'text-base')}>{value}</span>
      <span className="truncate text-[11px] text-muted-foreground">{hint}</span>
    </button>
  )
}

/** Days down, categories across; each cell is that day's total for the category. */
function Matrix({ ledger, categories, selectedCat, onCell }: {
  ledger: PlatformLedger; categories: PlatformLedger['categories']; selectedCat: string; onCell: (date: string, cat: string | null) => void
}) {
  if (!ledger.days.length) return <Card><CardContent className="py-10"><EmptyState title="Nothing recorded in this period" description="Pick a longer range or add an entry." /></CardContent></Card>
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="sticky left-0 z-30 border-b bg-card px-3 py-2.5 text-left text-xs font-medium text-muted-foreground">Date</th>
              {categories.map((c) => (
                <th key={c.id} className={cn('min-w-32 border-b bg-card px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap', selectedCat === c.id ? 'text-foreground' : 'text-muted-foreground')}>
                  <span className="inline-flex items-center gap-1.5"><span className={cn('size-2 rounded-full', colorOf(c.color).dot)} />{c.name}</span>
                </th>
              ))}
              <th className="sticky right-0 z-30 border-b border-l bg-card px-3 py-2.5 text-right text-xs font-medium text-muted-foreground">Total</th>
            </tr>
          </thead>
          <tbody>
            {ledger.days.map((d) => (
              <tr key={d.date} className="group">
                <td className="sticky left-0 z-10 border-b bg-card px-3 py-2 text-xs whitespace-nowrap text-muted-foreground group-hover:text-foreground">{formatDate(d.date)}</td>
                {categories.map((c) => {
                  const cell = d.cells[c.id]
                  return (
                    <td key={c.id} className="border-b p-1">
                      {cell ? (
                        <button type="button" onClick={() => onCell(d.date, c.id)} title={`${cell.count} entr${cell.count === 1 ? 'y' : 'ies'} — show them`}
                          className={cn('w-full rounded-md px-2 py-1 text-left transition-[filter] hover:brightness-110', colorOf(c.color).soft)}>
                          <span className="block font-medium tabular-nums">{formatMoney(cell.amount)}</span>
                          {cell.usd ? <span className="block text-[11px] text-muted-foreground tabular-nums">{usd(cell.usd)}</span> : null}
                        </button>
                      ) : <span className="block px-2 text-muted-foreground/40">—</span>}
                    </td>
                  )
                })}
                <td className="sticky right-0 z-10 border-b border-l bg-card px-3 py-2 text-right font-semibold tabular-nums">
                  <button type="button" onClick={() => onCell(d.date, null)} className="hover:underline">{formatMoney(d.total)}</button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 z-20">
            <tr>
              <td className="sticky left-0 z-30 border-t bg-card px-3 py-2.5 text-xs font-semibold uppercase">Total</td>
              {categories.map((c) => <td key={c.id} className="border-t bg-card px-3 py-2.5 font-semibold tabular-nums"><span className={colorOf(c.color).text}>{formatMoney(c.total)}</span></td>)}
              <td className="sticky right-0 z-30 border-t border-l bg-card px-3 py-2.5 text-right font-bold tabular-nums">{formatMoney(ledger.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  )
}

function Entries({ type, from, to, day, onClearDay, categories, state, update, onEdit }: {
  type: FinanceType; from: string; to: string; day: string | null; onClearDay: () => void
  categories: PlatformLedger['categories']; state: LedgerState; update: Update; onEdit: (e: PlatformEntry) => void
}) {
  const queryClient = useQueryClient()
  const { can } = usePlatform()
  const page = Number(state.page) || 1
  const filters = {
    type, from, to, category_id: state.cat || undefined, source: (state.source || undefined) as EntrySource | undefined, q: state.q || undefined,
    show_voided: state.voided === '1' || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
  }
  const entries = useQuery({ queryKey: ['platform-finance', 'entries', filters], queryFn: () => platformEntries(filters), placeholderData: keepPreviousData })
  const [removing, setRemoving] = useState<PlatformEntry | null>(null)

  const columns: Column<PlatformEntry>[] = [
    { key: 'date', header: 'Date', cell: (e) => <span className="whitespace-nowrap text-muted-foreground">{formatDate(e.date)}</span> },
    { key: 'amount', header: 'Amount', primary: true, cell: (e) => <span className={cn('font-semibold tabular-nums', e.voided && 'text-muted-foreground line-through')}><Money value={e.amount} /></span> },
    {
      key: 'foreign', header: 'USD', hideOnMobile: true,
      cell: (e) => e.foreign_amount
        ? <span className="tabular-nums" title={e.exchange_rate ? `Rate ${e.exchange_rate}` : undefined}>{usd(e.foreign_amount, e.foreign_currency ?? 'USD')}</span>
        : <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'category', header: 'Category',
      cell: (e) => {
        const tone = colorOf(e.category.color)
        return <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', tone.soft, tone.text)}><span className={cn('size-1.5 rounded-full', tone.dot)} />{e.category.name}</span>
      },
    },
    { key: 'sub', header: 'Sub category', hideOnMobile: true, cell: (e) => e.sub_category ?? <span className="text-muted-foreground">—</span> },
    {
      key: 'note', header: 'Note',
      cell: (e) => (
        <div className="max-w-72 text-xs">
          <p className="truncate" title={e.notes ?? ''}>{e.notes ?? '—'}</p>
          <p className="truncate text-muted-foreground">{e.txn_number}{e.created_by ? ` · ${e.created_by}` : ''}{e.voided ? ' · deleted' : ''}</p>
        </div>
      ),
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (e) => e.editable ? (
        <div className="flex justify-end gap-1">
          {can('finance', 'edit') && <Button size="sm" variant="outline" className="h-7" onClick={() => onEdit(e)}><Pencil /> Edit</Button>}
          {can('finance', 'delete') && <Button size="sm" variant="ghost" className="h-7 text-red-600 hover:bg-red-500/10 hover:text-red-600" onClick={() => setRemoving(e)}><Trash2 /> Delete</Button>}
        </div>
      ) : e.source !== 'MANUAL'
        ? <Badge variant="outline" className="text-[10px]" title={e.source === 'BILLING' ? 'A payment from a merchant, from Billing' : 'Synced from the Meta ad account'}>Auto · {SOURCE_LABEL[e.source]}</Badge>
        : e.voided ? <Badge variant="outline" className="text-[10px]">Deleted</Badge> : null,
    },
  ]

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-wrap items-center gap-2 border-b py-3">
        <CardTitle className="mr-auto text-sm">
          All entries {entries.data && <span className="ml-1 font-normal text-muted-foreground">{entries.data.total} · <Money value={entries.data.sum} /></span>}
          {day && <Badge variant="secondary" className="ml-2 cursor-pointer" onClick={onClearDay}>{formatDate(day)} ✕</Badge>}
        </CardTitle>
        <Select value={state.cat || 'all'} onValueChange={(v) => update({ cat: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={state.source || 'all'} onValueChange={(v) => update({ source: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every source</SelectItem>
            <SelectItem value="MANUAL">Recorded by hand</SelectItem>
            {type === 'EXPENSE' && <SelectItem value="META_ADS">Meta ads</SelectItem>}
            <SelectItem value="BILLING">{type === 'EXPENSE' ? 'Refunds to merchants' : 'Merchant payments'}</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 w-48 pl-8" placeholder="Search entries…" defaultValue={state.q} onKeyDown={(e) => e.key === 'Enter' && update({ q: e.currentTarget.value.trim() })}
            onBlur={(e) => update({ q: e.target.value.trim() })} aria-label="Search entries" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={state.voided === '1'} onCheckedChange={(on) => update({ voided: on ? '1' : '' })} aria-label="Show deleted entries" /> Deleted
        </label>
      </CardHeader>
      <DataTable className="rounded-none border-0 shadow-none" columns={columns} rows={entries.data?.items} rowKey={(e) => e.id} loading={entries.isFetching}
        error={entries.error} onRetry={() => entries.refetch()}
        empty={<EmptyState title="No entries" description="Nothing matches these filters." />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={entries.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete ${removing?.txn_number ?? 'entry'}?`}
        description="It stops counting in the totals. The entry stays on record with who deleted it and why (turn on Deleted to see it)."
        reason reasonRequired reasonLabel="Why?" destructive confirmLabel="Delete entry"
        onConfirm={async (reason) => {
          await deleteEntry(removing!.id, reason ?? '')
          toast.success('Entry deleted')
          void queryClient.invalidateQueries({ queryKey: ['platform-finance'] })
        }} />
    </Card>
  )
}

// ------------------------------------------------------------------ new / edit entry
function EntryDialog({ type, entry, onClose }: { type: FinanceType; entry?: PlatformEntry; onClose: () => void }) {
  const queryClient = useQueryClient()
  const categories = useQuery({ queryKey: ['platform-finance', 'categories'], queryFn: platformCategories })
  const lastRate = (() => { try { return localStorage.getItem('fullfilio:usd_rate') } catch { return null } })()
  const [form, setForm] = useState({
    category_id: entry?.category.id ?? '', sub_category: entry?.sub_category ?? '', txn_date: entry?.date ?? today(),
    inUsd: !!entry?.foreign_amount, amount: entry ? String(entry.foreign_amount ?? entry.amount) : '', rate: entry?.exchange_rate ? String(entry.exchange_rate) : lastRate ?? '122',
    notes: entry?.notes ?? '', reference: entry?.reference ?? '',
  })
  const manual = (categories.data ?? []).filter((c) => c.type === type && c.allow_manual && c.is_active)
  const cat = manual.find((c) => c.id === form.category_id)
  const bdt = form.inUsd ? Number(form.amount) * Number(form.rate) : Number(form.amount)
  const save = useMutation({
    mutationFn: () => {
      if (form.inUsd) { try { localStorage.setItem('fullfilio:usd_rate', form.rate) } catch { /* only a convenience */ } }
      const input: EntryInput = {
        id: entry?.id, type, category_id: form.category_id, txn_date: form.txn_date, sub_category: form.sub_category || null,
        notes: form.notes || null, reference: form.reference || null,
        ...(form.inUsd ? { foreign_amount: Number(form.amount), foreign_currency: 'USD', exchange_rate: Number(form.rate) } : { amount: Number(form.amount) }),
      }
      return saveEntry(input)
    },
    onSuccess: () => {
      toast.success(entry ? 'Entry updated' : type === 'EXPENSE' ? 'Expense added' : 'Income added')
      void queryClient.invalidateQueries({ queryKey: ['platform-finance'] })
      onClose()
    },
    onError: fail,
  })
  const word = type === 'EXPENSE' ? 'expense' : 'income'
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={entry ? `Edit ${entry.txn_number}` : `New ${word}`}
      description={type === 'EXPENSE' ? 'Meta ad spend from a connected ad account is added by itself — record it here only if it is not connected.' : 'Merchant payments are added by themselves from Billing.'}
      submitLabel={entry ? 'Save changes' : `Add ${word}`} busy={save.isPending} onSubmit={() => save.mutate()}
      disabled={!form.category_id || !(bdt > 0) || !form.txn_date}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category" required>
          <Select value={form.category_id} onValueChange={(v) => setForm({ ...form, category_id: v, sub_category: '' })}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
            <SelectContent>{manual.map((c) => <SelectItem key={c.id} value={c.id}><span className={cn('mr-1.5 inline-block size-2 rounded-full', colorOf(c.color).dot)} />{c.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Sub category" htmlFor="pf-sub" hint="Optional, e.g. Cloudflare, Office rent">
          <Input id="pf-sub" list="pf-sub-list" value={form.sub_category} maxLength={60} onChange={(e) => setForm({ ...form, sub_category: e.target.value })} />
          <datalist id="pf-sub-list">{(cat?.subcategories ?? []).map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <Field label={form.inUsd ? 'Amount (USD)' : 'Amount (৳)'} htmlFor="pf-amount" required
          hint={<button type="button" className="underline-offset-2 hover:underline" onClick={() => setForm({ ...form, inUsd: !form.inUsd })}>{form.inUsd ? 'Enter in taka instead' : 'Paid in USD?'}</button>}>
          <Input id="pf-amount" type="number" inputMode="decimal" min="0" step="any" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        {form.inUsd ? (
          <Field label="USD to BDT rate" htmlFor="pf-rate" required hint={bdt > 0 ? `= ${formatMoney(bdt)}` : 'Rate you paid at'}>
            <Input id="pf-rate" type="number" inputMode="decimal" min="0" step="any" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
          </Field>
        ) : (
          <Field label="Date" htmlFor="pf-date" required><DatePicker id="pf-date" max={today()} value={form.txn_date} onChange={(d) => setForm({ ...form, txn_date: d })} /></Field>
        )}
        {form.inUsd && <Field label="Date" htmlFor="pf-date" required><DatePicker id="pf-date" max={today()} value={form.txn_date} onChange={(d) => setForm({ ...form, txn_date: d })} /></Field>}
        <Field label="Reference" htmlFor="pf-ref" hint="Invoice or transaction number"><Input id="pf-ref" value={form.reference} maxLength={120} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
        <Field label="Note" htmlFor="pf-note" className="sm:col-span-2"><Input id="pf-note" value={form.notes} maxLength={300} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      </div>
    </FormDialog>
  )
}

// ------------------------------------------------------------------ ad accounts
const STATUS: Record<PlatformAdAccount['status'], { label: string; tone: string }> = {
  NEW: { label: 'Not synced yet', tone: 'text-muted-foreground' },
  OK: { label: 'Syncing', tone: 'text-emerald-600' },
  FAILED: { label: 'Sync failed', tone: 'text-red-600' },
  TOKEN_INVALID: { label: 'Token expired', tone: 'text-red-600' },
  NO_ACCESS: { label: 'No access', tone: 'text-red-600' },
  RATE_LIMITED: { label: 'Slowed down by Meta', tone: 'text-amber-600' },
  DISCONNECTED: { label: 'Disconnected', tone: 'text-muted-foreground' },
}

function AdAccountsTab() {
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ['platform-finance', 'ad-accounts'], queryFn: platformAdAccounts })
  const [editing, setEditing] = useState<PlatformAdAccount | 'new' | null>(null)
  const [removing, setRemoving] = useState<PlatformAdAccount | null>(null)
  const sync = useMutation({
    mutationFn: (id: string | undefined) => syncAdAccounts({ id, days: 7 }),
    onSuccess: (r) => {
      const failed = r.accounts.filter((a) => !a.ok)
      if (failed.length) toast.error(`${failed[0].name}: ${failed[0].error}`)
      else toast.success(`Ad spend updated: ${formatMoney(r.amount)} over the last 7 days`)
      void queryClient.invalidateQueries({ queryKey: ['platform-finance'] })
    },
    onError: (e) => { fail(e); void queryClient.invalidateQueries({ queryKey: ['platform-finance', 'ad-accounts'] }) },
  })
  if (list.error) return <ErrorState error={list.error} onRetry={() => list.refetch()} />
  if (!list.data) return <CardsSkeleton count={2} />
  const { accounts, can_manage: manage } = list.data
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-sm">Fullfilio's Meta ad accounts</CardTitle>
            <CardDescription>The money Fullfilio spends on its own ads. Each day's spend becomes one Ads expense, converted to taka at the account's rate, updated every 3 hours.</CardDescription>
          </div>
          {manage && (
            <div className="flex gap-2">
              {accounts.some((a) => a.is_active) && <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate(undefined)}><RefreshCw className={cn(sync.isPending && 'animate-spin')} /> Sync all</Button>}
              <Button size="sm" onClick={() => setEditing('new')}><Link2 /> Connect ad account</Button>
            </div>
          )}
        </CardHeader>
        {accounts.length === 0 && (
          <CardContent>
            <EmptyState title="No ad account connected" description="Connect Fullfilio's Meta ad account and its daily spend shows up under Expenses → Ads by itself." />
          </CardContent>
        )}
      </Card>
      <div className="grid gap-3 md:grid-cols-2 [&>*]:min-w-0">
        {accounts.map((a) => {
          const s = STATUS[a.status]
          return (
            <Card key={a.id} className={cn(!a.is_active && 'opacity-70')}>
              <CardHeader className="flex flex-row items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="truncate text-sm">{a.name}</CardTitle>
                  <CardDescription className="truncate">{a.account_name ?? 'Meta ad account'} · {a.ad_account_id}{a.currency ? ` · ${a.currency}` : ''}</CardDescription>
                </div>
                <span className={cn('flex shrink-0 items-center gap-1 text-xs font-medium', s.tone)}>
                  {a.status === 'OK' ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}{s.label}
                </span>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div><p className="text-xs text-muted-foreground">Last 30 days</p><p className="font-semibold tabular-nums"><Money value={a.spend_30d} /></p></div>
                  <div><p className="text-xs text-muted-foreground">In {a.currency ?? 'USD'}</p><p className="font-semibold tabular-nums">{usd(a.spend_30d_foreign, a.currency ?? 'USD')}</p></div>
                  <div><p className="text-xs text-muted-foreground">Rate</p><p className="font-semibold tabular-nums">{a.currency === 'BDT' ? '—' : `৳${toNumber(a.usd_rate)}`}</p></div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {a.last_sync_at ? `Last sync ${formatDateTime(a.last_sync_at)}` : 'Not synced yet'}
                  {a.token_hint ? ` · token ${a.token_hint}` : ''}{a.token_expires_at ? ` · expires ${formatDate(a.token_expires_at)}` : ''}
                </p>
                {a.last_error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{a.last_error}</p>}
                {manage && (
                  <div className="flex flex-wrap gap-2">
                    {a.is_active && <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate(a.id)}><RefreshCw className={cn(sync.isPending && 'animate-spin')} /> Sync now</Button>}
                    <Button size="sm" variant="outline" onClick={() => setEditing(a)}><Pencil /> {a.is_active ? 'Edit' : 'Reconnect'}</Button>
                    {a.is_active && <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-500/10 hover:text-red-600" onClick={() => setRemoving(a)}><Unplug /> Disconnect</Button>}
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
      <TokenGuide />
      {editing && <AdAccountDialog account={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}
        title={`Disconnect ${removing?.name ?? 'ad account'}?`}
        description="Syncing stops and the access token is erased. The ad spend already recorded stays in Expenses."
        destructive confirmLabel="Disconnect"
        onConfirm={async () => {
          await disconnectAdAccount(removing!.id)
          toast.success('Ad account disconnected')
          void queryClient.invalidateQueries({ queryKey: ['platform-finance'] })
        }} />
    </div>
  )
}

function TokenGuide() {
  const steps = [
    'Open business.facebook.com → Settings → Users → System users, and add one (Admin) if there is none.',
    'Assign assets → Ad accounts → pick Fullfilio\'s ad account → turn on "View performance" (ads_read).',
    'Generate new token → choose the Fullfilio app → tick ads_read → set it to never expire → copy the token.',
    'Paste it here with the ad account ID (Ads Manager shows it under the account name). App ID and App Secret are optional but make every call signed.',
  ]
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Where the access token comes from</CardTitle></CardHeader>
      <CardContent>
        <ol className="grid gap-2 text-sm">
          {steps.map((s, i) => (
            <li key={s} className="flex gap-2.5"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold">{i + 1}</span><span className="text-muted-foreground">{s}</span></li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}

function AdAccountDialog({ account, onClose }: { account?: PlatformAdAccount; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({
    name: account?.name ?? 'Fullfilio ads', ad_account_id: account?.ad_account_id.replace(/^act_/, '') ?? '', access_token: '', app_id: account?.app_id ?? '',
    app_secret: '', usd_rate: account ? String(account.usd_rate) : '122', is_active: true,
  })
  const [checked, setChecked] = useState<string | null>(null)
  const input = (): AdAccountInput => ({
    id: account?.id, name: form.name.trim(), ad_account_id: form.ad_account_id.trim(), access_token: form.access_token.trim() || undefined,
    app_id: form.app_id.trim() || undefined, app_secret: form.app_secret.trim() || undefined, usd_rate: Number(form.usd_rate), is_active: form.is_active,
  })
  const test = useMutation({
    mutationFn: () => testAdAccount(input()),
    onSuccess: (r) => {
      setChecked(`${r.account.name} · ${r.account.currency}${r.account.timezone ? ` · ${r.account.timezone}` : ''}`)
      if (r.warnings.length) r.warnings.forEach((w) => toast.warning(w)); else toast.success('Meta accepted the token')
      if (r.account.currency === 'BDT') setForm((f) => ({ ...f, usd_rate: '1' }))
    },
    onError: fail,
  })
  const save = useMutation({
    mutationFn: () => saveAdAccount(input()),
    onSuccess: (r) => {
      r.warnings.forEach((w) => toast.warning(w))
      if (r.sync && !r.sync.ok) toast.error(`Saved, but the first sync failed: ${r.sync.error}`)
      else toast.success(r.sync ? `Connected — ${r.sync.days ?? 0} days of spend (${formatMoney(r.sync.amount ?? 0)}) added` : 'Ad account saved')
      void queryClient.invalidateQueries({ queryKey: ['platform-finance'] })
      onClose()
    },
    onError: fail,
  })
  const needsToken = !account || !account.is_active || !account.token_hint
  const ready = form.name.trim().length >= 2 && /^[0-9]{3,32}$/.test(form.ad_account_id.trim()) && Number(form.usd_rate) > 0 && (!needsToken || form.access_token.trim().length >= 20)
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={account ? `Edit ${account.name}` : 'Connect a Meta ad account'}
      description="The token goes straight to encrypted storage; this page only ever shows its last 4 characters. The last 30 days of spend come in right away."
      submitLabel={account ? 'Save' : 'Connect'} busy={save.isPending} onSubmit={() => save.mutate()} disabled={!ready} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="ad-name" required><Input id="ad-name" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Ad account ID" htmlFor="ad-id" required hint="The number, without act_">
          <Input id="ad-id" inputMode="numeric" value={form.ad_account_id} onChange={(e) => setForm({ ...form, ad_account_id: e.target.value.replace(/^act_/, '') })} placeholder="123456789012345" />
        </Field>
        <Field label="Access token" htmlFor="ad-token" required={needsToken} className="sm:col-span-2"
          hint={account?.token_hint && !needsToken ? `Saved: ${account.token_hint}. Leave empty to keep it.` : 'System User token with ads_read'}>
          <Input id="ad-token" type="password" autoComplete="off" value={form.access_token} onChange={(e) => setForm({ ...form, access_token: e.target.value })} placeholder="EAA…" />
        </Field>
        <Field label="App ID" htmlFor="ad-app" hint="Optional"><Input id="ad-app" inputMode="numeric" value={form.app_id} onChange={(e) => setForm({ ...form, app_id: e.target.value })} /></Field>
        <Field label="App Secret" htmlFor="ad-secret" hint={account?.has_app_secret ? 'Saved. Leave empty to keep it.' : 'Optional, signs every call'}>
          <Input id="ad-secret" type="password" autoComplete="off" value={form.app_secret} onChange={(e) => setForm({ ...form, app_secret: e.target.value })} />
        </Field>
        <Field label="USD to BDT rate" htmlFor="ad-rate" required hint="What one dollar of ad spend costs Fullfilio (card or agency rate)">
          <Input id="ad-rate" type="number" inputMode="decimal" min="0" step="any" value={form.usd_rate} onChange={(e) => setForm({ ...form, usd_rate: e.target.value })} />
        </Field>
        <Field label="Sync" hint={form.is_active ? 'Every 3 hours' : 'Paused'}>
          <label className="flex h-9 items-center gap-2 text-sm"><Switch checked={form.is_active} onCheckedChange={(on) => setForm({ ...form, is_active: on })} /> {form.is_active ? 'On' : 'Off'}</label>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={test.isPending || !/^[0-9]{3,32}$/.test(form.ad_account_id.trim()) || (needsToken && form.access_token.trim().length < 20)}
          onClick={() => test.mutate()}><RefreshCw className={cn(test.isPending && 'animate-spin')} /> Test connection</Button>
        {checked && <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 className="size-3.5" /> {checked}</span>}
      </div>
    </FormDialog>
  )
}

// ------------------------------------------------------------------ categories
function CategoriesTab() {
  const queryClient = useQueryClient()
  const { can } = usePlatform()
  const manage = can('finance', 'manage')
  const categories = useQuery({ queryKey: ['platform-finance', 'categories'], queryFn: platformCategories })
  const [adding, setAdding] = useState<FinanceType | null>(null)
  const save = useMutation({
    mutationFn: saveCategory,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-finance'] }),
    onError: fail,
  })
  if (categories.error) return <ErrorState error={categories.error} onRetry={() => categories.refetch()} />
  if (!categories.data) return <CardsSkeleton count={2} />
  return (
    <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
      {(['EXPENSE', 'INCOME'] as const).map((t) => (
        <Card key={t}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">{t === 'EXPENSE' ? 'Expense' : 'Income'} categories</CardTitle>
            {manage && <Button size="sm" variant="outline" onClick={() => setAdding(t)}><Plus /> Category</Button>}
          </CardHeader>
          <CardContent className="divide-y p-0">
            {categories.data.filter((c) => c.type === t).map((c) => (
              <CategoryRow key={c.id} cat={c} manage={manage} onSave={(patch) => save.mutate({ id: c.id, ...patch })} />
            ))}
          </CardContent>
        </Card>
      ))}
      {adding && <NewCategoryDialog type={adding} onClose={() => setAdding(null)} />}
    </div>
  )
}

function CategoryRow({ cat, manage, onSave }: { cat: PlatformCategory; manage: boolean; onSave: (patch: Partial<PlatformCategory>) => void }) {
  const [sub, setSub] = useState('')
  return (
    <div className="grid gap-2 px-6 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('size-3 rounded-full', colorOf(cat.color).dot)} />
        <span className="mr-auto font-medium">{cat.name}</span>
        {!cat.allow_manual && <Badge variant="outline" className="text-[10px]">Auto only</Badge>}
        {manage && (
          <>
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`${cat.name} colour`}>
              {COLOR_NAMES.map((n) => (
                <button key={n} type="button" aria-label={n} aria-pressed={cat.color === n} onClick={() => onSave({ color: n })}
                  className={cn('size-4 rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110', colorOf(n).dot, cat.color === n && 'ring-2 ring-foreground')} />
              ))}
            </div>
            {!cat.is_system && <Switch checked={cat.is_active} onCheckedChange={(on) => onSave({ is_active: on })} aria-label="Active" />}
          </>
        )}
      </div>
      {(cat.allow_manual || cat.subcategories.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 pl-5">
          {cat.subcategories.map((s) => (
            <Badge key={s} variant="secondary" className="gap-1 text-xs">
              {s}{manage && <button type="button" aria-label={`Remove ${s}`} onClick={() => onSave({ subcategories: cat.subcategories.filter((x) => x !== s) })} className="opacity-60 hover:opacity-100">✕</button>}
            </Badge>
          ))}
          {manage && cat.allow_manual && (
            <form onSubmit={(e) => { e.preventDefault(); const v = sub.trim(); if (v && !cat.subcategories.includes(v)) onSave({ subcategories: [...cat.subcategories, v.slice(0, 60)] }); setSub('') }}>
              <Input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="+ sub category" className="h-7 w-36 text-xs" aria-label={`New sub category for ${cat.name}`} />
            </form>
          )}
        </div>
      )}
    </div>
  )
}

function NewCategoryDialog({ type, onClose }: { type: FinanceType; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>('violet')
  const save = useMutation({
    mutationFn: () => saveCategory({ type, name: name.trim(), color }),
    onSuccess: () => {
      toast.success('Category added')
      void queryClient.invalidateQueries({ queryKey: ['platform-finance'] })
      onClose()
    },
    onError: fail,
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`New ${type === 'EXPENSE' ? 'expense' : 'income'} category`}
      submitLabel="Add category" busy={save.isPending} onSubmit={() => save.mutate()} disabled={name.trim().length < 2}>
      <Field label="Name" htmlFor="pc-name" required><Input id="pc-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Travel" /></Field>
      <Field label="Colour">
        <div className="flex flex-wrap gap-1.5">
          {COLOR_NAMES.map((n) => (
            <button key={n} type="button" aria-label={n} aria-pressed={color === n} onClick={() => setColor(n)}
              className={cn('size-6 rounded-full ring-offset-2 ring-offset-background', colorOf(n).dot, color === n && 'ring-2 ring-foreground')} />
          ))}
        </div>
      </Field>
    </FormDialog>
  )
}
