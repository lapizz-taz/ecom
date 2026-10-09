import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

async function pathaoCourier(db: Db, config: Record<string, unknown> = {}) {
  await asSystem(db)
  return value<string>(db, `insert into public.couriers(name, provider, api_enabled, default_shipping_cost, config)
    values ('Pathao ' || substr(md5(random()::text), 1, 6), 'pathao', true, 70, $1) returning id`, [JSON.stringify(config)])
}

/** An order booked with the courier and waiting for pickup. */
async function bookedOrder(db: Db, courierId: string, phone: string, consignment: string, opts: { returnCharge?: number } = {}) {
  const p = await createProduct(db, { price: 600, cost: 250, stock: 5 })
  const order = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  await advanceOrder(db, order.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  const ship = await value<string>(db,
    `select id from public.assign_courier($1, $2, $3, 70, null, $3)`, [order.id, courierId, consignment])
  if (opts.returnCharge) await db.query(`update public.shipments set return_charge = $2 where id = $1`, [ship, opts.returnCharge])
  return { order, ship }
}

async function webhook(db: Db, courierId: string | null, event: Record<string, unknown>) {
  await asService(db)
  return value<{ status: string; event_id: string; error?: string }>(db,
    `select public.record_courier_webhook($1, 'pathao', $2)`, [courierId, JSON.stringify(event)])
}

async function charges(db: Db, shipId: string) {
  await asSystem(db)
  const { rows } = await db.query<{ kind: string; total: string }>(
    `select kind::text, sum(amount) as total from public.shipment_charges where shipment_id = $1 group by kind`, [shipId])
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.total)]))
}

async function financeByCategory(db: Db, orderId: string) {
  await asSystem(db)
  const { rows } = await db.query<{ code: string; total: string }>(`
    select c.code, sum(ft.amount) as total from public.finance_transactions ft
    join public.finance_categories c on c.id = ft.category_id where ft.order_id = $1 group by c.code`, [orderId])
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.total)]))
}

const event = (key: string, consignment: string, status: string | null, extra: Record<string, unknown> = {}) => ({
  event_key: `pathao:${consignment}:${key}`, event_type: key, consignment_id: consignment, status, provider_status: key, ...extra,
})

