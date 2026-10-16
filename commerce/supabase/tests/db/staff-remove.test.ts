import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

describe('deleting a staff member', () => {
  it('only a deactivated member, never yourself, keeping their name on past work', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const agent = await createStaff(db, 'CALL')
      await asUser(db, owner)
      await expectError(db, `select public.admin_staff_remove($1)`, [agent], /deactivate this person first/)
      await expectError(db, `select public.admin_staff_remove($1)`, [owner], /cannot delete yourself/)
      await db.query(`select public.admin_set_user_role($1, 'CALL', false)`, [agent])
      await db.query(`select public.admin_staff_remove($1)`, [agent])
      await expectError(db, `select public.admin_staff_remove($1)`, [agent], /not found/)

      await asSystem(db)
      // The row stays (orders and notes keep their name), marked removed, with an audit entry.
      expect(await value(db, `select removed_at is not null from public.profiles where id = $1`, [agent])).toBe(true)
      expect(await value(db, `select count(*)::int from public.audit_logs where action = 'staff.deleted' and entity_id = $1`, [agent])).toBe(1)

      // Added back with a role: on the list again.
      await asUser(db, owner)
      await db.query(`select public.admin_set_user_role($1, 'CALL', true)`, [agent])
      await asSystem(db)
      expect(await value(db, `select removed_at from public.profiles where id = $1`, [agent])).toBeNull()
    }))

  it('needs users.manage, and a manager cannot delete an owner', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const owner2 = await createStaff(db, 'OWNER')
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, owner)
      await db.query(`select public.admin_set_user_role($1, 'OWNER', false)`, [owner2])
      await asUser(db, viewer)
      await expectError(db, `select public.admin_staff_remove($1)`, [owner2], /PERMISSION_DENIED|permission/i)
    }))
})
