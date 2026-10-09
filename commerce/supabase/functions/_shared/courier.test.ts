import { describe, expect, it, vi } from 'vitest'
import { mapPathaoStatus, mapRedxStatus, matchByName, PathaoProvider, RedxProvider, SteadfastProvider } from './courier/providers.ts'
import { buildCourierProvider, courierOptions, credentialHint, invalidCredentialFields, itemDescription, missingCredentialFields } from './courier/registry.ts'
import { parse, placeOrderSchema } from './schemas.ts'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const request = {
  orderNumber: 'ISO-2001', recipientName: 'Karim', recipientPhone: '01811000000', recipientAddress: 'House 4, Road 7',
  district: 'Dhaka', area: 'Mirpur', codAmount: 1249.6, itemCount: 2,
}

describe('courier registry', () => {
  it('lists missing fields and masks credentials', () => {
    expect(missingCredentialFields('steadfast', { api_key: 'abc', secret_key: ' ' })).toEqual(['secret_key'])
    expect(missingCredentialFields('redx', { access_token: 't' })).toEqual([])
    expect(credentialHint('steadfast', { api_key: 'key-1234abcd' })).toBe('••••abcd')
    expect(buildCourierProvider('pathao', { client_id: 'c' }).code).toBe('pathao')
    expect(buildCourierProvider('something-else', {}).code).toBe('manual')
  })

  it('takes an optional account login, both parts or neither, and shows only a masked email', () => {
    expect(missingCredentialFields('steadfast', { api_key: 'a', secret_key: 'b' })).toEqual([])
    expect(missingCredentialFields('steadfast', { api_key: 'a', secret_key: 'b', panel_email: 'shop@x.com' })).toEqual(['panel_password'])
    expect(invalidCredentialFields('redx', { access_token: 't', panel_email: 'not-an-email', panel_password: 'p' })).toEqual(['account email'])
    expect(invalidCredentialFields('pathao', { username: 'owner@shop.com' })).toEqual([])
    const hint = credentialHint('steadfast', { api_key: 'key-1234abcd', panel_email: 'rahim@shop.com', panel_password: 'secret-pass' })
    expect(hint).toBe('••••abcd · ra•••@shop.com')
    expect(hint).not.toContain('secret-pass')
  })

  it('matches cities, zones and areas by name', () => {
    const rows = [{ n: 'Dhaka North' }, { n: 'Mirpur' }, { n: 'Mirpur DOHS' }]
    expect(matchByName(rows, (r) => r.n, 'mirpur')?.n).toBe('Mirpur')
    expect(matchByName(rows, (r) => r.n, 'Dhaka')?.n).toBe('Dhaka North')
    expect(matchByName(rows, (r) => r.n, '')).toBeUndefined()
  })
})

describe('Pathao courier provider', () => {
  it('maps statuses', () => {
    expect(mapPathaoStatus('Pickup Requested')).toBe('BOOKED')
    expect(mapPathaoStatus('Assigned for Delivery')).toBe('OUT_FOR_DELIVERY')
    expect(mapPathaoStatus('Delivered')).toBe('DELIVERED')
    expect(mapPathaoStatus('Paid Return')).toBe('RETURNED')
    expect(mapPathaoStatus('Mystery')).toBeNull()
  })

  it('signs in, resolves city and zone, then books the parcel', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: [{ city_id: 1, city_name: 'Dhaka' }, { city_id: 2, city_name: 'Chattogram' }] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: [{ zone_id: 10, zone_name: 'Dhanmondi' }, { zone_id: 11, zone_name: 'Mirpur' }] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { consignment_id: 'DL1234', order_status: 'Pending', delivery_fee: 60 } }))
    const pathao = new PathaoProvider({ clientId: 'cid-unique-1', clientSecret: 's', username: 'u@x.com', password: 'p', storeId: '777' }, fetchFn)
    const created = await pathao.createShipment(request)
    expect(created).toMatchObject({ consignmentId: 'DL1234', trackingNumber: 'DL1234', status: 'BOOKED', cost: 60 })
    expect(fetchFn.mock.calls[0][0]).toBe('https://api-hermes.pathao.com/aladdin/api/v1/issue-token')
    const [url, init] = fetchFn.mock.calls[3]
    expect(url).toBe('https://api-hermes.pathao.com/aladdin/api/v1/orders')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toMatchObject({
      store_id: 777, merchant_order_id: 'ISO-2001', recipient_city: 1, recipient_zone: 11, amount_to_collect: 1250, item_quantity: 2,
    })
  })

  it('explains when no zone matches', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: [{ city_id: 1, city_name: 'Dhaka' }] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: [{ zone_id: 10, zone_name: 'Dhanmondi' }] } }))
    const pathao = new PathaoProvider({ clientId: 'cid-unique-2', clientSecret: 's', username: 'u', password: 'p', storeId: '1', sandbox: true }, fetchFn)
    await expect(pathao.createShipment({ ...request, area: 'Uttara' })).rejects.toThrow(/no zone in Dhaka/)
    expect(fetchFn.mock.calls[0][0]).toContain('courier-api-sandbox.pathao.com')
  })

  it('checks the store id when testing the connection', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: [{ store_id: 5, store_name: 'Main' }] } }))
    const result = await new PathaoProvider({ clientId: 'cid-unique-3', clientSecret: 's', username: 'u', password: 'p', storeId: '9' }, fetchFn).testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/store 9 was not found/)
  })
})

