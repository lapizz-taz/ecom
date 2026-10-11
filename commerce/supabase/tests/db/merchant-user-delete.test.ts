import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

describe('Super Admin deletes one person of a merchant', () => {
  it('blocks their login for good, keeps their profile for history, and checks who may do it', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const packer = await createStaff(db, 'ORDER_MANAGER')

      await as(db, viewer)
      await expectError(db, `select public.platform_merchant_user_delete($1, $2, 'Left the company')`, [MERCHANT_1, packer], /PERMISSION_DENIED/)
      await as(db, superA)
      await expectError(db, `select public.platform_merchant_user_delete($1, $2, 'no')`, [MERCHANT_1, packer], /at least 5/)
      await expectError(db, `select public.platform_merchant_user_delete($1, $2, 'Left the company')`, [MERCHANT_1, superA], /not in this merchant|platform team|own login/)

      const r = await value<Record<string, unknown>>(db, `select public.platform_merchant_user_delete($1, $2, 'Left the company')`, [MERCHANT_1, packer])
      expect(r).toMatchObject({ deleted: true, user_id: packer })
      await expectError(db, `select public.platform_merchant_user_delete($1, $2, 'Left the company')`, [MERCHANT_1, packer], /already deleted/)

      await asSystem(db, MERCHANT_1)
      const p = await value<Record<string, any>>(db, `select to_jsonb(p) from public.profiles p where id = $1`, [packer])
      expect(p.is_active).toBe(false)
      expect(p.deleted_at).not.toBeNull()
      // Cannot be switched on again.
      await expectError(db, `select public.admin_set_user_role($1, 'ORDER_MANAGER', true)`, [packer], /was deleted/)
      await expectError(db, `update public.profiles set deleted_at = null, is_active = true where id = $1`, [packer], /was deleted/)

      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.account_removals where user_id = $1 and status = 'PENDING'`, [packer])).toBe(1)
      expect(await value<number>(db, `select count(*)::int from public.platform_audit_logs where action = 'merchants.user_deleted' and entity_id = $1::text`, [packer])).toBe(1)

      await as(db, superA)
      const staff = (await value<Record<string, any>>(db, `select public.platform_merchant_get($1)`, [MERCHANT_1])).staff as Array<Record<string, any>>
      expect(staff.find((s) => s.id === packer)?.deleted_at).not.toBeNull()
    }))

  it('will not delete the only owner', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      await as(db, superA)
      const shop = (await value<{ id: string }>(db, `select public.platform_merchant_create('{"name": "One Owner Shop", "phone": "01711000888"}')`)).id
      const owner = await createStaff(db, 'OWNER', 'only-owner@one.example', shop)
      await as(db, superA)
      await expectError(db, `select public.platform_merchant_user_delete($1, $2, 'Closing this login')`, [shop, owner], /only owner/)
      const second = await createStaff(db, 'OWNER', 'second-owner@one.example', shop)
      await as(db, superA)
      await value(db, `select public.platform_merchant_user_delete($1, $2, 'Closing this login')`, [shop, owner])
      await expectError(db, `select public.platform_merchant_user_delete($1, $2, 'Closing this login')`, [shop, second], /only owner/)
    }))
})
