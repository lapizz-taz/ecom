import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart3, Megaphone, Pencil, Plus, Receipt, Search, Settings2, Trash2, TrendingDown, TrendingUp, Wallet,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { COLOR_NAMES, colorOf } from '@/features/finance/category-colors'
import { BarsChart } from '@/features/reports/charts'
import { useDateRange } from '@/hooks/use-date-range'
import { useRealtimeInvalidate } from '@/hooks/use-realtime'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatMoney, formatNumber, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  createEntry, type EntryInput, financeEntries, financeLedger, financeLedgerOverview, type LedgerCategory, type LedgerEntry, type LedgerType,
  listCategories, reverseTransaction, saveCategory, updateCategoryLook, updateEntry,
} from '@/services/finance'
import { financeAccounts } from '@/services/marketing'

type Tab = 'overview' | 'expense' | 'income' | 'settings'
const TABS: Array<{ key: Tab; label: string; icon: typeof Receipt }> = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'expense', label: 'Expense', icon: TrendingDown },
  { key: 'income', label: 'Income', icon: TrendingUp },
  { key: 'settings', label: 'Settings', icon: Settings2 },
]
const PAGE_SIZE = 20
const usd = (v: number) => `$${toNumber(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const today = () => new Date().toLocaleDateString('en-CA')

export default function FinanceLedgerPage() {
  const { can } = useAuth()
  const manage = can('finance.manage')
  const [range, setRange] = useDateRange('30d')
  const [state, update] = useUrlState({ tab: 'expense', cat: '', sub: '', account: '', q: '', page: '1', reversed: '', new: '' })
  const tab = (TABS.some((t) => t.key === state.tab) ? state.tab : 'expense') as Tab
  const type: LedgerType = tab === 'income' ? 'INCOME' : 'EXPENSE'
  // ?new=1 (from the dashboard's "Add expense") opens the form straight away.
  const [dialog, setDialog] = useState<{ kind: 'entry' | 'ad'; type: LedgerType; entry?: LedgerEntry } | null>(() =>
    manage && new URLSearchParams(window.location.search).get('new') === '1' ? { kind: 'entry', type } : null)
  useRealtimeInvalidate('finance_transactions', [['finance-ledger']])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Income & Expense"
        description="Every taka in and out, by day and category. Entries made by the system (orders, couriers, synced ads) are marked Auto."
        actions={manage && (
          <>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'ad', type: 'EXPENSE' })}><Megaphone /> New ad expense</Button>
            <Button size="sm" variant={tab === 'income' ? 'outline' : 'default'} onClick={() => setDialog({ kind: 'entry', type: 'EXPENSE' })}><Plus /> New expense</Button>
            <Button size="sm" variant={tab === 'income' ? 'default' : 'outline'} onClick={() => setDialog({ kind: 'entry', type: 'INCOME' })}><Plus /> New income</Button>
          </>
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border bg-card p-1" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              onClick={() => update({ tab: t.key, cat: '', sub: '', page: '1' })}
              className={cn('press flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
                tab === t.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              <t.icon className="size-3.5" /> {t.label}
            </button>
          ))}
        </div>
        {tab !== 'settings' && <DateRangeFilter value={range} onChange={setRange} />}
      </div>

      {tab === 'overview' && <OverviewTab from={range.from} to={range.to} />}
      {(tab === 'expense' || tab === 'income') && (
        <LedgerTab type={type} from={range.from} to={range.to} state={state} update={update} manage={manage}
          onEdit={(entry) => setDialog({ kind: entry.category.code === 'ADVERTISING' && entry.foreign_amount ? 'ad' : 'entry', type: entry.type, entry })} />
      )}
      {tab === 'settings' && <SettingsTab manage={manage} />}

      {dialog?.kind === 'entry' && <EntryDialog type={dialog.type} entry={dialog.entry} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'ad' && <AdExpenseDialog entry={dialog.entry} onClose={() => setDialog(null)} />}
    </div>
  )
}

// ------------------------------------------------------------------ expense / income
function LedgerTab({ type, from, to, state, update, manage, onEdit }: {
  type: LedgerType; from: string; to: string
  state: Record<'cat' | 'sub' | 'account' | 'q' | 'page' | 'reversed', string>
  update: (patch: Partial<Record<string, string>>, opts?: { resetPage?: boolean }) => void
  manage: boolean
  onEdit: (e: LedgerEntry) => void
}) {
  const ledger = useQuery({ queryKey: ['finance-ledger', 'matrix', type, from, to], queryFn: () => financeLedger(type, from, to), placeholderData: keepPreviousData })
  const L = ledger.data
  const active = useMemo(() => (L?.categories ?? []).filter((c) => toNumber(c.total) !== 0), [L])
  const [dayFilter, setDayFilter] = useState<string | null>(null)

  if (ledger.error) return <ErrorState error={ledger.error} onRetry={() => ledger.refetch()} />
  if (!L) return <CardsSkeleton count={8} />
  const word = type === 'EXPENSE' ? 'spent' : 'received'

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 [&>*]:min-w-0">
        <SummaryCard label={`Total ${word}`} value={<Money value={L.total} />} hint={`${formatNumber(L.count)} entries${L.usd_total ? ` · ${usd(L.usd_total)} ads` : ''}`}
          icon={type === 'EXPENSE' ? TrendingDown : TrendingUp} active={!state.cat} onClick={() => update({ cat: '', sub: '' })} strong />
        {active.map((c) => {
          const tone = colorOf(c.color)
          return (
            <SummaryCard key={c.id} label={c.name} value={<Money value={c.total} />} hint={`${c.count} entr${c.count === 1 ? 'y' : 'ies'}`}
              dot={tone.dot} active={state.cat === c.id} onClick={() => update({ cat: state.cat === c.id ? '' : c.id, sub: '' })} />
          )
        })}
      </section>

      <Matrix categories={active} days={L.days} total={L.total} selectedCat={state.cat}
        onCell={(date, cat) => { setDayFilter(date); update({ cat: cat ?? '', sub: '' }) }} />

      <Entries type={type} from={dayFilter ?? from} to={dayFilter ?? to} day={dayFilter} onClearDay={() => setDayFilter(null)}
        categories={L.categories} state={state} update={update} manage={manage} onEdit={onEdit} />
    </div>
  )
}

function SummaryCard({ label, value, hint, icon: Icon, dot, active, onClick, strong }: {
  label: string; value: React.ReactNode; hint: string; icon?: typeof Receipt; dot?: string; active: boolean; onClick: () => void; strong?: boolean
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
function Matrix({ categories, days, total, selectedCat, onCell }: {
  categories: LedgerCategory[]; days: Array<{ date: string; total: number; cells: Record<string, { amount: number; count: number; usd: number | null }> }>
  total: number; selectedCat: string; onCell: (date: string, cat: string | null) => void
}) {
  if (!days.length) return <Card><CardContent className="py-10"><EmptyState title="Nothing recorded in this period" description="Pick a longer range or add an entry." /></CardContent></Card>
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
            {days.map((d) => (
              <tr key={d.date} className="group">
                <td className="sticky left-0 z-10 border-b bg-card px-3 py-2 text-xs whitespace-nowrap text-muted-foreground group-hover:text-foreground">{formatDate(d.date)}</td>
                {categories.map((c) => {
                  const cell = d.cells[c.id]
                  const tone = colorOf(c.color)
                  return (
                    <td key={c.id} className="border-b p-1">
                      {cell ? (
                        <button type="button" onClick={() => onCell(d.date, c.id)} title={`${cell.count} entr${cell.count === 1 ? 'y' : 'ies'} — show them`}
                          className={cn('w-full rounded-md px-2 py-1 text-left transition-[filter] hover:brightness-110', tone.soft)}>
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
              <td className="sticky right-0 z-30 border-t border-l bg-card px-3 py-2.5 text-right font-bold tabular-nums">{formatMoney(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  )
}

function Entries({ type, from, to, day, onClearDay, categories, state, update, manage, onEdit }: {
  type: LedgerType; from: string; to: string; day: string | null; onClearDay: () => void
  categories: LedgerCategory[]
  state: Record<'cat' | 'sub' | 'account' | 'q' | 'page' | 'reversed', string>
  update: (patch: Partial<Record<string, string>>, opts?: { resetPage?: boolean }) => void
  manage: boolean; onEdit: (e: LedgerEntry) => void
}) {
  const queryClient = useQueryClient()
  const page = Number(state.page) || 1
  const accounts = useQuery({ queryKey: ['finance-accounts'], queryFn: financeAccounts, staleTime: 60_000 })
  const filters = { type, from, to, category_id: state.cat || undefined, sub_category: state.sub || undefined, account_id: state.account || undefined,
    q: state.q || undefined, show_reversed: state.reversed === '1' || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }
  const entries = useQuery({ queryKey: ['finance-ledger', 'entries', filters], queryFn: () => financeEntries(filters), placeholderData: keepPreviousData })
  const [removing, setRemoving] = useState<LedgerEntry | null>(null)
  const subs = categories.find((c) => c.id === state.cat)?.subcategories ?? []

  const columns: Column<LedgerEntry>[] = [
    { key: 'date', header: 'Date', cell: (e) => <span className="whitespace-nowrap text-muted-foreground">{formatDate(e.date)}</span> },
    {
      key: 'amount', header: 'Amount', primary: true,
      cell: (e) => <span className={cn('font-semibold tabular-nums', e.is_reversal && 'text-muted-foreground line-through', e.reversed && 'text-muted-foreground line-through')}><Money value={e.amount} /></span>,
    },
    { key: 'usd', header: 'USD', hideOnMobile: true, cell: (e) => e.foreign_amount ? <span className="tabular-nums" title={e.exchange_rate ? `Rate ${e.exchange_rate}` : undefined}>{usd(e.foreign_amount)}</span> : <span className="text-muted-foreground">—</span> },
    {
      key: 'category', header: 'Category',
      cell: (e) => {
        const tone = colorOf(e.category.color)
        return <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', tone.soft, tone.text)}><span className={cn('size-1.5 rounded-full', tone.dot)} />{e.category.name}</span>
      },
    },
    { key: 'sub', header: 'Sub category', hideOnMobile: true, cell: (e) => e.sub_category ?? <span className="text-muted-foreground">—</span> },
    { key: 'account', header: 'Payment account', hideOnMobile: true, cell: (e) => e.account?.name ?? <span className="text-muted-foreground">—</span> },
    {
      key: 'note', header: 'Note',
      cell: (e) => (
        <div className="max-w-64 text-xs">
          <p className="truncate" title={e.notes ?? ''}>{e.notes ?? (e.order_number ? `Order ${e.order_number}` : '—')}</p>
          <p className="truncate text-muted-foreground">{e.txn_number}{e.created_by ? ` · ${e.created_by}` : ''}</p>
        </div>
      ),
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (e) => e.editable && manage ? (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="outline" className="h-7" onClick={() => onEdit(e)}><Pencil /> Edit</Button>
          <Button size="sm" variant="ghost" className="h-7 text-red-600 hover:bg-red-500/10 hover:text-red-600" onClick={() => setRemoving(e)}><Trash2 /> Delete</Button>
        </div>
      ) : e.source !== 'MANUAL' ? <Badge variant="outline" className="text-[10px]" title="Made by the system; corrected through the order, courier or ad sync">Auto</Badge>
        : e.is_reversal || e.reversed ? <Badge variant="outline" className="text-[10px]">{e.is_reversal ? 'Reversal' : 'Reversed'}</Badge> : null,
    },
  ]

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-wrap items-center gap-2 border-b py-3">
        <CardTitle className="mr-auto text-sm">
          All entries {entries.data && <span className="ml-1 font-normal text-muted-foreground">{entries.data.total} · <Money value={entries.data.sum} /></span>}
          {day && <Badge variant="secondary" className="ml-2 cursor-pointer" onClick={onClearDay}>{formatDate(day)} ✕</Badge>}
        </CardTitle>
        <Select value={state.cat || 'all'} onValueChange={(v) => update({ cat: v === 'all' ? '' : v, sub: '' })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={state.sub || 'all'} onValueChange={(v) => update({ sub: v === 'all' ? '' : v })} disabled={!subs.length}>
          <SelectTrigger size="sm" className="w-44"><SelectValue placeholder="Sub category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sub categories</SelectItem>
            {subs.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={state.account || 'all'} onValueChange={(v) => update({ account: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {(accounts.data ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 w-48 pl-8" placeholder="Search entries…" defaultValue={state.q} onKeyDown={(e) => e.key === 'Enter' && update({ q: e.currentTarget.value.trim() })}
            onBlur={(e) => update({ q: e.target.value.trim() })} aria-label="Search entries" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={state.reversed === '1'} onCheckedChange={(on) => update({ reversed: on ? '1' : '' })} aria-label="Show reversed entries" /> Reversed
        </label>
      </CardHeader>
      <DataTable className="rounded-none border-0 shadow-none" columns={columns} rows={entries.data?.items} rowKey={(e) => e.id} loading={entries.isFetching}
        error={entries.error} onRetry={() => entries.refetch()}
        empty={<EmptyState title="No entries" description="Nothing matches these filters." />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={entries.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete ${removing?.txn_number ?? 'entry'}?`}
        description={`A reversal entry is recorded so the books stay complete${removing?.account ? `, and ${formatMoney(removing.amount)} goes back to ${removing.account.name}` : ''}.`}
        reason reasonRequired reasonLabel="Why?" destructive confirmLabel="Delete entry"
        onConfirm={async (reason) => {
          await reverseTransaction(removing!.id, reason ?? '')
          toast.success('Entry deleted')
          void queryClient.invalidateQueries({ queryKey: ['finance-ledger'] })
          void queryClient.invalidateQueries({ queryKey: ['finance-accounts'] })
        }} />
    </Card>
  )
}

