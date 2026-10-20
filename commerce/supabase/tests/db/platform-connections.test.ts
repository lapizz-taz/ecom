// What Super Admin connects is what merchants see: the platform SMS account and the
// gateways merchants pay the platform through. The provider account itself never
// reaches a merchant, and only the server (after testing the keys) may connect one.
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff } from '../support/fixtures'

afterAll(closePool)

const asStaff = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

async function newMerchant(db: Db, superId: string): Promise<{ id: string; owner: string }> {
  await asStaff(db, superId)
  const created = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name: `Shop ${randomUUID().slice(0, 6)}` })])
  await asSystem(db, null)
  const owner = randomUUID()
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [owner, `owner-${owner.slice(0, 6)}@shop.example`])
  await asStaff(db, superId)
  await db.query(`select public.platform_merchant_set_owner($1, $2, 'Shop Owner')`, [created.id, owner])
  return { id: created.id, owner }
}

const asOwner = (db: Db, m: { id: string; owner: string }) => asUser(db, m.owner, 'owner@shop.example', m.id)

type SmsSettings = { connected: boolean; sender_id: string; provided_by_platform: boolean }
const merchantSms = async (db: Db, m: { id: string; owner: string }) => {
  await asOwner(db, m)
  const o = await value<{ settings: SmsSettings }>(db, `select public.sms_overview(current_date, current_date)`)
  return o.settings
}

describe('platform connections reach the merchant screens', () => {
  it('an SMS account connected in Super Admin shows as connected to merchants, without the account itself', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asService(db, null)
      await db.query(`select public.platform_sms_set_connection(null, null, null, null, $1)`, [superId])
      expect((await merchantSms(db, m)).connected).toBe(false)

      // What the function does after the provider accepted the keys.
      await asService(db, null)
      await db.query(`select public.platform_sms_set_connection('smsnetbd', 'key ••••9f31', 'FULLFILIO', 120, $1)`, [superId])
      const seen = await merchantSms(db, m)
      expect(seen).toMatchObject({ connected: true, provided_by_platform: true, sender_id: 'FULLFILIO' })
      const whole = JSON.stringify(await value(db, `select public.sms_overview(current_date, current_date)`))
      expect(whole).not.toMatch(/smsnetbd|9f31/)

      await asStaff(db, superId)
      const platform = await value<{ platform: { sms: { connected: boolean; provider: string; balance: number } } }>(db, `select public.platform_integrations_overview()`)
      expect(platform.platform.sms).toMatchObject({ connected: true, provider: 'smsnetbd', balance: 120 })

      // Nobody connects an account without the server having tested the keys: not staff, not a merchant.
      await expectError(db, `select public.platform_sms_set_connection('bulksmsbd', 'x', 'X', null, $1)`, [superId], /PERMISSION_DENIED|permission denied/)
      await asOwner(db, m)
      await expectError(db, `select public.platform_sms_set_connection('bulksmsbd', 'x', 'X', null, $1)`, [m.owner], /PERMISSION_DENIED|permission denied/)

      await asService(db, null)
      await db.query(`select public.platform_sms_set_connection(null, null, null, null, $1)`, [superId])
      expect((await merchantSms(db, m)).connected).toBe(false)
    }))

  it('a payment gateway connected for the platform appears in the merchant wallet, and switching it off removes it', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      const walletGateways = async () => {
        await asOwner(db, m)
        return (await value<{ gateways: string[] }>(db, `select public.my_credits()`)).gateways
      }
      await asService(db, null)
      await db.query(`select public.platform_billing_gateway_set('bkash', false, null, true, $1)`, [superId])
      await db.query(`select public.platform_billing_gateway_set('paystation', false, null, true, $1)`, [superId])
      await db.query(`select public.platform_billing_gateway_set('sslcommerz', false, null, true, $1)`, [superId])
      expect(await walletGateways()).toEqual([])

      // Super Admin cannot switch on a gateway whose account was never connected.
      await asStaff(db, superId)
      await expectError(db, `select public.platform_billing_gateway_toggle('bkash', true)`, [], /connect the gateway account first/)

      // After the billing function verified the credentials.
      await asService(db, null)
      await db.query(`select public.platform_billing_gateway_set('bkash', true, 'app ••••77', true, $1)`, [superId])
      expect(await walletGateways()).toEqual(['bkash'])
      await asStaff(db, superId)
      const platform = await value<{ platform: { billing_gateways: Record<string, { connected: boolean; enabled: boolean }> } }>(db, `select public.platform_integrations_overview()`)
      expect(platform.platform.billing_gateways.bkash).toMatchObject({ connected: true, enabled: true })

      await db.query(`select public.platform_billing_gateway_toggle('bkash', false)`)
      expect(await walletGateways()).toEqual([])

      // SSLCommerz, for paying the platform by card, mobile or internet banking.
      await asService(db, null)
      await db.query(`select public.platform_billing_gateway_set('sslcommerz', true, 'store ••••01', false, $1)`, [superId])
      expect(await walletGateways()).toEqual(['sslcommerz'])
      await asOwner(db, m)
      expect((await value<{ gateways: string[] }>(db, `select public.my_billing()`)).gateways).toEqual(['sslcommerz'])
      await asService(db, null)
      await expectError(db, `select public.platform_billing_gateway_set('nagad', true, 'x', false, $1)`, [superId], /unknown gateway/)

      // A merchant can neither connect nor switch gateways.
      await asOwner(db, m)
      await expectError(db, `select public.platform_billing_gateway_set('paystation', true, 'x', false, $1)`, [m.owner], /PERMISSION_DENIED|permission denied/)
      await expectError(db, `select public.platform_billing_gateway_toggle('bkash', true)`, [], /PERMISSION_DENIED|permission denied|platform/i)
    }))
})
