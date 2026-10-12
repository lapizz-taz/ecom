// Runs SQL against a fresh Cloudflare test database (debugging the engine):
//   npx jiti scripts/pg-engine/try.ts "select …" '[params]'
import { asSystem, inTx } from '../../worker/db/pgshim/db.ts'

const [sql, params] = [process.argv[2], JSON.parse(process.argv[3] ?? '[]')]
await inTx(async (db) => {
  await asSystem(db)
  for (const st of sql.split(/;\s*\n/)) {
    if (!st.trim()) continue
    const res = await db.query(st, params)
    console.log(JSON.stringify(res.rows, null, 1))
  }
})
