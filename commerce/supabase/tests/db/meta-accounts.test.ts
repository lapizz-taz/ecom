import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { createStaff, setSetting } from '../support/fixtures'

afterAll(closePool)

const row = (ad: string, campaign: string, date: string, spend: number) => ({
  ad_id: ad, adset_id: `${ad}1`, campaign_id: campaign, date, platform: 'facebook', spend: String(spend), impressions: '1000', link_clicks: '10',
})

async function localDay(db: Db, offset: number): Promise<string> {
  await asSystem(db)
  return value<string>(db, `select (public._local_date(now()) + $1::int)::text`, [offset])
}

async function sync(db: Db, account: string, since: string, until: string, insights: unknown[]) {
  await asService(db)
  return value<Record<string, number>>(db, `select public.meta_ads_apply_sync($1)`,
    [JSON.stringify({ account_id: account, since, until, complete: true, insights })])
}

async function paymentAccount(db: Db, name: string, opening = 0) {
  const finance = await createStaff(db, 'FINANCE_MANAGER')
  await asUser(db, finance)
  return one<{ id: string }>(db, `select * from public.finance_account_save($1)`, [JSON.stringify({ name, kind: 'CARD', opening_balance: opening })])
}

async function metaAccount(db: Db, p: Record<string, unknown>) {
  await asService(db)
  return one<{ id: string; payments_from: string | null }>(db, `select id, payments_from::text as payments_from from public.meta_account_save($1, null)`, [JSON.stringify(p)])
}

async function balance(db: Db, accountId: string) {
  await asSystem(db)
  return num(await value(db, `select a.opening_balance + coalesce((select sum(amount) from public.finance_account_movements where account_id = a.id), 0)
    from public.finance_accounts a where a.id = $1`, [accountId]))
}

