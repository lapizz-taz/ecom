import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createStaff, setSetting } from '../support/fixtures'

afterAll(closePool)

const tag = () => Math.random().toString(36).slice(2, 6)
const json = (v: unknown) => JSON.stringify(v)

/** Owner, an order agent in a department on an all-week shift, and a second agent elsewhere. */
async function setUp(db: Db, shift: { start: string; end: string } = { start: '00:00', end: '23:59' }) {
  const owner = await createStaff(db, 'OWNER')
  const agent = await createStaff(db, 'ORDER_MANAGER')
  const other = await createStaff(db, 'ORDER_MANAGER')
  await asUser(db, owner)
  const dept = await value<Record<string, any>>(db, `select to_jsonb(public.hr_department_save($1))`, [json({ name: `Calls ${tag()}` })])
  const sh = await value<Record<string, any>>(db, `select to_jsonb(public.hr_shift_save($1))`, [json({
    name: `All week ${tag()}`, start_time: shift.start, end_time: shift.end, grace_minutes: 0, work_days: [0, 1, 2, 3, 4, 5, 6] })])
  await db.query(`select public.hr_employee_save($1, $2)`, [agent, json({ department_id: dept.id, shift_id: sh.id })])
  await db.query(`select public.hr_employee_save($1, $2)`, [other, json({ shift_id: sh.id })])
  return { owner, agent, other, dept, shift: sh }
}

/** Move a session and its breaks back in time (as the system), so durations are not zero inside one transaction. */
async function rewind(db: Db, user: string, attendanceId: string, checkInAgo: number, breaks: Array<[number, number | null]> = []) {
  await asSystem(db)
  await db.query(`update public.hr_attendance set check_in_at = now() - make_interval(mins => $2) where id = $1`, [attendanceId, checkInAgo])
  await db.query(`delete from public.hr_breaks where attendance_id = $1`, [attendanceId])
  for (const [from, to] of breaks) {
    await db.query(`insert into public.hr_breaks(attendance_id, profile_id, started_at, ended_at, ended_by)
      values ($1, $2, now() - make_interval(mins => $3), case when $4::int is null then null else now() - make_interval(mins => $4::int) end,
              case when $4::int is null then null else 'SELF' end)`, [attendanceId, user, from, to])
  }
  await asUser(db, user)
}

describe('HRM workforce: breaks and net hours', () => {
  it('a break can be started once, ended, and is taken off the worked time at check-out', () =>
    inTx(async (db) => {
      const { agent } = await setUp(db)
      await asUser(db, agent)
      await expectError(db, `select public.hr_break_start()`, [], /check in first/)
      const row = await value<Record<string, any>>(db, `select to_jsonb(public.hr_check_in())`)
      const b = await value<Record<string, any>>(db, `select public.hr_break_start()`)
      expect(b).toMatchObject({ kind: 'MANUAL', ended_at: null })
      await expectError(db, `select public.hr_break_start()`, [], /already on a break/)
      const me = await value<Record<string, any>>(db, `select public.hr_my_day()`)
      expect(me.breaks).toHaveLength(1)
      const end = await value<Record<string, any>>(db, `select public.hr_break_end()`)
      expect(end).toMatchObject({ minutes: 0, over_limit: false, max_break_minutes: 60 })
      await expectError(db, `select public.hr_break_end()`, [], /not on a break/)
      await expectError(db, `select public.hr_break_start('IDLE')`, [], /automatic breaks are off/)

      // 2 hours in, one 30-minute break and one still open for 10 minutes: 80 minutes net, 40 on breaks.
      await rewind(db, agent, row.id, 120, [[60, 30], [10, null]])
      const out = await value<Record<string, any>>(db, `select to_jsonb(public.hr_check_out())`)
      expect(out).toMatchObject({ worked_minutes: 80, break_minutes: 40, checkout_source: 'SELF' })
      expect(await value<number>(db, `select count(*)::int from public.hr_breaks where attendance_id = $1 and ended_at is null`, [row.id])).toBe(0)
    }))
})

