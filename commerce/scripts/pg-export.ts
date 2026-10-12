// Copies every row of a Postgres database (with the Supabase migrations applied) into
// SQL for the Cloudflare database, converting each value the way the Worker's data
// layer stores it. Used for the reference data new databases start with, and for
// the one-time copy of the live data at the switch-over.
//
//   npx jiti scripts/pg-export.ts <postgres-url> <out.sql>          all rows
//   npx jiti scripts/pg-export.ts --seed <out.sql>                    reference data of a fresh migrated database
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { exportStatements, TEXT_TYPE_OIDS } from '../worker/db/export.ts'
import { createTestDatabase } from '../supabase/tests/support/db.ts'

// Dates, times, timestamps, bigint and numeric as Postgres prints them (the codec parses them).
for (const oid of TEXT_TYPE_OIDS) pg.types.setTypeParser(oid, (v: string) => v)

export async function exportDatabase(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return `-- Rows copied from Postgres by scripts/pg-export.ts.\n${(await exportStatements(client)).join('\n')}\n`
  } finally {
    await client.end()
  }
}

const args = process.argv.slice(2)
if (args[0] === '--seed') {
  const url = await createTestDatabase('commerce_seed')
  writeFileSync(args[1], await exportDatabase(url))
  console.log(`reference data written to ${args[1]}`)
} else if (args.length === 2) {
  writeFileSync(args[1], await exportDatabase(args[0]))
  console.log(`rows written to ${args[1]}`)
} else {
  console.error('usage: pg-export.ts <postgres-url> <out.sql> | --seed <out.sql>')
  process.exit(1)
}
