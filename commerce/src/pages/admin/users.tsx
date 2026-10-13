import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutGrid, List, Plus, ShieldCheck, UserCheck, UserX } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/lib/toast'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, initials, timeAgo, titleCase } from '@/lib/format'
import { cn } from '@/lib/utils'
import { listDepartments, listEmployees } from '@/services/hr'
import {
  createStaffUser, listPermissions, listRoles, listStaffUsers, type RoleRow, setRolePermission, setStaffActive, setStaffRole, type StaffUser,
} from '@/services/users'

export default function UsersPage() {
  const [state, update] = useUrlState({ tab: 'staff' })
  return (
    <div className="space-y-4">
      <PageHeader title="Users & roles" description="Staff accounts and what each role can do. Permissions are enforced by the database on every request." />
      <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
        <TabsList><TabsTrigger value="staff">Staff</TabsTrigger><TabsTrigger value="roles">Roles & permissions</TabsTrigger></TabsList>
        <TabsContent value="staff"><StaffList /></TabsContent>
        <TabsContent value="roles"><PermissionMatrix /></TabsContent>
      </Tabs>
    </div>
  )
}

function StaffList() {
  const { user, access } = useAuth()
  const queryClient = useQueryClient()
  const staff = useQuery({ queryKey: ['staff-users'], queryFn: listStaffUsers })
  const roles = useQuery({ queryKey: ['roles'], queryFn: listRoles })
  const [inviting, setInviting] = useState(false)
  const [q, setQ] = useState('')
  const [role, setRole] = useState('all')
  const [dept, setDept] = useState('all')
  const [status, setStatus] = useState('all')
  const [grid, setGrid] = useState(false)
  const departments = useQuery({ queryKey: ['hr', 'departments'], queryFn: listDepartments })
  const employees = useQuery({ queryKey: ['hr', 'employees'], queryFn: listEmployees })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['staff-users'] })
    void queryClient.invalidateQueries({ queryKey: ['staff-directory'] })
  }
  const changeRole = useMutation({
    mutationFn: ({ u, role }: { u: StaffUser; role: string }) => setStaffRole(u.id, role, u.is_active),
    onSuccess: () => { toast.success('Role updated'); refresh() },
  })
  const setActive = useMutation({
    mutationFn: ({ u, active }: { u: StaffUser; active: boolean }) => setStaffActive(u.id, active),
    onSuccess: (_, { active }) => { toast.success(active ? 'Access restored' : 'Access removed; they are signed out at their next request'); refresh() },
  })
  // Only roles at or below the caller's own rank can be granted (the database enforces this too).
  const isOwner = access?.role === 'OWNER'
  const rankOf = (code: string | undefined) => roles.data?.find((r) => r.code === code)?.rank ?? 0
  const myRank = rankOf(access?.role)
  const assignable = (roles.data ?? []).filter((r) => isOwner || (r.rank <= myRank && r.code !== 'OWNER'))
  const manageable = (u: StaffUser) => u.id !== user?.id && (isOwner || (u.roles?.code !== 'OWNER' && rankOf(u.roles?.code) <= myRank))

  const columns: Column<StaffUser>[] = [
    {
      key: 'name', header: 'Name', primary: true,
      cell: (u) => (
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-medium">{initials(u.full_name || u.email)}</span>
          <div className="min-w-0">
            <p className="truncate font-medium">{u.full_name || '—'} {u.id === user?.id && <Badge variant="info">you</Badge>}</p>
            <p className="truncate text-xs text-muted-foreground">{u.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'role', header: 'Role',
      cell: (u) => {
        if (!manageable(u) || !u.roles) return <Badge variant="secondary">{u.roles?.name ?? 'No role'}</Badge>
        return (
          <Select value={u.roles.code} onValueChange={(role) => changeRole.mutate({ u, role })} disabled={changeRole.isPending}>
            <SelectTrigger size="sm" className="w-44" aria-label={`Role for ${u.email}`}><SelectValue /></SelectTrigger>
            <SelectContent>{assignable.map((r) => <SelectItem key={r.code} value={r.code}>{r.name}</SelectItem>)}</SelectContent>
          </Select>
        )
      },
    },
    { key: 'status', header: 'Status', cell: (u) => (u.is_active ? <Badge variant="success">active</Badge> : <Badge variant="neutral">deactivated</Badge>) },
    { key: 'last', header: 'Last sign-in', hideOnMobile: true, cell: (u) => <span title={formatDateTime(u.last_sign_in_at)}>{u.last_sign_in_at ? timeAgo(u.last_sign_in_at) : 'never'}</span> },
    { key: 'since', header: 'Added', hideOnMobile: true, cell: (u) => formatDateTime(u.created_at) },
    {
      key: 'actions', header: '', align: 'right',
      cell: (u) => !manageable(u) ? null : u.is_active ? (
        <Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${u.email}'s access? You can restore it later.`) && setActive.mutate({ u, active: false })}><UserX /> Deactivate</Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setActive.mutate({ u, active: true })}><UserCheck /> Reactivate</Button>
      ),
    },
  ]

  const all = staff.data ?? []
  const deptOf = (id: string) => departments.data?.find((d) => d.id === employees.data?.find((e) => e.profile_id === id)?.department_id)
  const shown = all.filter((u) => (!q || `${u.full_name} ${u.email}`.toLowerCase().includes(q.toLowerCase()))
    && (role === 'all' || u.roles?.code === role)
    && (dept === 'all' || deptOf(u.id)?.id === dept)
    && (status === 'all' || (status === 'active') === u.is_active))
  const active = all.filter((u) => u.is_active).length
  return (
    <div className="space-y-3">
      <Card className="gap-3 p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><ShieldCheck className="size-4" /></span>
          <div>
            <p className="text-[11px] font-medium tracking-wide text-primary uppercase">A simpler way to manage staff access</p>
            <p className="font-semibold">The right access for every person on your team</p>
            <p className="text-sm text-muted-foreground">Give each person a role, then fine-tune what each role can see and do under Roles & permissions. Costs, profit and finance stay hidden unless a role is allowed to see them, and the database checks every request.</p>
          </div>
        </div>
      </Card>
      <div className="grid grid-cols-3 gap-3">
        {[['Total', all.length, ''], ['Active', active, 'text-emerald-600'], ['Inactive', all.length - active, all.length - active ? 'text-red-600' : '']].map(([l, v, c]) => (
          <Card key={l as string} className="gap-1 p-3"><p className="text-xs text-muted-foreground">{l}</p><p className={cn('text-2xl font-semibold tabular-nums', c as string)}>{v}</p></Card>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" className="w-full sm:w-64" aria-label="Search staff" />
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger size="sm" className="w-40" aria-label="Role"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All roles</SelectItem>{(roles.data ?? []).map((r) => <SelectItem key={r.code} value={r.code}>{r.name}</SelectItem>)}</SelectContent>
        </Select>
        {Boolean(departments.data?.length) && (
          <Select value={dept} onValueChange={setDept}>
            <SelectTrigger size="sm" className="w-44" aria-label="Department"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All departments</SelectItem>{(departments.data ?? []).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-32" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All status</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Inactive</SelectItem></SelectContent>
        </Select>
        <div className="flex rounded-lg border p-0.5">
          <button type="button" onClick={() => setGrid(false)} className={cn('rounded-md p-1.5', !grid ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')} aria-label="List view"><List className="size-4" /></button>
          <button type="button" onClick={() => setGrid(true)} className={cn('rounded-md p-1.5', grid ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')} aria-label="Grid view"><LayoutGrid className="size-4" /></button>
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setInviting(true)}><Plus /> Add staff member</Button>
      </div>
      {grid ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((u) => (
            <Card key={u.id} className={cn('gap-2 p-4', !u.is_active && 'opacity-60')}>
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-sm font-medium">{initials(u.full_name || u.email)}</span>
                <div className="min-w-0"><p className="truncate font-medium">{u.full_name || '—'}</p><p className="truncate text-xs text-muted-foreground">{u.email}</p></div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">{u.roles?.name ?? 'No role'}</Badge>
                {deptOf(u.id) && <Badge variant="outline">{deptOf(u.id)!.name}</Badge>}
                {u.is_active ? <Badge variant="success">active</Badge> : <Badge variant="neutral">deactivated</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">Last sign-in {u.last_sign_in_at ? timeAgo(u.last_sign_in_at) : 'never'}</p>
            </Card>
          ))}
          {!shown.length && <EmptyState title="Nobody matches" />}
        </div>
      ) : (
        <DataTable columns={columns} rows={shown} rowKey={(u) => u.id} loading={staff.isFetching} error={staff.error} onRetry={() => staff.refetch()}
          empty={<EmptyState title={all.length ? 'Nobody matches' : 'No staff yet'} />} />
      )}
      <InviteDialog open={inviting} onOpenChange={setInviting} roles={assignable} onDone={refresh} />
    </div>
  )
}

function InviteDialog({ open, onOpenChange, roles, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; roles: RoleRow[]; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('ORDER_MANAGER')
  const [password, setPassword] = useState('')
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && name.trim().length >= 2 && (!password || password.length >= 10) && roles.some((r) => r.code === role)
  const create = useMutation({
    mutationFn: () => createStaffUser({ email: email.trim().toLowerCase(), full_name: name.trim(), role, password: password || undefined }),
    onSuccess: (res) => {
      toast.success(res.invited ? `Invitation sent to ${email}` : `${email} can now sign in`)
      setEmail(''); setName(''); setPassword('')
      onOpenChange(false)
      onDone()
    },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Add staff member" submitLabel={password ? 'Create account' : 'Send invitation'}
      description="Without a password, they get an email invitation to set their own. An existing customer account with this email is promoted to staff."
      busy={create.isPending} disabled={!valid} onSubmit={() => create.mutate()}>
      <Field label="Email" htmlFor="inv-email" required><Input id="inv-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Full name" htmlFor="inv-name" required><Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Role">
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{roles.map((r) => <SelectItem key={r.code} value={r.code}>{r.name}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label="Temporary password" htmlFor="inv-pass" hint="Optional, at least 10 characters. Share it securely and ask them to change it."
        error={password && password.length < 10 ? 'At least 10 characters' : undefined}>
        <Input id="inv-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
    </FormDialog>
  )
}

function PermissionMatrix() {
  const { access } = useAuth()
  const queryClient = useQueryClient()
  const roles = useQuery({ queryKey: ['roles'], queryFn: listRoles })
  const permissions = useQuery({ queryKey: ['permissions'], queryFn: listPermissions })
  const isOwner = access?.role === 'OWNER'
  const toggle = useMutation({
    mutationFn: ({ roleId, permissionId, granted }: { roleId: string; permissionId: string; granted: boolean }) => setRolePermission(roleId, permissionId, granted),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['roles'] })
      void queryClient.invalidateQueries({ queryKey: ['my-access'] })
    },
  })
  if (roles.isLoading || permissions.isLoading) return <LoadingState />
  const roleList = roles.data ?? []
  const modules = [...new Set((permissions.data ?? []).map((p) => p.module))]

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">Permissions by role</CardTitle>
        <CardDescription>
          {isOwner ? 'Changes apply on each user’s next request.' : 'Only an owner can change role permissions.'} Owners always have every permission.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="sticky left-0 bg-card py-2 pr-3 pl-6 text-left font-medium">Permission</th>
                {roleList.map((r) => <th key={r.id} className="px-2 py-2 text-center font-medium">{r.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {modules.map((module) => (
                <ModuleRows key={module} module={module} roles={roleList} permissions={(permissions.data ?? []).filter((p) => p.module === module)}
                  editable={isOwner} busy={toggle.isPending} onToggle={(roleId, permissionId, granted) => toggle.mutate({ roleId, permissionId, granted })} />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function ModuleRows({ module, roles, permissions, editable, busy, onToggle }: {
  module: string
  roles: RoleRow[]
  permissions: Array<{ id: string; code: string; name: string; description?: string | null }>
  editable: boolean
  busy: boolean
  onToggle: (roleId: string, permissionId: string, granted: boolean) => void
}) {
  return (
    <>
      <tr><td colSpan={roles.length + 1} className="bg-muted/40 py-1.5 pl-6 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{titleCase(module)}</td></tr>
      {permissions.map((p) => (
        <tr key={p.id} className="border-b last:border-0">
          <td className="sticky left-0 bg-card py-1.5 pr-3 pl-6">
            <p>{p.name}</p>
            <p className="font-mono text-xs text-muted-foreground">{p.code}</p>
          </td>
          {roles.map((r) => {
            const owner = r.code === 'OWNER'
            const granted = owner || r.role_permissions.some((rp) => rp.permission_id === p.id)
            return (
              <td key={r.id} className="px-2 py-1.5 text-center">
                {owner ? <ShieldCheck className="mx-auto size-4 text-emerald-600" aria-label="Always granted" /> : (
                  <Checkbox checked={granted} disabled={!editable || busy} aria-label={`${r.name}: ${p.name}`}
                    onCheckedChange={(v) => onToggle(r.id, p.id, v === true)} />
                )}
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
}
