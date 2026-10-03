import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, setSetting, transition } from '../support/fixtures'

afterAll(closePool)

interface Log {
  id: string
  event: string | null
  status: string
  recipient: string
  body: string
  segments: number
  encoding: string
  cost: string | null
  cost_source: string | null
  delivery_status: string | null
  error: string | null
  attempts: number
}

/** SMS connected and switched on, with only the given automations on. */
async function smsOn(db: Db, events: string[], settings: Record<string, unknown> = {}) {
  await setSetting(db, 'sms', { enabled: true, connected: true, provider: 'smsnetbd', cost_per_sms: 0.3, ...settings })
  await db.query(`update public.notifications set is_enabled = (event::text = any($1)) where channel = 'SMS'`, [events])
}

async function smsLogs(db: Db, orderId: string | null = null): Promise<Log[]> {
  await asSystem(db)
  const { rows } = await db.query<Log>(`select * from public.notification_logs
    where channel = 'SMS' and ($1::uuid is null or order_id = $1) order by created_at, id`, [orderId])
  return rows
}

async function order(db: Db, phone: string, opts: { price?: number; paymentMethod?: 'COD' | 'ADVANCE' | 'FULL_PAYMENT' } = {}) {
  const p = await createProduct(db, { price: opts.price ?? 600, cost: 250, stock: 5 })
  return createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }], paymentMethod: opts.paymentMethod })
}

async function shippedOrder(db: Db, phone: string) {
  const o = await order(db, phone)
  await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  const courier = await value<string>(db, `insert into public.couriers(name, provider, default_shipping_cost)
    values ('Courier ' || substr(md5(random()::text), 1, 6), 'manual', 70) returning id`)
  const ship = await value<string>(db, `select id from public.assign_courier($1, $2, 'TRK-' || substr(md5(random()::text), 1, 8), 70)`,
    [o.id, courier])
  await db.query(`select public.apply_shipment_status($1, 'PICKED_UP')`, [ship])
  return { order: o, ship }
}

async function sendAll(db: Db, result: { success: boolean; cost?: number | null; permanent?: boolean; delivery?: string }) {
  await asService(db)
  const { rows } = await db.query<{ id: string }>(`select id from public.claim_notifications(50) where channel = 'SMS'`)
  for (const row of rows) {
    await db.query(`select public.complete_notification($1, $2, 'smsnetbd', $3, $4, $5, $6, $7)`, [
      row.id, result.success, result.success ? `REQ-${row.id.slice(0, 6)}` : null, result.success ? null : 'gateway said no',
      result.cost ?? null, result.permanent ?? false, result.delivery ?? null,
    ])
  }
  return rows.map((r) => r.id)
}

async function smsFinance(db: Db, orderId: string) {
  await asSystem(db)
  return num(await value(db, `select coalesce(sum(ft.amount), 0) from public.finance_transactions ft
    join public.finance_categories c on c.id = ft.category_id where c.code = 'SMS' and ft.order_id = $1`, [orderId]))
}