describe('HRM workforce: check-in required to work', () => {
  it('staff must be checked in, and not on a break, to change things in operational modules', () =>
    inTx(async (db) => {
      const { owner, agent } = await setUp(db)
      await asUser(db, agent)
      expect(await value<boolean>(db, `select public.has_permission('orders.update')`)).toBe(true) // rule off

      await asUser(db, owner)
      await db.query(`select public.hr_settings_save($1)`, [json({ require_check_in: true })])
      expect(await value<boolean>(db, `select public.has_permission('orders.update')`)).toBe(true) // the owner is never held

      await asUser(db, agent)
      expect(await value<boolean>(db, `select public.has_permission('orders.update')`)).toBe(false)
      expect(await value<boolean>(db, `select public.has_permission('orders.view')`)).toBe(true) // viewing is not blocked
      expect(await value<boolean>(db, `select public.has_permission('hr.view')`)).toBe(false) // no role permission anyway
      await expectError(db, `select public.admin_update_order(gen_random_uuid(), '{}'::jsonb)`, [], /CHECK_IN_REQUIRED/)
      expect((await value<Record<string, any>>(db, `select public.hr_my_day()`)).gate).toBe('CHECK_IN_REQUIRED')

      await db.query(`select public.hr_check_in()`)
      await expectError(db, `select public.admin_update_order(gen_random_uuid(), '{}'::jsonb)`, [], /not found/i) // allowed now: fails only on the made-up order
      await db.query(`select public.hr_break_start()`)
      await expectError(db, `select public.process_order_return(gen_random_uuid(), '[]'::jsonb)`, [], /ON_BREAK/)
      await db.query(`select public.hr_break_end()`)
      expect(await value<boolean>(db, `select public.has_permission('orders.status')`)).toBe(true)
      await db.query(`select public.hr_check_out()`)
      await expectError(db, `select public.admin_update_order(gen_random_uuid(), '{}'::jsonb)`, [], /CHECK_IN_REQUIRED/)

      // Breaks may be allowed; an exempt person is never held.
      await asUser(db, owner)
      await db.query(`select public.hr_employee_save($1, $2)`, [agent, json({ attendance_exempt: true })])
      await asUser(db, agent)
      expect(await value<boolean>(db, `select public.has_permission('orders.update')`)).toBe(true)
      expect((await value<Record<string, any>>(db, `select public.hr_my_day()`)).rules.require_check_in).toBe(false)
    }))

  it('settings are validated', () =>
    inTx(async (db) => {
      const { owner, agent } = await setUp(db)
      await asUser(db, owner)
      await expectError(db, `select public.hr_settings_save($1)`, [json({ auto_break_after: 5, idle_warning_at: 5 })], /warning must come before/)
      await expectError(db, `select public.hr_settings_save($1)`, [json({ default_start: '09:00' })], /both the check-in and check-out/)
      await expectError(db, `select public.hr_settings_save($1)`, [json({ default_start: '9am', default_end: '18:00' })], /time like 09:00/)
      await expectError(db, `select public.hr_settings_save($1)`, [json({ max_break_minutes: 999 })], /0–480/)
      const cfg = await value<Record<string, any>>(db, `select public.hr_settings_save($1)`,
        [json({ default_start: '09:00', default_end: '18:00', late_grace_minutes: 15, auto_break: true, auto_break_after: 10, idle_warning_at: 8 })])
      expect(cfg).toMatchObject({ default_start: '09:00', default_end: '18:00', auto_break: true, require_check_in: false })
      await asUser(db, agent)
      await expectError(db, `select public.hr_settings_save($1)`, [json({ require_check_in: false })], /hr.manage/)
    }))

  it('staff without a shift follow the store work schedule once it is set', () =>
    inTx(async (db) => {
      const { owner } = await setUp(db)
      const loner = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, loner)
      expect((await value<Record<string, any>>(db, `select public.hr_my_day()`)).shift).toBeNull()
      await asUser(db, owner)
      await db.query(`select public.hr_settings_save($1)`, [json({ default_start: '00:00', default_end: '23:59', late_grace_minutes: 0, work_days: [0, 1, 2, 3, 4, 5, 6] })])
      await asUser(db, loner)
      const me = await value<Record<string, any>>(db, `select public.hr_my_day()`)
      expect(me.shift).toMatchObject({ name: 'Standard hours', grace_minutes: 0 })
    }))
})

