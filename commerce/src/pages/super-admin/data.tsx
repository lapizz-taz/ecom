import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Database, Download, FileWarning, HardDrive, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, EmptyState, ErrorState, Spinner } from '@/components/common/states'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { MerchantPicker } from '@/features/platform/services/merchant-picker'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { MerchantRef } from '@/services/platform'
import {
  backupStatus, cancelDeletionRequest, createDeletionRequest, type DataOverview, dataOverview, decideDeletionRequest, type DeletionRequest,
  type DeletionStatus, deleteMerchantForRequest, executeDeletionRequest, exportMerchantData, recordRestoreTest, runRetention,
} from '@/services/platform-data'

const M = ({ m }: { m: MerchantRef | null }) => (m ? <Link className="hover:underline" to={`/super-admin/merchants/${m.id}`}>#{m.number} {m.name}</Link> : <span className="text-muted-foreground">Platform</span>)
const DELETION: Record<DeletionStatus, { label: string; variant: BadgeVariant }> = {
  REQUESTED: { label: 'Waiting for approval', variant: 'warning' }, APPROVED: { label: 'Approved', variant: 'info' },
  REJECTED: { label: 'Rejected', variant: 'neutral' }, CANCELLED: { label: 'Cancelled', variant: 'neutral' }, COMPLETED: { label: 'Erased', variant: 'success' },
}
const TABLE_LABEL: Record<string, string> = {
  merchants: 'Merchants', deleted_merchants: 'Deleted merchants (money records kept)', orders: 'Orders', order_items: 'Order items', customers: 'Customers', products: 'Products', shipments: 'Shipments',
  invoices: 'Platform invoices', platform_payments: 'Platform payments', credit_ledger: 'Credit ledger entries', audit_logs: 'Audit log entries',
}
const ERASED = 'Customers’ names, phone numbers, emails, addresses and notes (customers, orders, saved addresses, leads, carts, abandoned checkouts, contact messages, coupon uses, payments, SMS log, fraud checks, call records) and raw payloads from stores, couriers and gateways.'
const DELETES = 'The business and all its data: orders, customers, products and stock, couriers, stores and every connection with its keys, staff, roles, settings, HR, phone system set-up and logs. Logins that belong only to this business are removed, here and from sign-in.'
const DELETE_KEEPS = 'Money records for the accounts — plan, invoices and payments, credits, order fees, metered usage, phone charges — and every audit log, under "Deleted merchant #N" with no contact details.'
const KEPT = 'Order amounts, items, statuses and dates, district and city, invoices, platform payments, credit and PBX ledgers, and both audit logs — needed for accounting. Staff logins are switched off (not deleted).'

function Backups() {
  const q = useQuery({ queryKey: ['platform-data', 'backups'], queryFn: backupStatus, retry: false })
  const d = q.data
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><HardDrive className="size-4" /> Backups</CardTitle>
        <CardDescription>Supabase makes the database backups. The panel reads their status from the Supabase Management API; it cannot start or restore one.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {q.isLoading ? <Spinner /> : q.error ? <p className="text-red-500">{(q.error as Error).message}</p> : !d?.configured ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">Not connected: set <code>MANAGEMENT_API_TOKEN</code> (a Supabase personal access token that can read project {d?.ref}) as an edge function secret to see backup status here. Until then, check Database → Backups in the Supabase dashboard.</p>
        ) : !d.ok ? (
          <p className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs">The Management API refused ({d.status ?? 'no answer'}): {d.error}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <p>Last completed backup: <strong>{d.last_completed ? `${formatDateTime(d.last_completed)} (${timeAgo(d.last_completed)})` : 'none found'}</strong></p>
              <p>Point-in-time recovery: <strong>{d.pitr_enabled ? 'on' : 'off'}</strong></p>
              {d.region && <p className="text-muted-foreground">Region {d.region}</p>}
            </div>
            {(d.backups ?? []).length > 0 && (
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                {d.backups!.slice(0, 10).map((b, i) => <li key={i}>{b.inserted_at ? formatDateTime(b.inserted_at) : '—'} · <span className={/fail/i.test(b.status ?? '') ? 'text-red-500' : ''}>{(b.status ?? 'unknown').toLowerCase()}</span>{b.physical ? ' · physical' : ''}</li>)}
              </ul>
            )}
          </>
        )}
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}>{q.isFetching ? <Spinner /> : <RefreshCw />} Check again</Button>
      </CardContent>
    </Card>
  )
}

