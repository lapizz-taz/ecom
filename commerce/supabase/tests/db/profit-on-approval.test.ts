// The dashboard's profit counts an order from the day it is approved. A returned order costs the
// courier's delivery and return charges, less what the customer paid towards them.
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const TO_READY = ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP']
type Report = Record<string, any>

async function estimate(db: Db): Promise<Report> {
  await asSystem(db)
  return value<Report>(db, `select public.report_estimated_profit(current_date - 1, current_date + 1)`)
}
const t = (r: Report, k: string) => num(r.totals[k])

/**
 * One product: sold for 1,000, cost 400. Delivery zone: delivery charge 120, return charge 60.
 * Courier fee 80 when booked. Every order is approved today.
 */
async function shop(db: Db) {
  await asSystem(db)
  const district = `profit${Math.floor(Math.random() * 1e6)}`
  await db.query(`insert into public.delivery_zones(name, districts, charge, return_charge, sort_order) values ('Profit zone', $1, 120, 60, 0)`, [`{${district}}`])
  const courier = await value<string>(db, `insert into public.couriers(name, provider) values ('Profit courier', 'manual') returning id`)
  const product = await createProduct(db, { price: 1000, cost: 400, stock: 20 })

  const approve = async (advance = 0) => {
    const o = await createOrder(db, { district, items: [{ variantId: product.variantIds[0], quantity: 1 }] })
    await asSystem(db)
    if (advance) await db.query(`select public.record_order_payment($1, 'ADVANCE', 'BKASH', $2)`, [o.id, advance])
    await advanceOrder(db, o.id, TO_READY)
    return o.id
  }
  const book = async (id: string) => {
    await asSystem(db)
    await db.query(`select public.assign_courier($1, $2, $3, 80)`, [id, courier, `TRK-${id.slice(0, 8)}`])
  }
  const returned = async (advance = 0) => {
    const id = await approve(advance)
    await book(id)
    await advanceOrder(db, id, ['SHIPPED', 'FAILED_DELIVERY', 'RETURNED'])
    return id
  }
  return { approve, book, returned }
}

