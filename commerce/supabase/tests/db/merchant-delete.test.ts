import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)
const count = (db: Db, table: string, merchant: string) =>
  value<number>(db, `select count(*)::int from public.${table} where merchant_id = $1`, [merchant])

describe('delete a merchant', () => {
  async function doomedShop(db: Db, superId: string) {
    await as(db, superId)
    const id = (await value<{ id: string }>(db, `select public.platform_merchant_create('{"name": "Doomed Shop", "phone": "01711000999"}')`)).id
    const owner = await createStaff(db, 'OWNER', `owner-${randomUUID().slice(0, 6)}@doomed.example`, id)
    await createProduct(db, { price: 400, stock: 3, merchantId: id })
    await as(db, superId)
    await value(db, `select public.platform_credit_adjust($1, 'BALANCE', 700, 'ADJUSTMENT', 'Paid in cash at the office', null, $2)`, [id, randomUUID()])
    return { id, owner }
  }

  it('needs the right person, the exact name, a reason and a fresh export; the asker cannot approve', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const shop = await doomedShop(db, superA)
      await as(db, viewer)
      await expectError(db, `select public.platform_merchant_delete_request($1, 'Doomed Shop', 'Closing the test account')`, [shop.id], /PERMISSION_DENIED/)
      await as(db, superA)
      await expectError(db, `select public.platform_merchant_delete_request($1, 'Other Shop', 'Closing the test account')`, [shop.id], /name exactly/)
      await expectError(db, `select public.platform_merchant_delete_request($1, 'Doomed Shop', 'Closing')`, [shop.id], /at least 10/)
      await expectError(db, `select public.platform_merchant_delete_request($1, 'Doomed Shop', 'Closing the test account')`, [shop.id], /export/)
      await db.query(`select public.platform_merchant_export($1, 'Copy before deleting the merchant')`, [shop.id])
      const req = await value<{ approval_id: string }>(db, `select public.platform_merchant_delete_request($1, ' doomed shop ', 'Closing the test account')`, [shop.id])
      await expectError(db, `select public.platform_approval_decide($1, true, 'Looks right')`, [req.approval_id], /second person/)
      // Nothing happened yet.
      await asSystem(db, shop.id)
      expect(await count(db, 'products', shop.id)).toBe(1)
    }))

  it('removes the business and its data, keeps money records and audit trails, and queues its logins for removal', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      const superB = await createPlatformStaff(db, 'SUPER_ADMIN')
      const shop = await doomedShop(db, superA)
      await asSystem(db, shop.id)
      const ledgerBefore = await count(db, 'credit_ledger', shop.id)
      expect(ledgerBefore).toBeGreaterThan(0)
      expect(await count(db, 'roles', shop.id)).toBeGreaterThan(0)
      await asSystem(db)
      const otherProducts = await count(db, 'products', MERCHANT_1)

      await as(db, superA)
      await db.query(`select public.platform_merchant_export($1, 'Copy before deleting the merchant')`, [shop.id])
      const req = await value<{ approval_id: string }>(db, `select public.platform_merchant_delete_request($1, 'Doomed Shop', 'Closing the test account')`, [shop.id])
      await as(db, superB)
      const done = await value<Record<string, any>>(db, `select public.platform_approval_decide($1, true, 'Confirmed with the owner by phone')`, [req.approval_id])
      expect(done.error ?? null).toBeNull()
      expect(done.status).toBe('EXECUTED')
      expect(done.result.logins_removed).toBe(1)
      expect(done.result.kept).toEqual({})

      await asSystem(db, null)
      const m = await value<Record<string, any>>(db, `select to_jsonb(m) from public.merchants m where id = $1`, [shop.id])
      expect(m).toMatchObject({ status: 'CLOSED', phone: null, owner_email: null })
      expect(m.name).toMatch(/^Deleted merchant #\d+$/)
      expect(m.deleted_at).not.toBeNull()
      await asSystem(db, shop.id)
      for (const t of ['products', 'product_variants', 'inventory', 'profiles', 'roles', 'settings', 'couriers', 'customers', 'orders']) {
        expect(await count(db, t, shop.id), t).toBe(0)
      }
      // Money records stay.
      expect(await count(db, 'credit_ledger', shop.id)).toBe(ledgerBefore)
      expect(await value<number>(db, `select public.credit_available($1, 'BALANCE')`, [shop.id])).toBe(700)
      await asSystem(db, null)
      expect(await value<string[]>(db, `select array_agg(user_id::text) from public.account_removals where from_merchant = $1 and status = 'PENDING'`, [shop.id]))
        .toEqual([shop.owner])
      expect(await value<number>(db, `select count(*)::int from public.platform_audit_logs where action = 'merchants.deleted' and merchant_id = $1`, [shop.id])).toBe(1)
      // Other businesses are untouched.
      await asSystem(db)
      expect(await count(db, 'products', MERCHANT_1)).toBe(otherProducts)
      expect(await count(db, 'roles', MERCHANT_1)).toBeGreaterThan(0)

      // Deleted once only.
      await as(db, superA)
      await expectError(db, `select public.platform_merchant_delete_request($1, $2, 'Closing the test account')`, [shop.id, m.name], /already deleted/)
    }))

  it('lets the asker approve their own request only while nobody else could approve it', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asSystem(db, null)
      await db.query(`update public.platform_staff set is_active = false where user_id <> $1`, [superA])
      const shop = await doomedShop(db, superA)
      await db.query(`select public.platform_merchant_export($1, 'Copy before deleting the merchant')`, [shop.id])
      const req = await value<{ approval_id: string; can_self_approve: boolean }>(db,
        `select public.platform_merchant_delete_request($1, 'Doomed Shop', 'Closing the test account')`, [shop.id])
      expect(req.can_self_approve).toBe(true)
      // Someone who may only look does not count as a second approver.
      await createPlatformStaff(db, 'VIEWER')
      await as(db, superA)
      const listed = await value<Array<Record<string, any>>>(db, `select public.platform_approvals_list('PENDING')`)
      expect(listed.find((a) => a.id === req.approval_id)).toMatchObject({ mine: true, can_decide: true })

      // A second active Super Admin brings the two-person rule back.
      const superB = await createPlatformStaff(db, 'SUPER_ADMIN')
      await as(db, superA)
      expect((await value<Array<Record<string, any>>>(db, `select public.platform_approvals_list('PENDING')`))
        .find((a) => a.id === req.approval_id)?.can_decide).toBe(false)
      await expectError(db, `select public.platform_approval_decide($1, true, null)`, [req.approval_id], /second person/)
      await asSystem(db, null)
      await db.query(`update public.platform_staff set is_active = false where user_id = $1`, [superB])

      await as(db, superA)
      const done = await value<Record<string, any>>(db, `select public.platform_approval_decide($1, true, 'Owner asked by phone')`, [req.approval_id])
      expect(done.error ?? null).toBeNull()
      expect(done.status).toBe('EXECUTED')
      await asSystem(db, null)
      const row = await value<Record<string, any>>(db, `select to_jsonb(a) from public.platform_approvals a where id = $1`, [req.approval_id])
      expect(row).toMatchObject({ status: 'EXECUTED', decided_by: superA, self_approved: true })
      expect(row.decision_note).toMatch(/self-approved/)
      expect(await value<boolean>(db,
        `select (after->>'self_approved')::boolean from public.platform_audit_logs where action = 'approval.executed' and entity_id = $1::text`, [req.approval_id])).toBe(true)
      expect(await value<boolean>(db, `select has_function_privilege('authenticated', 'public._platform_sole_approver(text, uuid)', 'execute')`)).toBe(false)
    }))

  it('finds a login by its Clerk account only for the server', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      const id = randomUUID()
      await db.query(`insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{"clerk_user_id": "user_abc123"}')`, [id, `c-${id.slice(0, 6)}@example.com`])
      expect(await value(db, `select public.find_auth_user_by_clerk('user_abc123')`)).toBe(id)
      expect(await value(db, `select has_function_privilege('authenticated', 'public.find_auth_user_by_clerk(text)', 'execute')`)).toBe(false)
      expect(await value(db, `select has_table_privilege('authenticated', 'public.account_removals', 'select')`)).toBe(false)
    }))
})
