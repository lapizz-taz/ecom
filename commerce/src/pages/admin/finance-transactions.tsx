import { zodResolver } from '@hookform/resolvers/zod'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Plus, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { Link, useLocation } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Field } from '@/components/common/field'
import { ChannelSelect, FormDialog, type PaymentChannel } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { Can } from '@/components/common/permission-gate'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useDateRange } from '@/hooks/use-date-range'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { toUserMessage } from '@/lib/errors'
import { formatDate, isoDateToday } from '@/lib/format'
import { PAYMENT_CHANNEL } from '@/lib/status'
import { createTransaction, listCategories, listTransactions, reverseTransaction, type TransactionRow } from '@/services/finance'
import { listSuppliers } from '@/services/purchases'
import type { Enums } from '@/types/database'

const PAGE_SIZE = 25

/** /admin/finance/income and /admin/finance/expenses share this page. */
export default function FinanceTransactionsPage() {
  const type: Enums<'finance_type'> = useLocation().pathname.endsWith('/income') ? 'INCOME' : 'EXPENSE'
  const noun = type === 'INCOME' ? 'income' : 'expense'
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [range, setRange] = useDateRange('month')
  const [state, update] = useUrlState({ q: '', category: '', page: '1', new: '' })
  const page = Number(state.page) || 1
  const [reversing, setReversing] = useState<TransactionRow | null>(null)
  const [exporting, setExporting] = useState(false)

  const categories = useQuery({ queryKey: ['finance-categories', type], queryFn: () => listCategories(type) })
  const filters = { type, categoryId: state.category || undefined, from: range.from, to: range.to, q: state.q }
  const txns = useQuery({
    queryKey: ['finance', 'transactions', filters, page],
    placeholderData: keepPreviousData,
    queryFn: () => listTransactions({ ...filters, page, pageSize: PAGE_SIZE }),
  })

  const exportCsv = async () => {
    setExporting(true)
    try {
      const all: TransactionRow[] = []
      for (let p = 1; p <= 50; p++) {
        const chunk = await listTransactions({ ...filters, page: p, pageSize: 500 })
        all.push(...chunk.items)
        if (all.length >= chunk.total) break
      }
      downloadCsv(`${noun}-${range.from}-to-${range.to}`, all, [
        { header: 'Date', value: (t) => t.txn_date },
        { header: 'Number', value: (t) => t.txn_number },
        { header: 'Category', value: (t) => t.finance_categories?.name },
        { header: 'Amount', value: (t) => t.amount },
        { header: 'Cash movement', value: (t) => (t.is_cash ? 'yes' : 'no') },
        { header: 'Channel', value: (t) => (t.payment_channel ? PAYMENT_CHANNEL[t.payment_channel] : '') },
        { header: 'Order', value: (t) => t.orders?.order_number },
        { header: 'Supplier', value: (t) => t.suppliers?.name },
        { header: 'Reference', value: (t) => t.reference },
        { header: 'Notes', value: (t) => t.notes },
        { header: 'Source', value: (t) => t.source },
        { header: 'Reversed', value: (t) => (t.reversed ? 'yes' : '') },
      ])
    } catch (e) {
      toast.error(toUserMessage(e))
    } finally {
      setExporting(false)
    }
  }

  const reversible = (t: TransactionRow) => !t.reverses_id && !t.reversed && !(t.source === 'SYSTEM' && t.source_key?.startsWith('order'))

  const columns: Column<TransactionRow>[] = [
    { key: 'date', header: 'Date', cell: (t) => formatDate(t.txn_date) },
    {
      key: 'category', header: 'Category', primary: true,
      cell: (t) => (
        <div>
          <p className="font-medium">{t.finance_categories?.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{t.txn_number}</p>
        </div>
      ),
    },
    {
      key: 'ref', header: 'Linked to',
      cell: (t) => (
        <div className="text-sm">
          {t.orders && <Link to={`/admin/orders/${t.order_id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{t.orders.order_number}</Link>}
          {t.suppliers && <p>{t.suppliers.name}</p>}
          {t.reference && <p className="text-xs text-muted-foreground">{t.reference}</p>}
          {!t.orders && !t.suppliers && !t.reference && <span className="text-muted-foreground">—</span>}
        </div>
      ),
    },
    { key: 'notes', header: 'Notes', hideOnMobile: true, cell: (t) => <span className="block max-w-64 truncate text-xs" title={t.notes ?? ''}>{t.notes ?? ''}</span> },
    {
      key: 'channel', header: 'Paid via', hideOnMobile: true,
      cell: (t) => (
        <span className="text-xs">
          {t.payment_channel ? PAYMENT_CHANNEL[t.payment_channel] : '—'}
          {!t.is_cash && <Badge variant="neutral" className="ml-1">non-cash</Badge>}
        </span>
      ),
    },
    {
      key: 'source', header: 'Source', hideOnMobile: true,
      cell: (t) => (
        <div className="flex flex-wrap gap-1">
          <Badge variant={t.source === 'MANUAL' ? 'secondary' : 'neutral'}>{t.source === 'MANUAL' ? 'manual' : 'automatic'}</Badge>
          {t.reverses_id && <Badge variant="warning">reversal</Badge>}
          {t.reversed && <Badge variant="neutral">reversed</Badge>}
        </div>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', cell: (t) => <Money value={t.amount} className={Number(t.amount) < 0 ? 'text-red-600' : t.reversed ? 'text-muted-foreground line-through' : ''} /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (t) => can('finance.manage') && reversible(t) ? (
        <Button size="icon-sm" variant="ghost" title="Reverse" aria-label={`Reverse ${t.txn_number}`} onClick={(e) => { e.stopPropagation(); setReversing(t) }}><Undo2 /></Button>
      ) : null,
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title={type === 'INCOME' ? 'Income' : 'Expenses'}
        description={type === 'INCOME'
          ? 'Sales, delivery charges and payments are posted automatically. Add other income by hand.'
          : 'Courier charges, refunds and ad spend are posted automatically. Add rent, salaries and other costs here.'}
        actions={
          <>
            {can('reports.export') && <Button size="sm" variant="outline" onClick={exportCsv} disabled={exporting}><Download /> Export CSV</Button>}
            <Can permission="finance.manage"><Button size="sm" onClick={() => update({ new: '1' }, { resetPage: false })}><Plus /> Add {noun}</Button></Can>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={setRange} />
        <Select value={state.category || 'all'} onValueChange={(v) => update({ category: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(categories.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Number, reference or note" />
      </div>
      <DataTable
        columns={columns}
        rows={txns.data?.items}
        rowKey={(t) => t.id}
        loading={txns.isFetching}
        error={txns.error}
        onRetry={() => txns.refetch()}
        empty={<EmptyState title={`No ${noun} in this period`} />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={txns.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />}
      />

      {can('finance.manage') && (
        <TransactionDialog
          type={type}
          open={state.new === '1'}
          onOpenChange={(o) => !o && update({ new: '' }, { resetPage: false })}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ['finance'] })}
        />
      )}
      <ConfirmDialog
        open={reversing !== null}
        onOpenChange={(o) => !o && setReversing(null)}
        title={`Reverse ${reversing?.txn_number ?? ''}?`}
        description={<>A new entry of <Money value={-Number(reversing?.amount ?? 0)} /> is added today. The original stays in the ledger for the audit trail.</>}
        confirmLabel="Reverse entry"
        destructive
        reason
        reasonRequired
        onConfirm={async (reason) => {
          await reverseTransaction(reversing!.id, reason)
          toast.success('Entry reversed')
          void queryClient.invalidateQueries({ queryKey: ['finance'] })
        }}
      />
    </div>
  )
}

const schema = z.object({
  category_id: z.string().min(1, 'Choose a category'),
  amount: z.coerce.number<string | number>().positive('Enter an amount greater than zero'),
  txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'),
  payment_channel: z.string().nullable(),
  reference: z.string().trim().max(200),
  notes: z.string().trim().max(1000),
  supplier_id: z.string().nullable(),
  is_cash: z.boolean(),
})
type Values = z.input<typeof schema>
type Parsed = z.output<typeof schema>

function TransactionDialog({ type, open, onOpenChange, onSaved }: { type: Enums<'finance_type'>; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const categories = useQuery({ queryKey: ['finance-categories', type], queryFn: () => listCategories(type), enabled: open })
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: listSuppliers, enabled: open && type === 'EXPENSE' })
  const manual = (categories.data ?? []).filter((c) => c.is_active && c.allow_manual)
  const defaults: Values = { category_id: '', amount: '', txn_date: isoDateToday(), payment_channel: 'CASH', reference: '', notes: '', supplier_id: null, is_cash: true }
  const form = useForm<Values, unknown, Parsed>({ resolver: zodResolver(schema), defaultValues: defaults })
  useEffect(() => {
    if (open) form.reset({ ...defaults, txn_date: isoDateToday() })
  }, [open])
  const categoryId = form.watch('category_id')
  const category = manual.find((c) => c.id === categoryId)

  const save = useMutation({
    mutationFn: (v: Parsed) => createTransaction({
      type, category_id: v.category_id, amount: v.amount, txn_date: v.txn_date,
      payment_channel: v.payment_channel as PaymentChannel | null, reference: v.reference || null, notes: v.notes || null,
      supplier_id: v.supplier_id, is_cash: v.is_cash,
    }),
    onSuccess: (row) => {
      toast.success(`${type === 'INCOME' ? 'Income' : 'Expense'} ${row.txn_number} saved`)
      onOpenChange(false)
      onSaved()
    },
  })
  const errors = form.formState.errors

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={type === 'INCOME' ? 'Add income' : 'Add expense'}
      submitLabel="Save"
      busy={save.isPending}
      onSubmit={form.handleSubmit((v) => save.mutate(v))}
    >
      <Field label="Category" required error={errors.category_id?.message} hint={category?.description ?? undefined}>
        <Controller control={form.control} name="category_id" render={({ field }) => (
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger aria-invalid={!!errors.category_id}><SelectValue placeholder="Choose a category" /></SelectTrigger>
            <SelectContent>{manual.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        )} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount" htmlFor="txn-amount" required error={errors.amount?.message}>
          <Input id="txn-amount" type="number" inputMode="decimal" min="0" step="0.01" {...form.register('amount')} />
        </Field>
        <Field label="Date" htmlFor="txn-date" required error={errors.txn_date?.message}>
          <Input id="txn-date" type="date" max={isoDateToday()} {...form.register('txn_date')} />
        </Field>
        <Field label={type === 'INCOME' ? 'Received via' : 'Paid via'} htmlFor="txn-channel">
          <Controller control={form.control} name="payment_channel" render={({ field }) => (
            <ChannelSelect id="txn-channel" allowNone value={field.value as PaymentChannel | null} onChange={field.onChange} />
          )} />
        </Field>
        <Field label="Reference" htmlFor="txn-ref" hint="Invoice, receipt or transaction ID">
          <Input id="txn-ref" {...form.register('reference')} />
        </Field>
      </div>
      {type === 'EXPENSE' && (
        <Field label="Supplier" hint="Optional">
          <Controller control={form.control} name="supplier_id" render={({ field }) => (
            <Select value={field.value ?? 'none'} onValueChange={(v) => field.onChange(v === 'none' ? null : v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No supplier</SelectItem>
                {(suppliers.data ?? []).filter((s) => s.is_active).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )} />
        </Field>
      )}
      <Field label="Notes" htmlFor="txn-notes"><Textarea id="txn-notes" rows={2} {...form.register('notes')} /></Field>
      <Controller control={form.control} name="is_cash" render={({ field }) => (
        <label className="flex items-start gap-3 text-sm">
          <Switch checked={field.value} onCheckedChange={field.onChange} className="mt-0.5" />
          <span>
            Money {type === 'INCOME' ? 'was received' : 'was paid'} now
            <span className="block text-xs text-muted-foreground">Turn off for accruals (e.g. a bill you will pay later). Non-cash entries count in profit &amp; loss but not in cash flow.</span>
          </span>
        </label>
      )} />
    </FormDialog>
  )
}
