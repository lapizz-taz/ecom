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
| `/rest/v1/rpc/<name>` | `worker/db/rpc` (functions ported to TypeScript) | Postgres functions |
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
  triggers refuse updates and deletes, except during an approved store reset;
- the audit trail is written for the same tables as before.

Checks SQLite cannot hold (patterns) run in the data layer; `report.md` lists them.
A table whose business trigger has no TypeScript version yet **refuses writes**
(`NOT_PORTED`) instead of skipping the rule; each stage ports its own.

## Stages

1. Foundation — schema, data layer, sign-in, permissions, store isolation. **Done.**
2. Products and stock
3. Orders and checkout
4. Couriers
5. Payments and finance
6. Shopify / WooCommerce sync
7. SMS, ads, HR, phone, Super Admin
8. Copy the data, switch over, retire Supabase (it stays read-only as the way back
   until the new setup has run cleanly)

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
