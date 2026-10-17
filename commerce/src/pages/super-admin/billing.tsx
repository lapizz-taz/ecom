import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import {
  type BillingControls, billingControls, billingDashboard, billingPayment, type BillingPaymentDetail, checkRefund, PAYMENT_STATUS, type PaymentPurpose,
  type PaymentStatus, PURPOSE_LABEL, recheckPayment, reconcilePayments, refundPayment, resolveBillingReview, saveBillingControls,
} from '@/services/billing-payments'

const iso = (d: Date) => d.toISOString().slice(0, 10)
const PAGE = 50
const err = (e: unknown) => toast.error((e as Error).message)

export default function PlatformBillingPage() {
  const [state, update] = useUrlState({ tab: 'payments' })
  return (
    <div className="space-y-5">
      <PageHeader title="Billing" description="Every payment stores make to Fullfilio: what was collected, what is waiting, refunds, checks with the gateway, and prices." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="reconcile">Reconciliation</TabsTrigger>
          <TabsTrigger value="prices">Prices & limits</TabsTrigger>
        </TabsList>
        <TabsContent value="payments"><Payments /></TabsContent>
        <TabsContent value="reconcile"><Reconcile /></TabsContent>
        <TabsContent value="prices"><Prices /></TabsContent>
      </Tabs>
    </div>
  )
}