describe('courier webhooks', () => {
  it('moves the order with the parcel and replaces the estimated fee with the one Pathao reports, once', () =>
    inTx(async (db) => {
      const courier = await pathaoCourier(db)
      const { order, ship } = await bookedOrder(db, courier, '01711000801', 'DL801')
      expect((await webhook(db, courier, event('order.picked', 'DL801', 'PICKED_UP'))).status).toBe('processed')
      expect(await value(db, `select status::text from public.orders where id = $1`, [order.id])).toBe('SHIPPED')

      const delivered = event('order.delivered', 'DL801', 'DELIVERED', { charges: { delivery_fee: 80, cod_fee: 7 } })
      expect((await webhook(db, courier, delivered)).status).toBe('processed')
      expect(await value(db, `select status::text from public.orders where id = $1`, [order.id])).toBe('DELIVERED')
      expect(await charges(db, ship)).toEqual({ DELIVERY: 80, COD_FEE: 7 })

      // Pathao sends the same callback again: logged as a duplicate, nothing charged twice.
      expect((await webhook(db, courier, delivered)).status).toBe('duplicate')
      expect(await charges(db, ship)).toEqual({ DELIVERY: 80, COD_FEE: 7 })
      expect(await financeByCategory(db, order.id)).toMatchObject({ COURIER: 80, COD_FEES: 7 })
      const log = await one<Record<string, unknown>>(db,
        `select result, previous_status::text as previous, new_status::text as next, duplicates, shipment_id
         from public.courier_webhook_events where event_key = $1`, [delivered.event_key])
      // Shipping the order already moved the parcel on to In transit.
      expect(log).toEqual({ result: 'PROCESSED', previous: 'IN_TRANSIT', next: 'DELIVERED', duplicates: 1, shipment_id: ship })
    }))

  it('ignores an update that arrives after a later one', () =>
    inTx(async (db) => {
      const courier = await pathaoCourier(db)
      const { ship } = await bookedOrder(db, courier, '01711000802', 'DL802')
      await webhook(db, courier, event('order.delivered', 'DL802', 'DELIVERED'))
      const late = await webhook(db, courier, event('order.in-transit', 'DL802', 'IN_TRANSIT'))
      expect(late.status).toBe('ignored')
      await asSystem(db)
      expect(await value(db, `select status::text from public.shipments where id = $1`, [ship])).toBe('DELIVERED')
      expect(await value(db, `select note from public.courier_webhook_events where id = $1`, [late.event_id])).toMatch(/already delivered/)
    }))

  it('keeps an event for an unknown parcel and applies it once the parcel exists', () =>
    inTx(async (db) => {
      const courier = await pathaoCourier(db)
      const early = await webhook(db, courier, event('order.picked', 'DL803', 'PICKED_UP'))
      expect(early.status).toBe('unmatched')
      await asSystem(db)
      expect(await value(db, `select next_retry_at is not null from public.courier_webhook_events where id = $1`, [early.event_id])).toBe(true)
      const { order } = await bookedOrder(db, courier, '01711000803', 'DL803')
      await db.query(`update public.courier_webhook_events set next_retry_at = now() - interval '1 minute' where id = $1`, [early.event_id])
      await asService(db)
      expect(await value(db, `select public.retry_courier_webhooks()`)).toMatchObject({ processed: 1 })
      expect(await value(db, `select status::text from public.orders where id = $1`, [order.id])).toBe('SHIPPED')
    }))

  it('records a processing failure with the error and lets staff retry it', () =>
    inTx(async (db) => {
      const courier = await pathaoCourier(db)
      await bookedOrder(db, courier, '01711000804', 'DL804')
      const bad = await webhook(db, courier, event('order.delivered', 'DL804', 'DELIVERED', { charges: { delivery_fee: 'n/a' } }))
      expect(bad.status).toBe('failed')
      await asSystem(db)
      const row = await one<Record<string, unknown>>(db,
        `select result, attempts, error is not null as has_error, next_retry_at is not null as will_retry,
                (select status::text from public.shipments where consignment_id = 'DL804') as parcel
         from public.courier_webhook_events where id = $1`, [bad.event_id])
      // Nothing half-applied: the parcel did not move.
      expect(row).toEqual({ result: 'FAILED', attempts: 1, has_error: true, will_retry: true, parcel: 'BOOKED' })
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      expect((await value<{ status: string }>(db, `select public.retry_courier_webhook($1)`, [bad.event_id])).status).toBe('failed')
      await asSystem(db)
      expect(await value(db, `select attempts from public.courier_webhook_events where id = $1`, [bad.event_id])).toBe(2)
    }))

  it('books the return charge when the parcel comes back, without doubling it later', () =>
    inTx(async (db) => {
      const courier = await pathaoCourier(db)
      const { order, ship } = await bookedOrder(db, courier, '01711000805', 'DL805', { returnCharge: 50 })
      await webhook(db, courier, event('order.picked', 'DL805', 'PICKED_UP'))
      await webhook(db, courier, event('order.returned', 'DL805', 'RETURNED'))
      expect(await charges(db, ship)).toEqual({ RETURN: 50 })
      // The parcel is received at the warehouse: costs are already booked.
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await db.query(`select public.process_order_return($1, null, 'Back')`, [order.id])
      expect(await charges(db, ship)).toEqual({ RETURN: 50, DELIVERY: 70 })
      expect(await financeByCategory(db, order.id)).toMatchObject({ RETURNS: 50, COURIER: 70 })
    }))

  it('keeps the webhook plumbing away from browsers', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await expectError(db, `select public.record_courier_webhook(null, 'pathao', '{}')`, [], /permission denied/)
      await asAnon(db)
      await expectError(db, `select public.retry_courier_webhooks()`, [], /permission denied/)
      await expectError(db, `select * from public.courier_webhook_events`, [], /permission denied/)
    }))
})