describe('Profit on approval', () => {
  it('counts an approved order at once; a returned one costs the courier charges less what the customer paid', () =>
    inTx(async (db) => {
      const before = await estimate(db)
      const s = await shop(db)

      await s.approve() // on the way, not booked yet: 1,120 − 400 − 120 (the delivery charge stands in for the courier)
      const delivered = await s.approve()
      await s.book(delivered)
      await advanceOrder(db, delivered, ['SHIPPED', 'DELIVERED']) // 1,120 − 400 − 80
      await s.returned() // nothing paid: −(80 + 60)
      await s.returned(150) // paid more than the charges: no loss
      await s.returned(100) // paid part: −40
      const cancelled = await s.approve()
      await advanceOrder(db, cancelled, ['CANCELLED']) // nothing
      await asSystem(db)
      const campaign = await value<string>(db, `insert into public.marketing_campaigns(platform, name) values ('META', 'Profit test') returning id`)
      await db.query(`insert into public.marketing_spend(campaign_id, spend_date, spend) values ($1, current_date, 300)`, [campaign])

      const r = await estimate(db)
      const d = (k: string) => t(r, k) - t(before, k)
      expect(d('sales')).toBe(2240)
      expect(d('product_cost')).toBe(800)
      expect(d('courier_cost')).toBe(120 + 80 + 140 * 3)
      expect(d('return_charges')).toBe(140 + 100)
      expect(d('ads')).toBe(300)
      expect(d('profit')).toBe(600 + 640 - 140 + 0 - 40 + 0 - 300)

      const n = (k: string) => num(r.orders[k]) - num(before.orders[k])
      expect([n('approved'), n('open'), n('delivered'), n('returned'), n('cancelled')]).toEqual([6, 1, 1, 3, 1])
      const ret = (k: string) => num(r.returns[k]) - num(before.returns[k])
      expect([ret('orders'), ret('courier_cost'), ret('paid'), ret('loss')]).toEqual([3, 420, 240, 180])
      expect(num(r.quality.courier_estimated) - num(before.quality.courier_estimated)).toBe(1)

      // The daily figures add up to the period's profit.
      expect(r.daily).toHaveLength(3)
      expect(r.daily.reduce((a: number, x: Report) => a + num(x.profit), 0)).toBeCloseTo(t(r, 'profit'), 2)
    }))

  it('an advance the business kept counts in full; a refunded one pays nothing towards the return', () =>
    inTx(async (db) => {
      const s = await shop(db)
      const before = await estimate(db)
      const kept = await s.returned(200)
      await asSystem(db)
      await db.query(`select public.retain_order_advance($1, 'Customer refused the parcel')`, [kept])
      const refunded = await s.returned(150)
      await asSystem(db)
      await db.query(`select public.refund_order($1, 150, 'BKASH', 'Sent back')`, [refunded])

      const r = await estimate(db)
      expect(t(r, 'courier_cost') - t(before, 'courier_cost')).toBe(280)
      expect(t(r, 'return_charges') - t(before, 'return_charges')).toBe(200)
      expect(t(r, 'profit') - t(before, 'profit')).toBe(200 - 280)
    }))

  it('what the courier collected at the door pays the return; a whole COD amount on a returned parcel is not cash', () =>
    inTx(async (db) => {
      const s = await shop(db)
      await asSystem(db)
      const pathao = await value<string>(db, `insert into public.couriers(name, provider, api_enabled) values ('Pathao profit', 'pathao', true) returning id`)
      const send = async (consignment: string, key: string, status: string, charges: Record<string, number> = {}) => {
        await asService(db)
        const r = await value<{ status: string }>(db, `select public.record_courier_webhook($1, 'pathao', $2)`, [pathao, JSON.stringify({
          event_key: `pathao:${consignment}:${key}`, event_type: key, consignment_id: consignment, status, provider_status: key, charges,
        })])
        expect(r.status).toBe('processed')
      }
      const booked = async () => {
        const id = await s.approve()
        const consignment = `PR${id.slice(0, 8)}`
        await asSystem(db)
        await db.query(`select public.assign_courier($1, $2, $3, 80, null, $3)`, [id, pathao, consignment])
        await send(consignment, 'order.picked', 'PICKED_UP')
        return consignment
      }
      const before = await estimate(db)

      const paidReturn = await booked() // Pathao "paid return": the customer paid 100 at the door → loss 140 − 100
      await send(paidReturn, 'order.paid-return', 'RETURNED', { collected: 100 })
      const echoed = await booked() // the whole COD amount on a returned parcel is the booked amount, not cash → loss 140
      await send(echoed, 'order.returned', 'RETURNED', { collected: 1120 })
      const partial = await booked() // Steadfast's paid return: a "partial delivery" that collected only the delivery charge
      await send(partial, 'order.partial-delivery', 'PARTIALLY_DELIVERED', { collected: 100 })

      const r = await estimate(db)
      const d = (k: string) => t(r, k) - t(before, k)
      expect(d('sales')).toBe(0)
      expect(d('product_cost')).toBe(0)
      expect(d('courier_cost')).toBe(140 * 3)
      expect(d('return_charges')).toBe(200)
      expect(d('profit')).toBe(-40 - 140 - 40)
      const ret = (k: string) => num(r.returns[k]) - num(before.returns[k])
      expect([ret('orders'), ret('paid'), ret('loss')]).toEqual([3, 200, 220])
      await asSystem(db)
      expect(num(await value(db, `select collected_amount from public.shipments where consignment_id = $1`, [paidReturn]))).toBe(100)
    }))

  it('the dashboard shows it for the period and today; without finance.view there is none', () =>
    inTx(async (db) => {
      const s = await shop(db)
      await s.approve()
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      const c = await value<Report>(db, `select public.dashboard_command_center(current_date - 1, current_date + 1)`)
      const direct = await value<Report>(db, `select public.report_estimated_profit(current_date - 1, current_date + 1)`)
      expect(num(c.finance.estimate.totals.profit)).toBe(num(direct.totals.profit))
      expect(c.finance.today_estimate).toHaveProperty('profit')

      const manager = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, manager)
      await expectError(db, `select public.report_estimated_profit(current_date - 1, current_date)`, [], /PERMISSION_DENIED|finance\.view/)
      const m = await value<Report>(db, `select public.dashboard_command_center(current_date - 1, current_date)`)
      expect(m.finance).toBeUndefined()

      await asUser(db, admin)
      await expectError(db, `select public.report_estimated_profit(current_date, current_date - 1)`, [], /VALIDATION/)
    }))
})
