import { beforeAll, describe, expect, it } from 'vitest'
import { decode, encode, roundTo, toTimestamp } from './codec.ts'
import { callRpc } from './rpc/index.ts'
import type { Sql } from './sql.ts'
import { asAnon, asService, asUser, createMerchant, createStaff, freshDatabase, MERCHANT_1, rest, rolledBack } from './testing.ts'

let sql: Sql
beforeAll(() => {
  sql = freshDatabase()
})

describe('values', () => {
  it('stores timestamps as UTC ISO text and rejects impossible ones', () => {
    expect(toTimestamp('2026-10-12 10:00:00+06')).toBe('2026-10-12T04:00:00.000Z')
    expect(toTimestamp('2026-10-12T04:00:00.123456+00:00')).toBe('2026-10-12T04:00:00.123Z')
    expect(toTimestamp('2026-10-12')).toBe('2026-10-12T00:00:00.000Z')
    expect(() => toTimestamp('2026-02-30')).toThrow(/timestamp/)
  })

  it('rounds money like Postgres numeric and converts booleans, JSON and lists', () => {
    expect(roundTo(1.005, 2)).toBe(1.01)
    expect(roundTo(-2.5, 0)).toBe(-3)
    expect(encode('12.345', { type: 'numeric', scale: 2 })).toBe(12.35)
    expect(encode(true, { type: 'bool' })).toBe(1)
    expect(decode(0, { type: 'bool' })).toBe(false)
    expect(encode({ a: 1 }, { type: 'json' })).toBe('{"a":1}')
    expect(encode('{a,"b c"}', { type: 'array', elem: 'text' })).toBe('["a","b c"]')
    expect(() => encode('nope', { type: 'uuid' })).toThrow(/uuid/)
    expect(() => encode('PENDINGX', { type: 'enum', values: ['PENDING'] })).toThrow(/enum/)
  })
})

