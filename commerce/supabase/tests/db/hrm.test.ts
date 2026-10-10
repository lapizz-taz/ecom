import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

const today = (db: Db) => value<string>(db, `select public._hr_today()::text`)
/** Store-time helpers, read as the system (staff cannot call store_timezone directly). */
async function asStore<T>(db: Db, user: string, sql: string, params: unknown[] = []) {
  await asSystem(db)
  const v = await value<T>(db, sql, params)
  await asUser(db, user)
  return v
}

async function setUp(db: Db) {
  const owner = await createStaff(db, 'OWNER')
  const agent = await createStaff(db, 'ORDER_MANAGER')
  await asUser(db, owner)
  const dept = await value<Record<string, any>>(db, `select to_jsonb(public.hr_department_save($1))`, [JSON.stringify({ name: `Packing ${Math.random().toString(36).slice(2, 6)}` })])
  // Starts at midnight with no grace and works every day, so any check-in today is late by the minutes since midnight.
  const shift = await value<Record<string, any>>(db, `select to_jsonb(public.hr_shift_save($1))`, [JSON.stringify({
    name: `Night ${Math.random().toString(36).slice(2, 6)}`, start_time: '00:00', end_time: '23:59', grace_minutes: 0, work_days: [0, 1, 2, 3, 4, 5, 6] })])
  await db.query(`select public.hr_employee_save($1, $2)`, [agent, JSON.stringify({ department_id: dept.id, shift_id: shift.id, designation: 'Packer' })])
  return { owner, agent, dept, shift }
}

describe('HRM attendance', () => {
  it('staff check in and out themselves; late is measured from the shift start; one check-in per day', () =>
    inTx(async (db) => {
      const { agent } = await setUp(db)
      await asUser(db, agent)
      const mins = await asStore<number>(db, agent, `select floor(extract(epoch from (now() at time zone public.store_timezone())::time) / 60)::int`)
      const row = await value<Record<string, any>>(db, `select to_jsonb(public.hr_check_in('On time?'))`)
      expect(row.work_date).toBe(await today(db))
      if (mins > 0) expect(row).toMatchObject({ status: 'LATE', late_minutes: mins })
      await expectError(db, `select public.hr_check_in()`, [], /already checked in/)
      const out = await value<Record<string, any>>(db, `select to_jsonb(public.hr_check_out())`)
      expect(out.worked_minutes).toBe(0)
      expect(out.status).toBe('HALF_DAY') // left before the half-day threshold
      const me = await value<Record<string, any>>(db, `select public.hr_my_day()`)
      expect(me.record.id).toBe(row.id)
      expect(me.shift.grace_minutes).toBe(0)
    }))

  it('HR sees the board, corrects days and gets a report that counts missing work days as absent', () =>
    inTx(async (db) => {
      const { owner, agent } = await setUp(db)
      const day = await today(db)
      const yesterday = await value<string>(db, `select (public._hr_today() - 1)::text`)
      const before = await value<string>(db, `select (public._hr_today() - 2)::text`)
      await asUser(db, owner)
      const board = await value<any[]>(db, `select public.hr_attendance_board()`)
      expect(board.find((b) => b.profile_id === agent)).toMatchObject({ designation: 'Packer', state: 'NOT_IN' })

      // Two days ago: present 09:00–17:00 local. Yesterday: nothing recorded. Today: leave.
      const at = (d: string, t: string) => asStore<string>(db, owner, `select (($1::date + $2::time) at time zone public.store_timezone())::text`, [d, t])
      const set = await value<Record<string, any>>(db, `select to_jsonb(public.hr_attendance_set($1, $2, 'PRESENT', $3, $4, 'Fixed by HR'))`,
        [agent, before, await at(before, '09:00'), await at(before, '17:00')])
      expect(set).toMatchObject({ status: 'LATE', late_minutes: 540, worked_minutes: 480, source: 'ADMIN' })
      await db.query(`select public.hr_attendance_set($1, $2, 'LEAVE')`, [agent, day])
      await expectError(db, `select public.hr_attendance_set($1, $2::date + 1, 'LEAVE')`, [agent, day], /future/)

      const rep = await value<Record<string, any>>(db, `select public.hr_attendance_report($1, $2)`, [before, day])
      const r = rep.staff.find((s: any) => s.profile_id === agent)
      expect(r).toMatchObject({ work_days: 3, late: 1, leave: 1, absent: 1, worked_minutes: 480, late_minutes: 540 })

      // A holiday yesterday: no longer an absence.
      await db.query(`select public.hr_holiday_save($1, 'Victory Day')`, [yesterday])
      const rep2 = await value<Record<string, any>>(db, `select public.hr_attendance_report($1, $2)`, [before, day])
      expect(rep2.staff.find((s: any) => s.profile_id === agent)).toMatchObject({ work_days: 2, absent: 0 })

      const dash = await value<Record<string, any>>(db, `select public.hr_dashboard()`)
      expect(dash.today.leave).toBeGreaterThanOrEqual(1)

      // Staff without HR permission: only their own day.
      await asUser(db, agent)
      await expectError(db, `select public.hr_attendance_board()`, [], /hr.view/)
      await expectError(db, `select public.hr_attendance_set($1, $2, 'ABSENT')`, [agent, day], /hr.manage/)
      expect(await value<number>(db, `select count(*)::int from public.hr_attendance where profile_id <> $1`, [agent])).toBe(0)
      await asSystem(db)
    }))
})
