// Schema versions of the Cloudflare database. 0001 is the schema converted from the
// Supabase migrations; later changes are added here as new numbered entries and run
// once, in order, inside a transaction.
import schema from './generated/schema.ts'
import type { Sql } from './sql.ts'

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const UUID = "lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',1+(abs(random())%4),1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))"

export const migrations: Array<{ name: string; sql: readonly string[] }> = [
  { name: '0001_initial', sql: schema },
  // supabase/migrations/20261007000200_cron_secret.sql: the shared secret scheduled calls present,
  // made once per database (one copied from Supabase at the switch-over is kept).
  { name: '0002_cron_secret', sql: [`INSERT INTO _vault_secrets (id, name, description, secret)
    SELECT ${UUID}, 'cron_secret', 'Authenticates scheduled calls to the backend', lower(hex(randomblob(32)))
    WHERE NOT EXISTS (SELECT 1 FROM _vault_secrets WHERE name = 'cron_secret')`] },
  // Supabase's auth.sessions: one row per signed-in session (a Clerk session, by its stable
  // uuid), recorded the first time it is seen. Staff session limits read created_at; signing
  // staff out deletes the rows, and a deleted session is remembered so it is never recorded again.
  { name: '0003_auth_sessions', sql: [
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY DEFAULT (${UUID}) CHECK (length(id) = 36),
      user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      updated_at TEXT NOT NULL DEFAULT (${NOW}),
      not_after TEXT
    ) STRICT`,
    'CREATE INDEX sessions_user_idx ON sessions (user_id)',
    `CREATE TABLE _ended_sessions (id TEXT PRIMARY KEY, ended_at TEXT NOT NULL DEFAULT (${NOW})) STRICT`,
    'CREATE TRIGGER sessions_ended AFTER DELETE ON sessions FOR EACH ROW BEGIN INSERT OR IGNORE INTO _ended_sessions (id) VALUES (OLD.id); END',
  ] },
  // Sign-in sessions served here (worker/db/auth.ts): one-time sign-in tokens and the
  // sessions' refresh tokens, each stored only as its SHA-256.
  { name: '0004_auth_tokens', sql: [
    `CREATE TABLE _auth_link_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      expires_at TEXT NOT NULL,
      used_at TEXT
    ) STRICT`,
    `CREATE TABLE _auth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      revoked_at TEXT
    ) STRICT`,
    'CREATE INDEX _auth_refresh_tokens_session_idx ON _auth_refresh_tokens (session_id)',
  ] },
  // The switch-over copy from Supabase (worker/copy.ts): one row per run, so each runs once.
  { name: '0005_copy_runs', sql: [
    'CREATE TABLE _copy_runs (token TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER, issues TEXT) STRICT',
  ] },
]

export function migrate(sql: Sql): string[] {
  sql.script('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT')
  const done = new Set(sql.all('SELECT name FROM _migrations').map((r) => String(r.name)))
  const applied: string[] = []
  for (const m of migrations) {
    if (done.has(m.name)) continue
    sql.transaction(() => {
      sql.script(m.sql)
      sql.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [m.name, new Date().toISOString()])
    })
    applied.push(m.name)
  }
  return applied
}