describe('SMS automation', () => {
  it('queues one message per rule, order and event, with its parts and estimated cost', () =>
    inTx(async (db) => {
      await smsOn(db, ['ORDER_CREATED'])
      const o = await order(db, '01711000901')
      const [log, ...rest] = await smsLogs(db, o.id)
      expect(rest).toHaveLength(0)
      expect(log).toMatchObject({ event: 'ORDER_CREATED', status: 'QUEUED', recipient: '8801711000901', segments: 1, encoding: 'GSM',
        cost_source: 'ESTIMATE' })
      expect(num(log.cost)).toBeCloseTo(0.3)
      // Amounts are written "Tk 1,234" so the message stays in the cheaper GSM encoding.
      expect(log.body).toContain(o.order_number)
      expect(log.body).toMatch(/\(Tk [0-9,]+\)/)

      // The same event again (a retry, a duplicate webhook…) never texts twice.
      expect(await value(db, `select public._enqueue_order_notification($1, 'ORDER_CREATED')`, [o.id])).toBe(0)
      expect(await smsLogs(db, o.id)).toHaveLength(1)
    }))

  it('sends nothing while SMS is switched off or the automation is off', () =>
    inTx(async (db) => {
      await smsOn(db, ['ORDER_CREATED'], { enabled: false })
      expect(await smsLogs(db, (await order(db, '01711000902')).id)).toHaveLength(0)
      await smsOn(db, [])
      expect(await smsLogs(db, (await order(db, '01711000903')).id)).toHaveLength(0)
    }))

  it('uses conditions to pick the right automation, and validates them', () =>
    inTx(async (db) => {
      await smsOn(db, [])
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      const cod = await one<{ id: string }>(db, `select * from public.sms_rule_save(null, 'ORDER_CREATED', 'COD orders',
        'COD {{order_number}}', '[{"field":"payment_method","op":"in","value":["COD"]}]', true)`)
      await db.query(`select public.sms_rule_save(null, 'ORDER_CREATED', 'Big orders', 'Big {{order_number}}',
        '[{"field":"total","op":"gte","value":5000}]', true)`)
      await db.query(`select public.sms_rule_save(null, 'ORDER_CREATED', 'Repeat customers', 'Welcome back',
        '[{"field":"first_order","op":"eq","value":false}]', true)`)
      await expectError(db, `select public.sms_rule_save(null, 'ORDER_CREATED', 'x', 'y', '[{"field":"colour","op":"in","value":["red"]}]', true)`,
        [], /unknown condition colour/)
      await expectError(db, `select public.sms_rule_save(null, 'ORDER_CREATED', 'x', 'y', '[{"field":"total","op":"in","value":[1]}]', true)`,
        [], /at least/)
      await expectError(db, `select public.sms_rule_save(null, 'ORDER_CREATED', 'x', '   ', '[]', true)`, [], /write a message/)

      const o = await order(db, '01711000904')
      expect((await smsLogs(db, o.id)).map((l) => l.body)).toEqual([`COD ${o.order_number}`])

      // A viewer can't change automations.
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.sms_rule_delete($1)`, [cod.id], /permission|sms\.manage/i)
    }))

  it('texts for pre-orders, out for delivery (once a day), returns, payments and failed payments', () =>
    inTx(async (db) => {
      await smsOn(db, ['PRE_ORDER_CONFIRMED', 'OUT_FOR_DELIVERY', 'RETURN_INITIATED', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED'])

      const pre = await order(db, '01711000905')
      await advanceOrder(db, pre.id, ['CONFIRMED', 'PRE_ORDER'])
      expect((await smsLogs(db, pre.id)).map((l) => l.event)).toEqual(['PRE_ORDER_CONFIRMED'])

      const { order: o, ship } = await shippedOrder(db, '01711000906')
      await asSystem(db)
      await db.query(`select public.apply_shipment_status($1, 'OUT_FOR_DELIVERY', null, null, null, 'API', null, 'ofd-1')`, [ship])
      await db.query(`select public.apply_shipment_status($1, 'IN_TRANSIT', null, null, null, 'API', null, 'back-1')`, [ship])
      await db.query(`select public.apply_shipment_status($1, 'OUT_FOR_DELIVERY', null, null, null, 'API', null, 'ofd-2')`, [ship])
      // The parcel comes back: both the parcel and the order change, one message.
      await db.query(`select public.apply_shipment_status($1, 'RETURNING', null, null, null, 'API', null, 'ret-1')`, [ship])
      expect((await smsLogs(db, o.id)).map((l) => l.event).sort()).toEqual(['OUT_FOR_DELIVERY', 'RETURN_INITIATED'])
      expect(await value(db, `select status::text from public.orders where id = $1`, [o.id])).toBe('RETURNING')

      const paid = await order(db, '01711000907')
      await asSystem(db)
      await db.query(`select public.record_order_payment($1, 'BALANCE', 'BKASH', 200, 'TRX1', null, null)`, [paid.id])
      await db.query(`select public.record_order_payment($1, 'BALANCE', 'BKASH', 100, 'TRX2', null, null)`, [paid.id])
      const receipts = await smsLogs(db, paid.id)
      expect(receipts.map((l) => `${l.event} ${l.body.match(/Tk [0-9,]+/)?.[0]}`).sort()).toEqual([
        'PAYMENT_RECEIVED Tk 100', 'PAYMENT_RECEIVED Tk 200'])

      const failing = await order(db, '01711000908')
      await asSystem(db)
      const ref = await value<string>(db, `select reference from public.start_order_payment($1, '01711000908', 'FULL', 'bkash')`,
        [failing.order_number])
      await asService(db)
      await db.query(`select public.confirm_payment($1, 'bkash', null, null, 'ev-1', 'failed', '{"reason":"Cancelled"}', false)`, [ref])
      const failed = await smsLogs(db, failing.id)
      expect(failed.map((l) => l.event)).toEqual(['PAYMENT_FAILED'])
      expect(failed[0].body).toMatch(/payment of Tk [0-9,]+ for order/)
    }))

  it('posts each sent SMS to Finance once, then the charge the provider reports', () =>
    inTx(async (db) => {
      await smsOn(db, ['ORDER_CREATED'])
      const o = await order(db, '01711000909')
      await sendAll(db, { success: true, delivery: 'PENDING' })
      const [sent] = await smsLogs(db, o.id)
      expect(sent).toMatchObject({ status: 'SENT', delivery_status: 'PENDING' })
      expect(await smsFinance(db, o.id)).toBeCloseTo(0.3)

      // Delivery report: delivered, and it cost 0.25.
      await asService(db)
      await db.query(`update public.notification_logs set sent_at = now() - interval '5 minutes' where id = $1`, [sent.id])
      const due = await db.query<{ id: string }>(`select id from public.sms_delivery_checks(10)`)
      expect(due.rows.map((r) => r.id)).toContain(sent.id)
      // Just checked: not due again straight away.
      expect((await db.query(`select id from public.sms_delivery_checks(10)`)).rows).toHaveLength(0)
      await db.query(`select public.record_sms_delivery($1, 'DELIVERED', 0.25)`, [sent.id])
      await db.query(`select public.record_sms_delivery($1, 'DELIVERED', 0.25)`, [sent.id])
      expect(await smsFinance(db, o.id)).toBeCloseTo(0.25)
      expect(num(await value(db, `select count(*) from public.finance_transactions where source_key like 'sms:' || $1 || '%'`, [sent.id]))).toBe(2)
      const after = (await smsLogs(db, o.id))[0]
      expect(after).toMatchObject({ delivery_status: 'DELIVERED', cost_source: 'PROVIDER' })
      expect(await value(db, `select notes from public.finance_transactions where source_key = 'sms:' || $1`, [sent.id]))
        .toBe('SMS · Order placed · 880171••••909')
    }))

  it('fails a bad number at once, retries other failures, and never charges for them', () =>
    inTx(async (db) => {
      await smsOn(db, ['ORDER_CREATED'])
      const a = await order(db, '01711000910')
      await sendAll(db, { success: false, permanent: true })
      expect((await smsLogs(db, a.id))[0]).toMatchObject({ status: 'FAILED', error: 'gateway said no', attempts: 1 })

      const b = await order(db, '01711000911')
      await sendAll(db, { success: false })
      expect((await smsLogs(db, b.id))[0]).toMatchObject({ status: 'QUEUED', attempts: 1 })
      for (let i = 0; i < 2; i++) {
        await asSystem(db)
        await db.query(`update public.notification_logs set next_attempt_at = now() where order_id = $1`, [b.id])
        await sendAll(db, { success: false })
      }
      expect((await smsLogs(db, b.id))[0]).toMatchObject({ status: 'FAILED', attempts: 3 })
      expect(await smsFinance(db, a.id)).toBe(0)
      expect(await smsFinance(db, b.id)).toBe(0)

      // Interrupted mid-send: marked failed, not sent again.
      const c = await order(db, '01711000912')
      await asService(db)
      await db.query(`select public.claim_notifications(50)`)
      await asSystem(db)
      await db.query(`set local session_replication_role = replica`) // keep the backdated updated_at
      await db.query(`update public.notification_logs set updated_at = now() - interval '20 minutes' where order_id = $1`, [c.id])
      await db.query(`set local session_replication_role = origin`)
      await asService(db)
      await db.query(`select public.claim_notifications(50)`)
      expect((await smsLogs(db, c.id))[0]).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/interrupted/) })
    }))

  it('skips a number that is not a Bangladesh mobile, with the reason', () =>
    inTx(async (db) => {
      await smsOn(db, ['ORDER_CONFIRMED'])
      const o = await order(db, '01711000913')
      await asSystem(db)
      await db.query(`update public.orders set customer_phone = '0221234567' where id = $1`, [o.id])
      await transition(db, o.id, 'CONFIRMED')
      expect((await smsLogs(db, o.id))[0]).toMatchObject({ status: 'SKIPPED', error: 'Not a Bangladesh mobile number' })
    }))

  it('never blocks an order change when a message cannot be queued, and says so in the System log', () =>
    inTx(async (db) => {
      await smsOn(db, ['ORDER_CONFIRMED'], { cost_per_sms: 'not a number' })
      const o = await order(db, '01711000914')
      const confirmed = await transition(db, o.id, 'CONFIRMED')
      expect(confirmed.status).toBe('CONFIRMED')
      expect(await smsLogs(db, o.id)).toHaveLength(0)
      expect(await value(db, `select count(*)::int from public.system_logs
        where category = 'SMS' and source = '_enqueue_order_notification' and message like 'Could not queue the Order approved message%'`)).toBe(1)
    }))

  it('counts parts the way phones do', () =>
    inTx(async (db) => {
      await asService(db)
      const parts = async (text: string) => one<{ encoding: string; units: number; segments: number }>(db,
        `select * from public.sms_parts($1)`, [text])
      expect(await parts('a'.repeat(160))).toEqual({ encoding: 'GSM', units: 160, segments: 1 })
      expect(await parts('a'.repeat(161))).toEqual({ encoding: 'GSM', units: 161, segments: 2 })
      expect(await parts(`${'a'.repeat(159)}€`)).toEqual({ encoding: 'GSM', units: 161, segments: 2 })
      expect(await parts('আপনার অর্ডার')).toMatchObject({ encoding: 'UNICODE', segments: 1 })
      expect(await parts('ক'.repeat(71))).toMatchObject({ encoding: 'UNICODE', segments: 2 })
      expect(await parts('Total ৳1,250')).toMatchObject({ encoding: 'UNICODE' })
    }))
})

describe('SMS page access', () => {
  it('logs test messages, with a valid number only', () =>
    inTx(async (db) => {
      await smsOn(db, [])
      const owner = await createStaff(db, 'OWNER')
      await asService(db)
      const log = await one<Log & { purpose: string }>(db, `select * from public.sms_log_test('01811000915', 'Hello from the shop', $1)`, [owner])
      expect(log).toMatchObject({ purpose: 'TEST', status: 'SENDING', recipient: '8801811000915', event: null, segments: 1 })
      await expectError(db, `select public.sms_log_test('12345', 'x', $1)`, [owner], /Bangladesh mobile number/)
    }))

  it('lets SMS viewers see usage, keeps settings changes to sms.manage, and hides messages from the public', () =>
    inTx(async (db) => {
      await smsOn(db, ['ORDER_CREATED'])
      const o = await order(db, '01711000916')
      await sendAll(db, { success: true })
      const orders = await createStaff(db, 'ORDER_MANAGER')
      const today = await value<string>(db, `select (now() at time zone public.store_timezone())::date::text`)
      await asUser(db, orders)
      const overview = await value<{ totals: Record<string, number>; settings: Record<string, unknown> }>(db,
        `select public.sms_overview($1::date, $1::date)`, [today])
      expect(overview.totals.sent).toBeGreaterThanOrEqual(1)
      expect(overview.settings).toMatchObject({ enabled: true, connected: true, provider: 'smsnetbd' })
      expect(JSON.stringify(overview)).not.toMatch(/api_key|secret/)
      expect(await value(db, `select count(*)::int from public.notification_logs where order_id = $1`, [o.id])).toBe(1)
      await expectError(db, `select public.sms_update_settings(p_cost_per_sms => 0.5)`, [], /sms\.manage|permission/i)

      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.sms_overview(current_date, current_date)`, [], /sms\.view|permission/i)

      await asAnon(db)
      expect(await value(db, `select count(*)::int from public.notification_logs`).catch(() => 0)).toBe(0)

      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await setSetting(db, 'sms', { connected: false })
      await asUser(db, admin)
      await expectError(db, `select public.sms_update_settings(p_enabled => true)`, [], /connect an SMS provider first/)
      const saved = await value<Record<string, unknown>>(db,
        `select public.sms_update_settings(p_sender_id => 'MyShop', p_cost_per_sms => 0.25, p_currency_text => 'BDT')`)
      expect(saved).toMatchObject({ sender_id: 'MyShop', cost_per_sms: 0.25, currency_text: 'BDT' })
      await expectError(db, `select public.sms_update_settings(p_sender_id => 'Shop<script>')`, [], /sender ID/)
    }))
})
