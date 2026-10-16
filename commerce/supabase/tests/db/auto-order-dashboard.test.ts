import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff, setSetting } from '../support/fixtures'

afterAll(closePool)

async function webOrder(db: Db, phone: string, set: Record<string, unknown> = {}) {
  const p = await createProduct(db, { price: 700, stock: 20 })
  const o = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  if (Object.keys(set).length) {
    await asSystem(db)
    const cols = Object.keys(set)
    await db.query(`set local session_replication_role = replica`)
    await db.query(`update public.orders set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [o.id, ...cols.map((c) => set[c])])
    await db.query(`set local session_replication_role = origin`)
  }
  return o.id as string
}
type Next = { kind: string; id: string; queue: string } | null
const openNext = (db: Db, queue: string, skip: string[] = []) => value<Next>(db, `select public.auto_order_open_next($1, $2::uuid[])`, [queue, skip])
const dashboard = (db: Db) => value<{ queues: Record<string, number>; report: Record<string, number>; claim: { id: string } | null }>(db, `select public.auto_order_dashboard()`)

describe('Auto Order Dashboard', () => {
  it('puts each order in its queue and opens the oldest one first', () =>
    inTx(async (db) => {
      const agent = await createStaff(db, 'CALL')
      const older = await webOrder(db, '01755000001', { created_at: new Date(Date.now() - 3_600_000).toISOString() })
      const newer = await webOrder(db, '01755000002')
      const noAnswer = await webOrder(db, '01755000003', { review_status: 'NO_RESPONSE', contact_attempts: 1, last_contact_at: new Date(Date.now() - 3_600_000).toISOString() })
      const justCalled = await webOrder(db, '01755000004', { review_status: 'NO_RESPONSE', contact_attempts: 1, last_contact_at: new Date().toISOString() })
      const later = await webOrder(db, '01755000005', { review_status: 'FOLLOW_UP', follow_up_at: new Date(Date.now() + 3_600_000).toISOString() })
      const due = await webOrder(db, '01755000006', { review_status: 'FOLLOW_UP', follow_up_at: new Date(Date.now() - 60_000).toISOString() })
      const advance = await webOrder(db, '01755000007', { status: 'ADVANCE_REQUIRED' })

      await asUser(db, agent)
      const d = await dashboard(db)
      expect(d.queues).toMatchObject({ processing: 2, no_response: 1, on_hold: 1, advance_payment: 1, good_no_response: 0 })
      expect((await openNext(db, 'processing'))?.id).toBe(older)
      expect((await openNext(db, 'no_response'))?.id).toBe(noAnswer)
      expect((await openNext(db, 'on_hold'))?.id).toBe(due)
      expect((await openNext(db, 'advance_payment'))?.id).toBe(advance)
      expect([justCalled, later, newer]).not.toContain((await openNext(db, 'no_response'))?.id)
    }))

  it('never gives two agents the same customer, and frees the customer once the status changes', () =>
    inTx(async (db) => {
      const a = await createStaff(db, 'CALL')
      const b = await createStaff(db, 'CALL')
      const first = await webOrder(db, '01755100001', { created_at: new Date(Date.now() - 600_000).toISOString() })
      const second = await webOrder(db, '01755100002')

      await asUser(db, a)
      expect((await openNext(db, 'processing'))?.id).toBe(first)
      await asUser(db, b)
      expect((await dashboard(db)).queues.processing).toBe(1)
      expect((await openNext(db, 'processing'))?.id).toBe(second)
      // Skipping their own, nothing is left for b: a holds the other one.
      expect(await openNext(db, 'processing', [second])).toBeNull()

      // Taken: the order is now the agent's own.
      await asSystem(db)
      expect(await value(db, `select assigned_to from public.orders where id = $1`, [first])).toBe(a)

      // A recorded outcome ends the claim.
      await asUser(db, a)
      await db.query(`select public.set_web_order_status(array[$1]::uuid[], 'NO_RESPONSE', null, null)`, [first])
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.call_claims where ref_id = $1`, [first])).toBe(0)
    }))

  it('leaves orders Auto Pick gave to another agent with that agent', () =>
    inTx(async (db) => {
      const a = await createStaff(db, 'CALL')
      const b = await createStaff(db, 'CALL')
      await setSetting(db, 'auto_pick', { enabled: true, mode: 'round_robin', agent_ids: [a], max_open: 0 })
      const mine = await webOrder(db, '01755200001')
      await asUser(db, b)
      expect((await dashboard(db)).queues.processing).toBe(0)
      expect(await openNext(db, 'processing')).toBeNull()
      await asUser(db, a)
      expect((await openNext(db, 'processing'))?.id).toBe(mine)
    }))

  it('opens incomplete checkouts once the visitor has left, and reports the agent\'s day', () =>
    inTx(async (db) => {
      const a = await createStaff(db, 'CALL')
      await asSystem(db)
      const lead = await value<string>(db, `insert into public.checkout_leads (visitor_id, phone, total, updated_at) values ('visitor-abc-123', '01755300001', 900, now() - interval '20 minutes') returning id`)
      await db.query(`insert into public.checkout_leads (visitor_id, phone, total) values ('visitor-abc-456', '01755300002', 900)`)
      await asUser(db, a)
      expect((await dashboard(db)).queues.incomplete).toBe(1)
      expect(await openNext(db, 'incomplete')).toMatchObject({ kind: 'LEAD', id: lead })
      expect((await dashboard(db)).claim?.id).toBe(lead)

      await webOrder(db, '01755300003')
      await asUser(db, a)
      await openNext(db, 'processing')
      expect((await dashboard(db)).report.taken).toBe(1)
    }))

  it('refuses agents without order access and unknown queues', () =>
    inTx(async (db) => {
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.auto_order_open_next('processing', '{}')`, [], /PERMISSION_DENIED/)
      const agent = await createStaff(db, 'CALL')
      await asUser(db, agent)
      await expectError(db, `select public.auto_order_open_next('everything', '{}')`, [], /VALIDATION/)
    }))
})

describe('Auto Pick round robin', () => {
  it('keeps taking turns inside one batch instead of piling onto one agent', () =>
    inTx(async (db) => {
      const a = await createStaff(db, 'ORDER_MANAGER')
      const b = await createStaff(db, 'ORDER_MANAGER')
      await setSetting(db, 'auto_pick', { enabled: true, mode: 'round_robin', agent_ids: [a, b], max_open: 0 })
      const ids: string[] = []
      for (let i = 0; i < 6; i++) ids.push(await webOrder(db, `0175540000${i}`))
      await asSystem(db)
      const owners = await value<string[]>(db, `select array_agg(assigned_to order by assigned_at) from public.orders where id = any($1::uuid[])`, [ids])
      expect(owners.filter((x) => x === a)).toHaveLength(3)
      expect(owners.filter((x) => x === b)).toHaveLength(3)
    }))
})
