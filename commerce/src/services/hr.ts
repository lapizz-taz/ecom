import { supabase } from '@/lib/supabase'
import type { Enums, Tables } from '@/types/database'

export type AttendanceStatus = Enums<'hr_attendance_status'>
export type AttendanceRow = Tables<'hr_attendance'>
export type Department = Tables<'hr_departments'>
export type Sop = Tables<'hr_sops'>
export type Shift = Tables<'hr_shifts'>
export type Employee = Tables<'hr_employees'>
export type Holiday = Tables<'hr_holidays'>
export type BoardState = AttendanceStatus | 'NOT_IN' | 'OFF'

export interface BoardRow {
  profile_id: string; name: string; email: string; role: string; department: string | null; department_color: string | null; designation: string | null
  shift: string | null; shift_start: string | null; shift_end: string | null; work_day: boolean; record: AttendanceRow | null; state: BoardState
}
export interface BreakRow { id: string; kind: 'MANUAL' | 'IDLE'; started_at: string; ended_at: string | null }
export type WorkGate = 'CHECK_IN_REQUIRED' | 'ON_BREAK' | null
export interface MyRules {
  require_check_in: boolean; block_during_breaks: boolean; auto_break: boolean; auto_break_after: number; idle_warning_at: number
  max_break_minutes: number; auto_checkout: boolean
}
export interface MyDay {
  date: string; tz: string; now: string; record: AttendanceRow | null; work_day: boolean; self_check_in: boolean
  shift: { id: string; name: string; start_time: string; end_time: string; grace_minutes: number } | null
  breaks: BreakRow[]; break_minutes: number; scheduled_end: string | null; rules: MyRules; gate: WorkGate
}
export interface HrDashboard {
  date: string
  today: { staff: number; present: number; late: number; half_day: number; leave: number; absent: number; not_in: number; off: number; checked_out: number }
  departments: Array<{ id: string; name: string; color: string; staff: number; sops: number }>
  trend: Array<{ date: string; present: number; late: number; absent: number; leave: number }>
  recent: Array<{ name: string; at: string; kind: 'in' | 'out'; status: AttendanceStatus; late_minutes: number }>
  unassigned: number
  board: BoardRow[]
}
export interface ReportStaff {
  profile_id: string; name: string; department: string | null; shift: string | null; work_days: number; present: number; late: number; half_day: number
  leave: number; holiday: number; absent: number; late_minutes: number; worked_minutes: number; rate: number | null
}
export interface ReportDay {
  profile_id: string; date: string; status: AttendanceStatus; check_in_at: string | null; check_out_at: string | null
  late_minutes: number; worked_minutes: number | null; note: string | null; source: 'SELF' | 'ADMIN'
}
export interface HrSettings {
  work_days: number[]; half_day_minutes: number; allow_self_check_in: boolean
  require_check_in: boolean; block_during_breaks: boolean; auto_checkout: boolean
  default_start: string | null; default_end: string | null; late_grace_minutes: number; max_break_minutes: number
  auto_break: boolean; auto_break_after: number; idle_warning_at: number
}
export type LiveState = 'WORKING' | 'IDLE' | 'ON_BREAK' | 'LEFT' | 'NOT_IN' | 'ABSENT' | 'OFF' | 'LEAVE' | 'HOLIDAY'
export interface LiveMember {
  profile_id: string; name: string; role: string; is_owner: boolean; department: string | null; department_color: string | null; designation: string | null
  shift: string | null; shift_start: string | null; shift_end: string | null
  check_in_at: string | null; check_out_at: string | null; checkout_source: 'SELF' | 'AUTO' | 'HR' | null; status: AttendanceStatus | null
  late_minutes: number; break_minutes: number; worked_minutes: number | null; on_break_since: string | null; on_break_kind: 'MANUAL' | 'IDLE' | null
  last_seen_at: string | null; open_orders: number; breaks: Array<{ kind: 'MANUAL' | 'IDLE'; started_at: string; ended_at: string | null }>; state: LiveState
}
export interface LiveDashboard {
  date: string; now: string; tz: string; idle_minutes: number
  tiles: { total: number; working: number; idle: number; on_break: number; present: number; left: number; not_in: number; off: number; late: number; expected: number; open_orders: number }
  team: LiveMember[]
  events: Array<{ name: string; kind: 'in' | 'out' | 'auto_out' | 'break' | 'idle' | 'back'; at: string }>
  pending_requests: number
}
export type MonthState = AttendanceStatus | 'UPCOMING' | 'OFF' | 'NOT_IN'
export interface MonthDay {
  date: string; work_day: boolean; holiday: string | null; state: MonthState; check_in_at: string | null; check_out_at: string | null
  checkout_source: 'SELF' | 'AUTO' | 'HR' | null; late_minutes: number; worked_minutes: number | null; break_minutes: number; breaks: number
  note: string | null; source: 'SELF' | 'ADMIN' | null
}
export interface MonthReview {
  profile_id: string; name: string; from: string; to: string; shift: { name: string; start_time: string; end_time: string } | null; days: MonthDay[]
  summary: { work_days: number; present: number; late: number; half_day: number; absent: number; leave: number; late_minutes: number; worked_minutes: number; break_minutes: number }
}
export type RequestKind = 'LEAVE' | 'CORRECTION' | 'LATE_EXCUSE'
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
export interface HrRequest {
  id: string; profile_id: string; name: string; kind: RequestKind; from_date: string; to_date: string; check_in: string | null; check_out: string | null
  reason: string; status: RequestStatus; decided_by: string | null; decided_at: string | null; decision_note: string | null; created_at: string; mine: boolean
}
export interface Checklist { id: string; title: string; body: string; version: number; department_id: string | null; items_total: number; done: number[] }
export interface Compliance {
  sop_id: string; title: string; department_id: string | null; department: string | null; items_total: number
  people: Array<{ profile_id: string; name: string; done: number }>
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never)
  if (error) throw error
  return data as T
}

