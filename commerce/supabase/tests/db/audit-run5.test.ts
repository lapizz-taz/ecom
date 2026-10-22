// Security audit run 5: the one-time setup fee on plan changes chosen before the renewal, phone
// patterns with zero-width or bounded "separators", and the inbox thread's customer by typed phone.
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, MERCHANT_1, one, value, type Db } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

const OFFER = { enabled: true, trial_days: 0, first_price: 99, first_periods: 1, setup_fee: 1000 }

async function signUp(db: Db) {
  await asSystem(db, null)
  await db.query(`update public.platform_settings set value = value || '{"method": "online_payment"}' where key = 'onboarding'`)
  await db.query(`update public.platform_settings set value = jsonb_set(value, '{bkash,enabled}', 'true') where key = 'billing_gateways'`)
  await db.query(`insert into public.platform_settings (key, value) values ('signup_offer', '{}') on conflict (key) do nothing`)
  await db.query(`update public.platform_settings set value = value || $1::jsonb where key = 'signup_offer'`, [JSON.stringify(OFFER)])
  const id = randomUUID()
  const email = `r4-${id.slice(0, 8)}@shop.example`
  await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{"full_name": "Dummy Owner"}')`, [id, email])
  await asUser(db, id, email, null)
  const r = await value<{ merchant_id: string }>(db, `select public.merchant_self_onboard($1)`,
    [JSON.stringify({ business_name: 'Dummy Shop', full_name: 'Dummy Owner', phone: '01712345678', plan_code: 'GROWTH' })])
  const m = { id, email, merchant: r.merchant_id }
  // The offer's first invoice is paid: ACTIVE, the offer period still running, no renewal yet.
  const first = await openRenewal(db, m.merchant)
  await pay(db, m.merchant, first.id, Number(first.total))
  return m
}
const openRenewal = async (db: Db, merchant: string) => {
  await asSystem(db, null)
  return value<{ id: string; total: number; lines: Array<{ kind: string; amount: number }> }>(db, `select to_jsonb(i) from public.billing_invoices i
    where merchant_id = $1 and kind = 'SUBSCRIPTION' and status = 'OPEN' order by created_at desc, period_start desc limit 1`, [merchant])
}
async function pay(db: Db, merchant: string, invoice: string, amount: number) {
  await asService(db, merchant)
  const p = await value<{ reference: string }>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [invoice])
  return value<string>(db, `select public.billing_gateway_confirm($1, 'bkash', $2, $3, true, '{}') ->> 'status'`, [p.reference, `TXN-${randomUUID().slice(0, 8)}`, amount])
}


const feeLines = async (db: Db, merchant: string) => {
  await asSystem(db, null)
  return value<{ paid: number; open: number }>(db, `select jsonb_build_object(
      'paid', count(*) filter (where i.status = 'PAID'), 'open', count(*) filter (where i.status = 'OPEN'))
    from public.billing_invoices i, jsonb_array_elements(i.lines) l where i.merchant_id = $1 and l ->> 'kind' = 'setup_fee'`, [merchant])
}
const otherPlan = async (db: Db) => {
  await asSystem(db, null)
  return one<{ code: string; price: number }>(db,
    `select code, price from public.plans where status = 'ACTIVE' and is_public and price > 0 and code <> 'GROWTH' order by price limit 1`)
}

describe('setup fee on a plan change chosen before the renewal', () => {
  it('a plan change during the offer period carries the fee; once paid, later changes do not', () =>
    inTx(async (db) => {
      const m = await signUp(db)
      const other = await otherPlan(db)
      await asUser(db, m.id, m.email, m.merchant)
      const pc = await value<{ id: string; total: number }>(db, `select public.billing_choose_plan($1)`, [other.code])
      expect(Number(pc.total)).toBe(Number(other.price) + 1000)
      expect(await pay(db, m.merchant, pc.id, Number(pc.total))).toBe('succeeded')
      expect(await feeLines(db, m.merchant)).toEqual({ paid: 1, open: 0 })

      await asUser(db, m.id, m.email, m.merchant)
      const back = await value<{ id: string; total: number }>(db, `select public.billing_choose_plan('GROWTH')`)
      await asSystem(db, null)
      const plan = await value<number>(db, `select price from public.plans where code = 'GROWTH'`)
      expect(Number(back.total)).toBe(Number(plan))
    }))

  it('a plan change without the fee cannot be paid while the fee is pending (and cannot lift the block)', () =>
    inTx(async (db) => {
      const m = await signUp(db)
      const other = await otherPlan(db)
      await asUser(db, m.id, m.email, m.merchant)
      const pc = await value<{ id: string }>(db, `select public.billing_choose_plan($1)`, [other.code])
      // As raised before this fix: the plan alone.
      await asSystem(db, null)
      await db.query(`update public.billing_invoices set lines = (select jsonb_agg(l) from jsonb_array_elements(lines) l where l ->> 'kind' <> 'setup_fee'),
        total = $2 where id = $1`, [pc.id, other.price])
      // The offer ends: the renewal with the fee is raised and the business is blocked.
      await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                      where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      expect(await value<string>(db, `select status from public.subscriptions where merchant_id = $1 and ended_at is null`, [m.merchant])).toBe('PAST_DUE')
      await asService(db, m.merchant)
      await expectError(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [pc.id], /setup fee is still due/)
      // The renewal with the fee is still the way to continue.
      const renewal = await openRenewal(db, m.merchant)
      expect(renewal.lines.map((l) => l.kind)).toContain('setup_fee')
      expect(await pay(db, m.merchant, renewal.id, Number(renewal.total))).toBe('succeeded')
      expect(await feeLines(db, m.merchant)).toEqual({ paid: 1, open: 0 })
    }))
})

