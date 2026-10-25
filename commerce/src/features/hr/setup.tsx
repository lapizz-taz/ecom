import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, CalendarOff, CheckCheck, ChevronRight, Clock, Coffee, FileText, FolderTree, ListChecks, Pencil, Plus, Save, Settings2, ShieldCheck, Sparkles, Timer, UserCog, Users } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { DatePicker } from '@/components/ui/date-picker'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { formatDate, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  attendanceBoard, type BoardRow, checklistCompliance, type Department, type Employee, type HrSettings, hrSettings, listDepartments, listEmployees, listHolidays,
  listShifts, listSops, saveDepartment, saveEmployee, saveHoliday, saveHrSettings, saveShift, saveSop, setDepartmentMembers, type Shift, type Sop, sopSteps, timeLabel,
  WEEKDAYS,
} from '@/services/hr'
import { isoDate } from '@/lib/dates'

const COLORS = ['#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7', '#64748b']
const invalidate = (qc: ReturnType<typeof useQueryClient>) => { void qc.invalidateQueries({ queryKey: ['hr'] }) }
const onError = (e: unknown) => toast.error((e as Error).message)

function ColorPick({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLORS.map((c) => (
        <button key={c} type="button" onClick={() => onChange(c)} aria-label={`Colour ${c}`}
          className={cn('size-6 rounded-full border-2', value === c ? 'border-foreground' : 'border-transparent')} style={{ background: c }} />
      ))}
    </div>
  )
}