// ------------------------------------------------------------------ dialogs
function EntryDialog({ type, entry, onClose }: { type: LedgerType; entry?: LedgerEntry; onClose: () => void }) {
  const queryClient = useQueryClient()
  const categories = useQuery({ queryKey: ['finance-categories', type], queryFn: () => listCategories(type) })
  const accounts = useQuery({ queryKey: ['finance-accounts'], queryFn: financeAccounts, staleTime: 60_000 })
  const [form, setForm] = useState({
    category_id: entry?.category.id ?? '', sub_category: entry?.sub_category ?? '', amount: entry ? String(entry.amount) : '',
    txn_date: entry?.date ?? today(), account_id: entry?.account?.id ?? '', notes: entry?.notes ?? '', reference: entry?.reference ?? '',
  })
  const manualCats = (categories.data ?? []).filter((c) => c.allow_manual && c.is_active)
  const cat = manualCats.find((c) => c.id === form.category_id)
  const save = useMutation({
    mutationFn: () => {
      const input: EntryInput = {
        type, category_id: form.category_id, amount: Number(form.amount), txn_date: form.txn_date, sub_category: form.sub_category || null,
        account_id: form.account_id || null, notes: form.notes || null, reference: form.reference || null,
      }
      return entry ? updateEntry(entry.id, input) : createEntry(input)
    },
    onSuccess: () => {
      toast.success(entry ? 'Entry updated' : type === 'EXPENSE' ? 'Expense added' : 'Income added')
      void queryClient.invalidateQueries({ queryKey: ['finance-ledger'] })
      void queryClient.invalidateQueries({ queryKey: ['finance-accounts'] })
      onClose()
    },
  })
  const word = type === 'EXPENSE' ? 'expense' : 'income'
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={entry ? `Edit ${entry.txn_number}` : `New ${word}`}
      description={entry ? 'The old entry is reversed and this one recorded in its place, so the history stays complete.' : undefined}
      submitLabel={entry ? 'Save changes' : `Add ${word}`} busy={save.isPending} onSubmit={() => save.mutate()}
      disabled={!form.category_id || !(Number(form.amount) > 0) || !form.txn_date}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category" required>
          <Select value={form.category_id} onValueChange={(v) => setForm({ ...form, category_id: v, sub_category: '' })}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
            <SelectContent>{manualCats.map((c) => <SelectItem key={c.id} value={c.id}><span className={cn('mr-1.5 inline-block size-2 rounded-full', colorOf(c.color).dot)} />{c.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Sub category" htmlFor="e-sub" hint="Optional, e.g. Boxes, Office rent">
          <Input id="e-sub" list="e-sub-list" value={form.sub_category} maxLength={60} onChange={(e) => setForm({ ...form, sub_category: e.target.value })} />
          <datalist id="e-sub-list">{(cat?.subcategories ?? []).map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <Field label="Amount" htmlFor="e-amount" required>
          <Input id="e-amount" type="number" inputMode="decimal" min="0" step="any" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="Date" htmlFor="e-date" required>
          <Input id="e-date" type="date" max={today()} value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} />
        </Field>
        <Field label="Payment account" hint={type === 'EXPENSE' ? 'Its balance goes down by this amount' : 'Its balance goes up by this amount'} className="sm:col-span-2">
          <Select value={form.account_id || 'none'} onValueChange={(v) => setForm({ ...form, account_id: v === 'none' ? '' : v })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No account selected</SelectItem>
              {(accounts.data ?? []).filter((a) => a.is_active).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}{a.balance != null ? ` · ${formatMoney(a.balance)}` : ''}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Note" htmlFor="e-note" className="sm:col-span-2"><Input id="e-note" value={form.notes} maxLength={300} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      </div>
    </FormDialog>
  )
}

const AD_PLATFORMS = ['Meta', 'TikTok', 'Google', 'Other']

function AdExpenseDialog({ entry, onClose }: { entry?: LedgerEntry; onClose: () => void }) {
  const queryClient = useQueryClient()
  const categories = useQuery({ queryKey: ['finance-categories', 'EXPENSE'], queryFn: () => listCategories('EXPENSE') })
  const accounts = useQuery({ queryKey: ['finance-accounts'], queryFn: financeAccounts, staleTime: 60_000 })
  const lastRate = (() => { try { return localStorage.getItem('ad_usd_rate') } catch { return null } })()
  const [form, setForm] = useState({
    platform: entry?.sub_category ?? 'Meta', usd: entry?.foreign_amount ? String(entry.foreign_amount) : '',
    rate: entry?.exchange_rate ? String(entry.exchange_rate) : lastRate ?? '122', txn_date: entry?.date ?? today(),
    account_id: entry?.account?.id ?? '', notes: entry?.notes ?? '',
  })
  const ads = (categories.data ?? []).find((c) => c.code === 'ADVERTISING')
  const bdt = Number(form.usd) * Number(form.rate)
  const save = useMutation({
    mutationFn: () => {
      try { localStorage.setItem('ad_usd_rate', form.rate) } catch { /* only a convenience */ }
      const input: EntryInput = {
        type: 'EXPENSE', category_id: ads!.id, txn_date: form.txn_date, sub_category: form.platform,
        foreign_amount: Number(form.usd), foreign_currency: 'USD', exchange_rate: Number(form.rate),
        account_id: form.account_id || null, notes: form.notes || null,
      }
      return entry ? updateEntry(entry.id, input) : createEntry(input)
    },
    onSuccess: () => {
      toast.success(entry ? 'Ad expense updated' : 'Ad expense added')
      void queryClient.invalidateQueries({ queryKey: ['finance-ledger'] })
      void queryClient.invalidateQueries({ queryKey: ['finance-accounts'] })
      onClose()
    },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={entry ? `Edit ${entry.txn_number}` : 'New ad expense'}
      description="For ad spend that is not synced automatically (e.g. a boost from a personal card). Connected Meta, TikTok and Google accounts already post their daily spend here — adding it again would count it twice."
      submitLabel={entry ? 'Save changes' : 'Add ad expense'} busy={save.isPending} onSubmit={() => save.mutate()}
      disabled={!ads || !(Number(form.usd) > 0) || !(Number(form.rate) > 0)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Platform" className="sm:col-span-2">
          <div className="flex flex-wrap gap-1.5">
            {AD_PLATFORMS.map((p) => (
              <button key={p} type="button" onClick={() => setForm({ ...form, platform: p })} aria-pressed={form.platform === p}
                className={cn('press rounded-full border px-3 py-1 text-sm', form.platform === p ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{p}</button>
            ))}
          </div>
        </Field>
        <Field label="Amount (USD)" htmlFor="a-usd" required>
          <Input id="a-usd" type="number" inputMode="decimal" min="0" step="any" value={form.usd} onChange={(e) => setForm({ ...form, usd: e.target.value })} placeholder="0.00" />
        </Field>
        <Field label="USD to BDT rate" htmlFor="a-rate" required hint={bdt > 0 ? `= ${formatMoney(bdt)}` : 'Current conversion rate'}>
          <Input id="a-rate" type="number" inputMode="decimal" min="0" step="any" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
        </Field>
        <Field label="Date" htmlFor="a-date" required><Input id="a-date" type="date" max={today()} value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} /></Field>
        <Field label="Paid from">
          <Select value={form.account_id || 'none'} onValueChange={(v) => setForm({ ...form, account_id: v === 'none' ? '' : v })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No account selected</SelectItem>
              {(accounts.data ?? []).filter((a) => a.is_active).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Note" htmlFor="a-note" className="sm:col-span-2"><Input id="a-note" value={form.notes} maxLength={300} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Eid boost, card top-up" /></Field>
      </div>
    </FormDialog>
  )
}

// ------------------------------------------------------------------ overview
function OverviewTab({ from, to }: { from: string; to: string }) {
  const overview = useQuery({ queryKey: ['finance-ledger', 'overview', from, to], queryFn: () => financeLedgerOverview(from, to), placeholderData: keepPreviousData })
  const o = overview.data
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
  if (!o) return <CardsSkeleton count={4} />
  const net = toNumber(o.income) - toNumber(o.expense)
  const top = (t: LedgerType) => o.by_category.filter((c) => c.type === t).slice(0, 8)
  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Kpi label="Income" value={<Money value={o.income} />} hint={`${o.income_count} entries`} tone="text-emerald-600" icon={TrendingUp} />
        <Kpi label="Expense" value={<Money value={o.expense} />} hint={`${o.expense_count} entries`} tone="text-red-600" icon={TrendingDown} />
        <Kpi label="Net" value={<Money value={net} signed />} hint="income − expense" tone={net < 0 ? 'text-red-600' : 'text-emerald-600'} icon={Wallet} />
        <Kpi label="Spend ratio" value={toNumber(o.income) > 0 ? `${Math.round((100 * toNumber(o.expense)) / toNumber(o.income))}%` : '—'} hint="of income spent" icon={Receipt} />
      </section>
      <Card>
        <CardHeader><CardTitle className="text-sm">Income and expense by day</CardTitle></CardHeader>
        <CardContent>
          <BarsChart data={o.series} xKey="date" dateAxis format="money" height={260}
            series={[{ key: 'income', label: 'Income', slot: 2 }, { key: 'expense', label: 'Expense', slot: 4 }]} />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        {(['EXPENSE', 'INCOME'] as const).map((t) => (
          <Card key={t}>
            <CardHeader><CardTitle className="text-sm">Top {t === 'EXPENSE' ? 'expenses' : 'income'}</CardTitle></CardHeader>
            <CardContent className="space-y-2.5">
              {top(t).length === 0 ? <p className="text-sm text-muted-foreground">Nothing in this period.</p> : top(t).map((c) => {
                const max = toNumber(top(t)[0].total) || 1
                const tone = colorOf(c.color)
                return (
                  <div key={c.name} className="grid gap-1">
                    <div className="flex justify-between gap-2 text-sm"><span className="flex items-center gap-1.5 truncate"><span className={cn('size-2 rounded-full', tone.dot)} />{c.name}</span><Money value={c.total} className="tabular-nums" /></div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', tone.dot)} style={{ width: `${(100 * toNumber(c.total)) / max}%` }} /></div>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        ))}
      </div>
      {o.by_account.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">By payment account</CardTitle></CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {o.by_account.map((a) => (
              <div key={a.name} className="rounded-xl border p-3 text-sm">
                <p className="font-medium">{a.name}</p>
                <p className="text-xs text-muted-foreground">In <Money value={a.income ?? 0} /> · Out <Money value={a.expense ?? 0} /></p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Kpi({ label, value, hint, tone, icon: Icon }: { label: string; value: React.ReactNode; hint: string; tone?: string; icon: typeof Receipt }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"><Icon className="size-3.5" />{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular-nums', tone)}>{value}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

// ------------------------------------------------------------------ settings
function SettingsTab({ manage }: { manage: boolean }) {
  const queryClient = useQueryClient()
  const categories = useQuery({ queryKey: ['finance-categories', 'all'], queryFn: () => listCategories() })
  const [adding, setAdding] = useState<LedgerType | null>(null)
  const save = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateCategoryLook>[1] }) => updateCategoryLook(id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['finance-categories'] })
      void queryClient.invalidateQueries({ queryKey: ['finance-ledger'] })
    },
  })
  if (categories.error) return <ErrorState error={categories.error} onRetry={() => categories.refetch()} />
  return (
    <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
      {(['EXPENSE', 'INCOME'] as const).map((t) => (
        <Card key={t}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">{t === 'EXPENSE' ? 'Expense' : 'Income'} categories</CardTitle>
            {manage && <Button size="sm" variant="outline" onClick={() => setAdding(t)}><Plus /> Category</Button>}
          </CardHeader>
          <CardContent className="divide-y p-0">
            {(categories.data ?? []).filter((c) => c.type === t).map((c) => (
              <CategoryRow key={c.id} cat={c} manage={manage} onSave={(patch) => save.mutate({ id: c.id, patch })} />
            ))}
          </CardContent>
        </Card>
      ))}
      {adding && <NewCategoryDialog type={adding} onClose={() => setAdding(null)} />}
    </div>
  )
}

function CategoryRow({ cat, manage, onSave }: {
  cat: { id: string; name: string; color: string | null; subcategories: string[]; is_active: boolean; allow_manual: boolean; is_system: boolean }
  manage: boolean
  onSave: (patch: { color?: string; subcategories?: string[]; is_active?: boolean }) => void
}) {
  const [sub, setSub] = useState('')
  const tone = colorOf(cat.color)
  return (
    <div className="grid gap-2 px-6 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('size-3 rounded-full', tone.dot)} />
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
    </div>
  )
}

function NewCategoryDialog({ type, onClose }: { type: LedgerType; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>('violet')
  const save = useMutation({
    mutationFn: () => saveCategory({
      code: name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `CAT_${Date.now()}`,
      name: name.trim(), type, pnl_group: type === 'EXPENSE' ? 'OPERATING_EXPENSE' : 'OTHER_INCOME', allow_manual: true, is_system: false, color,
    } as never),
    onSuccess: () => {
      toast.success('Category added')
      void queryClient.invalidateQueries({ queryKey: ['finance-categories'] })
      void queryClient.invalidateQueries({ queryKey: ['finance-ledger'] })
      onClose()
    },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`New ${type === 'EXPENSE' ? 'expense' : 'income'} category`}
      submitLabel="Add category" busy={save.isPending} onSubmit={() => save.mutate()} disabled={name.trim().length < 2}>
      <Field label="Name" htmlFor="c-name" required><Input id="c-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Office snacks" /></Field>
      <Field label="Colour">
        <div className="flex flex-wrap gap-1.5">
          {COLOR_NAMES.map((n) => (
            <button key={n} type="button" aria-label={n} aria-pressed={color === n} onClick={() => setColor(n)}
              className={cn('size-6 rounded-full ring-offset-2 ring-offset-background', colorOf(n).dot, color === n && 'ring-2 ring-foreground')} />
          ))}
        </div>
      </Field>
      {type === 'EXPENSE' && <p className="text-xs text-muted-foreground">Counted as an operating expense in Profit &amp; Loss.</p>}
    </FormDialog>
  )
}
