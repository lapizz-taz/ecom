import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

describe('system log', () => {
  it('groups repeats of the same open problem and keeps staff out of writing directly', () =>
    inTx(async (db) => {
      await asService(db)
      const a = await value<number>(db, `select public.log_system_event('WARN', 'COURIER', 'courier', 'Pathao answered HTTP 502 for order 123')`)
      const b = await value<number>(db, `select public.log_system_event('ERROR', 'COURIER', 'courier', 'Pathao answered HTTP 502 for order 456')`)
      expect(b).toBe(a)
      await asSystem(db)
      const row = await value<{ occurrences: number; level: string }>(db, `select to_jsonb(s) from public.system_logs s where id = $1`, [a])
      expect(row).toMatchObject({ occurrences: 2, level: 'ERROR' })

      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.log_system_event('ERROR', 'OTHER', 'x', 'y')`, [], /permission denied/)
      await db.query(`select public.log_client_error('TypeError: x is undefined', '{"path":"/admin"}')`)
      expect(await value(db, `select count(*)::int from public.system_logs where category = 'FRONTEND'`)).toBe(1)
      expect(await value(db, `select public.admin_resolve_system_logs(array[$1::bigint])`, [a])).toBe(1)

      // Resolved problems start a new row when they happen again.
      await asService(db)
      const c = await value<number>(db, `select public.log_system_event('ERROR', 'COURIER', 'courier', 'Pathao answered HTTP 502 for order 789')`)
      expect(c).not.toBe(a)
    }))

  it('only staff with audit access can read it', () =>
    inTx(async (db) => {
      await asService(db)
      await db.query(`select public.log_system_event('ERROR', 'PAYMENT', 'payments', 'bKash token grant failed')`)
      const packer = await createStaff(db, 'PRODUCTION_MANAGER')
      await asUser(db, packer)
      expect(await value(db, `select count(*)::int from public.system_logs`)).toBe(0)
      await expectError(db, `select public.admin_resolve_system_logs(array[1::bigint])`, [], /PERMISSION_DENIED/)
      await db.query(`set local role anon`)
      await expectError(db, `select count(*) from public.system_logs`, [], /permission denied/)
      await expectError(db, `select public.log_client_error('x')`, [], /permission denied/)
    }))
})
