import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { usePlatform } from '@/features/platform/platform-context'
import { useUrlState } from '@/hooks/use-url-state'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  deleteRole, inviteEmployee, listEmployees, listMerchants, listRoles, type PlatformEmployee, type PlatformRole, removeEmployee, saveEmployee, saveRole, setEmployeeActive,
} from '@/services/platform'

const ACTIONS = ['view', 'create', 'edit', 'delete', 'manage', 'export', 'approve'] as const

function MerchantPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState('')
  const merchants = useQuery({ queryKey: ['platform-merchants', 'picker', q], queryFn: () => listMerchants({ q }, 'name', 'asc', 1, 50) })
  return (
    <div className="space-y-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a merchant" />
      <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
        {(merchants.data?.items ?? []).map((m) => (
          <label key={m.id} className="flex items-center gap-2 text-sm">
            <Checkbox checked={value.includes(m.id)} onCheckedChange={(c) => onChange(c ? [...value, m.id] : value.filter((v) => v !== m.id))} />
            #{m.number} {m.name}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{value.length} merchant(s) assigned.</p>
    </div>
  )
}

function EmployeeDialog({ employee, roles, open, onOpenChange }: { employee: PlatformEmployee | null; roles: PlatformRole[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const { me } = usePlatform()
  const isSuper = Boolean(me?.role.is_super)
  const [form, setForm] = useState({
    email: employee?.email ?? '', full_name: employee?.full_name ?? '', title: employee?.title ?? '', password: '',
    role_id: employee?.role.id ?? roles.find((r) => r.code === 'VIEWER')?.id ?? '', merchant_scope: employee?.merchant_scope ?? 'ALL',
    merchant_ids: employee?.merchants.map((m) => m.id) ?? [], reason: '',
  })
  const roleChanging = !employee || employee.role.id !== form.role_id
  const save = useMutation({
    mutationFn: async () => {
      if (!employee) {
        return inviteEmployee({ email: form.email.trim(), full_name: form.full_name.trim(), role_id: form.role_id, title: form.title || undefined,
          merchant_scope: form.merchant_scope, merchant_ids: form.merchant_scope === 'ASSIGNED' ? form.merchant_ids : [], password: form.password || undefined, reason: form.reason || undefined })
      }
      return saveEmployee({ user_id: employee.user_id, full_name: form.full_name, title: form.title, role_id: form.role_id, merchant_scope: form.merchant_scope,
        merchant_ids: form.merchant_scope === 'ASSIGNED' ? form.merchant_ids : [], reason: form.reason || null })
    },
    onSuccess: (r) => {
      const result = (employee ? r : (r as { employee: unknown }).employee) as { pending_approval?: string } | null
      const pending = Boolean(result?.pending_approval)
      toast.success(pending ? 'Sent for approval' : employee ? 'Saved' : 'Employee added', pending ? { description: 'Making someone a Super Admin needs a second Super Admin.' } : undefined)
      void queryClient.invalidateQueries({ queryKey: ['platform-employees'] })
      onOpenChange(false)
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const role = roles.find((r) => r.id === form.role_id)
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={employee ? 'Edit employee' : 'Add employee'} wide busy={save.isPending} onSubmit={() => save.mutate()}
      submitLabel={employee ? 'Save' : 'Add'} disabled={!form.full_name || (!employee && !form.email) || !form.role_id || (role?.is_super && roleChanging && form.reason.trim().length < 5)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required><Input value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} /></Field>
        <Field label="E-mail" required><Input type="email" disabled={Boolean(employee)} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></Field>
        <Field label="Job title"><Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} /></Field>
        <Field label="Role" hint={isSuper ? undefined : 'Only a Super Admin can choose roles'}>
          <Select value={form.role_id} disabled={!isSuper} onValueChange={(v) => setForm((f) => ({ ...f, role_id: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{roles.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {!employee && <Field label="Password (optional)" hint="Leave empty to send an invitation e-mail" className="sm:col-span-2"><Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} /></Field>}
        <Field label="Merchants they work on" className="sm:col-span-2">
          <Select value={form.merchant_scope} onValueChange={(v) => setForm((f) => ({ ...f, merchant_scope: v as 'ALL' | 'ASSIGNED' }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="ALL">All merchants</SelectItem><SelectItem value="ASSIGNED">Only merchants assigned to them</SelectItem></SelectContent>
          </Select>
        </Field>
        {form.merchant_scope === 'ASSIGNED' && <div className="sm:col-span-2"><MerchantPicker value={form.merchant_ids} onChange={(ids) => setForm((f) => ({ ...f, merchant_ids: ids }))} /></div>}
        {role?.is_super && roleChanging && (
          <Field label="Why they need Super Admin" required className="sm:col-span-2" hint="A second Super Admin approves this before it takes effect.">
            <Textarea rows={2} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
          </Field>
        )}
      </div>
    </FormDialog>
  )
}

function RoleDialog({ role, open, onOpenChange }: { role: PlatformRole | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { me } = usePlatform()
  const queryClient = useQueryClient()
  const modules = me?.modules ?? []
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? ['overview.view']))
  const save = useMutation({
    mutationFn: () => saveRole({ id: role?.id, name, description, permissions: [...perms] }),
    onSuccess: () => {
      toast.success('Role saved')
      void queryClient.invalidateQueries({ queryKey: ['platform-roles'] })
      onOpenChange(false)
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const toggle = (p: string) => setPerms((s) => {
    const next = new Set(s)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    return next
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={role ? `Role: ${role.name}` : 'New role'} wide busy={save.isPending} onSubmit={() => save.mutate()} submitLabel="Save role" disabled={name.trim().length < 2}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <div className="max-h-[50vh] overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background text-muted-foreground">
            <tr><th className="px-2 py-2 text-left font-medium">Section</th>{ACTIONS.map((a) => <th key={a} className="px-1 py-2 font-medium capitalize">{a}</th>)}</tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.code} className="border-t">
                <td className="px-2 py-1.5">{m.name}</td>
                {ACTIONS.map((a) => (
                  <td key={a} className="text-center">
                    {m.actions.includes(a) ? <Checkbox checked={perms.has(`${m.code}.${a}`)} onCheckedChange={() => toggle(`${m.code}.${a}`)} aria-label={`${m.name} ${a}`} /> : <span className="text-muted-foreground/40">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Approve lets someone confirm another person's sensitive request (never their own). Every change here is recorded.</p>
    </FormDialog>
  )
}

export default function EmployeesPage() {
  const { can, me } = usePlatform()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'employees', focus: '' })
  const employees = useQuery({ queryKey: ['platform-employees'], queryFn: listEmployees })
  const roles = useQuery({ queryKey: ['platform-roles'], queryFn: listRoles })
  const [editing, setEditing] = useState<PlatformEmployee | null | 'new'>(null)
  const [roleEditing, setRoleEditing] = useState<PlatformRole | null | 'new'>(null)
  const [toggling, setToggling] = useState<PlatformEmployee | null>(null)
  const [deleting, setDeleting] = useState<PlatformEmployee | null>(null)
  const [removing, setRemoving] = useState<PlatformRole | null>(null)
  const isSuper = Boolean(me?.role.is_super)
  const rows = useMemo(() => {
    const list = employees.data ?? []
    return state.focus ? [...list].sort((a) => (a.user_id === state.focus ? -1 : 0)) : list
  }, [employees.data, state.focus])

  const columns: Column<PlatformEmployee>[] = [
    { key: 'name', header: 'Employee', primary: true, cell: (e) => <div className={cn(e.user_id === state.focus && 'font-semibold')}>{e.full_name || e.email}<p className="text-xs text-muted-foreground">{e.email}{e.title && ` · ${e.title}`}</p></div> },
    { key: 'role', header: 'Role', cell: (e) => <Badge variant={e.role.is_super ? 'violet' : 'neutral'}>{e.role.is_super && <ShieldCheck className="size-3" />}{e.role.name}</Badge> },
    { key: 'scope', header: 'Merchants', cell: (e) => <span className="text-xs">{e.merchant_scope === 'ALL' ? 'All' : `${e.merchants.length} assigned`}{e.managed_merchants > 0 && ` · manages ${e.managed_merchants}`}</span> },
    { key: 'status', header: 'Status', cell: (e) => <Badge variant={e.is_active ? 'success' : 'neutral'}>{e.is_active ? 'Active' : 'Deactivated'}</Badge> },
    { key: 'seen', header: 'Last seen', hideOnMobile: true, cell: (e) => <span className="text-xs text-muted-foreground">{e.last_seen_at ? timeAgo(e.last_seen_at) : 'never'}</span> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (e) => (
        <div className="flex justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
          {can('employees', 'edit') && <Button size="sm" variant="ghost" onClick={() => setEditing(e)}>Edit</Button>}
          {can('employees', 'manage') && e.user_id !== me?.user_id && <Button size="sm" variant="ghost" onClick={() => setToggling(e)}>{e.is_active ? 'Deactivate' : 'Reactivate'}</Button>}
          {can('employees', 'manage') && e.user_id !== me?.user_id && !e.is_active && (
            <Button size="sm" variant="ghost" className="text-red-500 hover:text-red-600" onClick={() => setDeleting(e)}>Remove</Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader title="Employees & Roles" description="The platform team, what each role may do, and which merchants each person works on. Enforced by the database."
        actions={state.tab === 'employees'
          ? can('employees', 'create') && <Button size="sm" onClick={() => setEditing('new')} disabled={!roles.data}><Plus /> Add employee</Button>
          : isSuper && <Button size="sm" onClick={() => setRoleEditing('new')}><Plus /> New role</Button>} />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList><TabsTrigger value="employees">Employees</TabsTrigger><TabsTrigger value="roles">Roles & permissions</TabsTrigger></TabsList>
        <TabsContent value="employees">
          <DataTable columns={columns} rows={rows} rowKey={(e) => e.user_id} loading={employees.isLoading} error={employees.error} onRetry={() => employees.refetch()} />
        </TabsContent>
        <TabsContent value="roles" className="space-y-3">
          {roles.error ? <ErrorState error={roles.error} /> : !roles.data ? <LoadingState /> : roles.data.map((r) => (
            <Card key={r.id} className="gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{r.name} {r.is_system && <Badge variant="neutral" className="ml-1 text-[10px]">Built-in</Badge>}</p>
                  <p className="text-xs text-muted-foreground">{r.description ?? ''} {r.staff} {r.staff === 1 ? 'person' : 'people'}</p>
                </div>
                {isSuper && !r.is_super && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => setRoleEditing(r)}>Edit permissions</Button>
                    {!r.is_system && <Button size="sm" variant="ghost" onClick={() => setRemoving(r)}>Remove</Button>}
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{r.is_super ? 'Every permission. Only Super Admins assign roles and change what roles may do.' : r.permissions.length ? r.permissions.join(' · ') : 'No permissions'}</p>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
      {editing && roles.data && <EmployeeDialog employee={editing === 'new' ? null : editing} roles={roles.data} open onOpenChange={(o) => !o && setEditing(null)} />}
      {roleEditing && <RoleDialog role={roleEditing === 'new' ? null : roleEditing} open onOpenChange={(o) => !o && setRoleEditing(null)} />}
      {toggling && (
        <ConfirmDialog open onOpenChange={(o) => !o && setToggling(null)} title={toggling.is_active ? `Deactivate ${toggling.full_name || toggling.email}?` : `Reactivate ${toggling.full_name || toggling.email}?`}
          description={toggling.is_active ? 'They lose access at once; any open support view ends.' : 'They can sign in to the panel again with their role.'}
          destructive={toggling.is_active} reason reasonRequired confirmLabel={toggling.is_active ? 'Deactivate' : 'Reactivate'}
          onConfirm={async (reason) => {
            try {
              await setEmployeeActive(toggling.user_id, !toggling.is_active, reason)
              toast.success('Saved')
              void queryClient.invalidateQueries({ queryKey: ['platform-employees'] })
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Remove ${deleting.full_name || deleting.email} for good?`}
          description="They disappear from this list and cannot be switched on again. If this login runs no business, it is also blocked and removed from the sign-in service. Audit logs keep their name."
          destructive reason reasonRequired reasonLabel="Why (kept in the platform log)" confirmLabel="Remove"
          onConfirm={async (reason) => {
            try {
              await removeEmployee(deleting.user_id, reason.trim())
              toast.success('Employee removed')
              setDeleting(null)
              void queryClient.invalidateQueries({ queryKey: ['platform-employees'] })
              void queryClient.invalidateQueries({ queryKey: ['platform-roles'] })
            } catch (e) {
              toast.error((e as Error).message.replace(/^[A-Z_]+: /, ''))
              throw e
            }
          }} />
      )}
      {removing && (
        <ConfirmDialog open onOpenChange={(o) => !o && setRemoving(null)} title={`Remove the role ${removing.name}?`} destructive confirmLabel="Remove"
          description="Only possible when nobody has this role."
          onConfirm={async () => {
            try {
              await deleteRole(removing.id)
              void queryClient.invalidateQueries({ queryKey: ['platform-roles'] })
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
    </div>
  )
}
