// Database errors in the shape the app already understands (PostgREST / Postgres):
// { code, message, details, hint } with the same SQLSTATE codes. Business rules
// raise "CODE: message" exactly like the Postgres functions did.

export class DbError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: string | null = null,
    public readonly hint: string | null = null,
    public readonly status = statusFor(code),
  ) {
    super(message)
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details, hint: this.hint }
  }
}

/** HTTP status PostgREST uses for a SQLSTATE. */
export function statusFor(code: string): number {
  if (code === '42501') return 403
  if (code === 'PGRST301' || code === 'PGRST302') return 401
  if (code === '23505' || code === '23503') return 409
  if (code === 'PGRST116') return 406
  if (code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205') return 404
  if (code === 'PT500' || code === 'XX000') return 500
  if (code === '40001') return 409
  if (code === '54000') return 400
  return 400
}

/** RAISE EXCEPTION 'CODE: message' USING errcode = … */
export function raise(message: string, code = 'P0001', details: string | null = null): never {
  throw new DbError(code, message, details)
}

export const permissionDenied = (what: string): never => raise(`permission denied for ${what}`, '42501')

/** Turns a SQLite error into the Postgres error the app expects. */
export function fromSqlite(e: unknown, names?: { unique?: (table: string, columns: string[]) => string | undefined }): DbError {
  if (e instanceof DbError) return e
  // Durable Object errors end in ": SQLITE_CONSTRAINT (extended: …)".
  const message = (e instanceof Error ? e.message : String(e)).replace(/: SQLITE_[A-Z_]+(?: \(extended: [A-Z_]+\))?$/, '')
  // RAISE(ABORT, 'CODE: message') from the permanent-record and other rule triggers.
  const raised = /^([A-Z][A-Z0-9_]+): (.+)$/s.exec(message)
  if (raised && !/^(UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint/.test(message)) return new DbError('P0001', message)
  let m = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/.exec(message)
  if (m) {
    const cols = m[1].split(', ').map((c) => c.split('.'))
    const table = cols[0][0]
    const name = names?.unique?.(table, cols.map((c) => c[1])) ?? `${table}_${cols.map((c) => c[1]).join('_')}_key`
    return new DbError('23505', `duplicate key value violates unique constraint "${name}"`, `Key (${cols.map((c) => c[1]).join(', ')}) already exists.`)
  }
  if (/PRIMARY KEY must be unique|UNIQUE constraint failed: index/i.test(message)) return new DbError('23505', 'duplicate key value violates unique constraint')
  if (/FOREIGN KEY constraint failed/.test(message)) return new DbError('23503', 'insert, update or delete violates foreign key constraint')
  m = /NOT NULL constraint failed: (\w+)\.(\w+)/.exec(message)
  if (m) return new DbError('23502', `null value in column "${m[2]}" of relation "${m[1]}" violates not-null constraint`)
  m = /CHECK constraint failed: (\w+)/.exec(message)
  if (m) return new DbError('23514', `new row violates check constraint "${m[1]}"`)
  if (/CHECK constraint failed/.test(message)) return new DbError('23514', 'new row violates a check constraint')
  if (/cannot store \w+ value in \w+ column/.test(message)) return new DbError('22P02', 'invalid input value')
  m = /no such table: (\w+)/.exec(message)
  if (m) return new DbError('42P01', `relation "${m[1]}" does not exist`)
  m = /no such column: ([\w.]+)/.exec(message)
  if (m) return new DbError('42703', `column ${m[1]} does not exist`)
  if (/SQLITE_TOOBIG|string or blob too big/i.test(message)) return new DbError('54000', 'value too large')
  return new DbError('XX000', 'Database error', message)
}
