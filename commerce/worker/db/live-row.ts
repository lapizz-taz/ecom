// One changed row as a live-update subscriber may read it (database.ts sends it, realtime.ts).
import type { Context } from './context.ts'
import { readableColumns } from './policy.ts'
import { handleRest } from './rest/index.ts'
import type { Sql } from './sql.ts'

/**
 * The row through row security, with only the columns the subscriber may read, as Supabase
 * Realtime sends it. Staff read some tables column by column (an order's cost is hidden from
 * them): there a plain select=* is refused, and no new order or order change reached the pages.
 */
export function liveRow(sql: Sql, ctx: Context, table: string, search: string): Record<string, unknown> | null {
  const columns = readableColumns(table, ctx)
  const query = columns ? search.replace(/^select=\*(?=&|$)/, `select=${[...columns].join(',')}`) : search
  const res = handleRest(sql, ctx, { method: 'GET', path: table, search: query, headers: {}, body: null })
  if (res.status !== 200 || !res.body) return null
  return (JSON.parse(res.body) as Array<Record<string, unknown>>)[0] ?? null
}