describe('HRM workforce: automatic check-out', () => {
  it('checks out open sessions at the scheduled end unless the person keeps working today', () =>
    inTx(async (db) => {
      // The shift ended at 00:01 today, so any session today is past its end.
      const { owner, agent, other } = await setUp(db, { start: '00:00', end: '00:01' })
      await asUser(db, owner)
      await db.query(`select public.hr_settings_save($1)`, [json({ auto_checkout: true })])
      await asUser(db, agent)
      const a = await value<Record<string, any>>(db, `select to_jsonb(public.hr_check_in())`)
      await db.query(`select public.hr_break_start()`)
      await asUser(db, other)
      await db.query(`select public.hr_check_in()`)
      await db.query(`select public.hr_keep_working_today()`)
      await expectError(db, `select public.hr_auto_checkout()`, [], /permission denied/i)

      await asSystem(db)
      const run = await value<Record<string, any>>(db, `select public.for_each_merchant('hr_auto_checkout')`)
      expect(run.failed).toBe(0)
      const row = await value<Record<string, any>>(db, `select to_jsonb(a) from public.hr_attendance a where id = $1`, [a.id])
      expect(row).toMatchObject({ checkout_source: 'AUTO', worked_minutes: 0 })
      expect(row.check_out_at).not.toBeNull()
      expect(await value<string>(db, `select ended_by from public.hr_breaks where attendance_id = $1`, [a.id])).toBe('AUTO_CHECKOUT')
      expect(await value<string | null>(db, `select check_out_at::text from public.hr_attendance where profile_id = $1`, [other])).toBeNull()
    }))
})

describe('HRM workforce: requests', () => {
  it('leave, correction and late excuse are applied when HR approves them', () =>
    inTx(async (db) => {
      const { owner, agent } = await setUp(db)
      const day = await value<string>(db, `select public._hr_today()::text`)
      const yesterday = await value<string>(db, `select (public._hr_today() - 1)::text`)
      const later = await value<string>(db, `select (public._hr_today() + 3)::text`)
      await asUser(db, agent)
      await expectError(db, `select public.hr_request_submit($1)`, [json({ kind: 'LEAVE', from_date: later, reason: 'x' })], /short reason/)
      await expectError(db, `select public.hr_request_submit($1)`, [json({ kind: 'CORRECTION', from_date: later, check_in: '09:00', reason: 'Forgot' })], /one past day/)
      const leave = await value<Record<string, any>>(db, `select to_jsonb(public.hr_request_submit($1))`,
        [json({ kind: 'LEAVE', from_date: later, to_date: later, reason: 'Family wedding' })])
      await expectError(db, `select public.hr_request_submit($1)`, [json({ kind: 'LEAVE', from_date: later, reason: 'Again please' })], /already have a pending/)
      const fix = await value<Record<string, any>>(db, `select to_jsonb(public.hr_request_submit($1))`,
        [json({ kind: 'CORRECTION', from_date: yesterday, check_in: '09:00', check_out: '17:00', reason: 'Phone died, forgot to check in' })])
      await db.query(`select public.hr_check_in()`)
      const excuse = await value<Record<string, any>>(db, `select to_jsonb(public.hr_request_submit($1))`,
        [json({ kind: 'LATE_EXCUSE', from_date: day, reason: 'Traffic jam on the bridge' })])
      await expectError(db, `select public.hr_request_decide($1, true)`, [leave.id], /hr.manage/)
      const mine = await value<any[]>(db, `select public.hr_requests_list()`)
      expect(mine.map((r) => r.kind).sort()).toEqual(['CORRECTION', 'LATE_EXCUSE', 'LEAVE'])

      await asUser(db, owner)
      expect((await value<Record<string, any>>(db, `select to_jsonb(public.hr_request_decide($1, true, 'Enjoy'))`, [leave.id])).status).toBe('APPROVED')
      await expectError(db, `select public.hr_request_decide($1, false)`, [leave.id], /already approved/)
      expect(await value<string>(db, `select status::text from public.hr_attendance where profile_id = $1 and work_date = $2`, [agent, later])).toBe('LEAVE')
      await db.query(`select public.hr_request_decide($1, true)`, [fix.id])
      const corrected = await value<Record<string, any>>(db, `select to_jsonb(a) from public.hr_attendance a where profile_id = $1 and work_date = $2`, [agent, yesterday])
      expect(corrected).toMatchObject({ status: 'LATE', late_minutes: 540, worked_minutes: 480, source: 'ADMIN' })
      await db.query(`select public.hr_request_decide($1, true)`, [excuse.id])
      expect(await value<number>(db, `select late_minutes from public.hr_attendance where profile_id = $1 and work_date = $2`, [agent, day])).toBe(0)
    }))
})