describe('store phone pattern (run 5)', () => {
  it('refuses zero-width and bounded "separators" and many variable repeats; keeps real phone patterns', () =>
    inTx(async (db) => {
      await asSystem(db, MERCHANT_1)
      const save = (pattern: string) => db.query(`insert into public.settings (key, value) values ('store', jsonb_build_object('phone_pattern', $1::text))
        on conflict (merchant_id, key) do update set value = public.settings.value || excluded.value`, [pattern])
      for (const p of [`^${'\\d*\\d*\\d*a{0}'.repeat(15)}x$`, `^${'\\d*\\d*\\d*\\d{0,2}'.repeat(12)}x$`,
        '^\\d*\\d?\\d*\\d?\\d*\\d?\\d*x$', `^${'\\d{0,9}'.repeat(9)}x$`, '^(\\d*)(\\d*)(\\d*)(\\d*)x$']) {
        await db.query('savepoint p')
        await expect(save(p), p).rejects.toThrow(/nested repetition/)
        await db.query('rollback to savepoint p')
      }
      for (const p of ['^(?:01|8801)[3-9]\\d{8}$', '^\\+?(88)?0?1[3-9]\\d{8}$', '^01[3-9][0-9]{8}$', '^\\d{3}\\d*$']) {
        await save(p)
        expect(await value(db, `select public.setting_text('store', array['phone_pattern'], '')`)).toBe(p)
      }
    }))
})

describe('inbox thread (run 5)', () => {
  it('a phone typed by an agent without customers.view does not pull in the customer\'s other conversations', () =>
    inTx(async (db) => {
      await asSystem(db, MERCHANT_1)
      const roleId = await value<string>(db,
        `insert into public.roles (merchant_id, code, name, rank) values ($1, 'CHATONLY5', 'Chat Only', 10) returning id`, [MERCHANT_1])
      await db.query(`insert into public.role_permissions (merchant_id, role_id, permission_id)
        select $1, $2, p.id from public.permissions p where p.code in ('inbox.view','inbox.reply')`, [MERCHANT_1, roleId])
      const agent = await createStaff(db, 'CHATONLY5')
      const customer = await value<string>(db, `insert into public.customers (merchant_id, full_name, phone) values ($1, 'Dummy Buyer', '01755444333') returning id`, [MERCHANT_1])
      await asService(db, MERCHANT_1)
      const ch = (await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
        [JSON.stringify({ platform: 'FACEBOOK', external_id: '7777777505', name: 'Audit Page 5' })])).id
      const ingest = async (key: string) => (await value<{ conversation_id: string }>(db, `select public.inbox_ingest($1::jsonb)`,
        [JSON.stringify({ channel_id: ch, thread_key: key, customer: { external_id: key, name: 'Someone' }, message: { external_id: `m_${key}`, body: 'hi' } })])).conversation_id
      const mine = await ingest('psid-r5-a')
      const linked = await ingest('psid-r5-b')
      await asSystem(db, MERCHANT_1)
      await db.query(`update public.inbox_conversations set customer_id = $2 where id = $1`, [linked, customer])
      await db.query(`update public.inbox_conversations set customer_phone = '01755444333' where id = $1`, [mine])
      const others = async () => (await value<{ other_conversations: Array<{ id: string }> }>(db, `select public.inbox_thread($1)`, [mine])).other_conversations.map((c) => c.id)
      await asUser(db, agent)
      expect(await others()).not.toContain(linked)
      await asUser(db, await createStaff(db, 'ADMIN'))
      expect(await others()).toContain(linked)
    }))
})