export const myDay = () => rpc<MyDay>('hr_my_day')
export const checkIn = (note?: string) => rpc<AttendanceRow>('hr_check_in', { p_note: note || undefined })
export const checkOut = (note?: string) => rpc<AttendanceRow>('hr_check_out', { p_note: note || undefined })
export const hrDashboard = () => rpc<HrDashboard>('hr_dashboard')
export const attendanceBoard = (date: string) => rpc<BoardRow[]>('hr_attendance_board', { p_date: date })
export const setAttendance = (v: { profileId: string; date: string; status: AttendanceStatus; checkIn?: string | null; checkOut?: string | null; note?: string }) =>
  rpc<AttendanceRow>('hr_attendance_set', {
    p_profile: v.profileId, p_date: v.date, p_status: v.status, p_check_in: v.checkIn ?? undefined, p_check_out: v.checkOut ?? undefined, p_note: v.note || undefined,
  })
export const attendanceReport = (from: string, to: string) => rpc<{ from: string; to: string; staff: ReportStaff[]; days: ReportDay[] }>('hr_attendance_report', { p_from: from, p_to: to })
export const saveDepartment = (p: Partial<Department>) => rpc<Department>('hr_department_save', { p })
export const saveSop = (p: Partial<Sop>) => rpc<Sop>('hr_sop_save', { p })
export const saveShift = (p: Partial<Shift>) => rpc<Shift>('hr_shift_save', { p })
export const saveEmployee = (profileId: string, p: Partial<Employee>) => rpc<Employee>('hr_employee_save', { p_profile: profileId, p })
export const saveHoliday = (date: string, name: string, active = true) => rpc<Holiday>('hr_holiday_save', { p_date: date, p_name: name, p_active: active })
export const saveHrSettings = (p: Partial<HrSettings>) => rpc<HrSettings>('hr_settings_save', { p })
export const hrSettings = () => rpc<HrSettings>('hr_settings_get')
export const startBreak = (kind: 'MANUAL' | 'IDLE' = 'MANUAL') => rpc<BreakRow>('hr_break_start', { p_kind: kind })
export const endBreak = () => rpc<{ minutes: number; total_minutes: number; max_break_minutes: number; over_limit: boolean }>('hr_break_end')
export const keepWorkingToday = () => rpc<AttendanceRow>('hr_keep_working_today')
export const liveDashboard = (date?: string) => rpc<LiveDashboard>('hr_live_dashboard', { p_date: date || undefined })
export const employeeMonth = (profileId: string, month: string) => rpc<MonthReview>('hr_employee_month', { p_profile: profileId, p_month: month })
export const submitRequest = (p: { kind: RequestKind; from_date: string; to_date?: string; check_in?: string; check_out?: string; reason: string }) =>
  rpc<HrRequest>('hr_request_submit', { p })