function DaysPick({ value, onChange }: { value: number[]; onChange: (d: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {WEEKDAYS.map((d, i) => (
        <button key={d} type="button" aria-pressed={value.includes(i)} onClick={() => onChange(value.includes(i) ? value.filter((x) => x !== i) : [...value, i].sort())}
          className={cn('rounded-md border px-2.5 py-1 text-xs', value.includes(i) ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground')}>{d}</button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Shifts
export function ShiftManagement() {
  const { can } = useAuth()
  const shifts = useQuery({ queryKey: ['hr', 'shifts'], queryFn: listShifts })
  const employees = useQuery({ queryKey: ['hr', 'employees'], queryFn: listEmployees })
  const [editing, setEditing] = useState<Partial<Shift> | null>(null)
  if (shifts.isLoading) return <LoadingState />
  if (shifts.error) return <ErrorState error={shifts.error} onRetry={() => shifts.refetch()} />
  const staffOn = (id: string) => (employees.data ?? []).filter((e) => e.shift_id === id).length
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Late is counted from the shift start after the grace minutes. Staff without a shift use the work days in HR settings.</p>
        {can('hr.manage') && <Button size="sm" onClick={() => setEditing({ name: '', start_time: '09:00', end_time: '18:00', grace_minutes: 10, work_days: [0, 1, 2, 3, 4, 6], color: COLORS[0], is_active: true })}><Plus /> New shift</Button>}
      </div>
      {!shifts.data?.length ? <EmptyState icon={<Clock />} title="No shifts yet" description="Create a shift, then assign staff to it under Departments & SOP." /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shifts.data.map((s) => (
            <Card key={s.id} className={cn('gap-2 p-4', !s.is_active && 'opacity-60')}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2"><span className="size-3 rounded-full" style={{ background: s.color }} /><p className="font-semibold">{s.name}</p></div>
                {can('hr.manage') && <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}><Pencil /></Button>}
              </div>
              <p className="text-2xl font-semibold tabular-nums">{timeLabel(s.start_time)} <span className="text-muted-foreground">–</span> {timeLabel(s.end_time)}</p>
              <div className="flex flex-wrap gap-1">{WEEKDAYS.map((d, i) => <span key={d} className={cn('rounded px-1.5 py-0.5 text-[11px]', s.work_days.includes(i) ? 'bg-muted font-medium' : 'text-muted-foreground/50 line-through')}>{d}</span>)}</div>
              <p className="text-xs text-muted-foreground">{s.grace_minutes} min grace · {staffOn(s.id)} staff{!s.is_active ? ' · inactive' : ''}</p>
            </Card>
          ))}
        </div>
      )}
      {editing && <ShiftDialog shift={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function ShiftDialog({ shift, onClose }: { shift: Partial<Shift>; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ ...shift, start_time: shift.start_time?.slice(0, 5), end_time: shift.end_time?.slice(0, 5) })
  const save = useMutation({ mutationFn: () => saveShift(v), onSuccess: () => { toast.success('Shift saved'); invalidate(qc); onClose() }, onError })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{shift.id ? 'Edit shift' : 'New shift'}</DialogTitle><DialogDescription>An end before the start means the shift ends the next morning.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <Field label="Name" htmlFor="sh-name" required><Input id="sh-name" value={v.name ?? ''} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Day shift" /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Starts" htmlFor="sh-start"><Input id="sh-start" type="time" value={v.start_time ?? ''} onChange={(e) => setV({ ...v, start_time: e.target.value })} /></Field>
            <Field label="Ends" htmlFor="sh-end"><Input id="sh-end" type="time" value={v.end_time ?? ''} onChange={(e) => setV({ ...v, end_time: e.target.value })} /></Field>
            <Field label="Grace (min)" htmlFor="sh-grace"><Input id="sh-grace" type="number" min={0} max={240} value={v.grace_minutes ?? 0} onChange={(e) => setV({ ...v, grace_minutes: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Work days"><DaysPick value={v.work_days ?? []} onChange={(d) => setV({ ...v, work_days: d })} /></Field>
          <Field label="Colour"><ColorPick value={v.color ?? COLORS[0]} onChange={(c) => setV({ ...v, color: c })} /></Field>
          {shift.id && <label className="flex items-center justify-between text-sm">Active <Switch checked={v.is_active ?? true} onCheckedChange={(c) => setV({ ...v, is_active: c })} /></label>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || (v.name ?? '').trim().length < 2 || !v.start_time || !v.end_time || !(v.work_days ?? []).length}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- Departments & SOP
export function DepartmentsSop() {
  const { can } = useAuth()
  const [tab, setTab] = useState<'departments' | 'sops' | 'compliance'>('departments')
  const departments = useQuery({ queryKey: ['hr', 'departments'], queryFn: listDepartments })
  const [editDept, setEditDept] = useState<Partial<Department> | null>(null)
  const [editSop, setEditSop] = useState<Partial<Sop> | null>(null)
  if (departments.isLoading) return <LoadingState />
  if (departments.error) return <ErrorState error={departments.error} onRetry={() => departments.refetch()} />
  const manage = can('hr.manage')
  return (
    <div className="space-y-4">
      <Card className="relative gap-3 overflow-hidden border-primary/20 bg-gradient-to-br from-primary/15 via-card to-card p-5">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs text-primary"><Sparkles className="size-3" /> Org structure & quality</span>
        <p className="text-2xl font-semibold tracking-tight">Departments & SOP management</p>
        <p className="max-w-xl text-sm text-muted-foreground">Define your team structure, who leads each department, and the standard steps and daily checklists everyone follows.</p>
        {manage && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setEditDept({ name: '', color: COLORS[1], is_active: true })}><Plus /> New department</Button>
            <Button variant="outline" onClick={() => setEditSop({ title: '', body: '', kind: 'CHECKLIST', department_id: null, is_active: true })}><Plus /> New SOP checklist</Button>
          </div>
        )}
      </Card>
      <div className="flex gap-1 rounded-xl border p-1">
        {([['departments', FolderTree, 'Departments'], ['sops', ListChecks, 'SOPs & checklists'], ['compliance', CheckCheck, 'Today’s compliance']] as const)
          .filter(([k]) => k !== 'compliance' || can('hr.view')).map(([k, Icon, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={cn('flex flex-1 items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm', tab === k ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
              <Icon className="size-4" /> <span className="truncate">{label}</span>
            </button>
          ))}
      </div>
      {tab === 'departments' ? (
        <>
          <DepartmentCards departments={departments.data ?? []} onEdit={setEditDept} />
          <StaffAssignment departments={departments.data ?? []} />
        </>
      ) : tab === 'sops' ? <SopList departments={departments.data ?? []} onEdit={setEditSop} /> : <ComplianceView />}
      {editDept && <DepartmentDialog dept={editDept} onClose={() => setEditDept(null)} />}
      {editSop && <SopDialog sop={editSop} departments={departments.data ?? []} onClose={() => setEditSop(null)} />}
    </div>
  )
}

function DepartmentCards({ departments, onEdit }: { departments: Department[]; onEdit: (d: Department) => void }) {
  const { can } = useAuth()
  const today = isoDate(new Date())
  const employees = useQuery({ queryKey: ['hr', 'employees'], queryFn: listEmployees })
  const sops = useQuery({ queryKey: ['hr', 'sops'], queryFn: listSops })
  const board = useQuery({ queryKey: ['hr', 'board', today], queryFn: () => attendanceBoard(today), enabled: can('hr.view') })
  const [members, setMembers] = useState<Department | null>(null)
  const nameOf = (id: string | null) => (board.data ?? []).find((b) => b.profile_id === id)?.name
  if (!departments.length) return <EmptyState icon={<FolderTree />} title="No departments yet" description="Create teams like Packing, Calling or Customer support, then add their members." />
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {departments.map((d) => {
          const count = (employees.data ?? []).filter((e) => e.department_id === d.id).length
          const sopCount = (sops.data ?? []).filter((x) => x.department_id === d.id && x.is_active).length
          const head = nameOf(d.head_id)
          return (
            <Card key={d.id} className={cn('gap-0 overflow-hidden p-0', !d.is_active && 'opacity-60')}>
              <div className="h-1.5" style={{ background: d.color }} />
              <div className="flex items-start justify-between gap-2 p-4 pb-2">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold">{d.name}</p>
                  <p className="line-clamp-2 text-sm text-muted-foreground">{d.description || 'No description provided.'}</p>
                </div>
                {can('hr.manage') && <Button size="icon" variant="ghost" className="size-8 shrink-0" onClick={() => onEdit(d)} aria-label={`Edit ${d.name}`}><Pencil /></Button>}
              </div>
              <div className="mx-4 my-2 flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2">
                <span className="flex size-8 items-center justify-center rounded-full bg-card text-xs font-medium">{head ? head.slice(0, 1).toUpperCase() : 'H'}</span>
                <div className="min-w-0"><p className="text-[11px] text-muted-foreground">Department head</p><p className="truncate text-sm font-medium">{head ?? 'Unassigned'}</p></div>
              </div>
              <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5 text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground"><Users className="size-4" /> {count} member{count === 1 ? '' : 's'} · {sopCount} SOP{sopCount === 1 ? '' : 's'}</span>
                {can('hr.manage') && <Button size="sm" variant="link" className="h-auto px-0" onClick={() => setMembers(d)}>Manage members <ChevronRight className="size-3.5" /></Button>}
              </div>
            </Card>
          )
        })}
      </div>
      {members && <MembersDialog dept={members} staff={board.data ?? []} current={(employees.data ?? []).filter((e) => e.department_id === members.id).map((e) => e.profile_id)} onClose={() => setMembers(null)} />}
    </>
  )
}

function MembersDialog({ dept, staff, current, onClose }: { dept: Department; staff: BoardRow[]; current: string[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<string[]>(current)
  const [q, setQ] = useState('')
  const save = useMutation({ mutationFn: () => setDepartmentMembers(dept.id, picked), onSuccess: () => { toast.success(`${dept.name}: ${picked.length} member${picked.length === 1 ? '' : 's'}`); invalidate(qc); onClose() }, onError })
  const shown = staff.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Members of {dept.name}</DialogTitle><DialogDescription>Someone in another department moves here when you tick them.</DialogDescription></DialogHeader>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search staff" aria-label="Search staff" />
        <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
          {shown.map((s) => {
            const on = picked.includes(s.profile_id)
            return (
              <li key={s.profile_id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                  <Checkbox checked={on} onCheckedChange={(c) => setPicked(c ? [...picked, s.profile_id] : picked.filter((x) => x !== s.profile_id))} />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{s.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{s.department && s.department !== dept.name ? `Now in ${s.department}` : s.designation ?? s.role}</span></span>
                </label>
              </li>
            )
          })}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <Spinner /> : <Save />} Save members</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SopList({ departments, onEdit }: { departments: Department[]; onEdit: (s: Sop) => void }) {
  const { can } = useAuth()
  const sops = useQuery({ queryKey: ['hr', 'sops'], queryFn: listSops })
  const [dept, setDept] = useState('all')
  const [reading, setReading] = useState<Sop | null>(null)
  if (sops.isLoading) return <LoadingState />
  const list = (sops.data ?? []).filter((s) => dept === 'all' || s.department_id === dept || (dept === 'general' && !s.department_id))
  const deptName = (id: string | null) => departments.find((d) => d.id === id)?.name ?? 'All departments'
  return (
    <div className="space-y-3">
      <Select value={dept} onValueChange={setDept}>
        <SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All SOPs</SelectItem>
          {departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
          <SelectItem value="general">General (no department)</SelectItem>
        </SelectContent>
      </Select>
      {list.length === 0 ? <EmptyState icon={<FileText />} title="No SOPs here" description="Write down how each job is done, step by step. Make it a checklist and staff tick it off every day." /> : (
        <div className="grid gap-2 md:grid-cols-2">
          {list.map((s) => (
            <Card key={s.id} className={cn('gap-1.5 p-3', !s.is_active && 'opacity-60')}>
              <div className="flex items-start justify-between gap-2">
                <button type="button" onClick={() => setReading(s)} className="text-left font-medium hover:underline">{s.title}</button>
                <div className="flex shrink-0 items-center gap-1">
                  <Badge variant={s.kind === 'CHECKLIST' ? 'info' : 'secondary'} className="text-[10px]">{s.kind === 'CHECKLIST' ? `Checklist · ${sopSteps(s.body).length}` : 'Guide'}</Badge>
                  {can('hr.manage') && <Button size="icon" variant="ghost" className="size-7" onClick={() => onEdit(s)} aria-label={`Edit ${s.title}`}><Pencil /></Button>}
                </div>
              </div>
              <p className="line-clamp-3 text-xs whitespace-pre-line text-muted-foreground">{s.body || 'No steps yet.'}</p>
              <p className="text-[11px] text-muted-foreground">{deptName(s.department_id)} · v{s.version} · updated {formatDate(s.updated_at)}{!s.is_active ? ' · archived' : ''}</p>
            </Card>
          ))}
        </div>
      )}
      {reading && (
        <Dialog open onOpenChange={(o) => !o && setReading(null)}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader><DialogTitle>{reading.title}</DialogTitle><DialogDescription>{deptName(reading.department_id)} · version {reading.version} · updated {formatDateTime(reading.updated_at)}</DialogDescription></DialogHeader>
            {reading.kind === 'CHECKLIST'
              ? <ol className="max-h-[60vh] list-decimal space-y-1 overflow-y-auto pl-5 text-sm">{sopSteps(reading.body).map((x, i) => <li key={i}>{x}</li>)}</ol>
              : <div className="max-h-[60vh] overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">{reading.body || 'No steps yet.'}</div>}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

/** Today's checklist completion per checklist and person. */
function ComplianceView() {
  const comp = useQuery({ queryKey: ['hr', 'compliance'], queryFn: () => checklistCompliance(), refetchInterval: 60_000 })
  if (comp.isLoading) return <LoadingState />
  if (comp.error) return <ErrorState error={comp.error} onRetry={() => comp.refetch()} />
  if (!comp.data?.length) return <EmptyState icon={<CheckCheck />} title="No checklists yet" description="Create an SOP of type Checklist; staff in its department tick it off each day." />
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {comp.data.map((c) => {
        const complete = c.people.filter((p) => c.items_total > 0 && p.done >= c.items_total).length
        return (
          <Card key={c.sop_id} className="gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <div><p className="font-medium">{c.title}</p><p className="text-xs text-muted-foreground">{c.department ?? 'All departments'} · {c.items_total} steps</p></div>
              <Badge variant={c.people.length && complete === c.people.length ? 'success' : 'secondary'}>{complete}/{c.people.length} done</Badge>
            </div>
            <ul className="space-y-1.5">
              {c.people.map((p) => (
                <li key={p.profile_id} className="flex items-center gap-2 text-sm">
                  <span className="w-32 shrink-0 truncate">{p.name}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${c.items_total ? (100 * p.done) / c.items_total : 0}%` }} /></span>
                  <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{p.done}/{c.items_total}</span>
                </li>
              ))}
              {!c.people.length && <li className="text-xs text-muted-foreground">Nobody in this department yet.</li>}
            </ul>
          </Card>
        )
      })}
    </div>
  )
}

function DepartmentDialog({ dept, onClose }: { dept: Partial<Department>; onClose: () => void }) {
  const qc = useQueryClient()
  const today = isoDate(new Date())
  const staff = useQuery({ queryKey: ['hr', 'board', today], queryFn: () => attendanceBoard(today) })
  const [v, setV] = useState(dept)
  const save = useMutation({ mutationFn: () => saveDepartment(v), onSuccess: () => { toast.success('Department saved'); invalidate(qc); onClose() }, onError })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{dept.id ? 'Edit department' : 'New department'}</DialogTitle><DialogDescription>For example Packing, Call center, Content, Accounts.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <Field label="Name" htmlFor="dp-name" required><Input id="dp-name" value={v.name ?? ''} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
          <Field label="What this team does" htmlFor="dp-desc"><Textarea id="dp-desc" rows={2} value={v.description ?? ''} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
          <Field label="Department head">
            <Select value={v.head_id ?? 'none'} onValueChange={(h) => setV({ ...v, head_id: h === 'none' ? null : h })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">Unassigned</SelectItem>{(staff.data ?? []).map((s) => <SelectItem key={s.profile_id} value={s.profile_id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Colour"><ColorPick value={v.color ?? COLORS[1]} onChange={(c) => setV({ ...v, color: c })} /></Field>
          {dept.id && <label className="flex items-center justify-between text-sm">Active <Switch checked={v.is_active ?? true} onCheckedChange={(c) => setV({ ...v, is_active: c })} /></label>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || (v.name ?? '').trim().length < 2}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SopDialog({ sop, departments, onClose }: { sop: Partial<Sop>; departments: Department[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState(sop)
  const save = useMutation({ mutationFn: () => saveSop(v), onSuccess: () => { toast.success('SOP saved'); invalidate(qc); onClose() }, onError })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>{sop.id ? 'Edit SOP' : 'New SOP'}</DialogTitle><DialogDescription>Each save of a changed SOP becomes a new version.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_200px]">
            <Field label="Title" htmlFor="sop-title" required><Input id="sop-title" value={v.title ?? ''} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="How to pack an order" /></Field>
            <Field label="Department">
              <Select value={v.department_id ?? 'none'} onValueChange={(d) => setV({ ...v, department_id: d === 'none' ? null : d })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">All departments</SelectItem>{departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Type">
            <div className="grid grid-cols-2 gap-2">
              {([['CHECKLIST', 'Daily checklist', 'Staff tick each line off every day'], ['GUIDE', 'Guide', 'A how-to to read']] as const).map(([k, l, h]) => (
                <button key={k} type="button" onClick={() => setV({ ...v, kind: k })}
                  className={cn('rounded-lg border p-2 text-left', (v.kind ?? 'GUIDE') === k ? 'border-primary bg-primary/5' : 'text-muted-foreground')}>
                  <span className="block text-sm font-medium text-foreground">{l}</span><span className="block text-xs">{h}</span>
                </button>
              ))}
            </div>
          </Field>
          <Field label="Steps" htmlFor="sop-body" hint={(v.kind ?? 'GUIDE') === 'CHECKLIST' ? `Each line is one step to tick (${sopSteps(v.body ?? '').length} now). Changing the steps starts today's ticks again.` : 'One step per line works well, e.g. 1. Check the invoice  2. Pick the items…'}>
            <Textarea id="sop-body" rows={12} value={v.body ?? ''} onChange={(e) => setV({ ...v, body: e.target.value })} />
          </Field>
          {sop.id && <label className="flex items-center justify-between text-sm">Active (archived SOPs stay readable) <Switch checked={v.is_active ?? true} onCheckedChange={(c) => setV({ ...v, is_active: c })} /></label>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || (v.title ?? '').trim().length < 2}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Staff: department, shift, designation, code and joining date. */
function StaffAssignment({ departments }: { departments: Department[] }) {
  const { can } = useAuth()
  const today = isoDate(new Date())
  const board = useQuery({ queryKey: ['hr', 'board', today], queryFn: () => attendanceBoard(today) })
  const employees = useQuery({ queryKey: ['hr', 'employees'], queryFn: listEmployees })
  const shifts = useQuery({ queryKey: ['hr', 'shifts'], queryFn: listShifts })
  const [editing, setEditing] = useState<BoardRow | null>(null)
  const byId = useMemo(() => new Map((employees.data ?? []).map((e) => [e.profile_id, e])), [employees.data])
  if (!can('hr.view')) return null
  return (
    <Card className="gap-0 p-0">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <p className="flex items-center gap-2 font-medium"><Users className="size-4" /> Staff details</p>
        <p className="text-xs text-muted-foreground">New staff are added under User & Role</p>
      </div>
      {board.isLoading ? <LoadingState /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b text-xs text-muted-foreground"><tr className="[&>th]:px-4 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium"><th>Staff</th><th>Department</th><th>Shift</th><th>Code</th><th>Joined</th><th /></tr></thead>
            <tbody className="divide-y">
              {(board.data ?? []).map((r) => {
                const e = byId.get(r.profile_id)
                return (
                  <tr key={r.profile_id} className="[&>td]:px-4 [&>td]:py-2">
                    <td><p className="font-medium">{r.name}</p><p className="text-xs text-muted-foreground">{e?.designation ?? r.role}</p></td>
                    <td>{r.department ?? <Badge variant="warning" className="text-[10px]">Not set</Badge>}</td>
                    <td>{r.shift ?? <Badge variant="warning" className="text-[10px]">Not set</Badge>}</td>
                    <td className="text-xs">{e?.employee_code ?? '—'}</td>
                    <td className="text-xs">{e?.joined_on ? formatDate(e.joined_on) : '—'}</td>
                    <td className="text-right">{can('hr.manage') && <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}><Pencil /></Button>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <EmployeeDialog row={editing} current={byId.get(editing.profile_id)} departments={departments} shifts={shifts.data ?? []} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function EmployeeDialog({ row, current, departments, shifts, onClose }: {
  row: BoardRow; current: Employee | undefined
  departments: Department[]; shifts: Shift[]; onClose: () => void
}) {
  const qc = useQueryClient()
  const [v, setV] = useState({
    department_id: current?.department_id ?? '', shift_id: current?.shift_id ?? '', designation: current?.designation ?? '',
    employee_code: current?.employee_code ?? '', joined_on: current?.joined_on ?? '', emergency_contact: current?.emergency_contact ?? '',
  })
  const save = useMutation({
    mutationFn: () => saveEmployee(row.profile_id, { ...v, department_id: v.department_id || null, shift_id: v.shift_id || null, joined_on: v.joined_on || null }),
    onSuccess: () => { toast.success(`${row.name} updated`); invalidate(qc); onClose() }, onError,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{row.name}</DialogTitle><DialogDescription>{row.email}</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Department">
              <Select value={v.department_id || 'none'} onValueChange={(d) => setV({ ...v, department_id: d === 'none' ? '' : d })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">None</SelectItem>{departments.filter((d) => d.is_active || d.id === v.department_id).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Shift">
              <Select value={v.shift_id || 'none'} onValueChange={(d) => setV({ ...v, shift_id: d === 'none' ? '' : d })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">None</SelectItem>{shifts.filter((s) => s.is_active || s.id === v.shift_id).map((s) => <SelectItem key={s.id} value={s.id}>{s.name} · {timeLabel(s.start_time)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Designation" htmlFor="em-des"><Input id="em-des" value={v.designation} onChange={(e) => setV({ ...v, designation: e.target.value })} placeholder="Packer, Call agent…" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Employee code" htmlFor="em-code"><Input id="em-code" value={v.employee_code} onChange={(e) => setV({ ...v, employee_code: e.target.value })} /></Field>
            <Field label="Joined on" htmlFor="em-join"><DatePicker id="em-join" clearable value={v.joined_on} onChange={(d) => setV({ ...v, joined_on: d })} /></Field>
          </div>
          <Field label="Emergency contact" htmlFor="em-emg"><Input id="em-emg" value={v.emergency_contact} onChange={(e) => setV({ ...v, emergency_contact: e.target.value })} placeholder="Name and phone" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- Team Rhythm (attendance rules)
type SettingsDraft = Omit<HrSettings, 'default_start' | 'default_end'> & { default_start: string; default_end: string; standard_hours: boolean }

function SettingRow({ title, hint, children, disabled }: { title: string; hint?: string; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 rounded-xl border p-3', disabled && 'opacity-50')}>
      <div className="min-w-0"><p className="text-sm font-medium">{title}</p>{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Section({ icon, title, hint, children, action }: { icon: ReactNode; title: string; hint: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card className="gap-0 p-0">
      <div className="flex items-start justify-between gap-3 border-b p-4">
        <div className="flex gap-3"><span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span><div><p className="font-medium">{title}</p><p className="text-xs text-muted-foreground">{hint}</p></div></div>
        {action}
      </div>
      <div className="grid gap-3 p-4">{children}</div>
    </Card>
  )
}

export function HrSettingsView() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: ['hr', 'settings'], queryFn: hrSettings })
  const holidays = useQuery({ queryKey: ['hr', 'holidays'], queryFn: listHolidays })
  const [v, setV] = useState<SettingsDraft | null>(null)
  const [hDate, setHDate] = useState('')
  const [hName, setHName] = useState('')
  const [addingHoliday, setAddingHoliday] = useState(false)
  useEffect(() => {
    if (settings.data && !v) {
      const x = settings.data
      setV({ ...x, standard_hours: Boolean(x.default_start), default_start: (x.default_start ?? '09:00').slice(0, 5), default_end: (x.default_end ?? '18:00').slice(0, 5) })
    }
  }, [settings.data, v])
  const save = useMutation({
    mutationFn: () => {
      const { standard_hours, ...rest } = v!
      return saveHrSettings({ ...rest, default_start: standard_hours ? rest.default_start : null, default_end: standard_hours ? rest.default_end : null })
    },
    onSuccess: () => { toast.success('Team Rhythm saved'); invalidate(qc) }, onError,
  })
  const addHoliday = useMutation({ mutationFn: () => saveHoliday(hDate, hName), onSuccess: () => { toast.success('Holiday added'); setHDate(''); setHName(''); setAddingHoliday(false); invalidate(qc) }, onError })
  const toggleHoliday = useMutation({ mutationFn: (h: { holiday_date: string; name: string; is_active: boolean }) => saveHoliday(h.holiday_date, h.name, !h.is_active), onSuccess: () => invalidate(qc), onError })
  if (settings.isLoading || !v) return <LoadingState />
  const edit = can('hr.manage')
  const set = (p: Partial<SettingsDraft>) => edit && setV({ ...v, ...p })
  const offDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !v.work_days.includes(d))
  const year = new Date().getFullYear()
  const warnOk = v.idle_warning_at < v.auto_break_after
  return (
    <div className="space-y-4 pb-20">
      <div className="grid gap-4 lg:grid-cols-2">
        <Section icon={<ShieldCheck />} title="Attendance access" hint="Whether attendance gates operational work.">
          <SettingRow title="Require check-in to work" hint="Staff must be checked in to change orders, stock, customers and couriers. The owner and exempt staff are never held.">
            <Switch disabled={!edit} checked={v.require_check_in} onCheckedChange={(c) => set({ require_check_in: c })} aria-label="Require check-in to work" />
          </SettingRow>
          <div className="pl-4">
            <SettingRow title="Block work during breaks" hint="Work pages stay closed until the break ends." disabled={!v.require_check_in}>
              <Switch disabled={!edit || !v.require_check_in} checked={v.block_during_breaks} onCheckedChange={(c) => set({ block_during_breaks: c })} aria-label="Block work during breaks" />
            </SettingRow>
          </div>
          <SettingRow title="Automatic check-out" hint="At the end of the shift (or standard hours). Staff get a 10-minute warning and can keep working for the day; every session keeps its times.">
            <Switch disabled={!edit} checked={v.auto_checkout} onCheckedChange={(c) => set({ auto_checkout: c })} aria-label="Automatic check-out" />
          </SettingRow>
          <SettingRow title="Staff check in and out themselves" hint="Off: only HR records attendance.">
            <Switch disabled={!edit} checked={v.allow_self_check_in} onCheckedChange={(c) => set({ allow_self_check_in: c })} aria-label="Self check-in" />
          </SettingRow>
        </Section>

        <Section icon={<CalendarDays />} title="Work schedule" hint="Weekly off-days and standard hours for staff without a shift.">
          <Field label="Weekly off-days">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d, i) => {
                const off = !v.work_days.includes(i)
                return (
                  <button key={d} type="button" aria-pressed={off} disabled={!edit}
                    onClick={() => { const next = off ? [...v.work_days, i].sort() : v.work_days.filter((x) => x !== i); if (next.length) set({ work_days: next }) }}
                    className={cn('min-w-12 rounded-lg border px-3 py-1.5 text-sm', off ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground')}>{d}</button>
                )
              })}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Off: {offDays.length ? offDays.map((d) => WEEKDAYS[d]).join(', ') : 'none'}</p>
          </Field>
          <SettingRow title="Standard hours" hint="Late, absent and automatic check-out for staff without a shift use these times.">
            <Switch disabled={!edit} checked={v.standard_hours} onCheckedChange={(c) => set({ standard_hours: c })} aria-label="Standard hours" />
          </SettingRow>
          <div className={cn('grid grid-cols-2 gap-2', !v.standard_hours && 'opacity-50')}>
            <Field label="Check-in time" htmlFor="ws-in"><Input id="ws-in" type="time" disabled={!edit || !v.standard_hours} value={v.default_start} onChange={(e) => set({ default_start: e.target.value })} /></Field>
            <Field label="Check-out time" htmlFor="ws-out"><Input id="ws-out" type="time" disabled={!edit || !v.standard_hours} value={v.default_end} onChange={(e) => set({ default_end: e.target.value })} /></Field>
          </div>
        </Section>

        <Section icon={<Timer />} title="Attendance rules" hint="Late threshold and break limits.">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Late grace (min)" htmlFor="ar-grace" hint="0–120, staff without a shift"><Input id="ar-grace" type="number" min={0} max={120} disabled={!edit} value={v.late_grace_minutes} onChange={(e) => set({ late_grace_minutes: Number(e.target.value) })} /></Field>
            <Field label="Max break (min)" htmlFor="ar-break" hint="Per day, 0–480"><Input id="ar-break" type="number" min={0} max={480} disabled={!edit} value={v.max_break_minutes} onChange={(e) => set({ max_break_minutes: Number(e.target.value) })} /></Field>
            <Field label="Half day under (min)" htmlFor="ar-half" hint={`${Math.floor(v.half_day_minutes / 60)}h ${v.half_day_minutes % 60}m of net work`}><Input id="ar-half" type="number" min={30} max={720} disabled={!edit} value={v.half_day_minutes} onChange={(e) => set({ half_day_minutes: Number(e.target.value) })} /></Field>
          </div>
        </Section>

        <Section icon={<Coffee />} title="Automatic break" hint="Start a break when nobody touches the admin for a while.">
          <SettingRow title="Auto-break on inactivity" hint="No mouse, keyboard or touch in the admin.">
            <Switch disabled={!edit} checked={v.auto_break} onCheckedChange={(c) => set({ auto_break: c })} aria-label="Automatic break" />
          </SettingRow>
          <div className={cn('grid grid-cols-2 gap-2', !v.auto_break && 'opacity-50')}>
            <Field label="Auto-break after (min)" htmlFor="ab-after" hint="1–60"><Input id="ab-after" type="number" min={1} max={60} disabled={!edit || !v.auto_break} value={v.auto_break_after} onChange={(e) => set({ auto_break_after: Number(e.target.value) })} /></Field>
            <Field label="Warning at (min)" htmlFor="ab-warn" error={!warnOk ? 'Must be less than the auto-break time' : undefined}><Input id="ab-warn" type="number" min={1} max={59} disabled={!edit || !v.auto_break} value={v.idle_warning_at} onChange={(e) => set({ idle_warning_at: Number(e.target.value) })} /></Field>
          </div>
          <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">How it works:</span> after <span className="font-medium text-amber-600">{v.idle_warning_at} minutes</span> of no activity, staff see a warning.
            If they don’t respond within <span className="font-medium text-amber-600">{Math.max(0, v.auto_break_after - v.idle_warning_at)} more minutes</span>, they’re put on a break, shown as idle time.
          </p>
        </Section>

        <Section icon={<CalendarOff />} title="Holidays" hint={`Holiday calendar for ${year}. Holidays are not work days, so nobody is marked absent.`}
          action={edit && <Button size="sm" variant="outline" onClick={() => setAddingHoliday((x) => !x)}><Plus /> Add</Button>}>
          {addingHoliday && (
            <form onSubmit={(e) => { e.preventDefault(); if (hDate && hName.trim().length >= 2) addHoliday.mutate() }} className="flex flex-wrap gap-2">
              <DatePicker value={hDate} onChange={setHDate} className="w-44" aria-label="Holiday date" />
              <Input value={hName} onChange={(e) => setHName(e.target.value)} placeholder="Name, e.g. Eid-ul-Fitr" className="min-w-40 flex-1" aria-label="Holiday name" />
              <Button type="submit" disabled={!hDate || hName.trim().length < 2 || addHoliday.isPending}><Plus /> Add</Button>
            </form>
          )}
          {!holidays.data?.length ? (
            <div className="flex flex-col items-center gap-2 py-6 text-sm text-muted-foreground"><CalendarDays className="size-8 opacity-40" /> No holidays configured</div>
          ) : (
            <ul className="divide-y rounded-lg border">
              {holidays.data.map((h) => (
                <li key={h.holiday_date} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className={cn(!h.is_active && 'text-muted-foreground line-through')}><span className="font-medium tabular-nums">{formatDate(h.holiday_date)}</span> · {h.name}</span>
                  {edit && <Switch checked={h.is_active} onCheckedChange={() => toggleHoliday.mutate(h)} aria-label={`${h.name} on or off`} />}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <EmployeeOverrides />
      </div>
      {edit && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <Button size="lg" className="pointer-events-auto shadow-lg" onClick={() => save.mutate()} disabled={save.isPending || !v.work_days.length || !warnOk}>
            {save.isPending ? <Spinner /> : <Settings2 />} Save settings
          </Button>
        </div>
      )}
    </div>
  )
}

type Tri = 'inherit' | 'on' | 'off'
const tri = (b: boolean | null | undefined): Tri => (b == null ? 'inherit' : b ? 'on' : 'off')
const fromTri = (t: Tri) => (t === 'inherit' ? '' : t === 'on')

/** People with their own rules: exempt from the check-in rule, own break limit, auto break or check-out on/off. */
function EmployeeOverrides() {
  const { can } = useAuth()
  const today = isoDate(new Date())
  const employees = useQuery({ queryKey: ['hr', 'employees'], queryFn: listEmployees })
  const board = useQuery({ queryKey: ['hr', 'board', today], queryFn: () => attendanceBoard(today) })
  const [editing, setEditing] = useState<string | null>(null)
  const name = (id: string) => (board.data ?? []).find((b) => b.profile_id === id)?.name ?? 'Staff member'
  const rows = (employees.data ?? []).filter((e) => e.attendance_exempt || e.max_break_minutes != null || e.auto_break != null || e.auto_checkout != null)
  return (
    <Section icon={<UserCog />} title="Employee overrides" hint="Rules for one person that differ from the store’s."
      action={can('hr.manage') && <Button size="sm" variant="outline" onClick={() => setEditing('')}><Plus /> Add override</Button>}>
      {!rows.length ? <p className="py-4 text-center text-sm text-muted-foreground">Everyone follows the store rules.</p> : (
        <ul className="divide-y rounded-lg border">
          {rows.map((e) => (
            <li key={e.profile_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{name(e.profile_id)}</p>
                <p className="text-xs text-muted-foreground">{[e.attendance_exempt && 'exempt from check-in', e.max_break_minutes != null && `${e.max_break_minutes} min breaks`,
                  e.auto_break != null && `auto break ${e.auto_break ? 'on' : 'off'}`, e.auto_checkout != null && `auto check-out ${e.auto_checkout ? 'on' : 'off'}`].filter(Boolean).join(' · ')}</p>
              </div>
              {can('hr.manage') && <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(e.profile_id)} aria-label={`Edit ${name(e.profile_id)}`}><Pencil /></Button>}
            </li>
          ))}
        </ul>
      )}
      {editing !== null && <OverrideDialog profileId={editing} staff={board.data ?? []} current={(employees.data ?? []).find((e) => e.profile_id === editing)} onClose={() => setEditing(null)} />}
    </Section>
  )
}

function OverrideDialog({ profileId, staff, current, onClose }: { profileId: string; staff: BoardRow[]; current: Employee | undefined; onClose: () => void }) {
  const qc = useQueryClient()
  const employees = useQuery({ queryKey: ['hr', 'employees'], queryFn: listEmployees })
  const [who, setWho] = useState(profileId)
  const cur = current ?? (employees.data ?? []).find((e) => e.profile_id === who)
  const [exempt, setExempt] = useState(Boolean(cur?.attendance_exempt))
  const [maxBreak, setMaxBreak] = useState(cur?.max_break_minutes == null ? '' : String(cur.max_break_minutes))
  const [autoBreak, setAutoBreak] = useState<Tri>(tri(cur?.auto_break))
  const [autoOut, setAutoOut] = useState<Tri>(tri(cur?.auto_checkout))
  const save = useMutation({
    mutationFn: () => saveEmployee(who, { attendance_exempt: exempt, max_break_minutes: maxBreak === '' ? null : Number(maxBreak), auto_break: fromTri(autoBreak) as never, auto_checkout: fromTri(autoOut) as never }),
    onSuccess: () => { toast.success('Override saved'); invalidate(qc); onClose() }, onError,
  })
  const clear = useMutation({
    mutationFn: () => saveEmployee(who, { attendance_exempt: false, max_break_minutes: null, auto_break: '' as never, auto_checkout: '' as never }),
    onSuccess: () => { toast.success('Back to the store rules'); invalidate(qc); onClose() }, onError,
  })
  const TriPick = ({ value, onChange, label }: { value: Tri; onChange: (t: Tri) => void; label: string }) => (
    <Field label={label}>
      <Select value={value} onValueChange={(t) => onChange(t as Tri)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="inherit">Store setting</SelectItem><SelectItem value="on">On</SelectItem><SelectItem value="off">Off</SelectItem></SelectContent>
      </Select>
    </Field>
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Employee override</DialogTitle><DialogDescription>Anything left on “Store setting” follows the store’s rules.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          {!profileId && (
            <Field label="Employee">
              <Select value={who} onValueChange={setWho}>
                <SelectTrigger><SelectValue placeholder="Choose someone" /></SelectTrigger>
                <SelectContent>{staff.map((s) => <SelectItem key={s.profile_id} value={s.profile_id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
            <span>Exempt from the check-in rule<span className="block text-xs text-muted-foreground">Never held by “Require check-in” or automatic check-out</span></span>
            <Switch checked={exempt} onCheckedChange={setExempt} />
          </label>
          <Field label="Max break (min)" htmlFor="ov-break" hint="Empty: store setting"><Input id="ov-break" type="number" min={0} max={480} value={maxBreak} onChange={(e) => setMaxBreak(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <TriPick label="Auto break" value={autoBreak} onChange={setAutoBreak} />
            <TriPick label="Auto check-out" value={autoOut} onChange={setAutoOut} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          {cur && <Button variant="ghost" className="mr-auto" onClick={() => clear.mutate()} disabled={clear.isPending || !who}>Remove override</Button>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !who}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
