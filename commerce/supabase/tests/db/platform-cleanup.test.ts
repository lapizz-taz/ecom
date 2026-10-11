import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

describe('Super Admin clean-up', () => {
  it('hides deleted merchants from the list, its counts and the overview', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      await as(db, superA)
      const id = (await value<{ id: string }>(db, `select public.platform_merchant_create('{"name": "Gone Shop", "phone": "01711000777"}')`)).id
      const list = () => value<Record<string, any>>(db, `select public.platform_merchants_list('{"q": "Gone Shop"}'::jsonb)`)
      expect((await list()).total).toBe(1)
      const before = await value<Record<string, any>>(db, `select public.platform_overview(current_date - 30, current_date)`)
      await asSystem(db, null)
      await db.query(`update public.merchants set deleted_at = now(), status = 'CLOSED', name = 'Deleted merchant #' || number where id = $1`, [id])
      await as(db, superA)
      expect((await value<Record<string, any>>(db, `select public.platform_merchants_list('{}'::jsonb, 'created_at', 'desc', 200)`)).items
        .some((m: { id: string }) => m.id === id)).toBe(false)
      const after = await value<Record<string, any>>(db, `select public.platform_overview(current_date - 30, current_date)`)
      expect(JSON.stringify(after)).not.toEqual(JSON.stringify(before))
      // Its page still opens (money records stay).
      expect((await value<Record<string, any>>(db, `select public.platform_merchant_get($1)`, [id])).merchant.id).toBe(id)
    }))

  it('removes a switched-off employee for good', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      const other = await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      await as(db, viewer)
      await expectError(db, `select public.platform_staff_remove($1, 'Typo account')`, [other], /PERMISSION_DENIED/)
      await as(db, superA)
      await expectError(db, `select public.platform_staff_remove($1, 'Typo account')`, [superA], /yourself/)
      await expectError(db, `select public.platform_staff_remove($1, 'Typo account')`, [other], /switch this employee off first/)
      await db.query(`select public.platform_staff_set_active($1, false, 'Typo account')`, [other])
      const r = await value<Record<string, any>>(db, `select public.platform_staff_remove($1, 'Typo account')`, [other])
      expect(r).toEqual({ removed: true, login_removed: true })

      const staff = await value<Array<{ user_id: string }>>(db, `select public.platform_staff_list()`)
      expect(staff.some((s) => s.user_id === other)).toBe(false)
      await expectError(db, `select public.platform_staff_set_active($1, true, 'Back again')`, [other], /not found/)
      await expectError(db, `select public.platform_staff_remove($1, 'Typo account')`, [other], /not found/)
      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.account_removals where user_id = $1 and status = 'PENDING'`, [other])).toBe(1)
      expect(await value<number>(db, `select count(*)::int from public.platform_audit_logs where action = 'employees.removed' and entity_id = $1::text`, [other])).toBe(1)
    }))

  it('keeps the login of a removed employee who also runs a business', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      const owner = await createStaff(db, 'OWNER', `both-${randomUUID().slice(0, 6)}@example.com`)
      await asSystem(db, null)
      await db.query(`insert into public.platform_staff (user_id, email, full_name, role_id, is_active)
                      select $1, 'both@example.com', 'Both', id, false from public.platform_roles where code = 'VIEWER'`, [owner])
      await as(db, superA)
      expect(await value<Record<string, any>>(db, `select public.platform_staff_remove($1, 'No longer on the team')`, [owner]))
        .toEqual({ removed: true, login_removed: false })
    }))
})
