import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value } from '../support/db'
import { createPlatformStaff } from '../support/fixtures'

afterAll(closePool)

const as = (db: Parameters<typeof asSystem>[0], id: string) => asUser(db, id, 'staff@platform.example', null)

/** A custom platform role that may approve support matters only. */
async function supportLead(db: Parameters<typeof asSystem>[0]): Promise<string> {
  await asSystem(db, null)
  const role = await value<string>(db, `insert into public.platform_roles (code, name, description) values ('SUPPORT_LEAD', 'Support lead', 'Approves support matters') returning id`)
  await db.query(`insert into public.platform_role_permissions (role_id, module, action) values ($1, 'support', 'view'), ($1, 'support', 'approve')`, [role])
  return createPlatformStaff(db, 'SUPPORT_LEAD')
}

describe('platform approval requests', () => {
  it('are filed only by the flows that check the asker (adding a Super Admin, closing or deleting a merchant, a credit adjustment)', () =>
    inTx(async (db) => {
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const lead = await supportLead(db)
      await asSystem(db, null)
      const superRole = await value<string>(db, `select id from public.platform_roles where code = 'SUPER_ADMIN'`)

      // A read-only employee asks to be made Super Admin, filed under a module someone else may approve.
      await as(db, viewer)
      await expectError(db, `select public.platform_request_approval('support', 'grant_super_admin', null, 'Routine support access', $1, 'Needed for tickets')`,
        [JSON.stringify({ user_id: viewer, role_id: superRole })], /permission denied/)

      // Had it been filed, the support lead could not have approved it either: the action belongs to "employees".
      await asSystem(db, null)
      await expectError(db, `select public.platform_request_approval('support', 'grant_super_admin', null, 'Routine support access', $1, 'Needed for tickets')`,
        [JSON.stringify({ user_id: viewer, role_id: superRole })], /VALIDATION/)
      await as(db, lead)
      expect(await value<number>(db, `select jsonb_array_length(coalesce(public.platform_approvals_list('PENDING'), '[]'::jsonb))`)).toBe(0)

      await asSystem(db, null)
      expect(await value<string>(db, `select r.code from public.platform_staff s join public.platform_roles r on r.id = s.role_id where s.user_id = $1`, [viewer])).toBe('VIEWER')
    }))

  it('keep their module: each action is filed under the module whose approvers decide it', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      for (const [module, action] of [['employees', 'grant_super_admin'], ['merchants', 'merchant_close'], ['merchants', 'merchant_delete'], ['credits', 'credit_adjust']]) {
        await db.query('savepoint s')
        // The right module passes the check (whatever the payload then needs).
        try {
          await db.query(`select public.platform_request_approval($1, $2, null, 'x', '{}'::jsonb, 'A reason')`, [module, action])
        } catch (e) {
          expect(String(e)).not.toMatch(/VALIDATION: .*module/)
        }
        await db.query('rollback to savepoint s')
        await expectError(db, `select public.platform_request_approval('features', $1, null, 'x', '{}'::jsonb, 'A reason')`, [action], /VALIDATION/)
      }
      await expectError(db, `select public.platform_request_approval('merchants', 'drop_everything', null, 'x', '{}'::jsonb, 'A reason')`, [], /VALIDATION/)
    }))
})