function Retention({ d }: { d: DataOverview }) {
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const p = d.retention.policy
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Archive className="size-4" /> Retention</CardTitle>
        <CardDescription>Applied once a day by the platform job. Change the periods under Global Settings.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <ul className="space-y-1">
          <li>Resolved system log entries: kept {p.system_logs_days ?? 90} days · <span className="text-muted-foreground">{formatNumber(d.retention.due.system_logs)} due</span></li>
          <li>Read staff notifications: kept {p.notifications_days ?? 90} days · <span className="text-muted-foreground">{formatNumber(d.retention.due.notifications)} due</span></li>
          <li>Approved data erasure waits {p.deletion_cooling_days ?? 14} days before it can be carried out</li>
          <li className="text-muted-foreground">Kept for good: audit logs, orders, invoices, payments, credit and PBX ledgers, unresolved errors.</li>
        </ul>
        <p className="text-xs text-muted-foreground">{d.retention.last_run ? `Last run ${timeAgo(d.retention.last_run.last_run_at)}: ${d.retention.last_run.system_logs_removed} log entries and ${d.retention.last_run.notifications_removed} notifications removed.` : 'Not run yet.'}</p>
        {d.can.manage && <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>Run now</Button>}
        {confirm && (
          <ConfirmDialog open onOpenChange={setConfirm} title="Apply the retention policy now?" confirmLabel="Run" reason reasonRequired reasonLabel="Why now"
            description={`${d.retention.due.system_logs} resolved log entries and ${d.retention.due.notifications} read notifications past their period are removed. Nothing else is touched.`}
            onConfirm={async (reason) => {
              const r = await runRetention(reason)
              toast.success(`${r.system_logs_removed} log entries and ${r.notifications_removed} notifications removed`)
              void queryClient.invalidateQueries({ queryKey: ['platform-data'] })
            }} />
        )}
      </CardContent>
    </Card>
  )
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [merchant, setMerchant] = useState<MerchantRef | null>(null)
  const [reason, setReason] = useState('')
  const run = useMutation({
    meta: { silent: true },
    mutationFn: () => exportMerchantData(merchant!.id, reason.trim()),
    onSuccess: (r) => {
      const blob = new Blob([JSON.stringify({ exported_at: r.exported_at, export_id: r.export_id, rows: r.rows, ...r.data }, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `merchant-${merchant!.number}-export-${r.exported_at.slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success(`Exported ${Object.values(r.rows).reduce((s, n) => s + n, 0)} records`)
      void queryClient.invalidateQueries({ queryKey: ['platform-data'] })
      onClose()
    },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Export a merchant's data" submitLabel="Export as JSON" busy={run.isPending}
      disabled={!merchant || reason.trim().length < 5} onSubmit={() => run.mutate()}
      description="Customers, products, orders, shipments, invoices, platform payments and the credit ledger, as one file. Credentials are never included. The export is recorded.">
      <Field label="Merchant" required><MerchantPicker value={merchant} onChange={setMerchant} /></Field>
      <Field label="Why" required hint="Kept in the export log and the audit log."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Owner asked for a copy before closing" /></Field>
      {run.error && <p className="text-sm text-red-500" role="alert">{(run.error as Error).message}</p>}
    </FormDialog>
  )
}

function DeletionRequests({ d }: { d: DataOverview }) {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [picked, setPicked] = useState<MerchantRef | null>(null)
  const [reason, setReason] = useState('')
  const [deciding, setDeciding] = useState<{ r: DeletionRequest; approve: boolean } | null>(null)
  const [cancelling, setCancelling] = useState<DeletionRequest | null>(null)
  const [erasing, setErasing] = useState<DeletionRequest | null>(null)
  const [typed, setTyped] = useState('')
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['platform-data'] })
  const create = useMutation({ meta: { silent: true }, mutationFn: () => createDeletionRequest(picked!.id, reason.trim()),
    onSuccess: () => { toast.success('Recorded — it now needs someone else to approve it'); setCreating(false); setPicked(null); setReason(''); void refresh() } })
  const erase = useMutation({ meta: { silent: true }, mutationFn: () => executeDeletionRequest(erasing!.id, typed),
    onSuccess: () => { toast.success('Personal data erased'); setErasing(null); setTyped(''); void refresh() } })
  const [deleting, setDeleting] = useState<DeletionRequest | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const exportNow = useMutation({ meta: { silent: true },
    mutationFn: (r: DeletionRequest) => exportMerchantData(r.merchant.id, `Copy kept before deleting the merchant (request #${r.number})`),
    onSuccess: (x, r) => {
      const blob = new Blob([JSON.stringify({ exported_at: x.exported_at, export_id: x.export_id, rows: x.rows, ...x.data }, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `merchant-${r.merchant.number}-before-delete-${x.exported_at.slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      setExported(r.id)
      toast.success('Export downloaded')
    } })
  const remove = useMutation({ meta: { silent: true }, mutationFn: () => deleteMerchantForRequest(deleting!.id, typed),
    onSuccess: () => { toast.success('Merchant deleted'); setDeleting(null); setTyped(''); setExported(null); void refresh() } })
  return (
    <div className="space-y-3">
      <Card className="gap-1 px-4 py-3 text-xs text-muted-foreground">
        <p><strong className="text-foreground">How it works.</strong> The owner asks (from Plan & Billing) or staff record a request. Someone other than the requester approves it after checking it is genuine. After the {d.retention.policy.deletion_cooling_days ?? 14}-day waiting period, someone other than the approver either <strong className="text-foreground">erases the personal data</strong> (the account must be closed; the business stays) or <strong className="text-foreground">deletes the whole merchant</strong> (with a full export taken in the last 24 hours), after typing the merchant's name.</p>
        <p><strong className="text-foreground">Erased:</strong> {ERASED}</p>
        <p><strong className="text-foreground">Kept:</strong> {KEPT}</p>
      </Card>
      {d.can.manage && <Button size="sm" onClick={() => setCreating(true)}><Plus /> Record a request</Button>}
      <Card className="gap-0 overflow-hidden py-0">
        {d.deletion_requests.length === 0 ? <EmptyState icon={<ShieldCheck />} title="No deletion requests" /> : (
          <div className="overflow-x-auto"><Table>
            <TableHeader><TableRow><TableHead>Request</TableHead><TableHead>Merchant</TableHead><TableHead>Status and decision</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{d.deletion_requests.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="max-w-xs text-xs whitespace-normal"><p className="text-sm font-medium">#{r.number} · {r.source === 'MERCHANT' ? 'by the owner' : 'recorded by staff'}</p>
                  <p className="line-clamp-2 text-muted-foreground">{r.reason}</p><p className="text-muted-foreground">{r.requested_by_email} · {timeAgo(r.created_at)}</p></TableCell>
                <TableCell className="max-w-56 text-sm whitespace-normal"><M m={r.merchant} /><p className="text-xs text-muted-foreground">account {r.merchant.status.toLowerCase()} · {r.exports} export(s) since the request</p></TableCell>
                <TableCell className="max-w-sm text-xs whitespace-normal"><Badge variant={DELETION[r.status].variant}>{DELETION[r.status].label}</Badge>
                  {r.status === 'APPROVED' && <span className="ml-2 text-muted-foreground">{r.ready ? 'wait over' : `wait ends ${formatDateTime(r.erase_after)}`}</span>}
                  {r.decided_by_name && <p className="mt-1 text-muted-foreground">{r.decided_by_name}: {r.decision_note}</p>}
                  {r.completed_at && <p className="text-muted-foreground">Erased {formatDateTime(r.completed_at)} by {r.completed_by_name} · {Object.entries(r.result ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}</p>}</TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-wrap justify-end gap-1">
                    {r.status === 'REQUESTED' && d.can.approve && <>
                      <Button size="sm" variant="outline" onClick={() => setDeciding({ r, approve: true })}>Approve</Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeciding({ r, approve: false })}>Reject</Button></>}
                    {r.status === 'APPROVED' && d.can.manage && <>
                      <Button size="sm" variant="outline" disabled={!r.ready} title={r.ready ? 'Erase customers\' personal data; the business stays' : 'The waiting period is not over'} onClick={() => setErasing(r)}>Erase data</Button>
                      <Button size="sm" variant="destructive" disabled={!r.ready} title={r.ready ? 'Delete the whole merchant' : `The waiting period ends ${formatDateTime(r.erase_after)}`} onClick={() => { setTyped(''); setDeleting(r) }}><Trash2 /> Delete merchant</Button></>}
                    {(r.status === 'REQUESTED' || r.status === 'APPROVED') && d.can.manage && <Button size="sm" variant="ghost" onClick={() => setCancelling(r)}>Cancel</Button>}
                  </div>
                </TableCell>
              </TableRow>))}</TableBody>
          </Table></div>
        )}
      </Card>
      {creating && (
        <FormDialog open onOpenChange={setCreating} title="Record a data deletion request" submitLabel="Record" busy={create.isPending}
          disabled={!picked || reason.trim().length < 5} onSubmit={() => create.mutate()} description="For a request that came by email or phone. Someone else must approve it.">
          <Field label="Merchant" required><MerchantPicker value={picked} onChange={setPicked} /></Field>
          <Field label="Who asked, how, and why" required><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {create.error && <p className="text-sm text-red-500" role="alert">{(create.error as Error).message}</p>}
        </FormDialog>
      )}
      {deciding && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeciding(null)} reason reasonRequired reasonLabel={deciding.approve ? 'How the request was verified' : 'Why it is rejected'}
          title={`${deciding.approve ? 'Approve' : 'Reject'} request #${deciding.r.number} for ${deciding.r.merchant.name}?`} confirmLabel={deciding.approve ? 'Approve' : 'Reject'}
          description={deciding.approve ? `Nothing is erased yet. After ${d.retention.policy.deletion_cooling_days ?? 14} days someone other than you can carry it out, once the account is closed.` : undefined}
          onConfirm={async (note) => {
            try { await decideDeletionRequest(deciding.r.id, deciding.approve, note); toast.success(deciding.approve ? 'Approved' : 'Rejected'); void refresh() } catch (e) { toast.error((e as Error).message); throw e }
          }} />
      )}
      {cancelling && (
        <ConfirmDialog open onOpenChange={(o) => !o && setCancelling(null)} title={`Cancel request #${cancelling.number}?`} confirmLabel="Cancel request" reason reasonRequired
          onConfirm={async (r) => { await cancelDeletionRequest(cancelling.id, r); toast.success('Cancelled'); void refresh() }} />
      )}
      {erasing && (
        <FormDialog open onOpenChange={(o) => { if (!o) { setErasing(null); setTyped('') } }} title={`Erase ${erasing.merchant.name}'s personal data?`} destructive
          submitLabel="Erase permanently" busy={erase.isPending} disabled={typed !== erasing.merchant.name} onSubmit={() => erase.mutate()}
          description="This cannot be undone.">
          <div className="space-y-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs">
            <p><strong>Erased:</strong> {ERASED}</p><p><strong>Kept:</strong> {KEPT}</p>
            {erasing.exports === 0 && <p className="font-medium text-amber-600">No export was taken since the request. Export first if the owner wants a copy.</p>}
          </div>
          <Field label={`Type the merchant's name: ${erasing.merchant.name}`} required><Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
          {erase.error && <p className="text-sm text-red-500" role="alert">{(erase.error as Error).message}</p>}
        </FormDialog>
      )}
      {deleting && (
        <FormDialog open onOpenChange={(o) => { if (!o) { setDeleting(null); setTyped('') } }} title={`Delete ${deleting.merchant.name}?`} destructive
          submitLabel="Delete merchant permanently" busy={remove.isPending} disabled={typed.trim().toLowerCase() !== deleting.merchant.name.trim().toLowerCase()}
          onSubmit={() => remove.mutate()} description={`Request #${deleting.number}: ${deleting.reason}. This cannot be undone.`}>
          <div className="space-y-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs">
            <p><strong>Deleted:</strong> {DELETES}</p><p><strong>Kept:</strong> {DELETE_KEEPS}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-xs">
            <span className="mr-auto">{exported === deleting.id ? 'Export downloaded — keep it safe.' : 'A full export from the last 24 hours is needed first (it downloads as a file).'}</span>
            <Button type="button" size="sm" variant="outline" disabled={exportNow.isPending} onClick={() => exportNow.mutate(deleting)}>
              {exportNow.isPending ? 'Exporting…' : exported === deleting.id ? 'Download again' : 'Download export'}</Button>
          </div>
          {exportNow.error && <p className="text-sm text-red-500" role="alert">{(exportNow.error as Error).message}</p>}
          <Field label={`Type the merchant's name: ${deleting.merchant.name}`} required><Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
          {remove.error && <p className="text-sm text-red-500" role="alert">{(remove.error as Error).message}</p>}
        </FormDialog>
      )}
    </div>
  )
}

function RestoreTests({ d }: { d: DataOverview }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ tested_at: '', backup_taken_at: '', environment: '', result: 'PASSED', duration_minutes: '', notes: '' })
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => recordRestoreTest({ ...f, tested_at: f.tested_at ? new Date(f.tested_at).toISOString() : null,
      backup_taken_at: f.backup_taken_at ? new Date(f.backup_taken_at).toISOString() : null, checks: { production_counts: d.database.tables } }),
    onSuccess: () => { toast.success('Recorded'); setOpen(false); void queryClient.invalidateQueries({ queryKey: ['platform-data'] }) },
  })
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">Restore procedure</CardTitle><CardDescription>Practise it on a copy at least every quarter. Never restore over production to test.</CardDescription></CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            <li>In the Supabase dashboard open <em>Database → Backups</em> and restore the chosen backup (or a point in time) into a <strong>new project</strong>.</li>
            <li>Deploy the edge functions to that project and point a preview of the app at it.</li>
            <li>Compare the row counts below with the restored copy (run the same counts there in the SQL editor).</li>
            <li>Sign in as a test employee, open the order list, an invoice and the credit ledger of a test merchant.</li>
            <li>Record the result here, then delete the test project.</li>
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Production row counts</CardTitle><CardDescription>Now, {formatDateTime(d.database.at)} · database size {d.database.size}</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {Object.entries(d.database.tables).map(([k, n]) => <div key={k} className="flex justify-between gap-2"><span className="text-muted-foreground">{TABLE_LABEL[k] ?? k}</span><span className="tabular-nums">{formatNumber(n)}</span></div>)}
        </CardContent>
      </Card>
      <Card className="gap-0 overflow-hidden py-0 lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between border-b py-3"><CardTitle className="text-sm">Restore tests</CardTitle>
          {d.can.manage && <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus /> Record a test</Button>}</CardHeader>
        {d.restore_tests.length === 0 ? <EmptyState title="No restore test recorded" description="A backup is only proven once it has been restored." /> : (
          <Table>
            <TableHeader><TableRow><TableHead>Tested</TableHead><TableHead>Backup from</TableHead><TableHead>Where</TableHead><TableHead>Result</TableHead><TableHead>Notes</TableHead></TableRow></TableHeader>
            <TableBody>{d.restore_tests.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="text-xs">{formatDateTime(t.tested_at)}<p className="text-muted-foreground">{t.recorded_by_email}</p></TableCell>
                <TableCell className="text-xs">{t.backup_taken_at ? formatDateTime(t.backup_taken_at) : '—'}</TableCell>
                <TableCell className="text-xs">{t.environment}{t.duration_minutes != null && ` · ${t.duration_minutes} min`}</TableCell>
                <TableCell><Badge variant={t.result === 'PASSED' ? 'success' : t.result === 'PARTIAL' ? 'warning' : 'danger'}>{t.result.toLowerCase()}</Badge></TableCell>
                <TableCell className="max-w-sm text-xs whitespace-normal text-muted-foreground">{t.notes}</TableCell>
              </TableRow>))}</TableBody>
          </Table>
        )}
      </Card>
      {open && (
        <FormDialog open onOpenChange={setOpen} title="Record a restore test" submitLabel="Record" busy={save.isPending} disabled={!f.tested_at || f.environment.trim().length < 2} onSubmit={() => save.mutate()}
          description="Today's production row counts are attached for comparison.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tested at" required><Input type="datetime-local" value={f.tested_at} onChange={(e) => setF({ ...f, tested_at: e.target.value })} /></Field>
            <Field label="Backup taken at"><Input type="datetime-local" value={f.backup_taken_at} onChange={(e) => setF({ ...f, backup_taken_at: e.target.value })} /></Field>
            <Field label="Restored into" required><Input value={f.environment} placeholder="e.g. staging project restore-test-oct" onChange={(e) => setF({ ...f, environment: e.target.value })} /></Field>
            <Field label="Result">
              <Select value={f.result} onValueChange={(result) => setF({ ...f, result })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="PASSED">Passed</SelectItem><SelectItem value="PARTIAL">Partly worked</SelectItem><SelectItem value="FAILED">Failed</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Took (minutes)"><Input type="number" min={0} value={f.duration_minutes} onChange={(e) => setF({ ...f, duration_minutes: e.target.value })} /></Field>
          </div>
          <Field label="Notes (what was checked, what differed)"><Textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          {save.error && <p className="text-sm text-red-500" role="alert">{(save.error as Error).message}</p>}
        </FormDialog>
      )}
    </div>
  )
}

export default function DataManagementPage() {
  const [state, update] = useUrlState({ tab: 'overview' })
  const [exporting, setExporting] = useState(false)
  const q = useQuery({ queryKey: ['platform-data', 'overview'], queryFn: dataOverview })
  const d = q.data
  const open = d?.deletion_requests.filter((r) => r.status === 'REQUESTED' || r.status === 'APPROVED').length ?? 0
  return (
    <div className="space-y-4">
      <PageHeader title="Data Management" description="Backups, exports, retention, merchant data deletion, import errors and restore tests. There is no direct database access here; every action goes through checked, logged functions."
        actions={d?.can.export && <Button variant="outline" onClick={() => setExporting(true)}><Download /> Export a merchant's data</Button>} />
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <CardsSkeleton count={4} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Database size" value={d.database.size} icon={<Database />} hint={`${formatNumber(d.database.tables.orders)} orders · ${formatNumber(d.database.tables.merchants)} merchant${d.database.tables.merchants === 1 ? '' : 's'}${d.database.tables.deleted_merchants ? ` (+${formatNumber(d.database.tables.deleted_merchants)} deleted)` : ''}`} />
            <StatCard label="Open deletion requests" value={formatNumber(open)} tone={open ? 'warning' : 'default'} />
            <StatCard label="Failed imports (30 days)" value={formatNumber(d.imports.failed_30d)} icon={<FileWarning />} tone={d.imports.failed_30d ? 'warning' : 'default'} />
            <StatCard label="Last restore test" value={d.restore_tests[0] ? d.restore_tests[0].result.toLowerCase() : 'never'}
              tone={!d.restore_tests[0] || d.restore_tests[0].result !== 'PASSED' ? 'warning' : 'positive'} hint={d.restore_tests[0] ? timeAgo(d.restore_tests[0].tested_at) : 'record one after practising a restore'} />
          </div>
          <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
            <TabsList>
              <TabsTrigger value="overview">Backups & retention</TabsTrigger>
              <TabsTrigger value="exports">Exports</TabsTrigger>
              <TabsTrigger value="deletion">Deletion requests</TabsTrigger>
              <TabsTrigger value="imports">Import errors</TabsTrigger>
              <TabsTrigger value="restore">Restore tests</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="mt-3 grid gap-3 lg:grid-cols-2"><Backups /><Retention d={d} /></TabsContent>
            <TabsContent value="exports" className="mt-3">
              <Card className="gap-0 overflow-hidden py-0">
                {d.exports.length === 0 ? <EmptyState icon={<Download />} title="No exports yet" description="Every download of merchant data, lists, the audit log or usage is recorded here." /> : (
                  <Table>
                    <TableHeader><TableRow><TableHead>When</TableHead><TableHead>What</TableHead><TableHead>Merchant</TableHead><TableHead>By</TableHead><TableHead>Why</TableHead></TableRow></TableHeader>
                    <TableBody>{d.exports.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-xs">{formatDateTime(e.created_at)}</TableCell>
                        <TableCell className="text-xs">{e.kind.toLowerCase().replace('_', ' ')}{typeof e.detail.rows === 'number' && ` · ${e.detail.rows} rows`}</TableCell>
                        <TableCell className="text-xs"><M m={e.merchant} /></TableCell>
                        <TableCell className="text-xs">{e.actor}</TableCell>
                        <TableCell className="max-w-xs text-xs whitespace-normal text-muted-foreground">{e.reason ?? '—'}</TableCell>
                      </TableRow>))}</TableBody>
                  </Table>
                )}
              </Card>
            </TabsContent>
            <TabsContent value="deletion" className="mt-3"><DeletionRequests d={d} /></TabsContent>
            <TabsContent value="imports" className="mt-3">
              <Card className="gap-0 overflow-hidden py-0">
                {d.imports.rows.length === 0 ? <EmptyState title="No failed imports in 30 days" description="Orders from Shopify and WooCommerce that could not be imported show here with the reason." /> : (
                  <div className="overflow-x-auto"><Table>
                    <TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>Store</TableHead><TableHead>Order</TableHead><TableHead>Why it failed</TableHead><TableHead className="text-right">Tries</TableHead><TableHead>Last try</TableHead></TableRow></TableHeader>
                    <TableBody>{d.imports.rows.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell className="text-sm"><M m={i.merchant} /></TableCell>
                        <TableCell className="text-xs">{i.channel.platform.toLowerCase()} · {i.channel.name}</TableCell>
                        <TableCell className="text-xs">{i.external_number}</TableCell>
                        <TableCell className="max-w-sm text-xs whitespace-normal">{i.error}{(i.warnings ?? []).length > 0 && <span className="text-muted-foreground"> · {i.warnings!.join('; ')}</span>}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{i.attempts}</TableCell>
                        <TableCell className="text-xs">{timeAgo(i.updated_at)} · {i.received_via.toLowerCase()}</TableCell>
                      </TableRow>))}</TableBody>
                  </Table></div>
                )}
              </Card>
            </TabsContent>
            <TabsContent value="restore" className="mt-3"><RestoreTests d={d} /></TabsContent>
          </Tabs>
        </>
      )}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  )
}
