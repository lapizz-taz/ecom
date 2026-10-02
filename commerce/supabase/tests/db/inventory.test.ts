import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, num, value } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, inventory, orderPayload, setSetting, transition } from '../support/fixtures'

afterAll(closePool)

const TO_SHIPPED = ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED']

describe('stock reservation', () => {
  it('reserves stock when an order is created and records the movement', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 10 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 3 }] })
      expect(await inventory(db, p.variantIds[0])).toEqual({ on_hand: 10, reserved: 3, available: 7, damaged: 0 })
      const mov = await db.query(`select movement_type, quantity, reserved_change, reference_label
                                  from public.inventory_movements where reference_id = $1`, [order.id])
      expect(mov.rows).toEqual([{ movement_type: 'RESERVATION', quantity: 3, reserved_change: 3, reference_label: order.order_number }])
    }))

  it('refuses to oversell unless the admin setting allows it', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 2 })
      await expectError(db, `select public._create_order($1, 'STOREFRONT')`,
        [JSON.stringify(orderPayload({ items: [{ variantId: p.variantIds[0], quantity: 3 }] }))], /INSUFFICIENT_STOCK/)
      expect((await inventory(db, p.variantIds[0])).reserved).toBe(0)
      await setSetting(db, 'inventory', { allow_overselling: true })
      await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 3 }] })
      expect((await inventory(db, p.variantIds[0])).available).toBe(-1)
    }))

  it('does not track stock for made-to-order products', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 0, trackInventory: false })
      await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 5 }] })
      expect(await inventory(db, p.variantIds[0])).toEqual({ on_hand: 0, reserved: 0, available: 0, damaged: 0 })
    }))
})

describe('stock release and deduction', () => {
  it('releases the reservation when an order is cancelled before shipping', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await transition(db, order.id, 'CANCELLED', 'Customer cancelled')
      expect(await inventory(db, p.variantIds[0])).toEqual({ on_hand: 5, reserved: 0, available: 5, damaged: 0 })
      expect(await value(db, `select status from public.stock_reservations where order_id = $1`, [order.id])).toBe('RELEASED')
      expect(await value(db, `select count(*)::int from public.inventory_movements where reference_id = $1 and movement_type = 'RELEASE'`, [order.id])).toBe(1)
    }))

  it('converts the reservation into a sale when the order ships', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await advanceOrder(db, order.id, TO_SHIPPED)
      expect(await inventory(db, p.variantIds[0])).toEqual({ on_hand: 3, reserved: 0, available: 3, damaged: 0 })
      expect(await value(db, `select status from public.stock_reservations where order_id = $1`, [order.id])).toBe('COMMITTED')
      await expectError(db, `select public._transition_order($1, 'CANCELLED')`, [order.id], /INVALID_TRANSITION/)
    }))

  it('re-reserves exactly when staff change order items', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 500, stock: 5 })
      const b = await createProduct(db, { price: 200, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: a.variantIds[0], quantity: 2 }] })
      await asSystem(db)
      await db.query(`select public.admin_set_order_items($1, $2)`, [order.id, JSON.stringify([
        { variant_id: a.variantIds[0], quantity: 1 }, { variant_id: b.variantIds[0], quantity: 4 },
      ])])
      expect((await inventory(db, a.variantIds[0])).reserved).toBe(1)
      expect((await inventory(db, b.variantIds[0])).reserved).toBe(4)
      expect(num(await value(db, `select total_amount from public.orders where id = $1`, [order.id]))).toBe(500 + 800 + 80)
    }))
})

describe('return handling', () => {
  it('restocks good items and moves damaged items to the damaged bucket', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, cost: 200, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 3 }] })
      await advanceOrder(db, order.id, [...TO_SHIPPED, 'FAILED_DELIVERY'])
      const itemId = await value<string>(db, `select id from public.order_items where order_id = $1`, [order.id])
      await asSystem(db)
      await db.query(`select public.process_order_return($1, $2, 'Parcel back from courier')`, [order.id, JSON.stringify([
        { order_item_id: itemId, quantity: 2, condition: 'RESTOCK' },
        { order_item_id: itemId, quantity: 1, condition: 'DAMAGED' },
      ])])
      expect(await inventory(db, p.variantIds[0])).toEqual({ on_hand: 4, reserved: 0, available: 4, damaged: 1 })
      // A completed return cannot be processed twice.
      await expectError(db, `select public.process_order_return($1, $2)`, [order.id, '[]'], /only parcels on their way back/)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('RETURNED')
    }))

  it('marks damaged returns without returning them to sellable stock', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, cost: 200, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await advanceOrder(db, order.id, [...TO_SHIPPED, 'FAILED_DELIVERY'])
      const itemId = await value<string>(db, `select id from public.order_items where order_id = $1`, [order.id])
      await asSystem(db)
      await db.query(`select public.process_order_return($1, $2)`, [order.id, JSON.stringify([{ order_item_id: itemId, quantity: 2, condition: 'DAMAGED' }])])
      expect(await inventory(db, p.variantIds[0])).toEqual({ on_hand: 3, reserved: 0, available: 3, damaged: 2 })
    }))

  it('returns everything with the default condition when a return is completed directly', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await advanceOrder(db, order.id, [...TO_SHIPPED, 'DELIVERED', 'RETURN_REQUESTED', 'RETURNED'])
      expect((await inventory(db, p.variantIds[0])).on_hand).toBe(5)
    }))
})