describe('Pathao booking options', () => {
  const signIn = () => jsonResponse({ access_token: 'tok', expires_in: 3600 })
  const cities = () => jsonResponse({ data: { data: [{ city_id: 1, city_name: 'Dhaka' }] } })
  const zones = () => jsonResponse({ data: { data: [{ zone_id: 10, zone_name: 'Dhanmondi' }] } })
  const booked = () => jsonResponse({ data: { consignment_id: 'DL9', order_status: 'Pending' } })

  it('lets Pathao read the address when no zone matches, only when allowed', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(signIn()).mockResolvedValueOnce(cities()).mockResolvedValueOnce(zones()).mockResolvedValueOnce(booked())
    const pathao = new PathaoProvider({ clientId: 'opt-1', clientSecret: 's', username: 'u', password: 'p', storeId: '1', allowWithoutZone: true }, fetchFn)
    await pathao.createShipment({ ...request, area: 'Uttara' })
    const sent = JSON.parse(fetchFn.mock.calls[3][1].body)
    expect(sent).not.toHaveProperty('recipient_city')
    expect(sent).not.toHaveProperty('recipient_zone')
    expect(sent.recipient_address).toContain('Uttara')
  })

  it('never books without a zone when the lookup itself failed', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(signIn()).mockResolvedValueOnce(jsonResponse({ message: 'server error' }, 500))
    const pathao = new PathaoProvider({ clientId: 'opt-2', clientSecret: 's', username: 'u', password: 'p', storeId: '1', allowWithoutZone: true }, fetchFn)
    await expect(pathao.createShipment(request)).rejects.toThrow(/server error/)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('uses the store picked for the order, the item type, product names, and the weight switch', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(signIn()).mockResolvedValueOnce(cities()).mockResolvedValueOnce(zones()).mockResolvedValueOnce(booked())
    const pathao = new PathaoProvider({ clientId: 'opt-3', clientSecret: 's', username: 'u', password: 'p', storeId: '1', itemType: 1, sendWeight: false }, fetchFn)
    await pathao.createShipment({ ...request, area: 'Dhanmondi', storeId: '55', weightGrams: 3000, itemDescription: '2× Tote' })
    expect(JSON.parse(fetchFn.mock.calls[3][1].body)).toMatchObject({ store_id: 55, item_type: 1, item_weight: 0.5, item_description: '2× Tote', recipient_zone: 10 })
  })

  it('asks for a pickup store before booking', async () => {
    const pathao = new PathaoProvider({ clientId: 'opt-4', clientSecret: 's', username: 'u', password: 'p', storeId: '' }, vi.fn())
    await expect(pathao.createShipment(request)).rejects.toThrow(/choose a pickup store/)
  })

  it('lists the pickup stores and connects without one chosen yet', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(signIn())
      .mockResolvedValueOnce(jsonResponse({ data: { data: [{ store_id: 5, store_name: 'Main', store_address: 'Mirpur', is_active: 1 }, { store_id: 6, store_name: 'Old', is_active: 0 }] } }))
    const pathao = new PathaoProvider({ clientId: 'opt-5', clientSecret: 's', username: 'u', password: 'p', storeId: '' }, fetchFn)
    expect(await pathao.listStores()).toEqual([
      { id: '5', name: 'Main', address: 'Mirpur', active: true }, { id: '6', name: 'Old', address: null, active: false }])
  })

  it('reads options from the courier settings and builds the item text', () => {
    expect(missingCredentialFields('pathao', { client_id: 'a', client_secret: 'b', username: 'u@x.com', password: 'p' })).toEqual([])
    expect(courierOptions({ store_id: '5', credential_hint: '••••', default_note: '', send_weight: false })).toEqual({ store_id: '5', send_weight: false })
    expect(itemDescription([{ quantity: 2, product_name: 'Canvas Tote' }, { quantity: 1, product_name: ' Cap ' }])).toBe('2× Canvas Tote, 1× Cap')
    expect(itemDescription([{ quantity: 1, product_name: 'x'.repeat(300) }])!.length).toBe(200)
    expect(itemDescription([])).toBeNull()
  })

  it('sends product names to Steadfast as the item description', () => {
    const body = new SteadfastProvider({ apiKey: 'k', secretKey: 's' }).buildOrder({ ...request, itemDescription: '1× Cap', note: 'Call first' })
    expect(body).toMatchObject({ item_description: '1× Cap', note: 'Call first' })
  })
})

