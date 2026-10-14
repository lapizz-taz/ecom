import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createPlatformStaff, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const platformStaff = createPlatformStaff

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

async function newMerchant(db: Db, superId: string, name = `Shop ${randomUUID().slice(0, 6)}`): Promise<string> {
  await as(db, superId)
  const created = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name, owner_email: 'owner@shop.example', phone: '01700000000' })])
  return created.id
}

describe('platform: who can do what', () => {
  it('ships seven built-in roles; Super Admin has everything, the viewer only looks', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      const roles = (await db.query(`select code from public.platform_roles where is_system order by code`)).rows.map((r) => r.code)
      expect(roles).toEqual(['BILLING_MANAGER', 'OPERATIONS_MANAGER', 'PBX_ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT', 'TECHNICAL_SUPPORT', 'VIEWER'])
      const viewerActions = (await db.query(`select distinct action from public.platform_role_permissions rp join public.platform_roles r on r.id = rp.role_id where r.code = 'VIEWER'`)).rows
      expect(viewerActions).toEqual([{ action: 'view' }])

      const superId = await platformStaff(db, 'SUPER_ADMIN')
      const viewer = await platformStaff(db, 'VIEWER')
      await as(db, superId)
      const me = await value<{ role: { code: string; is_super: boolean }; permissions: string[] }>(db, `select public.platform_me()`)
      expect(me.role).toMatchObject({ code: 'SUPER_ADMIN', is_super: true })
      expect(me.permissions).toContain('employees.approve')
      await as(db, viewer)
      const vme = await value<{ permissions: string[] }>(db, `select public.platform_me()`)
      expect(vme.permissions.every((p) => p.endsWith('.view'))).toBe(true)
      expect(await value(db, `select public.platform_can('merchants', 'create')`)).toBe(false)
      await expectError(db, `select public.platform_merchant_create('{"name":"Nope"}')`, [], /PERMISSION_DENIED/)
    }))

  it('gives merchant staff and strangers nothing', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      expect(await value(db, `select public.platform_me()`)).toBeNull()
      await expectError(db, `select public.platform_merchants_list()`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_overview(current_date, current_date)`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_search('shop')`, [], /PERMISSION_DENIED/)
      await expectError(db, `select * from public.platform_roles`, [], /permission denied/)
      await expectError(db, `select * from public.platform_approvals`, [], /permission denied/)
    }))

  it('limits staff with assigned merchants to those merchants', () =>
    inTx(async (db) => {
      const superId = await platformStaff(db, 'SUPER_ADMIN')
      const a = await newMerchant(db, superId, 'Assigned Shop')
      const b = await newMerchant(db, superId, 'Other Shop')
      const agent = await platformStaff(db, 'SUPPORT_AGENT', { scope: 'ASSIGNED', merchants: [a] })
      await as(db, agent)
      const list = await value<{ items: Array<{ id: string }> }>(db, `select public.platform_merchants_list('{}'::jsonb, 'created_at', 'desc', 100, 0)`)
      expect(list.items.map((i) => i.id)).toEqual([a])
      expect(await value(db, `select (public.platform_merchant_get($1)) -> 'merchant' ->> 'name'`, [a])).toBe('Assigned Shop')
      await expectError(db, `select public.platform_merchant_get($1)`, [b], /PERMISSION_DENIED/)
      const found = await value<{ merchants: Array<{ id: string }> }>(db, `select public.platform_search('Shop')`)
      expect(found.merchants.map((m) => m.id)).toEqual([a])
    }))

  it('lets only Super Admins change roles and hand them out, and records refusals', () =>
    inTx(async (db) => {
      const superId = await platformStaff(db, 'SUPER_ADMIN')
      const ops = await platformStaff(db, 'OPERATIONS_MANAGER')
      await as(db, ops)
      await expectError(db, `select public.platform_role_save('{"name":"Sneaky","permissions":["employees.manage"]}')`, [], /only a Super Admin/)
      await as(db, superId)
      const role = await value<{ id: string; code: string }>(db, `select public.platform_role_save('{"name":"Night shift","permissions":["support.view","support.edit"]}')`)
      expect(role.code).toBe('NIGHT_SHIFT')
      await expectError(db, `select public.platform_role_save('{"name":"Bad","permissions":["support.fly"]}')`, [], /unknown permission/)
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_role_permissions where role_id = $1`, [role.id])).toBe(2)
      // A refusal rolls back with the request; the panel reports it afterwards (once a minute at most).
      await as(db, ops)
      await db.query(`select public.platform_report_denied('employees.role_save', '{"name":"Sneaky"}')`)
      await db.query(`select public.platform_report_denied('employees.role_save', '{"name":"Sneaky"}')`)
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where action = 'employees.role_save' and result = 'DENIED' and actor_id = $1`, [ops])).toBe(1)
    }))
})