describe('manual stock adjustments', () => {
  it('adds, removes and sets stock with an audited movement', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, stock: 10 })
      const staff = await createStaff(db, 'INVENTORY_MANAGER')
      await asUser(db, staff)
      await db.query(`select public.adjust_stock($1, 'ADJUSTMENT', 5, 'Found in back room', 'ADD')`, [p.variantIds[0]])
      await db.query(`select public.adjust_stock($1, 'ADJUSTMENT', 3, 'Counted wrong', 'REMOVE')`, [p.variantIds[0]])
      await db.query(`select public.adjust_stock($1, 'ADJUSTMENT', 20, 'Stock take', 'SET')`, [p.variantIds[0]])
      await db.query(`select public.adjust_stock($1, 'DAMAGE', 2, 'Water damage')`, [p.variantIds[0]])
      await db.query(`select public.adjust_stock($1, 'TRANSFER', 1, 'Repaired')`, [p.variantIds[0]])
      expect(await inventory(db, p.variantIds[0])).toEqual({ on_hand: 19, reserved: 0, available: 19, damaged: 1 })
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.audit_logs where action = 'stock.adjusted' and actor_id = $1`, [staff])).toBe(5)
    }))

  it('requires a reason and never lets available stock go negative', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, stock: 3 })
      await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await asSystem(db)
      await expectError(db, `select public.adjust_stock($1, 'ADJUSTMENT', 1, '', 'REMOVE')`, [p.variantIds[0]], /reason/)
      await expectError(db, `select public.adjust_stock($1, 'LOSS', 2, 'Stolen')`, [p.variantIds[0]], /INSUFFICIENT_STOCK/)
    }))

  it('is denied to roles without inventory.adjust', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, stock: 3 })
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.adjust_stock($1, 'ADJUSTMENT', 1, 'x', 'ADD')`, [p.variantIds[0]], /PERMISSION_DENIED/)
      await expectError(db, `update public.inventory set on_hand = 1000 where variant_id = $1`, [p.variantIds[0]], /permission denied/)
    }))

  it('keeps the movement ledger immutable', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, stock: 3 })
      await asSystem(db)
      await expectError(db, `update public.inventory_movements set quantity = 1 where variant_id = $1`, [p.variantIds[0]], /IMMUTABLE_RECORD/)
      await expectError(db, `delete from public.inventory_movements where variant_id = $1`, [p.variantIds[0]], /IMMUTABLE_RECORD/)
    }))
})

describe('purchase receiving', () => {
  it('increases stock, records PURCHASE movements and updates weighted average cost', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, cost: 400, stock: 10 })
      await asSystem(db)
      const supplierId = await value<string>(db, `insert into public.suppliers(name) values ('Fabric Co') returning id`)
      const po = await value<{ id: string }>(db, `select to_jsonb(po) from public.admin_save_purchase_order($1) po`, [JSON.stringify({
        supplier_id: supplierId, status: 'ORDERED', items: [{ variant_id: p.variantIds[0], quantity: 10, unit_cost: 500 }],
      })])
      await db.query(`select public.receive_purchase_order($1)`, [po.id])
      expect((await inventory(db, p.variantIds[0])).on_hand).toBe(20)
      expect(num(await value(db, `select cost_price from public.product_variants where id = $1`, [p.variantIds[0]]))).toBe(450)
      expect(await value(db, `select status from public.purchase_orders where id = $1`, [po.id])).toBe('RECEIVED')
      await expectError(db, `select public.receive_purchase_order($1)`, [po.id], /cannot be received/)
    }))
})
