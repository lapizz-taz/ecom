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
export interface MyDay {
  date: string; tz: string; record: AttendanceRow | null; work_day: boolean; self_check_in: boolean
  shift: { id: string; name: string; start_time: string; end_time: string; grace_minutes: number } | null
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
export interface HrSettings { work_days: number[]; half_day_minutes: number; allow_self_check_in: boolean }

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
export async function hrSettings(): Promise<HrSettings> {
  const { data, error } = await supabase.from('settings').select('value').eq('key', 'hr').maybeSingle()
  if (error) throw error
  const v = (data?.value ?? {}) as Partial<HrSettings>
  return { work_days: v.work_days ?? [0, 1, 2, 3, 4, 6], half_day_minutes: v.half_day_minutes ?? 240, allow_self_check_in: v.allow_self_check_in ?? true }
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