describe('platform: merchants', () => {
  it('creates a merchant with its own defaults, logged', () =>
    inTx(async (db) => {
      const superId = await platformStaff(db, 'SUPER_ADMIN')
      const id = await newMerchant(db, superId, 'Fresh Shop')
      await asSystem(db, null)
      expect(await value(db, `select status from public.merchants where id = $1`, [id])).toBe('ONBOARDING')
      expect(await value(db, `select count(*)::int from public.roles where merchant_id = $1`, [id])).toBe(9)
      expect(await value(db, `select value ->> 'name' from public.settings where merchant_id = $1 and key = 'store'`, [id])).toBe('Fresh Shop')
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where action = 'merchant.created' and merchant_id = $1`, [id])).toBe(1)
      expect(await value(db, `select current_setting('app.merchant_id', true)`)).toBe('')
      await as(db, superId)
      const detail = await value<{ onboarding: { done: number; total: number } }>(db, `select public.platform_merchant_get($1)`, [id])
      expect(detail.onboarding).toMatchObject({ done: 1, total: 5 })
    }))

  it('names the first owner, who then works only in that business', () =>
    inTx(async (db) => {
      const ops = await platformStaff(db, 'OPERATIONS_MANAGER')
      const id = await newMerchant(db, ops, 'Owner Shop')
      await asSystem(db, null)
      const owner = randomUUID()
      await db.query(`insert into auth.users (id, email) values ($1, 'boss@owner-shop.example')`, [owner])
      await as(db, ops)
      await db.query(`select public.platform_merchant_set_owner($1, $2, 'Shop Boss')`, [id, owner])
      await asUser(db, owner)
      expect(await value(db, `select public.current_merchant_id()`)).toBe(id)
      expect(await value(db, `select public.current_role_code()`)).toBe('OWNER')
      expect(await value(db, `select count(*)::int from public.orders`)).toBe(0)
      // A merchant-1 staff login cannot be made the owner of another business.
      const m1staff = await createStaff(db, 'VIEWER')
      await as(db, ops)
      await expectError(db, `select public.platform_merchant_set_owner($1, $2)`, [id, m1staff], /PERMISSION_DENIED|another business/)
    }))

  it('shows real activity per merchant', () =>
    inTx(async (db) => {
      const superId = await platformStaff(db, 'SUPER_ADMIN')
      const p = await createProduct(db, { price: 600 })
      await createOrder(db, { phone: '01711000951', items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await as(db, superId)
      const detail = await value<{ activity: { orders_30d: number; order_value_30d: string } }>(db, `select public.platform_merchant_get($1)`, [MERCHANT_1])
      expect(Number(detail.activity.orders_30d)).toBeGreaterThanOrEqual(1)
      const list = await value<{ items: Array<{ id: string; orders_total: number }> }>(db, `select public.platform_merchants_list('{"q":"1"}')`)
      expect(list.items.some((i) => i.id === MERCHANT_1)).toBe(true)
      await asSystem(db, null)
      const number = await value<string>(db, `select order_number from public.orders where merchant_id = $1 order by created_at desc limit 1`, [MERCHANT_1])
      await as(db, superId)
      const search = await value<{ orders: Array<{ merchant_id: string }> }>(db, `select public.platform_search($1)`, [number])
      expect(search.orders[0]?.merchant_id).toBe(MERCHANT_1)
      const overview = await value<{ orders: { count: number }; merchants: { total: number } }>(db, `select public.platform_overview(current_date - 1, current_date)`)
      expect(Number(overview.orders.count)).toBeGreaterThanOrEqual(1)
    }))

  it('suspends only after the preview, and closing needs a second person', () =>
    inTx(async (db) => {
      const superA = await platformStaff(db, 'SUPER_ADMIN')
      const superB = await platformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superA)
      await as(db, superA)
      await expectError(db, `select public.platform_merchant_set_status($1, 'SUSPENDED', 'Unpaid for two months', 'guess')`, [[m]], /review the list/)
      const preview = await value<{ token: string; items: Array<{ id: string; changes: boolean }> }>(db, `select public.platform_merchant_status_preview($1, 'SUSPENDED')`, [[m]])
      expect(preview.items).toMatchObject([{ id: m, changes: true }])
      await expectError(db, `select public.platform_merchant_set_status($1, 'SUSPENDED', 'no', $2)`, [[m], preview.token], /give a reason/)
      expect(await value(db, `select public.platform_merchant_set_status($1, 'SUSPENDED', 'Unpaid for two months', $2)`, [[m], preview.token])).toMatchObject({ changed: 1 })

      const close = await value<{ token: string; needs_approval: boolean }>(db, `select public.platform_merchant_status_preview($1, 'CLOSED')`, [[m]])
      expect(close.needs_approval).toBe(true)
      const req = await value<{ changed: number; approval_requests: string[] }>(db, `select public.platform_merchant_set_status($1, 'CLOSED', 'Owner asked to close the account', $2)`, [[m], close.token])
      expect(req.changed).toBe(0)
      const approval = req.approval_requests[0]
      await expectError(db, `select public.platform_approval_decide($1, true)`, [approval], /second person/)
      await asSystem(db, null)
      expect(await value(db, `select status from public.merchants where id = $1`, [m])).toBe('SUSPENDED')

      await as(db, superB)
      const pending = await value<Array<{ id: string; can_decide: boolean }>>(db, `select public.platform_approvals_list('PENDING')`)
      expect(pending.find((a) => a.id === approval)?.can_decide).toBe(true)
      expect(await value(db, `select public.platform_approval_decide($1, true, 'Confirmed with the owner')`, [approval])).toMatchObject({ status: 'EXECUTED' })
      await expectError(db, `select public.platform_approval_decide($1, true)`, [approval], /already executed/)
      await asSystem(db, null)
      expect(await value(db, `select status from public.merchants where id = $1`, [m])).toBe('CLOSED')
      const actions = (await db.query(`select action, result from public.platform_audit_logs where merchant_id = $1 order by id`, [m])).rows
      expect(actions.map((a) => a.action)).toEqual(['merchant.created', 'merchant.status_changed', 'approval.requested', 'approval.executed'])
      await expectError(db, `delete from public.platform_audit_logs where merchant_id = $1`, [m], /IMMUTABLE_RECORD/)
    }))
})

describe('platform: employees', () => {
  it('needs a second Super Admin to make someone a Super Admin, and never leaves none', () =>
    inTx(async (db) => {
      const superA = await platformStaff(db, 'SUPER_ADMIN')
      const superB = await platformStaff(db, 'SUPER_ADMIN')
      await asSystem(db, null)
      const newbie = randomUUID()
      await db.query(`insert into auth.users (id, email) values ($1, 'new.boss@platform.example')`, [newbie])
      const superRole = await value<string>(db, `select id from public.platform_roles where code = 'SUPER_ADMIN'`)
      await as(db, superA)
      const pending = await value<{ pending_approval?: string }>(db, `select public.platform_staff_save($1)`,
        [JSON.stringify({ user_id: newbie, role_id: superRole, full_name: 'New Boss', reason: 'Second founder joins' })])
      expect(pending.pending_approval).toBeTruthy()
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_staff where user_id = $1`, [newbie])).toBe(0)
      await as(db, superB)
      expect(await value(db, `select public.platform_approval_decide($1, true)`, [pending.pending_approval])).toMatchObject({ status: 'EXECUTED' })
      await asSystem(db, null)
      expect(await value(db, `select r.code from public.platform_staff s join public.platform_roles r on r.id = s.role_id where s.user_id = $1`, [newbie])).toBe('SUPER_ADMIN')

      await as(db, superA)
      await expectError(db, `select public.platform_staff_set_active($1, false, 'leaving')`, [superA], /deactivate yourself/)
      await db.query(`select public.platform_staff_set_active($1, false, 'Left the company')`, [superB])
      await db.query(`select public.platform_staff_set_active($1, false, 'Left the company')`, [newbie])
      await as(db, superB)
      expect(await value(db, `select public.platform_me()`)).toBeNull()
    }))

  it('lets an operations manager add people with a role only a Super Admin assigns', () =>
    inTx(async (db) => {
      const ops = await platformStaff(db, 'OPERATIONS_MANAGER')
      await asSystem(db, null)
      const person = randomUUID()
      await db.query(`insert into auth.users (id, email) values ($1, 'agent.two@platform.example')`, [person])
      const agentRole = await value<string>(db, `select id from public.platform_roles where code = 'SUPPORT_AGENT'`)
      await as(db, ops)
      await expectError(db, `select public.platform_staff_save($1)`, [JSON.stringify({ user_id: person, role_id: agentRole })], /PERMISSION_DENIED/)
    }))
})
