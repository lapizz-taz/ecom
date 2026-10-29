import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createStaff } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

/** The Cloudflare database (staging) signs people in itself: no Supabase Auth tables to guard there. */
const onEngine = Boolean(process.env.CF_DB_TESTS)

// demo@gmail.com is handed to anyone who wants to see Fullfilio: its business is look-only, and the
// account's sign-in details cannot be taken over.

async function demoBusiness(db: Db): Promise<{ merchant: string; owner: string; email: string }> {
  const merchant = await createMerchant(db)
  const email = `demo-${merchant.slice(0, 6)}@example.com`
  const owner = await createStaff(db, 'OWNER', email, merchant)
  await asSystem(db, null)
  await db.query(`update public.merchants set view_only = true where id = $1`, [merchant])
  return { merchant, owner, email }
}

const access = (db: Db) => value<Record<string, unknown>>(db, `select public.get_my_access()`)
const can = (db: Db, code: string) => value<boolean>(db, `select public.has_permission($1)`, [code])

describe('look-only demo business', () => {
  it('its owner can view and export everything but change nothing', () =>
    inTx(async (db) => {
      const { merchant, owner, email } = await demoBusiness(db)
      await asUser(db, owner, email, merchant)
      expect(await access(db)).toMatchObject({ role: 'OWNER', access_mode: 'READ_ONLY', view_only: true })
      expect(await can(db, 'orders.view')).toBe(true)
      expect(await can(db, 'orders.export')).toBe(true)
      for (const code of ['orders.create', 'orders.update', 'settings.manage', 'users.manage', 'fraud.review']) {
        expect(await can(db, code)).toBe(false)
      }
      await expectError(db, `select public.update_my_profile('Someone else', null)`, [], /demo account/)

      // Switched off again (to fill it with sample data), it is a normal business.
      await asSystem(db, null)
      await db.query(`update public.merchants set view_only = false where id = $1`, [merchant])
      await asUser(db, owner, email, merchant)
      expect(await access(db)).toMatchObject({ access_mode: 'FULL', view_only: false })
      expect(await can(db, 'orders.update')).toBe(true)
    }))

  it.skipIf(onEngine)('its sign-in details cannot be changed, other accounts\' can', () =>
    inTx(async (db) => {
      const { owner } = await demoBusiness(db)
      const other = await createStaff(db, 'OWNER')
      await asSystem(db, null)
      // A password change or reset, an email change, a second factor: all refused.
      await expectError(db, `update auth.users set encrypted_password = 'new-hash' where id = $1`, [owner], /demo account/)
      await expectError(db, `update auth.users set email = 'taken@example.com' where id = $1`, [owner], /demo account/)
      await expectError(db, `update auth.users set email_change = 'taken@example.com' where id = $1`, [owner], /demo account/)
      await expectError(db, `insert into auth.mfa_factors (user_id) values ($1)`, [owner], /demo account/)
      // Signing in still works (Supabase Auth writes the sign-in time).
      await db.query(`update auth.users set last_sign_in_at = now() where id = $1`, [owner])

      // Everyone else is untouched.
      await db.query(`update auth.users set encrypted_password = 'new-hash' where id = $1`, [other])
      await db.query(`insert into auth.mfa_factors (user_id) values ($1)`, [other])

      // The platform team can still change it on purpose.
      await db.query(`set local app.view_only_unlock = 'on'`)
      await db.query(`update auth.users set encrypted_password = 'reset-by-team' where id = $1`, [owner])
      expect(await value(db, `select encrypted_password from auth.users where id = $1`, [owner])).toBe('reset-by-team')
    }))
})
