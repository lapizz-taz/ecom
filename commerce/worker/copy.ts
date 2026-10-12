// The switch-over copy: the live data from Supabase into the Cloudflare database, done by
// the Worker itself (Supabase → Worker → Database Durable Object), so the data passes
// through nobody's computer. Vault secrets come along machine to machine.
//
// It runs on the next scheduled minute after COPY_FROM_SUPABASE is set to a new value
// (any word, e.g. "trial-1"), once per value, and only while the site still runs on
// Supabase (DATABASE_BACKEND is not "cloudflare"): a copy never overwrites a live
// Cloudflare database. SUPABASE_DB_URL is the Postgres connection string (a secret).
//
// It reads one consistent snapshot, replaces the Cloudflare database with it, then
// compares both sides (rows per table and money totals). The result, counts only, goes
// into Supabase's system log (source "cloudflare-copy"), where it can be checked.
import pg from 'pg'
import type { Database } from './db/database.ts'
import { compareSummaries, exportStatements, sourceSummary, TEXT_TYPE_OIDS } from './db/export.ts'

export interface CopyEnv {
  DATABASE?: DurableObjectNamespace<Database>
  DATABASE_BACKEND?: string
  /** Postgres connection string of the Supabase database (Project Settings → Database). */
  SUPABASE_DB_URL?: string
  /** Set to a new value to run one copy. */
  COPY_FROM_SUPABASE?: string
}

export interface CopyReport {
  token: string
  ok: boolean
  tables: number
  rows: number
  accounts: number
  secrets: number
  seconds: number
  issues: string[]
}

const textTypes = {
  getTypeParser: (oid: number, format?: string) => (TEXT_TYPE_OIDS.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text')),
}

/** Runs the copy for COPY_FROM_SUPABASE if it has not run yet; null when there is nothing to do. */
export async function copyOnce(env: CopyEnv): Promise<CopyReport | null> {
  const token = env.COPY_FROM_SUPABASE?.trim()
  if (!token || !env.SUPABASE_DB_URL || !env.DATABASE) return null
  if (env.DATABASE_BACKEND === 'cloudflare') return null
  const ns = env.DATABASE
  const db = ns.get(ns.idFromName('main'), { locationHint: 'apac' })
  if (!(await db.copyBegin(token))) return null
  const started = Date.now()
  const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, types: textTypes })
  let report: CopyReport | null = null
  try {
    await client.connect()
    await client.query('begin isolation level repeatable read read only')
    const statements = await exportStatements(client, { vault: true })
    const source = await sourceSummary(client, { vault: true })
    await client.query('commit')
    const target = await db.copyLoad(statements)
    const issues = compareSummaries(source, target)
    report = {
      token, ok: issues.length === 0, tables: Object.keys(source).length,
      rows: Object.values(source).reduce((n, t) => n + t.rows, 0),
      accounts: source.users?.rows ?? 0, secrets: source._vault_secrets?.rows ?? 0,
      seconds: Math.round((Date.now() - started) / 1000), issues: issues.slice(0, 50),
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    report = { token, ok: false, tables: 0, rows: 0, accounts: 0, secrets: 0, seconds: Math.round((Date.now() - started) / 1000), issues: [`copy failed: ${message.slice(0, 500)}`] }
  } finally {
    await db.copyEnd(token, report?.ok ?? false, report?.issues ?? [])
    try {
      if (report) {
        // Counts only. Written in its own read-write transaction (Supabase may be read-only for the switch).
        await client.query('begin read write')
        await client.query(`insert into public.system_logs (level, category, source, message, context) values ($1, 'JOB', 'cloudflare-copy', $2, $3::jsonb)`, [
          report.ok ? 'INFO' : 'ERROR',
          report.ok ? `Copy "${token}" to Cloudflare matches: ${report.rows} rows in ${report.tables} tables` : `Copy "${token}" to Cloudflare does not match yet`,
          JSON.stringify(report),
        ])
        await client.query('commit')
      }
    } catch (e) {
      console.error('could not log the copy report:', e instanceof Error ? e.message : e)
    } finally {
      await client.end().catch(() => undefined)
    }
  }
  console.log('copy from Supabase:', JSON.stringify(report))
  return report
}