describe('RedX courier provider', () => {
  it('maps statuses', () => {
    expect(mapRedxStatus('delivery-in-progress')).toBe('OUT_FOR_DELIVERY')
    expect(mapRedxStatus('agent-returning')).toBe('RETURNING')
    expect(mapRedxStatus('Delivered')).toBe('DELIVERED')
  })

  it('finds the delivery area and creates the parcel', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ areas: [{ id: 1, name: 'Dhanmondi' }, { id: 2, name: 'Mirpur 10' }] }))
      .mockResolvedValueOnce(jsonResponse({ tracking_id: '21A427TU4BN3R' }))
    const redx = new RedxProvider({ accessToken: 'Bearer abc' }, fetchFn)
    const created = await redx.createShipment(request)
    expect(created).toMatchObject({ trackingNumber: '21A427TU4BN3R', status: 'BOOKED' })
    expect(fetchFn.mock.calls[0][0]).toBe('https://openapi.redx.com.bd/v1.0.0-beta/areas?district_name=Dhaka')
    const [, init] = fetchFn.mock.calls[1]
    expect(init.headers['API-ACCESS-TOKEN']).toBe('Bearer abc')
    expect(JSON.parse(init.body)).toMatchObject({ delivery_area_id: 2, merchant_invoice_id: 'ISO-2001', cash_collection_amount: '1250' })
  })
})

describe('checkout advance payment payload', () => {
  const base = {
    action: 'place',
    customer: { full_name: 'Rahim Uddin', phone: '01711000000', email: '' },
    shipping: { address: 'House 1, Road 2', district: 'Dhaka' },
    items: [{ variant_id: '7b4f8d4e-8f1a-4d39-9a1c-2f7a3b9c1d2e', quantity: 1 }],
    idempotency_key: 'abcdef123456',
  }

  it('accepts a bKash / Nagad advance and rejects other channels', () => {
    const ok = parse(placeOrderSchema, { ...base, advance_payment: { channel: 'NAGAD', sender_phone: '01811000000', transaction_id: '8N7A6B5C' } })
    expect(ok.advance_payment?.channel).toBe('NAGAD')
    expect(() => parse(placeOrderSchema, { ...base, advance_payment: { channel: 'CARD', sender_phone: '01811000000', transaction_id: '8N7A6B5C' } })).toThrow()
    expect(() => parse(placeOrderSchema, { ...base, advance_payment: { channel: 'BKASH', sender_phone: '01811000000', transaction_id: '12' } })).toThrow()
  })
})
