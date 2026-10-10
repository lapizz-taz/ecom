import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, CalendarOff, Clock, FileText, Pencil, Plus, Save, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { formatDate, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  attendanceBoard, type BoardRow, type Department, type Employee, hrSettings, listDepartments, listEmployees, listHolidays, listShifts, listSops,
  saveDepartment, saveEmployee, saveHoliday, saveHrSettings, saveShift, saveSop, type Shift, type Sop, timeLabel, WEEKDAYS,
} from '@/services/hr'

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
  const departments = useQuery({ queryKey: ['hr', 'departments'], queryFn: listDepartments })
  const sops = useQuery({ queryKey: ['hr', 'sops'], queryFn: listSops })
  const employees = useQuery({ queryKey: ['hr', 'employees'], queryFn: listEmployees })
  const [dept, setDept] = useState<string>('all')
  const [editDept, setEditDept] = useState<Partial<Department> | null>(null)
  const [editSop, setEditSop] = useState<Partial<Sop> | null>(null)
  const [reading, setReading] = useState<Sop | null>(null)
  if (departments.isLoading || sops.isLoading) return <LoadingState />
  if (departments.error) return <ErrorState error={departments.error} onRetry={() => departments.refetch()} />
  const list = (sops.data ?? []).filter((s) => dept === 'all' || s.department_id === dept || (dept === 'general' && !s.department_id))
  const deptName = (id: string | null) => (departments.data ?? []).find((d) => d.id === id)?.name ?? 'All departments'
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="gap-1 p-2">
          <div className="flex items-center justify-between px-2 py-1">
            <p className="text-sm font-medium">Departments</p>
            {can('hr.manage') && <Button size="sm" variant="ghost" onClick={() => setEditDept({ name: '', color: COLORS[1], is_active: true })}><Plus /> Add</Button>}
          </div>
          {[{ id: 'all', name: 'All SOPs', color: null as string | null }, ...(departments.data ?? []).map((d) => ({ id: d.id, name: d.name, color: d.color })), { id: 'general', name: 'General (no department)', color: null }].map((d) => {
            const full = (departments.data ?? []).find((x) => x.id === d.id)
            const staff = (employees.data ?? []).filter((e) => e.department_id === d.id).length
            return (
              <div key={d.id} className={cn('group flex items-center gap-2 rounded-lg px-2 py-1.5', dept === d.id && 'bg-muted')}>
                <button type="button" onClick={() => setDept(d.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm">
                  {d.color ? <span className="size-2.5 shrink-0 rounded-full" style={{ background: d.color }} /> : <BookOpen className="size-3.5 text-muted-foreground" />}
                  <span className={cn('truncate', full && !full.is_active && 'text-muted-foreground line-through')}>{d.name}</span>
                  {full && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{staff} staff</span>}
                </button>
                {full && can('hr.manage') && <button type="button" onClick={() => setEditDept(full)} className="text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Edit ${d.name}`}><Pencil className="size-3.5" /></button>}
              </div>
            )
          })}
        </Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">{dept === 'all' ? 'All SOPs' : dept === 'general' ? 'General SOPs' : deptName(dept)} <span className="text-sm font-normal text-muted-foreground">· {list.length}</span></p>
            {can('hr.manage') && <Button size="sm" onClick={() => setEditSop({ title: '', body: '', department_id: ['all', 'general'].includes(dept) ? null : dept, is_active: true })}><Plus /> New SOP</Button>}
          </div>
          {list.length === 0 ? <EmptyState icon={<FileText />} title="No SOPs here" description="Write down how each job is done, step by step, so new staff can follow it." /> : (
            <div className="grid gap-2 md:grid-cols-2">
              {list.map((s) => (
                <Card key={s.id} className={cn('gap-1.5 p-3', !s.is_active && 'opacity-60')}>
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" onClick={() => setReading(s)} className="text-left font-medium hover:underline">{s.title}</button>
                    {can('hr.manage') && <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={() => setEditSop(s)} aria-label={`Edit ${s.title}`}><Pencil /></Button>}
                  </div>
                  <p className="line-clamp-3 text-xs whitespace-pre-line text-muted-foreground">{s.body || 'No steps yet.'}</p>
                  <p className="text-[11px] text-muted-foreground">{deptName(s.department_id)} · v{s.version} · updated {formatDate(s.updated_at)}{!s.is_active ? ' · archived' : ''}</p>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
      <StaffAssignment departments={departments.data ?? []} />
      {editDept && <DepartmentDialog dept={editDept} onClose={() => setEditDept(null)} />}
      {editSop && <SopDialog sop={editSop} departments={departments.data ?? []} onClose={() => setEditSop(null)} />}
      {reading && (
        <Dialog open onOpenChange={(o) => !o && setReading(null)}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader><DialogTitle>{reading.title}</DialogTitle><DialogDescription>{deptName(reading.department_id)} · version {reading.version} · updated {formatDateTime(reading.updated_at)}</DialogDescription></DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">{reading.body || 'No steps yet.'}</div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function DepartmentDialog({ dept, onClose }: { dept: Partial<Department>; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState(dept)
  const save = useMutation({ mutationFn: () => saveDepartment(v), onSuccess: () => { toast.success('Department saved'); invalidate(qc); onClose() }, onError })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{dept.id ? 'Edit department' : 'New department'}</DialogTitle><DialogDescription>For example Packing, Call center, Content, Accounts.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <Field label="Name" htmlFor="dp-name" required><Input id="dp-name" value={v.name ?? ''} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
          <Field label="What this team does" htmlFor="dp-desc"><Textarea id="dp-desc" rows={2} value={v.description ?? ''} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
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
          <Field label="Steps" htmlFor="sop-body" hint="One step per line works well, e.g. 1. Check the invoice  2. Pick the items…">
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
  const today = new Date().toISOString().slice(0, 10)
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
            <Field label="Joined on" htmlFor="em-join"><Input id="em-join" type="date" value={v.joined_on} onChange={(e) => setV({ ...v, joined_on: e.target.value })} /></Field>
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

// ---------------------------------------------------------------- Settings & holidays
export function HrSettingsView() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: ['hr', 'settings'], queryFn: hrSettings })
  const holidays = useQuery({ queryKey: ['hr', 'holidays'], queryFn: listHolidays })
  const [v, setV] = useState<{ work_days: number[]; half_day_minutes: number; allow_self_check_in: boolean } | null>(null)
  const [hDate, setHDate] = useState('')
  const [hName, setHName] = useState('')
  useEffect(() => { if (settings.data && !v) setV(settings.data) }, [settings.data, v])
  const save = useMutation({ mutationFn: () => saveHrSettings(v!), onSuccess: () => { toast.success('HR settings saved'); invalidate(qc) }, onError })
  const addHoliday = useMutation({ mutationFn: () => saveHoliday(hDate, hName), onSuccess: () => { toast.success('Holiday added'); setHDate(''); setHName(''); invalidate(qc) }, onError })
  const toggleHoliday = useMutation({ mutationFn: (h: { holiday_date: string; name: string; is_active: boolean }) => saveHoliday(h.holiday_date, h.name, !h.is_active), onSuccess: () => invalidate(qc), onError })
  if (settings.isLoading || !v) return <LoadingState />
  const edit = can('hr.manage')
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="gap-4 p-4">
        <p className="font-medium">Attendance rules</p>
        <Field label="Work days (staff without a shift)"><DaysPick value={v.work_days} onChange={(d) => edit && setV({ ...v, work_days: d })} /></Field>
        <Field label="Half day if worked less than (minutes)" htmlFor="hr-half" hint={`${Math.floor(v.half_day_minutes / 60)}h ${v.half_day_minutes % 60}m`}>
          <Input id="hr-half" type="number" min={30} max={720} disabled={!edit} value={v.half_day_minutes} onChange={(e) => setV({ ...v, half_day_minutes: Number(e.target.value) })} />
        </Field>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Staff check in and out themselves<p className="text-xs text-muted-foreground">Off: only HR records attendance</p></span>
          <Switch disabled={!edit} checked={v.allow_self_check_in} onCheckedChange={(c) => setV({ ...v, allow_self_check_in: c })} />
        </label>
        {edit && <Button className="justify-self-start" onClick={() => save.mutate()} disabled={save.isPending || !v.work_days.length}>{save.isPending ? <Spinner /> : <Save />} Save rules</Button>}
      </Card>
      <Card className="gap-3 p-4">
        <p className="flex items-center gap-2 font-medium"><CalendarOff className="size-4" /> Holidays</p>
        <p className="text-xs text-muted-foreground">Holidays are not work days, so nobody is marked absent.</p>
        {edit && (
          <form onSubmit={(e) => { e.preventDefault(); if (hDate && hName.trim().length >= 2) addHoliday.mutate() }} className="flex flex-wrap gap-2">
            <Input type="date" value={hDate} onChange={(e) => setHDate(e.target.value)} className="w-40" aria-label="Holiday date" />
            <Input value={hName} onChange={(e) => setHName(e.target.value)} placeholder="Name, e.g. Eid-ul-Fitr" className="min-w-40 flex-1" aria-label="Holiday name" />
            <Button type="submit" disabled={!hDate || hName.trim().length < 2 || addHoliday.isPending}><Plus /> Add</Button>
          </form>
        )}
        {!holidays.data?.length ? <p className="text-sm text-muted-foreground">No holidays yet.</p> : (
          <ul className="divide-y rounded-lg border">
            {holidays.data.map((h) => (
              <li key={h.holiday_date} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className={cn(!h.is_active && 'text-muted-foreground line-through')}><span className="font-medium tabular-nums">{formatDate(h.holiday_date)}</span> · {h.name}</span>
                {edit && <Switch checked={h.is_active} onCheckedChange={() => toggleHoliday.mutate(h)} aria-label={`${h.name} on or off`} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
