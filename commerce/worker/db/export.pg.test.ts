// The switch-over copy against a real Postgres (TEST_DATABASE_URL): every row, the
// accounts and Vault secrets arrive, and the two sides' summaries match.
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase } from '../../supabase/tests/support/db.ts'
import { compareSummaries, exportStatements, loadStatements, sourceSummary, targetSummary, TEXT_TYPE_OIDS } from './export.ts'
import { migrate } from './migrate.ts'
import { nodeSql, type Sql } from './sql.ts'

const textTypes = { getTypeParser: (oid: number, format?: string) => (TEXT_TYPE_OIDS.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text')) }

describe.skipIf(!process.env.TEST_DATABASE_URL)('copy from Supabase', () => {
  let client: pg.Client
  let target: Sql

  beforeAll(async () => {
    client = new pg.Client({ connectionString: await createTestDatabase('commerce_copy', true), types: textTypes })
    await client.connect()
    await client.query(`insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, email_confirmed_at)
      values ('11111111-2222-4333-8444-555555555555', 'Copy.Owner@Example.com', '{"clerk_user_id":"user_copy_owner"}', '{"full_name":"Owner"}', now())`)
    await client.query(`select vault.create_secret('s3cret-value', 'platform:test', 'Platform credentials')`)
    target = nodeSql(new DatabaseSync(':memory:'))
    migrate(target)
  }, 300_000)

  afterAll(async () => { await client?.end() })

  it('copies every row, the accounts and the Vault secrets, and both sides match', async () => {
    await client.query('begin isolation level repeatable read read only')
    const statements = await exportStatements(client, { vault: true })
    const source = await sourceSummary(client, { vault: true })
    await client.query('commit')
    loadStatements(target, statements)
    expect(compareSummaries(source, targetSummary(target, { vault: true }))).toEqual([])
    const orders = source.orders
    expect(orders.rows).toBeGreaterThan(0)
    expect(Number(orders.sums.total_amount)).toBeGreaterThan(0)
    expect(target.all("SELECT email, clerk_user_id FROM users WHERE id = '11111111-2222-4333-8444-555555555555'")[0]).toEqual({ email: 'copy.owner@example.com', clerk_user_id: 'user_copy_owner' })
    expect(target.all("SELECT secret FROM _vault_secrets WHERE name = 'platform:test'")[0].secret).toBe('s3cret-value')
    // the migration's own random cron secret is replaced by the copied one
    expect(target.all("SELECT count(*) AS n FROM _vault_secrets WHERE name = 'cron_secret'")[0].n).toBe(
      Number((await client.query("select count(*)::int as n from vault.secrets where name = 'cron_secret'")).rows[0].n))
    // numbering continues where Supabase stopped
    const seq = (await client.query("select last_value::text as v from pg_sequences where schemaname = 'public' and sequencename = 'order_number_seq'")).rows[0]
    if (seq?.v) expect(target.all("SELECT value FROM _sequences WHERE name = 'order_number_seq'")[0].value).toBe(Number(seq.v))
  }, 300_000)

  it('notices a copy that does not match', async () => {
    const source = await sourceSummary(client, { vault: true })
    target.run("UPDATE orders SET total_amount = total_amount + 1 WHERE rowid = (SELECT min(rowid) FROM orders)")
    target.run("DELETE FROM _vault_secrets WHERE name = 'platform:test'")
    const issues = compareSummaries(source, targetSummary(target, { vault: true }))
    expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(/^orders\.total_amount: total /), expect.stringMatching(/^_vault_secrets: \d+ rows in Supabase/)]))
  })
})
