// A minimal Worker for checking the Cloudflare database in the real runtime
// (scripts/db-e2e.mjs): the Database Durable Object behind the same gateway the site uses.
import { Database as Base, type Caller } from '../database.ts'
import { database, type DbEnv } from '../gateway.ts'

/** The database with one extra call to load test data. */
export class Database extends Base {
  async seed(script: string): Promise<{ tables: number; roles: number }> {
    // One INSERT per line (scripts/pg-export.ts).
    const lines = script.split('\n').filter((l) => /^(INSERT|UPDATE|PRAGMA) /.test(l))
    this.sql.transaction(() => {
      for (const line of lines) {
        try {
          this.sql.script(line)
        } catch (e) {
          throw new Error(`${(e as { details?: string }).details ?? (e as Error).message} in ${line.slice(0, 160)}`)
        }
      }
    })
    return {
      tables: Number(this.sql.all("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")[0].n),
      roles: Number(this.sql.all('SELECT count(*) AS n FROM roles')[0].n),
    }
  }
}

export default {
  async fetch(req: Request, env: DbEnv): Promise<Response> {
    const ns = env.DATABASE as unknown as DurableObjectNamespace<Database>
    if (new URL(req.url).pathname === '/__seed') return Response.json(await ns.get(ns.idFromName('main')).seed(await req.text()))
    // A request as an already verified Clerk session (signing real Clerk tokens needs Clerk's keys).
    if (new URL(req.url).pathname === '/__as') {
      const { caller, path } = await req.json() as { caller: Caller; path: string }
      const res = await ns.get(ns.idFromName('main')).rest({ method: 'GET', path, search: '', headers: {}, body: null }, caller)
      return new Response(res.body, { status: res.status })
    }
    return database(req, env)
  },
} satisfies ExportedHandler<DbEnv>