describe('HRM workforce: SOP checklists, members, dashboards', () => {
  it('staff tick their department checklists and HR sees completion; other departments cannot tick', () =>
    inTx(async (db) => {
      const { owner, agent, other, dept } = await setUp(db)
      await asUser(db, owner)
      const sop = await value<Record<string, any>>(db, `select to_jsonb(public.hr_sop_save($1))`,
        [json({ title: 'Opening checklist', kind: 'CHECKLIST', department_id: dept.id, body: '1. Open the inbox\n\n2. Call yesterday\'s missed\n3. Print labels' })])
      await asUser(db, agent)
      const list = await value<any[]>(db, `select public.hr_my_checklists()`)
      expect(list.find((c) => c.id === sop.id)).toMatchObject({ items_total: 3, done: [] })
      await db.query(`select public.hr_checklist_tick($1, 0, true)`, [sop.id])
      const t = await value<Record<string, any>>(db, `select public.hr_checklist_tick($1, 2, true)`, [sop.id])
      expect(t).toMatchObject({ done: [0, 2], complete: false })
      await expectError(db, `select public.hr_checklist_tick($1, 3, true)`, [sop.id], /no such step/)
      await asUser(db, other)
      await expectError(db, `select public.hr_checklist_tick($1, 0, true)`, [sop.id], /another department/)

      await asUser(db, owner)
      const comp = await value<any[]>(db, `select public.hr_checklist_compliance()`)
      expect(comp.find((c) => c.sop_id === sop.id).people).toEqual([expect.objectContaining({ profile_id: agent, done: 2 })])
      // Editing the steps makes a new version: yesterday's ticks no longer count.
      await db.query(`select public.hr_sop_save($1)`, [json({ id: sop.id, body: 'Open the inbox\nPrint labels' })])
      const comp2 = await value<any[]>(db, `select public.hr_checklist_compliance()`)
      expect(comp2.find((c) => c.sop_id === sop.id)).toMatchObject({ items_total: 2, people: [expect.objectContaining({ done: 0 })] })

      // Members: exactly these people.
      expect(await value<number>(db, `select public.hr_department_members_set($1, $2)`, [dept.id, [other]])).toBe(1)
      expect(await value<string | null>(db, `select department_id::text from public.hr_employees where profile_id = $1`, [agent])).toBeNull()
    }))

  it('the live dashboard shows who is working, on a break or not in; the month review lists every day', () =>
    inTx(async (db) => {
      // The owner has no shift, so the store's work days apply: make today one, whatever the weekday.
      await setSetting(db, 'hr', { work_days: [0, 1, 2, 3, 4, 5, 6] })
      const { owner, agent, other } = await setUp(db)
      await asUser(db, agent)
      await db.query(`select public.hr_check_in()`)
      await db.query(`select public.presence_ping('admin', '/admin/orders')`)
      await asUser(db, other)
      await db.query(`select public.hr_check_in()`)
      await db.query(`select public.hr_break_start()`)
      await expectError(db, `select public.hr_live_dashboard()`, [], /hr.view/)
      await expectError(db, `select public.hr_employee_month($1, current_date)`, [agent], /hr.view/)
      const own = await value<Record<string, any>>(db, `select public.hr_employee_month($1, public._hr_today())`, [other])
      expect(own.days.length).toBeGreaterThanOrEqual(28)

      await asUser(db, owner)
      const live = await value<Record<string, any>>(db, `select public.hr_live_dashboard()`)
      const by = (id: string) => live.team.find((t: any) => t.profile_id === id)
      expect(by(agent)).toMatchObject({ state: 'WORKING', break_minutes: 0 })
      expect(by(other)).toMatchObject({ state: 'ON_BREAK', on_break_kind: 'MANUAL' })
      expect(by(owner).state).toBe('NOT_IN')
      expect(live.tiles.present).toBeGreaterThanOrEqual(2)
      expect(live.tiles.on_break).toBeGreaterThanOrEqual(1)
      expect(live.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['in', 'break']))

      const month = await value<Record<string, any>>(db, `select public.hr_employee_month($1, public._hr_today())`, [agent])
      const today = await value<string>(db, `select public._hr_today()::text`)
      expect(month.days.find((d: any) => d.date === today).state).toMatch(/PRESENT|LATE/)
      expect(month.summary.present).toBe(1)
    }))
})
