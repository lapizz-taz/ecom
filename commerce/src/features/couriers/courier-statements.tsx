import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, FileDown, FileUp, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { Pagination } from '@/components/common/pagination'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatMoney, toNumber } from '@/lib/format'
import { COURIER_INVOICE_STATUS } from '@/lib/status'
import { cn } from '@/lib/utils'
import {
  type CourierInvoiceDetail, type CourierInvoiceRow, type CourierInvoiceStatus, getCourierInvoice, importCourierInvoice, listCourierInvoices,
  listCouriers, setCourierInvoiceStatus, statementFileUrl, uploadStatementFile,
} from '@/services/couriers'
import {
  type ColumnMapping, findHeaderRow, guessMapping, readStatementFile, STATEMENT_FIELDS, type StatementField, toLines,
} from './statement-parse'

function Difference({ value, className }: { value: number | string; className?: string }) {
  const n = toNumber(value)
  if (Math.abs(n) < 1) return <span className={cn('text-emerald-700', className)}>Matches</span>
  return <span className={cn('font-medium text-red-700', className)}>{n > 0 ? '+' : '−'}{formatMoney(Math.abs(n))}</span>
}

/** Courier statements: upload, compare with our parcels, verify and record the payout. */
export function CourierStatements() {
  const { can } = useAuth()
  const [state, update] = useUrlState({ courier: '', sstatus: '', page: '1', statement: '' })
  const page = Number(state.page) || 1
  const [uploading, setUploading] = useState(false)
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const invoices = useQuery({
    queryKey: ['courier-invoices', state.courier, state.sstatus, page],
    placeholderData: keepPreviousData,
    queryFn: () => listCourierInvoices({ courierId: state.courier || undefined, status: state.sstatus as CourierInvoiceStatus, page, pageSize: 25 }),
  })
  const columns: Column<CourierInvoiceRow>[] = [
    {
      key: 'statement', header: 'Statement', primary: true,
      cell: (i) => (
        <span>
          <span className="font-medium">{i.invoice_number ?? 'No number'}</span>
          <span className="block text-xs text-muted-foreground">{i.couriers?.name} · {formatDate(i.invoice_date ?? i.created_at)}</span>
        </span>
      ),
    },
    {
      key: 'lines', header: 'Parcels', align: 'right', hideOnMobile: true,
      cell: (i) => (
        <span>{i.line_count}{i.line_count - i.matched_count > 0 && <span className="block text-xs text-red-700">{i.line_count - i.matched_count} flagged</span>}</span>
      ),
    },
    { key: 'expected', header: 'Expected payout', align: 'right', hideOnMobile: true, cell: (i) => <Money value={i.payout_expected} muted /> },
    { key: 'reported', header: 'Statement payout', align: 'right', cell: (i) => <Money value={i.payout_reported} /> },
    { key: 'diff', header: 'Difference', align: 'right', cell: (i) => <Difference value={i.difference ?? 0} /> },
    { key: 'status', header: 'Status', cell: (i) => <StatusBadge value={i.status} map={COURIER_INVOICE_STATUS} /> },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={state.courier || 'all'} onValueChange={(v) => update({ courier: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All couriers</SelectItem>{(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={state.sstatus || 'all'} onValueChange={(v) => update({ sstatus: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(COURIER_INVOICE_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {can('couriers.manage') && <Button size="sm" className="ml-auto" onClick={() => setUploading(true)}><FileUp /> Upload statement</Button>}
      </div>
      <DataTable columns={columns} rows={invoices.data?.items} rowKey={(i) => i.id} loading={invoices.isFetching} error={invoices.error}
        onRetry={() => invoices.refetch()} onRowClick={(i) => update({ statement: i.id }, { resetPage: false })}
        empty={<EmptyState title="No statements yet" description="Upload a courier invoice or payment statement (CSV or Excel) to check it against your parcels." />}
        footer={<Pagination page={page} pageSize={25} total={invoices.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />
      {uploading && <UploadStatementDialog onClose={() => setUploading(false)} onImported={(id) => { setUploading(false); update({ statement: id }, { resetPage: false }) }} />}
      {state.statement && <StatementDetail id={state.statement} onClose={() => update({ statement: '' }, { resetPage: false })} />}
    </div>
  )
}

function UploadStatementDialog({ onClose, onImported }: { onClose: () => void; onImported: (id: string) => void }) {
  const queryClient = useQueryClient()
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers(true) })
  const [courierId, setCourierId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<string[][]>([])
  const [headerRow, setHeaderRow] = useState(0)
  const [mapping, setMapping] = useState<ColumnMapping>({})
  const [readError, setReadError] = useState<string | null>(null)
  const [meta, setMeta] = useState({ invoice_number: '', invoice_date: '', payout: '', notes: '' })
  const courier = courierId || couriers.data?.find((c) => c.provider === 'pathao' || /pathao/i.test(c.name))?.id || couriers.data?.[0]?.id || ''
  const headers = rows[headerRow] ?? []
  const parsed = useMemo(() => (rows.length ? toLines(rows, headerRow, mapping) : null), [rows, headerRow, mapping])
  const hasRef = mapping.consignment_id !== undefined || mapping.order_ref !== undefined

  async function pick(f: File | undefined) {
    setReadError(null)
    setFile(f ?? null)
    setRows([])
    if (!f) return
    try {
      const data = await readStatementFile(f)
      if (data.length < 2) throw new Error('The file has no rows to import')
      const h = findHeaderRow(data)
      setRows(data)
      setHeaderRow(h)
      setMapping(guessMapping(data[h]))
    } catch (e) {
      setReadError((e as Error).message)
    }
  }

  const submit = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (!parsed || !file) throw new Error('Choose a file first')
      if (parsed.errors.length) throw new Error(parsed.errors[0])
      const path = await uploadStatementFile(courier, file)
      return importCourierInvoice({
        courier_id: courier,
        invoice_number: meta.invoice_number.trim() || undefined,
        invoice_date: meta.invoice_date || undefined,
        payout_reported: meta.payout.trim() === '' ? null : Number(meta.payout),
        file_path: path,
        file_name: file.name,
        notes: meta.notes.trim() || undefined,
        lines: parsed.lines,
      })
    },
    onSuccess: (r) => {
      const flagged = r.mismatched + r.unmatched + r.duplicates
      ;(flagged || Math.abs(r.difference) >= 1 ? toast.warning : toast.success)(
        flagged ? `Imported ${r.lines} parcels · ${flagged} need a look` : `Imported ${r.lines} parcels · everything matches`)
      void queryClient.invalidateQueries({ queryKey: ['courier-invoices'] })
      onImported(r.invoice_id)
    },
  })

  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Upload courier statement" wide submitLabel="Check and import"
      busy={submit.isPending} disabled={!parsed || !parsed.lines.length || !hasRef || !courier || parsed.errors.length > 0} onSubmit={() => submit.mutate()}
      description="CSV or Excel from the courier's panel (e.g. Pathao payment invoice). Each line is matched to your parcel by consignment ID or order number and compared with what you expected.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Courier">
          <Select value={courier} onValueChange={setCourierId}>
            <SelectTrigger><SelectValue placeholder="Choose courier" /></SelectTrigger>
            <SelectContent>{(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Statement file" htmlFor="st-file">
          <Input id="st-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => void pick(e.target.files?.[0])} />
        </Field>
      </div>
      {readError && <p className="flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{readError}</p>}
      {rows.length > 0 && (
        <>
          <div className="rounded-lg border p-3">
            <p className="mb-2 text-sm font-medium">Columns <span className="font-normal text-muted-foreground">· detected from row {headerRow + 1}, change if needed</span></p>
            <div className="grid gap-2 sm:grid-cols-3">
              {STATEMENT_FIELDS.map((f) => (
                <Field key={f.key} label={f.label}>
                  <Select value={mapping[f.key] === undefined ? 'none' : String(mapping[f.key])}
                    onValueChange={(v) => setMapping((m) => ({ ...m, [f.key]: v === 'none' ? undefined : Number(v) }) as Record<StatementField, number>)}>
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— not in file —</SelectItem>
                      {headers.map((h, i) => <SelectItem key={i} value={String(i)}>{h || `Column ${i + 1}`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
              ))}
            </div>
            {!hasRef && <p className="mt-2 text-sm text-red-700">Choose the consignment ID or order number column.</p>}
          </div>
          {parsed && (
            <div className="text-sm">
              <p><strong>{parsed.lines.length}</strong> parcels found{parsed.skipped ? ` · ${parsed.skipped} total/blank rows skipped` : ''}</p>
              {parsed.errors.slice(0, 3).map((e) => <p key={e} className="text-red-700">{e}</p>)}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Statement / invoice no." htmlFor="st-no"><Input id="st-no" value={meta.invoice_number} onChange={(e) => setMeta((m) => ({ ...m, invoice_number: e.target.value }))} /></Field>
            <Field label="Date" htmlFor="st-date"><Input id="st-date" type="date" value={meta.invoice_date} onChange={(e) => setMeta((m) => ({ ...m, invoice_date: e.target.value }))} /></Field>
            <Field label="Total payout (optional)" htmlFor="st-payout" hint="Empty: the payout column, or COD minus fees">
              <Input id="st-payout" type="number" step="0.01" value={meta.payout} onChange={(e) => setMeta((m) => ({ ...m, payout: e.target.value }))} />
            </Field>
          </div>
          <Field label="Notes" htmlFor="st-notes"><Textarea id="st-notes" rows={2} value={meta.notes} onChange={(e) => setMeta((m) => ({ ...m, notes: e.target.value }))} /></Field>
        </>
      )}
      {submit.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{submit.error.message}</p>}
    </FormDialog>
  )
}

type Line = CourierInvoiceDetail['courier_invoice_lines'][number]

const MATCH: Record<string, { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  MATCHED: { label: 'Matches', variant: 'success' },
  MISMATCH: { label: 'Differs', variant: 'warning' },
  UNMATCHED: { label: 'Unknown parcel', variant: 'danger' },
  DUPLICATE: { label: 'Duplicate', variant: 'danger' },
}

function Compare({ actual, expected }: { actual: number | string | null; expected: number | string | null }) {
  if (actual === null) return <span className="text-muted-foreground">—</span>
  const differs = expected !== null && Math.abs(toNumber(actual) - toNumber(expected)) >= 1
  return (
    <span className={cn(differs && 'font-medium text-red-700')}>
      <Money value={actual} />
      {differs && <span className="block text-xs font-normal text-muted-foreground">expected <Money value={expected} /></span>}
    </span>
  )
}

function StatementDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<'flagged' | 'all'>('flagged')
  const [paying, setPaying] = useState(false)
  const [paid, setPaid] = useState({ amount: '', reference: '' })
  const invoice = useQuery({ queryKey: ['courier-invoice', id], queryFn: () => getCourierInvoice(id) })
  const status = useMutation({
    mutationFn: (args: { status: CourierInvoiceStatus; amountPaid?: number; reference?: string }) =>
      setCourierInvoiceStatus(id, args.status, { amountPaid: args.amountPaid, reference: args.reference }),
    onSuccess: (_d, v) => {
      toast.success(v.status === 'PAID' ? 'Payout recorded — COD marked received on each order' : `Marked ${COURIER_INVOICE_STATUS[v.status].label.toLowerCase()}`)
      setPaying(false)
      void queryClient.invalidateQueries({ queryKey: ['courier-invoice', id] })
      void queryClient.invalidateQueries({ queryKey: ['courier-invoices'] })
      void queryClient.invalidateQueries({ queryKey: ['courier-metrics'] })
    },
  })
  const file = useMutation({
    mutationFn: (path: string) => statementFileUrl(path),
    onSuccess: (url) => window.open(url, '_blank', 'noopener'),
  })

  const inv = invoice.data
  const lines = (inv?.courier_invoice_lines ?? []).filter((l) => filter === 'all' || l.match_status !== 'MATCHED')
  const locked = inv?.status === 'PAID'
  const columns: Column<Line>[] = [
    {
      key: 'parcel', header: 'Parcel', primary: true,
      cell: (l) => (
        <span>
          <span className="font-mono text-xs">{l.consignment_id ?? '—'}</span>
          {l.orders ? <Link to={`/admin/orders/${l.orders.id}`} className="block text-xs font-medium hover:underline">{l.orders.order_number}</Link>
            : <span className="block text-xs text-muted-foreground">{l.order_ref ?? ''}</span>}
        </span>
      ),
    },
    { key: 'status', header: 'Courier status', hideOnMobile: true, cell: (l) => <span className="text-xs">{l.courier_status ?? '—'}</span> },
    { key: 'cod', header: 'Collected', align: 'right', cell: (l) => <Compare actual={l.cod_collected} expected={l.expected_cod} /> },
    { key: 'del', header: 'Delivery', align: 'right', cell: (l) => <Compare actual={l.delivery_fee} expected={l.expected_delivery_fee} /> },
    { key: 'ret', header: 'Return', align: 'right', hideOnMobile: true, cell: (l) => <Compare actual={l.return_fee} expected={l.expected_return_fee} /> },
    { key: 'codfee', header: 'COD fee', align: 'right', hideOnMobile: true, cell: (l) => <Compare actual={l.cod_fee} expected={l.expected_cod_fee} /> },
    { key: 'other', header: 'Other', align: 'right', hideOnMobile: true, cell: (l) => <Compare actual={l.other_fee} expected={l.other_fee === null ? null : 0} /> },
    {
      key: 'match', header: 'Check',
      cell: (l) => (
        <span className="space-y-1">
          <Badge variant={MATCH[l.match_status].variant}>{MATCH[l.match_status].label}</Badge>
          {l.issues.map((i) => <span key={i} className="block text-xs text-muted-foreground">{i}</span>)}
        </span>
      ),
    },
  ]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-5xl">
        {invoice.isLoading ? <LoadingState /> : invoice.error ? <ErrorState error={invoice.error} onRetry={() => invoice.refetch()} /> : inv && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {inv.couriers?.name} statement {inv.invoice_number ?? ''} <StatusBadge value={inv.status} map={COURIER_INVOICE_STATUS} />
              </DialogTitle>
              <DialogDescription>
                {formatDate(inv.invoice_date ?? inv.created_at)} · {inv.line_count} parcels · {inv.matched_count} match
                {inv.line_count > inv.matched_count ? ` · ${inv.line_count - inv.matched_count} flagged` : ''}
                {inv.paid_at ? ` · paid ${formatDate(inv.paid_at)}${inv.paid_reference ? ` (${inv.paid_reference})` : ''}` : ''}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 sm:grid-cols-4">
              {[
                ['Expected payout', <Money key="e" value={inv.payout_expected} />],
                ['Statement payout', <Money key="r" value={inv.payout_reported} />],
                ['Difference', <Difference key="d" value={inv.difference ?? 0} />],
                [locked ? 'Amount paid' : 'Outstanding', <Money key="p" value={locked ? inv.amount_paid : inv.payout_reported} />],
              ].map(([label, v]) => (
                <div key={label as string} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-lg font-semibold">{v}</p>
                </div>
              ))}
            </div>

            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="py-1 font-normal" /><th className="py-1 text-right font-normal">Statement</th><th className="py-1 text-right font-normal">Our records</th></tr>
              </thead>
              <tbody className="divide-y">
                {([
                  ['COD collected', inv.cod_collected, inv.expected_cod_collected],
                  ['Delivery fees', inv.delivery_fees, inv.expected_delivery_fees],
                  ['Return charges', inv.return_fees, inv.expected_return_fees],
                  ['COD fees', inv.cod_fees, inv.expected_cod_fees],
                  ['Other fees', inv.other_fees, 0],
                ] as const).map(([label, actual, expected]) => (
                  <tr key={label}>
                    <td className="py-1.5">{label}</td>
                    <td className="py-1.5 text-right"><Money value={actual} /></td>
                    <td className={cn('py-1.5 text-right', Math.abs(toNumber(actual) - toNumber(expected)) >= 1 && 'font-medium text-red-700')}><Money value={expected} /></td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex flex-wrap items-center gap-2">
              <Tabs value={filter} onValueChange={(v) => setFilter(v as 'flagged' | 'all')}>
                <TabsList>
                  <TabsTrigger value="flagged">Flagged ({inv.line_count - inv.matched_count})</TabsTrigger>
                  <TabsTrigger value="all">All parcels ({inv.line_count})</TabsTrigger>
                </TabsList>
              </Tabs>
              {inv.file_path && (
                <Button size="sm" variant="ghost" onClick={() => file.mutate(inv.file_path!)} disabled={file.isPending}><FileDown /> Original file</Button>
              )}
            </div>
            <DataTable dense columns={columns} rows={lines} rowKey={(l) => l.id}
              empty={<EmptyState title="Nothing flagged" description="Every parcel on this statement matches your records." />} />

            {inv.notes && <p className="rounded-lg bg-muted/50 p-3 text-sm">{inv.notes}</p>}
            {!locked && (can('couriers.manage') || can('payments.record')) && (
              <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
                {can('couriers.manage') && inv.status !== 'NEEDS_REVIEW' && (
                  <Button variant="ghost" onClick={() => status.mutate({ status: 'NEEDS_REVIEW' })} disabled={status.isPending}>Needs review</Button>
                )}
                {can('couriers.manage') && inv.status !== 'DISCREPANCY' && (
                  <Button variant="outline" onClick={() => status.mutate({ status: 'DISCREPANCY' })} disabled={status.isPending}><AlertTriangle /> Discrepancy</Button>
                )}
                {can('couriers.manage') && inv.status !== 'VERIFIED' && (
                  <Button variant="outline" onClick={() => status.mutate({ status: 'VERIFIED' })} disabled={status.isPending}
                    title="The statement's fees become each parcel's actual courier charges"><CheckCircle2 /> Verified</Button>
                )}
                {can('payments.record') && (
                  <Button onClick={() => { setPaid({ amount: String(inv.payout_reported), reference: '' }); setPaying(true) }}><Wallet /> Mark paid</Button>
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
      {inv && (
        <FormDialog open={paying} onOpenChange={setPaying} title="Record the courier's payout" submitLabel="Record payout" busy={status.isPending}
          disabled={paid.amount === '' || Number(paid.amount) < 0}
          onSubmit={() => status.mutate({ status: 'PAID', amountPaid: Number(paid.amount), reference: paid.reference })}
          description="The statement's fees become the parcels' courier charges, and the cash collected is marked received on each matched order. This cannot be undone.">
          <Field label="Amount received" htmlFor="pay-amt"><Input id="pay-amt" type="number" step="0.01" value={paid.amount} onChange={(e) => setPaid((p) => ({ ...p, amount: e.target.value }))} /></Field>
          <Field label="Reference (bank / bKash TrxID)" htmlFor="pay-ref"><Input id="pay-ref" value={paid.reference} onChange={(e) => setPaid((p) => ({ ...p, reference: e.target.value }))} /></Field>
          {status.isPending && <Spinner />}
        </FormDialog>
      )}
    </Dialog>
  )
}