describe('schema', () => {
  it('has every table and the reference data of the Postgres migrations', () => {
    expect(Number(sql.all("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> 'sqlite_sequence'")[0].n)).toBe(207) // the migrations' tables + sessions (stands in for auth.sessions)
    expect(Number(sql.all('SELECT count(*) AS n FROM permissions')[0].n)).toBeGreaterThan(40)
    expect(sql.all('SELECT code FROM roles WHERE merchant_id = ? ORDER BY rank DESC LIMIT 1', [MERCHANT_1])[0].code).toBe('OWNER')
  })

  it('keeps permanent records permanent and updated_at current', () => rolledBack(sql, () => {
    const order = sql.all("SELECT id FROM roles WHERE code = 'ADMIN' AND merchant_id = ?", [MERCHANT_1])[0].id as string
    const before = sql.all('SELECT updated_at FROM roles WHERE id = ?', [order])[0].updated_at
    sql.run("UPDATE roles SET description = 'changed', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [order])
    sql.run("UPDATE roles SET description = 'changed again' WHERE id = ?", [order])
    expect(sql.all('SELECT updated_at FROM roles WHERE id = ?', [order])[0].updated_at).not.toBe('2000-01-01T00:00:00.000Z')
    expect(before).toMatch(/Z$/)
    const audit = sql.all('SELECT id FROM audit_logs LIMIT 1')[0]
    if (audit) {
      expect(() => sql.run('DELETE FROM audit_logs WHERE id = ?', [audit.id as string])).toThrow(/IMMUTABLE_RECORD: audit_logs rows cannot be deleted/)
      expect(() => sql.run("UPDATE audit_logs SET action = 'x' WHERE id = ?", [audit.id as string])).toThrow(/IMMUTABLE_RECORD/)
    }
  }))
})

describe('rest api', () => {
  it('reads, filters, orders, pages and counts like PostgREST', () => rolledBack(sql, () => {
    const owner = createStaff(sql, 'OWNER')
    const me = asUser(sql, owner)
    for (const [i, name] of ['Shirts', 'Pants', 'Hats', 'Shoes'].entries()) {
      expect(rest(sql, me, 'POST', 'categories', { body: { name, slug: name.toLowerCase(), sort_order: i } }).status).toBe(201)
    }
    const page = rest(sql, me, 'GET', 'categories?select=name,slug&name=neq.Hats&order=sort_order.desc&limit=2', { prefer: 'count=exact' })
    expect(page.status).toBe(200)
    expect(page.body).toEqual([{ name: 'Shoes', slug: 'shoes' }, { name: 'Pants', slug: 'pants' }])
    expect(page.headers['Content-Range']).toBe('0-1/3')
    const like = rest(sql, me, 'GET', 'categories?select=name&or=(name.ilike.*sh*,slug.eq.hats)&order=name')
    expect(like.body).toEqual([{ name: 'Hats' }, { name: 'Shirts' }, { name: 'Shoes' }])
    const caseSensitive = rest(sql, me, 'GET', 'categories?select=name&name=like.sh*')
    expect(caseSensitive.body).toEqual([])
    expect(rest(sql, me, 'GET', 'categories?select=name&name=like.Sh_es').body).toEqual([{ name: 'Shoes' }])
    expect(rest(sql, me, 'GET', 'categories?select=name&name=ilike.*ANTS').body).toEqual([{ name: 'Pants' }])
    const long = `*${'x'.repeat(80)}*`
    expect(rest(sql, me, 'GET', `categories?select=name&name=ilike.${long}`).body).toEqual([])
    const inList = rest(sql, me, 'GET', 'categories?select=slug&slug=in.(hats,"pants")&order=slug')
    expect(inList.body).toEqual([{ slug: 'hats' }, { slug: 'pants' }])
    const one = rest(sql, me, 'GET', 'categories?select=name&slug=eq.hats', { accept: 'application/vnd.pgrst.object+json' })
    expect(one.body).toEqual({ name: 'Hats' })
    const none = rest(sql, me, 'GET', 'categories?select=name&slug=eq.nothing', { accept: 'application/vnd.pgrst.object+json' })
    expect(none.status).toBe(406)
    expect((none.body as { code: string }).code).toBe('PGRST116')
  }))

  it('fills the store and numbered defaults, and returns the new row', () => rolledBack(sql, () => {
    const owner = createStaff(sql, 'OWNER')
    const res = rest(sql, asUser(sql, owner), 'POST', 'suppliers?select=id,name,merchant_id,is_active', {
      body: { name: 'Dhaka Textiles' }, prefer: 'return=representation', accept: 'application/vnd.pgrst.object+json',
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: 'Dhaka Textiles', merchant_id: MERCHANT_1, is_active: true })
  }))

  it('keeps every store\'s rows apart, both ways', () => rolledBack(sql, () => {
    const other = createMerchant(sql)
    const mine = createStaff(sql, 'OWNER')
    const theirs = createStaff(sql, 'OWNER', other)
    expect(rest(sql, asUser(sql, mine), 'POST', 'suppliers', { body: { name: 'Mine only' } }).status).toBe(201)
    expect(rest(sql, asUser(sql, theirs), 'POST', 'suppliers', { body: { name: 'Theirs only' } }).status).toBe(201)
    const seenByMe = rest(sql, asUser(sql, mine), 'GET', 'suppliers?select=name').body as Array<{ name: string }>
    const seenByThem = rest(sql, asUser(sql, theirs), 'GET', 'suppliers?select=name').body as Array<{ name: string }>
    expect(seenByMe.map((s) => s.name)).toContain('Mine only')
    expect(seenByMe.map((s) => s.name)).not.toContain('Theirs only')
    expect(seenByThem.map((s) => s.name)).toEqual(['Theirs only'])
    // Writing into another store, or changing its rows, is refused or reaches nothing.
    const sneak = rest(sql, asUser(sql, mine), 'POST', 'suppliers', { body: { name: 'Sneaky', merchant_id: other } })
    expect(sneak.status).toBe(403)
    expect((sneak.body as { code: string }).code).toBe('42501')
    const theirRow = sql.all("SELECT id FROM suppliers WHERE name = 'Theirs only'")[0].id as string
    const patch = rest(sql, asUser(sql, mine), 'PATCH', `suppliers?id=eq.${theirRow}`, { body: { name: 'Hijacked' }, prefer: 'return=representation' })
    expect(patch.body).toEqual([])
    expect(sql.all('SELECT name FROM suppliers WHERE id = ?', [theirRow])[0].name).toBe('Theirs only')
    const del = rest(sql, asUser(sql, mine), 'DELETE', `suppliers?id=eq.${theirRow}`, { prefer: 'return=representation' })
    expect(del.body).toEqual([])
    // A visitor's x-merchant-id header does not open staff tables.
    expect(rest(sql, asAnon(sql, other), 'GET', 'suppliers?select=name').body).toEqual([])
  }))

  it('enforces permissions on the server, not just in the page', () => rolledBack(sql, () => {
    const viewer = createStaff(sql, 'VIEWER')
    const res = rest(sql, asUser(sql, viewer), 'POST', 'suppliers', { body: { name: 'Not allowed' } })
    expect(res.status).toBe(403)
    expect(rest(sql, asUser(sql, viewer), 'GET', 'coupons?select=code').body).toEqual([])
  }))

  it('checks rules SQLite cannot (patterns) and runs the business triggers', () => rolledBack(sql, () => {
    const owner = createStaff(sql, 'OWNER')
    const bad = rest(sql, asUser(sql, owner), 'POST', 'categories', { body: { name: 'Bad slug', slug: 'Not A Slug' } })
    expect(bad.status).toBe(400)
    expect((bad.body as { code: string; message: string })).toMatchObject({ code: '23514', message: expect.stringContaining('categories_slug_check') })
    // coupons' trigger (as written in the migrations) zeroes the usage counter a person sends …
    const coupon = rest(sql, asUser(sql, owner), 'POST', 'coupons', {
      body: { code: 'SAVE10', discount_type: 'FIXED', discount_value: 10, usage_count: 50 }, prefer: 'return=representation',
    })
    expect(coupon.status).toBe(201)
    const [row] = coupon.body as Array<{ id: string; usage_count: number; created_by: string }>
    expect(row).toMatchObject({ usage_count: 0, created_by: owner })
    // … and refuses edits to it.
    const edit = rest(sql, asUser(sql, owner), 'PATCH', `coupons?id=eq.${row.id}`, { body: { usage_count: 3 } })
    expect(edit.status).toBe(400)
    expect((edit.body as { message: string }).message).toMatch(/counted automatically/)
  }))

  it('embeds related rows: to-one objects, to-many arrays, inner joins and per-parent order', () => rolledBack(sql, () => {
    const owner = createStaff(sql, 'OWNER')
    const me = asUser(sql, owner)
    const roles = rest(sql, me, 'GET', 'roles?select=code,role_permissions(permissions(code))&code=eq.VIEWER', { accept: 'application/vnd.pgrst.object+json' })
    expect(roles.status).toBe(200)
    const body = roles.body as { code: string; role_permissions: Array<{ permissions: { code: string } }> }
    expect(body.code).toBe('VIEWER')
    expect(body.role_permissions.length).toBeGreaterThan(0)
    expect(typeof body.role_permissions[0].permissions.code).toBe('string')
    const profiles = rest(sql, me, 'GET', `profiles?select=email,roles!inner(code)&roles.code=eq.OWNER&id=eq.${owner}`)
    expect(profiles.body).toEqual([{ email: expect.stringMatching(/@example.com$/), roles: { code: 'OWNER' } }])
    const noAdmins = rest(sql, me, 'GET', `profiles?select=email,roles!inner(code)&roles.code=eq.ADMIN&id=eq.${owner}`)
    expect(noAdmins.body).toEqual([])
  }))

  it('requires a filter to change or delete rows', () => rolledBack(sql, () => {
    const owner = createStaff(sql, 'OWNER')
    expect((rest(sql, asUser(sql, owner), 'DELETE', 'suppliers').body as { code: string }).code).toBe('21000')
  }))

  it('lets the service role act for one store', () => rolledBack(sql, () => {
    const res = rest(sql, asService(sql), 'POST', 'suppliers?select=merchant_id', { body: { name: 'From a webhook' }, prefer: 'return=representation' })
    expect(res.body).toEqual([{ merchant_id: MERCHANT_1 }])
  }))
})

describe('sign-in functions', () => {
  it('get_my_access returns the role and permissions; device_register approves the first device', () => rolledBack(sql, () => {
    const admin = createStaff(sql, 'ADMIN')
    const session = '11111111-2222-4333-8444-555555555555'
    const me = asUser(sql, admin, { sessionId: session, userAgent: 'Test browser', ip: '203.0.113.9' })
    const device = callRpc(sql, me, 'device_register', { p_token: 'x'.repeat(40), p_label: 'Laptop' }) as { status: string; required: boolean }
    expect(device).toMatchObject({ status: 'APPROVED', required: false })
    const access = callRpc(sql, asUser(sql, admin, { sessionId: session }), 'get_my_access', {}) as Record<string, unknown>
    expect(access).toMatchObject({ user_id: admin, merchant_id: MERCHANT_1, role: 'ADMIN', device_blocked: false, access_mode: expect.any(String) })
    expect((access.permissions as string[]).length).toBeGreaterThan(5)
    expect(callRpc(sql, asUser(sql, '99999999-9999-4999-8999-999999999999'), 'get_my_access', {})).toBeNull()
    expect(() => callRpc(sql, asAnon(sql), 'get_my_access', {})).toThrow(/permission denied/)
  }))

  it('refuses functions a role may not call and unknown arguments', () => {
    expect(() => callRpc(sql, asAnon(sql), 'find_auth_user_id', { p_email: 'a@b.c' })).toThrow(/permission denied/)
    expect(() => callRpc(sql, asService(sql), 'get_my_access', { nope: 1 })).toThrow(/Could not find the function/)
  })
})