describe('courier statements', () => {
  async function scenario(db: Db) {
    const courier = await pathaoCourier(db, { cod_fee_percent: 1 })
    const a = await bookedOrder(db, courier, '01711000811', 'DL811')
    const b = await bookedOrder(db, courier, '01711000812', 'DL812', { returnCharge: 50 })
    await webhook(db, courier, event('order.picked', 'DL811', 'PICKED_UP'))
    await webhook(db, courier, event('order.delivered', 'DL811', 'DELIVERED'))
    await webhook(db, courier, event('order.picked', 'DL812', 'PICKED_UP'))
    await webhook(db, courier, event('order.returned', 'DL812', 'RETURNED'))
    await asSystem(db)
    const cod = num(await value(db, `select cod_amount from public.orders where id = $1`, [a.order.id]))
    return { courier, a, b, cod }
  }

  it('matches each line, flags what differs, and works out the expected payout', () =>
    inTx(async (db) => {
      const { courier, cod } = await scenario(db)
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      const result = await value<Record<string, unknown>>(db, `select public.import_courier_invoice($1)`, [JSON.stringify({
        courier_id: courier, invoice_number: 'INV-77', payout_reported: cod - 80 - 6 - 70 - 50 + 400,
        lines: [
          { consignment_id: 'DL811', cod_collected: cod, delivery_fee: 80, cod_fee: 6 },
          { consignment_id: 'DL812', cod_collected: 0, delivery_fee: 70, return_fee: 50 },
          { consignment_id: 'DL899', cod_collected: 500, delivery_fee: 100 },
          { consignment_id: 'DL811', cod_collected: cod },
        ],
      })])
      expect(result).toMatchObject({ status: 'DISCREPANCY', lines: 4, matched: 1, mismatched: 1, unmatched: 1, duplicates: 1 })
      await asSystem(db)
      const lines = (await db.query(`select consignment_id, match_status, issues from public.courier_invoice_lines
        where invoice_id = $1 order by line_no`, [result.invoice_id])).rows
      expect(lines.map((l) => l.match_status)).toEqual(['MISMATCH', 'MATCHED', 'UNMATCHED', 'DUPLICATE'])
      expect(lines[0].issues).toEqual(['Delivery fee 80.00, expected 70.00'])
      // Expected: what we think the courier owes for the parcels we know about.
      const inv = await one<Record<string, string>>(db, `select payout_expected, payout_reported, difference from public.courier_invoices where id = $1`, [result.invoice_id])
      const expectedCodFee = Math.round(cod) / 100
      expect(num(inv.payout_expected)).toBeCloseTo(cod - 70 - expectedCodFee - 70 - 50, 2)
      expect(num(inv.difference)).toBeCloseTo(num(inv.payout_reported) - num(inv.payout_expected), 2)

      // The same statement cannot be uploaded twice.
      await asUser(db, staff)
      await expectError(db, `select public.import_courier_invoice($1)`,
        [JSON.stringify({ courier_id: courier, invoice_number: 'inv-77', lines: [{ consignment_id: 'DL811' }] })], /already uploaded/)
    }))

  it('turns statement fees into actual charges once verified, and settles COD when paid', () =>
    inTx(async (db) => {
      const { courier, a, b, cod } = await scenario(db)
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      const imported = await value<{ invoice_id: string; status: string }>(db, `select public.import_courier_invoice($1)`, [JSON.stringify({
        courier_id: courier, invoice_number: 'INV-78',
        lines: [
          { consignment_id: 'DL811', cod_collected: cod, delivery_fee: 70, cod_fee: Math.round(cod) / 100 },
          { order_ref: b.order.order_number, cod_collected: 0, delivery_fee: 70, return_fee: 50 },
        ],
      })])
      expect(imported.status).toBe('NEEDS_REVIEW')
      await db.query(`select public.set_courier_invoice_status($1, 'VERIFIED')`, [imported.invoice_id])
      // Verifying twice changes nothing.
      await db.query(`select public.set_courier_invoice_status($1, 'VERIFIED')`, [imported.invoice_id])
      expect(await charges(db, a.ship)).toMatchObject({ DELIVERY: 70, COD_FEE: Math.round(cod) / 100 })
      expect(await charges(db, b.ship)).toMatchObject({ DELIVERY: 70, RETURN: 50 })

      await asUser(db, staff)
      const paid = await one<Record<string, string>>(db,
        `select status, amount_paid from public.set_courier_invoice_status($1, 'PAID', null, null, 'BANK-1')`, [imported.invoice_id])
      expect(paid.status).toBe('PAID')
      await asSystem(db)
      expect(await value(db, `select payment_status::text from public.orders where id = $1`, [a.order.id])).toBe('PAID')
      expect(num(await value(db, `select cod_collected from public.shipments where id = $1`, [a.ship]))).toBe(cod)
      await asUser(db, staff)
      await expectError(db, `select public.set_courier_invoice_status($1, 'DISCREPANCY')`, [imported.invoice_id], /cannot be changed/)
    }))

  it('reports courier performance and cost', () =>
    inTx(async (db) => {
      const { courier } = await scenario(db)
      const staff = await createStaff(db, 'ADMIN')
      // The store's own date (Dhaka), not the server's.
      const today = await value<string>(db, `select ((now() at time zone public.store_timezone())::date)::text`)
      await asUser(db, staff)
      const rows = await value<Array<Record<string, unknown>>>(db, `select public.courier_metrics($1::date - 1, $1::date)`, [today])
      const mine = rows.find((r) => r.id === courier)!
      expect(mine).toMatchObject({ shipped: 2, delivered: 1, returned: 1, delivery_rate: 50, return_rate: 50 })
      expect(num(mine.total_cost as number)).toBeGreaterThan(0)
    }))

  it('needs courier permissions to import or settle', () =>
    inTx(async (db) => {
      const { courier } = await scenario(db)
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.import_courier_invoice($1)`,
        [JSON.stringify({ courier_id: courier, lines: [{ consignment_id: 'DL811' }] })], /couriers.manage/)
    }))
})

describe('courier webhook secret', () => {
  it('lives in Vault, readable only by the service role', () =>
    inTx(async (db) => {
      const courier = await pathaoCourier(db)
      const owner = await createStaff(db, 'OWNER')
      await asService(db)
      await expectError(db, `select public.courier_webhook_secret_set($1, 'short', $2)`, [courier, owner], /16 to 200/)
      await db.query(`select public.courier_webhook_secret_set($1, 'a-long-webhook-secret-1234', $2)`, [courier, owner])
      expect(await value(db, `select public.courier_webhook_secret_get($1)`, [courier])).toBe('a-long-webhook-secret-1234')
      await asSystem(db)
      expect(await value(db, `select config ->> 'webhook_secret_hint' from public.couriers where id = $1`, [courier])).toBe('••••1234')
      expect(await value(db, `select config::text like '%a-long-webhook%' from public.couriers where id = $1`, [courier])).toBe(false)
      await asUser(db, owner)
      await expectError(db, `select public.courier_webhook_secret_get($1)`, [courier], /permission denied/)
    }))
})