export const cancelRequest = (id: string) => rpc<HrRequest>('hr_request_cancel', { p_id: id })
export const decideRequest = (id: string, approve: boolean, note?: string) => rpc<HrRequest>('hr_request_decide', { p_id: id, p_approve: approve, p_note: note || undefined })
export const listRequests = (status?: RequestStatus) => rpc<HrRequest[]>('hr_requests_list', { p_status: status })
export const myChecklists = () => rpc<Checklist[]>('hr_my_checklists')
export const tickChecklist = (sopId: string, item: number, done: boolean) =>
  rpc<{ sop_id: string; done: number[]; items_total: number; complete: boolean }>('hr_checklist_tick', { p_sop: sopId, p_item: item, p_done: done })
export const checklistCompliance = (date?: string) => rpc<Compliance[]>('hr_checklist_compliance', { p_date: date || undefined })
export const setDepartmentMembers = (departmentId: string, profileIds: string[]) =>
  rpc<number>('hr_department_members_set', { p_department: departmentId, p_profiles: profileIds })

/** The steps of an SOP checklist: its non-empty lines (the server counts them the same way). */
export const sopSteps = (body: string) => body.split('\n').filter((l) => l.trim() !== '').map((l) => l.trim().replace(/^(\d+[.)]|[-*•])\s*/, ''))

export async function listDepartments() {
  const { data, error } = await supabase.from('hr_departments').select('*').order('name')
  if (error) throw error
  return data ?? []
}
export async function listSops() {
  const { data, error } = await supabase.from('hr_sops').select('*').order('title')
  if (error) throw error
  return data ?? []
}
export async function listShifts() {
  const { data, error } = await supabase.from('hr_shifts').select('*').order('start_time')
  if (error) throw error
  return data ?? []
}
export async function listEmployees() {
  const { data, error } = await supabase.from('hr_employees').select('*')
  if (error) throw error
  return data ?? []
}
export async function listHolidays() {
  const { data, error } = await supabase.from('hr_holidays').select('*').order('holiday_date', { ascending: false })
  if (error) throw error
  return data ?? []
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
export const ATTENDANCE: Record<BoardState, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  PRESENT: { label: 'Present', variant: 'success' },
  LATE: { label: 'Late', variant: 'warning' },
  HALF_DAY: { label: 'Half day', variant: 'warning' },
  ABSENT: { label: 'Absent', variant: 'danger' },
  LEAVE: { label: 'Leave', variant: 'info' },
  HOLIDAY: { label: 'Holiday', variant: 'info' },
  NOT_IN: { label: 'Not in yet', variant: 'neutral' },
  OFF: { label: 'Day off', variant: 'neutral' },
}
export const LIVE: Record<LiveState, { label: string; dot: string }> = {
  WORKING: { label: 'Working', dot: 'bg-emerald-500' },
  IDLE: { label: 'Idle', dot: 'bg-zinc-400' },
  ON_BREAK: { label: 'On break', dot: 'bg-amber-500' },
  LEFT: { label: 'Checked out', dot: 'bg-sky-500' },
  NOT_IN: { label: 'Not present', dot: 'bg-zinc-300 dark:bg-zinc-600' },
  ABSENT: { label: 'Absent', dot: 'bg-red-500' },
  OFF: { label: 'Day off', dot: 'bg-zinc-300 dark:bg-zinc-600' },
  LEAVE: { label: 'On leave', dot: 'bg-violet-500' },
  HOLIDAY: { label: 'Holiday', dot: 'bg-violet-500' },
}
export const REQUEST_KIND: Record<RequestKind, string> = { LEAVE: 'Leave', CORRECTION: 'Attendance correction', LATE_EXCUSE: 'Late excuse' }
/** "1h 05m"-style clock for a duration in seconds. */
export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':')
}
export const minutesLabel = (m: number | null | undefined) => (m === null || m === undefined ? '—' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim())
export const timeLabel = (t: string | null | undefined) => {
  if (!t) return '—'
  const [h, m] = t.split(':').map(Number)
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** Minutes the store's time zone is ahead of UTC at a moment. */
function tzOffset(tz: string, at: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((x) => [x.type, x.value]))
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at.getTime()) / 60000
}
/** A store-local date + "HH:MM" as an ISO timestamp. */
export function zonedIso(date: string, time: string, tz: string) {
  const guess = new Date(`${date}T${time}:00Z`)
  return new Date(guess.getTime() - tzOffset(tz, guess) * 60000).toISOString()
}
/** "HH:MM" of a timestamp in the store's time zone (for time inputs). */
export function zonedHm(iso: string | null | undefined, tz: string) {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
}
/** "9:05 AM" of a timestamp in the store's time zone. */
export function zonedTime(iso: string | null | undefined, tz: string) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}