function Payments() {
  const [range, setRange] = useState(() => ({ from: iso(new Date(Date.now() - 29 * 86_400_000)), to: iso(new Date()) }))
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [purpose, setPurpose] = useState('all')
  const [review, setReview] = useState(false)
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => setPage(0), [range, q, status, purpose, review])
  const filters = { from: range.from || undefined, to: range.to || undefined, q: q.trim() || undefined, status: status === 'all' ? undefined : status,
    purpose: purpose === 'all' ? undefined : purpose, review: review || undefined, limit: PAGE, offset: page * PAGE }
  const d = useQuery({ queryKey: ['platform-billing', filters], queryFn: () => billingDashboard(filters), placeholderData: (p) => p })
  if (d.error) return <ErrorState error={d.error} onRetry={() => d.refetch()} />
  if (!d.data) return <LoadingState />
  const t = d.data.totals
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Collected" value={formatMoney(t.collected)} hint={`${formatNumber(t.succeeded_count)} payments, after refunds`} tone="positive" />
        <StatCard label="Pending" value={formatMoney(t.pending)} hint={`${formatNumber(t.pending_count)} waiting for the gateway`} />
        <StatCard label="Failed" value={formatMoney(t.failed)} hint={`${formatNumber(t.failed_count)} failed · ${formatNumber(t.cancelled_count)} cancelled · ${formatNumber(t.expired_count)} expired`} />
        <StatCard label="Refunded" value={formatMoney(t.refunded)} hint={`${formatNumber(t.refunded_count)} payments`} />
        <StatCard label="Needs review" value={formatNumber(t.review_count)} hint="Amount, transaction or gateway disagreed" tone={t.review_count > 0 ? 'warning' : 'default'} />
      </div>
      <Card>
        <CardContent className="flex flex-wrap gap-x-6 gap-y-2 py-3 text-sm">
          {(['SUBSCRIPTION', 'SMS', 'BALANCE', 'COURIER'] as PaymentPurpose[]).map((p) => (
            <span key={p}><span className="text-muted-foreground">{PURPOSE_LABEL[p]}</span> <span className="font-medium tabular-nums">{formatMoney(d.data.by_purpose[p] ?? 0)}</span></span>
          ))}
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} />
        <SearchInput value={q} onChange={setQ} placeholder="Store, reference, invoice or bKash transaction" className="min-w-56 flex-1 sm:max-w-sm" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every status</SelectItem>
            {(Object.keys(PAYMENT_STATUS) as PaymentStatus[]).map((s) => <SelectItem key={s} value={s}>{PAYMENT_STATUS[s].label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={purpose} onValueChange={setPurpose}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everything bought</SelectItem>
            {(Object.keys(PURPOSE_LABEL) as PaymentPurpose[]).map((p) => <SelectItem key={p} value={p}>{PURPOSE_LABEL[p]}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={review} onCheckedChange={(v) => setReview(v === true)} /> Needs review</label>
      </div>
      <Card>
        <CardContent className="p-0">
          {d.data.rows.length === 0 ? <EmptyState title="No payments" description="Nothing matches these filters." /> : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead><TableHead>Store</TableHead><TableHead>For</TableHead><TableHead>Reference</TableHead>
                    <TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.data.rows.map((r) => (
                    <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpen(r.id)}>
                      <TableCell className="whitespace-nowrap text-sm">{formatDateTime(r.created_at)}</TableCell>
                      <TableCell className="text-sm">{r.merchant.name}<span className="block text-xs text-muted-foreground">#{r.merchant.number}</span></TableCell>
                      <TableCell className="text-sm">{r.purpose ? PURPOSE_LABEL[r.purpose] : '—'}<span className="block text-xs text-muted-foreground">{r.provider === 'bkash' ? 'bKash' : r.provider ?? r.method}</span></TableCell>
                      <TableCell className="font-mono text-xs">{r.reference}<span className="block text-muted-foreground">{r.transaction ?? r.invoice_number}</span></TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(r.amount)}{r.refunded_amount > 0 && <span className="block text-xs text-muted-foreground">−{formatMoney(r.refunded_amount)}</span>}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant={PAYMENT_STATUS[r.status].variant}>{PAYMENT_STATUS[r.status].label}</Badge>
                          {r.needs_review && <Badge variant="warning"><AlertTriangle className="size-3" /> Review</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {d.data.count > PAGE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{formatNumber(page * PAGE + 1)}–{formatNumber(Math.min((page + 1) * PAGE, d.data.count))} of {formatNumber(d.data.count)}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={(page + 1) * PAGE >= d.data.count} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
      {open && <PaymentDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function PaymentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const d = useQuery({ queryKey: ['platform-billing-payment', id], queryFn: () => billingPayment(id) })
  const [refunding, setRefunding] = useState(false)
  const [resolving, setResolving] = useState(false)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['platform-billing-payment', id] })
    void qc.invalidateQueries({ queryKey: ['platform-billing'] })
  }
  const recheck = useMutation({
    mutationFn: () => recheckPayment(id),
    onSuccess: (r) => { toast.success(`Gateway: ${r.gateway} · ${r.result.replace(/_/g, ' ')}`); refresh() },
    onError: err,
  })
  const refundCheck = useMutation({
    mutationFn: (refundId: string) => checkRefund(refundId),
    onSuccess: (r) => { toast.success(`Refund ${r.status}${r.message ? ` — ${r.message}` : ''}`); refresh() },
    onError: err,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Payment</DialogTitle></DialogHeader>
        {d.error ? <ErrorState error={d.error} /> : !d.data ? <LoadingState /> : <PaymentBody d={d.data} actions={(
          <div className="flex flex-wrap gap-2">
            {d.data.can_manage && d.data.payment.method === 'GATEWAY' && d.data.payment.provider_session && (
              <Button size="sm" variant="outline" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
                {recheck.isPending ? <Spinner /> : <RefreshCw />} Re-check with {d.data.payment.provider === 'bkash' ? 'bKash' : 'the gateway'}
              </Button>
            )}
            {d.data.can_refund && d.data.payment.status === 'SUCCEEDED' && (
              <Button size="sm" variant="outline" onClick={() => setRefunding(true)}><RotateCcw /> Refund</Button>
            )}
            {d.data.can_manage && d.data.payment.needs_review && <Button size="sm" onClick={() => setResolving(true)}>Mark reviewed</Button>}
            {d.data.refunds.filter((r) => r.status === 'PROCESSING' && r.method === 'GATEWAY').map((r) => (
              <Button key={r.id} size="sm" variant="outline" disabled={refundCheck.isPending} onClick={() => refundCheck.mutate(r.id)}>Check refund {formatMoney(r.amount)}</Button>
            ))}
          </div>
        )} />}
        {refunding && d.data && <RefundDialog d={d.data} onClose={() => setRefunding(false)} onDone={refresh} />}
        {resolving && <ResolveDialog id={id} onClose={() => setResolving(false)} onDone={refresh} />}
      </DialogContent>
    </Dialog>
  )
}

function PaymentBody({ d, actions }: { d: BillingPaymentDetail; actions: React.ReactNode }) {
  const p = d.payment
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xl font-semibold tabular-nums">{formatMoney(p.amount)}</p>
          <p className="text-muted-foreground"><Link to={`/super-admin/merchants/${d.merchant.id}`} className="underline-offset-2 hover:underline">{d.merchant.name}</Link> · #{d.merchant.number}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant={PAYMENT_STATUS[p.status].variant}>{PAYMENT_STATUS[p.status].label}</Badge>
          {p.needs_review && <Badge variant="warning">Needs review</Badge>}
        </div>
      </div>
      {p.review_note && <p className={`rounded-[10px] px-3 py-2 ${p.needs_review ? 'bg-amber-500/10' : 'bg-muted'}`}>{p.review_note}</p>}
      {actions}
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">For</dt><dd>{p.purpose ? PURPOSE_LABEL[p.purpose] : '—'} · invoice <span className="font-mono">{d.invoice.number}</span> ({d.invoice.status.toLowerCase()})</dd>
        <dt className="text-muted-foreground">Reference</dt><dd className="font-mono">{p.reference}</dd>
        <dt className="text-muted-foreground">Gateway</dt><dd>{p.provider === 'bkash' ? 'bKash' : p.provider ?? p.method}{p.provider_session && <span className="font-mono text-xs text-muted-foreground"> · {p.provider_session}</span>}</dd>
        <dt className="text-muted-foreground">Transaction</dt><dd className="font-mono">{p.provider_txn_id ?? '—'}</dd>
        <dt className="text-muted-foreground">Started</dt><dd>{formatDateTime(p.created_at)}</dd>
        <dt className="text-muted-foreground">Verified</dt><dd>{p.verified_at ? formatDateTime(p.verified_at) : '—'}</dd>
        {p.status_reason && <><dt className="text-muted-foreground">Reason</dt><dd>{p.status_reason}</dd></>}
        {p.refunded_amount > 0 && <><dt className="text-muted-foreground">Refunded</dt><dd>{formatMoney(p.refunded_amount)}</dd></>}
      </dl>
      <div className="divide-y rounded-[10px] border">
        {d.invoice.lines.map((l, i) => <div key={i} className="flex justify-between gap-3 px-3 py-2"><span>{l.label}</span><span className="tabular-nums">{formatMoney(l.amount)}</span></div>)}
      </div>
      <Section title="Checks with the gateway" empty="No checks recorded yet.">
        {d.checks.map((c) => (
          <div key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
            <span><Badge variant={c.outcome === 'succeeded' || c.outcome === 'matches' ? 'success' : /mismatch|duplicate|error|flag/.test(c.outcome) ? 'warning' : 'neutral'}>{c.outcome.replace(/_/g, ' ')}</Badge>
              <span className="ml-2 text-xs text-muted-foreground">{c.source.toLowerCase()}{c.gateway_status ? ` · gateway: ${c.gateway_status}` : ''}{c.txn ? ` · ${c.txn}` : ''}{typeof c.detail?.reason === 'string' ? ` · ${c.detail.reason}` : ''}{typeof c.detail?.error === 'string' ? ` · ${c.detail.error}` : ''}{typeof c.detail?.note === 'string' ? ` · ${c.detail.note}` : ''}</span></span>
            <span className="text-xs text-muted-foreground">{formatDateTime(c.created_at)}</span>
          </div>
        ))}
      </Section>
      <Section title="Refunds" empty="No refunds.">
        {d.refunds.map((r) => (
          <div key={r.id} className="py-1.5">
            <div className="flex flex-wrap justify-between gap-2">
              <span><span className="font-medium tabular-nums">{formatMoney(r.amount)}</span> <Badge variant={r.status === 'SUCCEEDED' ? 'success' : r.status === 'FAILED' ? 'danger' : 'warning'}>{r.status.toLowerCase()}</Badge> <span className="text-xs text-muted-foreground">{r.method === 'MANUAL' ? 'recorded (returned outside Fullfilio)' : 'through the gateway'}</span></span>
              <span className="text-xs text-muted-foreground">{formatDateTime(r.created_at)}{r.requested_by ? ` · ${r.requested_by}` : ''}</span>
            </div>
            <p className="text-xs text-muted-foreground">{r.reason}{r.credits_reversed > 0 ? ` · ${formatNumber(r.credits_reversed)} credits taken back` : ''}{r.credits_short > 0 ? ` · ${formatNumber(r.credits_short)} already spent` : ''}{r.error ? ` · ${r.error}` : ''}</p>
          </div>
        ))}
      </Section>
      <Section title="Credits from this payment" empty="This payment did not add credits.">
        {d.credits.map((c) => (
          <div key={c.id} className="flex justify-between gap-2 py-1.5"><span>{c.reason} <span className="text-xs text-muted-foreground">· {c.credit_type.toLowerCase()} · {formatDateTime(c.created_at)}</span></span>
            <span className={`tabular-nums ${c.amount > 0 ? 'text-emerald-600' : ''}`}>{c.amount > 0 ? '+' : ''}{formatNumber(c.amount)}</span></div>
        ))}
      </Section>
      {d.gateway_answer != null && (
        <details className="rounded-[10px] border px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">What the gateway answered (phone numbers and tokens removed)</summary>
          <pre className="mt-2 max-h-60 overflow-auto text-xs">{JSON.stringify(d.gateway_answer, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      {children.length === 0 ? <p className="text-muted-foreground">{empty}</p> : <div className="divide-y">{children}</div>}
    </div>
  )
}

function RefundDialog({ d, onClose, onDone }: { d: BillingPaymentDetail; onClose: () => void; onDone: () => void }) {
  const left = d.payment.amount - d.payment.refunded_amount
  const gatewayRefund = d.payment.provider === 'bkash' && !!d.payment.provider_txn_id
  const [amount, setAmount] = useState(String(left))
  const [reason, setReason] = useState('')
  const [manual, setManual] = useState(!gatewayRefund)
  const [reverse, setReverse] = useState(true)
  const save = useMutation({
    mutationFn: () => refundPayment({ payment_id: d.payment.id, amount: Number(amount), reason: reason.trim(), manual, reverse_credits: reverse }),
    onSuccess: (r) => {
      if (r.status === 'succeeded') toast.success(`Refunded${r.credits_reversed ? ` · ${formatNumber(r.credits_reversed)} credits taken back` : ''}${r.credits_short ? ` · ${formatNumber(r.credits_short)} were already spent` : ''}`)
      else if (r.status === 'processing') toast.warning(r.message ?? 'The gateway is still working on the refund; check it again in a few minutes.')
      else toast.error(r.error ?? 'The refund did not go through')
      onDone(); onClose()
    },
    onError: err,
  })
  const n = Number(amount)
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Refund payment" submitLabel={manual ? 'Record refund' : `Refund ${formatMoney(n || 0)} through bKash`}
      busy={save.isPending} destructive disabled={!(n > 0 && n <= left) || reason.trim().length < 5} onSubmit={() => save.mutate()}
      description={manual ? 'Record money you already returned another way (the gateway\'s own panel, bank). Nothing is sent from here.' : 'The money goes back to the customer\'s bKash account. This cannot be undone.'}>
      <div className="space-y-3">
        <Field label="Amount (Tk)" hint={`Up to ${formatMoney(left)}`}><Input type="number" min={0.01} max={left} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the money goes back" rows={2} /></Field>
        {gatewayRefund && (
          <label className="flex items-center justify-between gap-3 text-sm">Already refunded outside Fullfilio (record only) <Switch checked={manual} onCheckedChange={setManual} /></label>
        )}
        {d.invoice.kind === 'CREDITS' && (
          <label className="flex items-center justify-between gap-3 text-sm">Take the bought credits back (in proportion) <Switch checked={reverse} onCheckedChange={setReverse} /></label>
        )}
        {d.invoice.kind === 'SUBSCRIPTION' && <p className="text-xs text-muted-foreground">The subscription is not changed by a refund. End or change it under Subscriptions & Plans if needed.</p>}
      </div>
    </FormDialog>
  )
}

function ResolveDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('')
  const save = useMutation({ mutationFn: () => resolveBillingReview(id, note.trim()), onSuccess: () => { toast.success('Marked as reviewed'); onDone(); onClose() }, onError: err })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Mark as reviewed" submitLabel="Save" busy={save.isPending} disabled={note.trim().length < 5}
      onSubmit={() => save.mutate()} description="Write what was checked or done (for example: refunded the second charge). It is kept in the audit log.">
      <Field label="What was done" required><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} /></Field>
    </FormDialog>
  )
}

function Reconcile() {
  const [range, setRange] = useState(() => ({ from: iso(new Date(Date.now() - 6 * 86_400_000)), to: iso(new Date()) }))
  const run = useMutation({ mutationFn: () => reconcilePayments(range.from, range.to), onError: err })
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Compare with bKash</CardTitle>
          <CardDescription>
            Asks bKash about every bKash payment in the period (up to 50 at a time). A payment bKash completed that we did not count is applied once; one it never completed is closed;
            one we count as paid that bKash does not is flagged for review — never undone automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <DateRangePicker value={range} onChange={setRange} />
          <Button disabled={run.isPending || !range.from || !range.to} onClick={() => run.mutate()}>{run.isPending ? <Spinner /> : <Search />} Run check</Button>
        </CardContent>
      </Card>
      {run.data && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{formatNumber(run.data.checked)} payments checked</CardTitle>
            <CardDescription>{Object.entries(run.data.counts).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' · ') || 'Nothing to check in this period.'}{run.data.more ? ' · more remain: run again for the rest' : ''}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {run.data.rows.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Reference</TableHead><TableHead>Ours before</TableHead><TableHead>bKash</TableHead><TableHead>Result</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {run.data.rows.map((r) => (
                      <TableRow key={r.reference}>
                        <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                        <TableCell>{PAYMENT_STATUS[r.before as PaymentStatus]?.label ?? r.before}</TableCell>
                        <TableCell>{r.gateway}</TableCell>
                        <TableCell><Badge variant={['matches', 'succeeded'].includes(r.result) ? 'success' : ['flagged', 'error'].includes(r.result) || r.result.includes('mismatch') ? 'warning' : 'neutral'}>{r.result.replace(/_/g, ' ')}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

const list = (v: number[]) => v.join(', ')
const parseList = (s: string) => s.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 8)

function Prices() {
  const qc = useQueryClient()
  const d = useQuery({ queryKey: ['platform-billing-controls'], queryFn: billingControls })
  const [form, setForm] = useState<BillingControls | null>(null)
  const [presets, setPresets] = useState({ SMS: '', COURIER: '', BALANCE: '' })
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (!d.data || form) return
    setForm(d.data.controls)
    setPresets({ SMS: list(d.data.controls.pricing.SMS.presets), COURIER: list(d.data.controls.pricing.COURIER.presets), BALANCE: list(d.data.controls.pricing.BALANCE.presets) })
  }, [d.data, form])
  const save = useMutation({
    mutationFn: () => saveBillingControls({
      ...form!,
      pricing: {
        SMS: { ...form!.pricing.SMS, presets: parseList(presets.SMS) },
        COURIER: { ...form!.pricing.COURIER, presets: parseList(presets.COURIER) },
        BALANCE: { ...form!.pricing.BALANCE, presets: parseList(presets.BALANCE) },
      },
    }, reason.trim()),
    onSuccess: () => { toast.success('Prices and limits saved'); setReason(''); void qc.invalidateQueries({ queryKey: ['platform-billing-controls'] }) },
    onError: err,
  })
  if (d.error) return <ErrorState error={d.error} onRetry={() => d.refetch()} />
  if (!d.data || !form) return <LoadingState />
  const can = d.data.can_manage
  const set = (f: (c: BillingControls) => BillingControls) => setForm((c) => (c ? f(structuredClone(c)) : c))
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0))
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-sm">What stores can pay for online</CardTitle><CardDescription>Switched off, the purchase is hidden and refused by the server.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {(['SUBSCRIPTION', 'SMS', 'BALANCE', 'COURIER'] as const).map((p) => (
            <label key={p} className="flex items-center justify-between gap-3 text-sm">{PURPOSE_LABEL[p]}
              <Switch disabled={!can} checked={form.purposes[p]} onCheckedChange={(v) => set((c) => { c.purposes[p] = v; return c })} /></label>
          ))}
          <Field label="Largest single payment (Tk)"><Input disabled={!can} type="number" min={1} value={form.max_payment_tk} onChange={(e) => set((c) => { c.max_payment_tk = num(e.target.value); return c })} /></Field>
        </CardContent>
      </Card>
      {(['SMS', 'COURIER'] as const).map((t) => {
        const pr = form.pricing[t]
        return (
          <Card key={t}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-sm">{t === 'SMS' ? 'SMS credits' : 'Courier check credits'}
                <Switch disabled={!can} checked={pr.enabled} onCheckedChange={(v) => set((c) => { c.pricing[t].enabled = v; return c })} /></CardTitle>
              <CardDescription>{t === 'SMS' ? 'One credit sends one SMS part (160 characters, or 70 with Bangla).' : 'One credit is one courier history check.'} Price changes apply to new purchases only.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Price per credit (poisha)" hint={`${formatMoney(pr.unit_poisha / 100)} per credit · 1,000 = ${formatMoney((pr.unit_poisha * 1000) / 100)}`}>
                <Input disabled={!can} type="number" min={1} value={pr.unit_poisha} onChange={(e) => set((c) => { c.pricing[t].unit_poisha = num(e.target.value); return c })} />
              </Field>
              <Field label="Quick choices" hint="Comma-separated"><Input disabled={!can} value={presets[t]} onChange={(e) => setPresets((p) => ({ ...p, [t]: e.target.value }))} /></Field>
              <Field label="Fewest per purchase"><Input disabled={!can} type="number" min={1} value={pr.min} onChange={(e) => set((c) => { c.pricing[t].min = num(e.target.value); return c })} /></Field>
              <Field label="Most per purchase"><Input disabled={!can} type="number" min={1} value={pr.max} onChange={(e) => set((c) => { c.pricing[t].max = num(e.target.value); return c })} /></Field>
            </CardContent>
          </Card>
        )
      })}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-sm">Balance top-up
            <Switch disabled={!can} checked={form.pricing.BALANCE.enabled} onCheckedChange={(v) => set((c) => { c.pricing.BALANCE.enabled = v; return c })} /></CardTitle>
          <CardDescription>The Tk balance that pays the fee for each approved order.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Field label="Smallest (Tk)"><Input disabled={!can} type="number" min={1} value={form.pricing.BALANCE.min_tk} onChange={(e) => set((c) => { c.pricing.BALANCE.min_tk = num(e.target.value); return c })} /></Field>
          <Field label="Largest (Tk)"><Input disabled={!can} type="number" min={1} value={form.pricing.BALANCE.max_tk} onChange={(e) => set((c) => { c.pricing.BALANCE.max_tk = num(e.target.value); return c })} /></Field>
          <Field label="Quick choices (Tk)"><Input disabled={!can} value={presets.BALANCE} onChange={(e) => setPresets((p) => ({ ...p, BALANCE: e.target.value }))} /></Field>
        </CardContent>
      </Card>
      {can && (
        <Card className="lg:col-span-2">
          <CardContent className="flex flex-wrap items-end gap-3 py-4">
            <Field label="Reason for the change" required className="min-w-64 flex-1"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="New SMS rate from the provider" /></Field>
            <Button disabled={save.isPending || reason.trim().length < 5} onClick={() => save.mutate()}>{save.isPending && <Spinner />} Save prices & limits</Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
