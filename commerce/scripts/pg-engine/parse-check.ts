// Parses every function body in worker/db/generated/functions.json; prints failures.
import fns from '../../worker/db/generated/functions.json' with { type: 'json' }
import { parseStatements } from '../../worker/db/pg/parse.ts'

const lang = process.argv[2] ?? 'sql'
let ok = 0
let bad = 0
for (const [name, list] of Object.entries(fns as Record<string, Array<{ lang: string; src: string }>>)) {
  for (const f of list) {
    if (f.lang !== lang) continue
    try {
      if (lang === 'sql') parseStatements(f.src)
      else {
        const { parseFunction } = await import('../../worker/db/pg/plparse.ts')
        parseFunction(f.src)
      }
      ok++
    } catch (e) {
      bad++
      if (bad <= Number(process.argv[3] ?? 20)) console.log(`${name}: ${(e as Error).message.slice(0, 220)}`)
    }
  }
}
console.log({ ok, bad })
