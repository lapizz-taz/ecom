# The Cloudflare database (moving off Supabase)

The data moves from Supabase Postgres to Cloudflare in stages. Until the final
switch-over the live site keeps using Supabase (`DATABASE_BACKEND=supabase` in
`wrangler.jsonc`); everything below is built and tested next to it.

## What it is

One **SQLite-backed Durable Object** (`worker/db/database.ts`, binding `DATABASE`),
the same storage engine D1 uses, chosen over a D1 database because:

- each request runs to the end before the next one starts, and every write runs in a
  real transaction (`transactionSync`, nested calls are savepoints). Stock and money
  updates cannot interleave, and a half-finished operation leaves nothing behind,
  as Postgres functions did. D1 only offers fixed batches;
- the business logic runs next to the data with a 30-second CPU budget, not inside
  the Worker's 10 ms (Workers Free).

Point-in-time recovery (30 days) comes with the Durable Object; a daily export to R2
is added at the switch-over.

## How the app talks to it

Nothing in the pages or functions has to learn a new API:

| Path | Served by | Replaces |
|---|---|---|
| `/rest/v1/<table>` | `worker/db/rest` (PostgREST-compatible) | Supabase's REST API |
| `/rest/v1/rpc/<name>` | `worker/db/rpc` → `worker/db/pg` (the original Postgres functions) | Postgres functions |
| `/auth/v1/admin/…` | `worker/db/users.ts` | Supabase Auth admin API (accounts; Clerk does sign-in) |

`worker/db/gateway.ts` decides who is calling from the token: the service key is the
service role, a **Clerk session token** (verified against Clerk's keys) is a signed-in
person, anything else is a visitor. The server functions keep their supabase-js
clients; with the Cloudflare database on, their requests are answered in-process.

## The rules came along

`scripts/pg-to-sqlite.mjs` reads the migrated Postgres schema and writes
`worker/db/generated/` (`schema.sql`, `meta.json`, `report.md`):

- all 167 tables with keys, foreign keys, unique rules, checks and 374 indexes;
- all 488 row-security rules, translated to SQLite and applied to every read
  (each table a query touches is replaced by its permitted rows) and write
  (USING and WITH CHECK), per caller: store isolation, permissions, support
  sessions, device approval and read-only access work as before;
- table privileges, column types (money keeps its decimals, rounded on every write),
  defaults the server fills in (store, signed-in user, numbered sequences);
- permanent records (ledgers, audit log, status history) stay permanent: SQLite
  triggers refuse updates and deletes, except during an approved store reset or
  merchant deletion;
- the audit trail is written for the same tables as before.

Checks SQLite cannot hold (patterns) run in the data layer; `report.md` lists them.

## The business logic: the original Postgres code, run here

There is one implementation of every function and trigger: the PL/pgSQL and SQL
bodies from the migrations (`worker/db/generated/functions.json`, 883 functions),
run by an engine in `worker/db/pg` instead of being rewritten by hand:

- a Postgres SQL and PL/pgSQL parser, and an interpreter for the PL/pgSQL statements
  (variables, loops, `EXCEPTION` blocks as savepoints, `RAISE`, `RETURN QUERY`,
  `EXECUTE … USING`, `GET DIAGNOSTICS`, triggers with `NEW`/`OLD`);
- a compiler from Postgres queries to SQLite. What SQLite cannot compute (regular
  expressions, PL/pgSQL functions called per row, time zones) is computed in
  JavaScript once per distinct argument and read back per row;
- Postgres semantics where they differ from SQLite's: three-valued logic, numeric
  display scale (`990.00`), jsonb operators and containment, intervals and time
  zones, enum and array types, `SETOF` functions, temporary tables (kept in memory
  for the transaction), insertion order on ties, `SECURITY DEFINER` roles, table
  grants for the role a statement runs as, row security before `NOT NULL`;
- the few catalog views functions read (`pg_class`, `pg_attribute`, `pg_policies`,
  `pg_proc`, `pg_roles`, `pg_stat_activity`) answer from the schema metadata.

Every write still goes through the data layer, so row security, checks, audit and
the permanent-record rules apply to what the functions do.

## How it is tested

- **The Postgres test suite, replayed:** `CF_DB_TESTS=1 npx vitest run --project cfdb`
  runs the 435 tests in `supabase/tests/db` (written against Postgres) on the
  Cloudflare database through a pg-driver look-alike. **432 pass.** The 3 that do not:
  - *order-tools — admin override to DELIVERED:* `_order_status_path` picks among
    equally short status paths by the order Postgres happens to read rows in (its
    hash join), not by a rule. On Cloudflare it can pick READY_TO_SHIP → PENDING_CANCEL
    → DELIVERED, which skips the stock commit that SHIPPED does. The tie-break needs
    a business decision before the switch-over (it is fragile on Postgres too).
  - *data-security — staff session limits and remote sign-out:* they read Supabase's
    `auth.sessions`. With Clerk, sessions need their own record (keyed by Clerk's
    session id); part of moving sign-in.
  - *voicedrive-pbx — the phone gateway:* Asterisk reads the `pbx_gw` views over a
    Postgres connection, which a Durable Object does not offer. The phone feature is
    marked coming soon; it needs a different gateway link before it can move.
- `npx vitest run worker` — data layer unit tests (40).
- `npm run db:e2e` — the database in the real Workers runtime (14 checks, including
  20 buyers racing for the last 10 items: exactly 10 succeed).

## Still to do before the switch-over

1. The three items above.
2. Sign-in fully on Clerk tokens in the pages, and live updates (3 places use
   Supabase Realtime) on the Worker.
3. Copy the data: export from Supabase, import here, compare counts and money
   totals; Vault credentials move machine to machine (never shown), with approval.
4. Switch over on Workers Paid ($5 a month); Supabase stays read-only as the way
   back until the new setup has run cleanly.

## Commands

```sh
npm run db:convert   # regenerate worker/db/generated from the migrations (needs local Postgres)
npm run db:seed      # reference data a new database starts with
npx vitest run worker/db
npm run db:e2e       # the database in the real Workers runtime (local, throwaway)
```

## Limits worth knowing

- One SQL statement at most 100 KB and LIKE/GLOB patterns at most 50 bytes in a
  Durable Object; the converter and the data layer stay inside both.
- Workers Free: 100,000 requests a day; Durable Objects free: 100,000 requests,
  5 million rows read and 100,000 rows written a day, 5 GB stored.
- At the switch-over the functions that still run on Supabase today (channels,
  courier, meta-ads, ad-platforms, notifications-dispatch) must run in the Worker,
  which needs the Workers Paid plan ($5 a month).