describe('Meta ad accounts', () => {
  it('costs each account with its own rate and never zeroes another account when syncing one', () =>
    inTx(async (db) => {
      await setSetting(db, 'meta_ads', { exchange_rate: 1, tax_percent: 0 })
      const d = await localDay(db, 0)
      await metaAccount(db, { name: 'Main', ad_account_id: 'act_111', usd_rate: 110 })
      await metaAccount(db, { name: 'Second', ad_account_id: '222', usd_rate: 120 })
      await asSystem(db)
      await db.query(`update public.meta_ad_accounts set currency = 'USD'`)

      await sync(db, 'act_111', d, d, [row('5001', '5000', d, 10)])
      await sync(db, 'act_222', d, d, [row('6001', '6000', d, 10)])
      await asSystem(db)
      expect(num(await value(db, `select cost from public.meta_ad_insights where ad_id = '5001'`))).toBe(1100)
      expect(num(await value(db, `select cost from public.meta_ad_insights where ad_id = '6001'`))).toBe(1200)
      expect(await value(db, `select account_id from public.meta_ad_insights where ad_id = '5001'`)).toBe('111')

      // A complete sync of account 111 with no rows leaves account 222 alone.
      await sync(db, '111', d, d, [])
      await asSystem(db)
      expect(num(await value(db, `select cost from public.meta_ad_insights where ad_id = '5001'`))).toBe(0)
      expect(num(await value(db, `select cost from public.meta_ad_insights where ad_id = '6001'`))).toBe(1200)
    }))

  it('withdraws a finished day from the payment account the day after and follows Meta revisions', () =>
    inTx(async (db) => {
      await setSetting(db, 'meta_ads', { exchange_rate: 1, tax_percent: 10 })
      const card = await paymentAccount(db, 'Visa card', 50000)
      const acc = await metaAccount(db, { name: 'Main', ad_account_id: '333', usd_rate: 100, payment_account_id: card.id })
      expect(acc.payments_from).toBe(await localDay(db, 0))
      const yesterday = await localDay(db, -1)
      const today = await localDay(db, 0)
      // Spend from before the payment account was chosen is not withdrawn.
      await sync(db, '333', yesterday, today, [row('7001', '7000', yesterday, 5), row('7001', '7000', today, 3)])
      expect(await balance(db, card.id)).toBe(50000)

      // Pretend the account was chosen yesterday: yesterday is withdrawn, today waits.
      await asSystem(db)
      await db.query(`update public.meta_ad_accounts set payments_from = $1 where id = $2`, [yesterday, acc.id])
      const r = await sync(db, '333', yesterday, today, [row('7001', '7000', yesterday, 5), row('7001', '7000', today, 3)])
      expect(r.payments).toBe(1)
      expect(await balance(db, card.id)).toBe(50000 - 550) // 5 × 100 × 1.10
      // Syncing again changes nothing.
      await sync(db, '333', yesterday, today, [row('7001', '7000', yesterday, 5), row('7001', '7000', today, 3)])
      expect(await balance(db, card.id)).toBe(49450)
      // Meta revises yesterday to 6: one correction of 110.
      await sync(db, '333', yesterday, today, [row('7001', '7000', yesterday, 6), row('7001', '7000', today, 3)])
      expect(await balance(db, card.id)).toBe(49340)
      await asSystem(db)
      const moves = await db.query(`select amount::float, movement_date::text, spend_date::text, description from public.finance_account_movements
        where account_id = $1 order by created_at`, [card.id])
      expect(moves.rows.map((m) => m.amount)).toEqual([-550, -110])
      expect(moves.rows[0].movement_date).toBe(today)
      expect(moves.rows[0].description).toMatch(/Meta Ads · Main · spend on/)
      expect(moves.rows[1].description).toMatch(/revised/)
      // Movements are permanent.
      await expectError(db, `update public.finance_account_movements set amount = 1 where account_id = $1`, [card.id], /IMMUTABLE/)
    }))

  it('re-costs an account when its rate changes and posts the difference to Finance', () =>
    inTx(async (db) => {
      await setSetting(db, 'meta_ads', { exchange_rate: 1, tax_percent: 0 })
      const d = await localDay(db, 0)
      const acc = await metaAccount(db, { name: 'Main', ad_account_id: '444', usd_rate: 100 })
      await sync(db, '444', d, d, [row('8001', '8000', d, 10)])
      await metaAccount(db, { id: acc.id, name: 'Main', ad_account_id: '444', usd_rate: 120 })
      await asSystem(db)
      expect(num(await value(db, `select cost from public.meta_ad_insights where ad_id = '8001'`))).toBe(1200)
      expect(num(await value(db, `select coalesce(sum(ft.amount), 0) from public.finance_transactions ft
        join public.finance_categories c on c.id = ft.category_id where c.code = 'ADVERTISING' and ft.txn_date = $1`, [d]))).toBe(1200)
    }))

  it('validates accounts and keeps account management on the server', () =>
    inTx(async (db) => {
      await expectError(db, `select public.meta_account_save('{"name":"X1","ad_account_id":"abc"}', null)`, [], /without act_/)
      await metaAccount(db, { name: 'Main', ad_account_id: '555' })
      await expectError(db, `select public.meta_account_save('{"name":"Other","ad_account_id":"act_555"}', null)`, [], /already connected/)
      await expectError(db, `select public.meta_account_save($1, null)`,
        [JSON.stringify({ name: 'Other', ad_account_id: '556', payment_account_id: '00000000-0000-0000-0000-000000000000' })], /payment account/)

      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await expectError(db, `select public.meta_account_save('{"name":"Hack","ad_account_id":"999"}', null)`, [], /PERMISSION_DENIED|permission/i)
      const list = await value<{ accounts: { name: string }[] }>(db, `select public.meta_accounts_list()`)
      expect(list.accounts.map((a) => a.name)).toContain('Main')
      expect(JSON.stringify(list)).not.toMatch(/access_token|"app_secret"/)

      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.finance_account_move(gen_random_uuid(), 10, null, 'top up')`, [], /finance\.manage|permission/i)
    }))

  it('lets finance staff top up and see balances; marketing staff only see names', () =>
    inTx(async (db) => {
      const card = await paymentAccount(db, 'bKash merchant', 1000)
      await db.query(`select public.finance_account_move($1, 500, null, 'Top up')`, [card.id])
      const list = await value<{ name: string; balance: number }[]>(db, `select public.finance_accounts_list()`)
      expect(num(list.find((a) => a.name === 'bKash merchant')!.balance)).toBe(1500)
      await expectError(db, `select public.finance_account_save('{"name":"bkash MERCHANT"}')`, [], /already an account/)

      const admin = await createStaff(db, 'ADMIN') // marketing.manage, finance.view
      await asUser(db, admin)
      expect((await value<unknown[]>(db, `select public.finance_accounts_list()`)).length).toBe(1)
      const manager = await createStaff(db, 'MANAGER') // marketing.view only
      await asUser(db, manager)
      await expectError(db, `select public.finance_accounts_list()`, [], /finance\.view|permission/i)
    }))
})
