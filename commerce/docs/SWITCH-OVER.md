# Moving Fullfilio fully to Cloudflare (switch-over runbook)

Today the site runs on Cloudflare, but the data lives in Supabase. This runbook moves
the database, sign-in sessions, live updates and scheduled jobs to Cloudflare and then
retires Supabase and Vercel. Nothing here deletes Supabase data: Supabase stays,
read-only, as the way back until the new setup has run cleanly.

## What is ready (built and tested)

| Piece | Where | Checked |
| --- | --- | --- |
| Database (orders, stock, money, staff…) | Database Durable Object (`worker/db`) | 435 of 436 Postgres tests replayed; the one left is the phone gateway |
| Sign-in sessions behind Clerk | `worker/db/auth.ts`, `worker/db/tokens.ts` | supabase-js sign-in, renew, sign-out in the Workers runtime |
| Live updates (new orders, scans, live lists) | `worker/db/realtime.ts` | supabase-js realtime: staff hear changes, visitors do not |
| 12 scheduled jobs | `worker/cron.ts` (one trigger a minute) | schedules, due checks, every database job runs on the engine |
| 5 long functions (channels, courier, ads, notifications) | the Worker (`SUPABASE_FUNCTIONS=""`) | needs Workers Paid for their running time |
| The data copy, with checks | `worker/copy.ts`, `worker/db/export.ts` | rows, money totals, accounts, Vault secrets; once per request; never over a live database |

Not moving: the phone system (VoiceDrive PBX) needs a direct Postgres connection for
Asterisk; it is marked "coming soon" and stays off.

## Before the switch (no downtime)

1. **Cloudflare Workers Paid** ($5 a month): Workers & Pages → Plans. Needed for the
   long functions and the database's running time.
2. **One secret for the copy**: Supabase → Project Settings → Database → Connection
   string → *Session pooler* (URI), with the database password (reset it there if it is
   not known). Add it in Cloudflare → fullfilio → Settings → Variables and Secrets as a
   **Secret** named `SUPABASE_DB_URL`. Never paste it anywhere else.
3. **The schema snapshot is current**: the Cloudflare database enforces the grants,
   row-security rules and function bodies in `worker/db/generated`, made by
   `npm run db:convert` from a database built from `supabase/migrations`. The unit test
   `worker/db/snapshot.test.ts` fails when a migration was added without regenerating it;
   it must pass before the switch.
4. **Deploy the new code, still on Supabase**: the work branch goes to the live branch.
   With `DATABASE_BACKEND=supabase` nothing changes for anyone; the Cloudflare database
   is created empty and stays unused.
4. **Trial copy**: add the variable `COPY_FROM_SUPABASE` = `trial-1`. Within a minute
   the Worker copies everything and writes a report (counts and totals only) to
   Supabase's system log (`source = 'cloudflare-copy'`). It must say *matches*. A trial
   can be repeated with a new value (`trial-2`, …); each copy replaces the last.

## The switch (about 15 minutes, at a quiet hour)

5. **Maintenance on**: variable `MAINTENANCE` = `on`. Pages show "being upgraded",
   the API answers "try again in a few minutes" (webhook senders retry), jobs pause.
6. **Freeze Supabase** (with approval, reversible): pause its scheduled jobs, make the
   database read-only, pause the Vercel project, so nothing can write to the old copy.
7. **Final copy**: `COPY_FROM_SUPABASE` = `final-1`; the report must say *matches*.
8. **Switch**: one commit sets `DATABASE_BACKEND=cloudflare` and `SUPABASE_FUNCTIONS=""`
   (wrangler.jsonc) and `VITE_DATABASE_BACKEND=cloudflare` (.env.cloudflare), and is
   deployed. Remove `COPY_FROM_SUPABASE`.
9. **Maintenance off** (`MAINTENANCE` removed), then check at once: staff sign-in and
   the Super Admin, orders and stock, a test checkout (no real payment), new-order
   alert, a courier status webhook.

Staff sign in again once (their sessions start fresh on Cloudflare).

## Going back

Until step 9, going back is: remove `MAINTENANCE`, undo step 6. After step 9, revert the
switch commit and undo step 6; anything written on Cloudflare after the switch would then
have to be copied back to Supabase (not automated), so problems are best found in the
first checks of step 9.

## Retiring (after a clean week, with approval)

10. Delete the Vercel project (its address stops working).
11. Pause the Supabase project (it can be restored for 90 days), later delete it.
12. Delete the `SUPABASE_DB_URL` secret. Keep `SUPABASE_SERVICE_ROLE_KEY`: the Worker
    uses it as its own server key and derives the sign-in signing key from it (changing
    it signs everyone out once).
