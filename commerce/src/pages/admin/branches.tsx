import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Crown, MoreHorizontal, Pencil, Plus, Settings2, Store, Trash2, Users, Warehouse } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import {
  type Branch, type BranchKind, branchesOverview, branchReport, deleteBranch, enableBranches, saveBranch, setBranchStaff, setCentralBranch,
} from '@/services/branches'
import { listStaffUsers } from '@/services/users'

const KIND: Record<BranchKind, { label: string; icon: typeof Store }> = { STORE: { label: 'Store', icon: Store }, WAREHOUSE: { label: 'Warehouse', icon: Warehouse } }
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** Inventory → Branches: track stock separately for each branch. */
export default function BranchesPage() {
  const { can } = useAuth()
  const manage = can('settings.manage')
  const queryClient = useQueryClient()
  const overview = useQuery({ queryKey: ['branches'], queryFn: branchesOverview })
  const [editing, setEditing] = useState<Partial<Branch> | null>(null)
  const [staffOf, setStaffOf] = useState<Branch | null>(null)
  const [removing, setRemoving] = useState<Branch | null>(null)
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['branches'] }); void queryClient.invalidateQueries({ queryKey: ['branch-stock'] }) }
  const enable = useMutation({
    mutationFn: enableBranches,
    onSuccess: (o) => { toast.success(o.enabled ? 'Branch stock is on' : 'Branch stock is off'); refresh(); void queryClient.invalidateQueries({ queryKey: ['settings'] }) },
    onError: (e) => toast.error(e),
  })
  const central = useMutation({ mutationFn: setCentralBranch, onSuccess: () => { toast.success('Central branch changed'); refresh() }, onError: (e) => toast.error(e) })
  const close = useMutation({
    mutationFn: (b: Branch) => saveBranch({ id: b.id, name: b.name, code: b.code, kind: b.kind, address: b.address, phone: b.phone, manager_id: b.manager_id, is_active: !b.is_active }),
    onSuccess: (b) => { toast.success(b.is_active ? 'Branch reopened' : 'Branch closed'); refresh() }, onError: (e) => toast.error(e),
  })

  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
  if (!overview.data) return <LoadingState />
  const o = overview.data
  return (
    <div className="space-y-4">
      <PageHeader title="Branches" description="Track stock separately for each branch: stores and warehouses, with one central branch that holds the rest."
        actions={o.enabled ? (
          <>
            <Button size="sm" variant="outline" asChild><Link to="/admin/inventory/branches/setup"><Settings2 /> Advanced Setup</Link></Button>
            {manage && <Button size="sm" onClick={() => setEditing({ kind: 'STORE' })}><Plus /> Add Branch</Button>}
          </>
        ) : undefined} />

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Multi Warehouse / Branch Stock</p>
            <p className="text-xs text-muted-foreground">Off: one stock count for the whole store, as before. On: every sale, return, purchase and adjustment lands on a branch.</p>
          </div>
          <Switch checked={o.enabled} disabled={!manage || enable.isPending} onCheckedChange={(v) => enable.mutate(v)} aria-label="Multi Warehouse / Branch Stock" />
        </CardContent>
      </Card>

      {o.enabled && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Total branches" value={formatNumber(o.stats.total)} />
            <StatCard label="Stores" value={formatNumber(o.stats.stores)} />
            <StatCard label="Warehouses" value={formatNumber(o.stats.warehouses)} />
            <StatCard label="Central branch" value={o.stats.central ?? '—'} />
          </div>

          {o.branches.length === 0 ? (
            <Card><CardContent>
              <EmptyState icon={<Building2 className="size-5" />} title="Create your first branch" description="Add your stores and warehouses, then split your stock between them."
                action={manage ? <Button onClick={() => setEditing({ kind: 'STORE' })}><Plus /> Add Branch</Button> : undefined} />
            </CardContent></Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {o.branches.map((b) => {
                const K = KIND[b.kind]
                return (
                  <Card key={b.id} className={b.is_active ? undefined : 'opacity-60'}>
                    <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                      <div className="min-w-0">
                        <CardTitle className="flex items-center gap-2 text-base"><K.icon className="size-4 shrink-0 text-muted-foreground" /> <span className="truncate">{b.name}</span></CardTitle>
                        <CardDescription className="flex flex-wrap items-center gap-1.5 pt-1">
                          <Badge variant="outline">{K.label}</Badge>
                          {b.is_central && <Badge variant="info" className="gap-1"><Crown className="size-3" /> Central</Badge>}
                          {!b.is_active && <Badge variant="neutral">Closed</Badge>}
                          {b.code && <span className="font-mono text-xs">{b.code}</span>}
                        </CardDescription>
                      </div>
                      {manage && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`Actions for ${b.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditing(b)}><Pencil /> Edit</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setStaffOf(b)}><Users /> Staff</DropdownMenuItem>
                            {!b.is_central && b.is_active && <DropdownMenuItem onClick={() => central.mutate(b.id)}><Crown /> Make central</DropdownMenuItem>}
                            {!b.is_central && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => close.mutate(b)}>{b.is_active ? 'Close branch' : 'Reopen branch'}</DropdownMenuItem>
                                <DropdownMenuItem className="text-red-600" onClick={() => setRemoving(b)}><Trash2 /> Delete</DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </CardHeader>
                    <CardContent className="grid gap-3 text-sm">
                      <dl className="grid grid-cols-3 gap-2 text-center tabular-nums">
                        <div className="rounded-lg bg-muted/50 p-2"><dt className="text-[11px] text-muted-foreground">Units</dt><dd className="font-semibold">{formatNumber(b.units)}</dd></div>
                        <div className="rounded-lg bg-muted/50 p-2"><dt className="text-[11px] text-muted-foreground">To ship</dt><dd className="font-semibold">{formatNumber(b.open_orders)}</dd></div>
                        <div className="rounded-lg bg-muted/50 p-2"><dt className="text-[11px] text-muted-foreground">Staff</dt><dd className="font-semibold">{formatNumber(b.staff.length)}</dd></div>
                      </dl>
                      {(b.address || b.manager) && <p className="text-xs text-muted-foreground">{[b.address, b.manager && `Manager: ${b.manager}`].filter(Boolean).join(' · ')}</p>}
                      {b.units < 0 && <p className="text-xs text-red-600">Below zero: more left this branch than it held. Move stock in or count it again.</p>}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
          <BranchReport />
        </>
      )}

      {editing && <BranchDialog branch={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {staffOf && <StaffDialog branch={staffOf} onClose={() => setStaffOf(null)} onSaved={refresh} />}
      <ConfirmDialog open={!!removing} onOpenChange={(v) => !v && setRemoving(null)} title={`Delete ${removing?.name ?? ''}?`} destructive confirmLabel="Delete"
        description="Only a branch that never held stock or orders can be deleted. Otherwise close it."
        onConfirm={() => deleteBranch(removing!.id).then(() => { toast.success('Branch deleted'); refresh() }, (e) => { toast.error(e); throw e })} />
    </div>
  )
}

function BranchDialog({ branch, onClose, onSaved }: { branch: Partial<Branch>; onClose: () => void; onSaved: () => void }) {
  const [b, setB] = useState(branch)
  const staff = useQuery({ queryKey: ['staff-users'], queryFn: listStaffUsers })
  const save = useMutation({
    mutationFn: () => saveBranch({ id: b.id, name: b.name ?? '', code: b.code ?? null, kind: b.kind ?? 'STORE', address: b.address ?? null, phone: b.phone ?? null, manager_id: b.manager_id ?? null, is_active: b.is_active ?? true }),
    onSuccess: () => { toast.success('Branch saved'); onSaved(); onClose() },
    onError: (e) => toast.error(e),
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={b.id ? `Edit ${branch.name}` : 'Add branch'} submitLabel="Save" busy={save.isPending}
      onSubmit={() => save.mutate()}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required className="sm:col-span-2"><Input value={b.name ?? ''} maxLength={80} onChange={(e) => setB({ ...b, name: e.target.value })} /></Field>
        <Field label="Type">
          <Select value={b.kind ?? 'STORE'} onValueChange={(v) => setB({ ...b, kind: v as BranchKind })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="STORE">Store</SelectItem><SelectItem value="WAREHOUSE">Warehouse</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field label="Short code" hint="Up to 12 letters or digits"><Input value={b.code ?? ''} maxLength={12} onChange={(e) => setB({ ...b, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={b.address ?? ''} maxLength={300} onChange={(e) => setB({ ...b, address: e.target.value })} /></Field>
        <Field label="Phone"><Input value={b.phone ?? ''} maxLength={20} inputMode="tel" onChange={(e) => setB({ ...b, phone: e.target.value })} /></Field>
        <Field label="Manager">
          <Select value={b.manager_id ?? 'none'} onValueChange={(v) => setB({ ...b, manager_id: v === 'none' ? null : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No manager</SelectItem>
              {(staff.data ?? []).filter((s) => s.is_active).map((s) => <SelectItem key={s.id} value={s.id}>{s.full_name || s.email}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </FormDialog>
  )
}

function StaffDialog({ branch, onClose, onSaved }: { branch: Branch; onClose: () => void; onSaved: () => void }) {
  const staff = useQuery({ queryKey: ['staff-users'], queryFn: listStaffUsers })
  const [picked, setPicked] = useState(new Set(branch.staff.map((s) => s.id)))
  const save = useMutation({
    mutationFn: () => setBranchStaff(branch.id, [...picked]),
    onSuccess: () => { toast.success('Staff saved'); onSaved(); onClose() },
    onError: (e) => toast.error(e),
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`Staff at ${branch.name}`} submitLabel="Save" busy={save.isPending} onSubmit={() => save.mutate()}
      description="New orders that staff in exactly one branch create start on that branch.">
      {!staff.data ? <LoadingState /> : (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {staff.data.filter((s) => s.is_active).map((s) => (
            <li key={s.id}>
              <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                <Checkbox checked={picked.has(s.id)} onCheckedChange={(v) => { const n = new Set(picked); if (v === true) n.add(s.id); else n.delete(s.id); setPicked(n) }} />
                {s.full_name || s.email}
              </label>
            </li>
          ))}
        </ul>
      )}
    </FormDialog>
  )
}

function BranchReport() {
  const { can } = useAuth()
  const to = new Date()
  const from = new Date(Date.now() - 29 * 86_400_000)
  const report = useQuery({ queryKey: ['branch-report', isoDay(from)], queryFn: () => branchReport(isoDay(from), isoDay(to)), enabled: can('reports.view') })
  if (!can('reports.view') || !report.data?.length) return null
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Last 30 days by branch</CardTitle><CardDescription>Orders without a branch count for the central branch.</CardDescription></CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground"><tr className="border-b">
            <th className="py-1.5 text-left font-medium">Branch</th><th className="px-2 text-right font-medium">Orders</th><th className="px-2 text-right font-medium">Sales</th>
            <th className="px-2 text-right font-medium">Delivered</th><th className="px-2 text-right font-medium">Returned</th><th className="pl-2 text-right font-medium">Units now</th>
          </tr></thead>
          <tbody className="divide-y tabular-nums">
            {report.data.map((r) => (
              <tr key={r.branch_id}>
                <td className="py-2">{r.name}{r.is_central && <span className="ml-1 text-xs text-muted-foreground">(central)</span>}</td>
                <td className="px-2 text-right">{formatNumber(r.orders)}</td>
                <td className="px-2 text-right">{formatMoney(r.sales)}</td>
                <td className="px-2 text-right text-emerald-600">{formatNumber(r.delivered)}</td>
                <td className="px-2 text-right">{formatNumber(r.returned)}</td>
                <td className="pl-2 text-right">{formatNumber(r.units)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
