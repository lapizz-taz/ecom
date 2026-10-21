# Security audit run 4 (cloudflare/security-audit-skill)

Scope: everything changed since run 3 (74523a4..f8531a7: 52 commits, 253 files), plus the run-3
fixes and open leads. Profile standard, 18 agents (8 hunters, 2 coverage critics, 6 candidate
verifiers, 2 independent record verifiers). Every confirmed problem was reproduced in a sandbox
(no network, throwaway Postgres built from the migrations) and re-checked independently.
Full records: `/srv/security-audit/run-4/` (REPORT.md, FINDINGS-DETAIL.md, NEEDS-VALIDATION.md).

**Result: no critical, high or medium problems. 6 low ones confirmed, all fixed below.**
All 5 run-3 fixes still hold; 12 of the 16 run-3 leads are now closed.

## Confirmed and fixed

| # | Problem (low) | Fix | Test |
|---|---|---|---|
| 1 | A business past due could "change" to its own plan and pay only the plan price: the one-time setup fee was never collected and the TRIAL_ENDED block lifted. | Same plan while a renewal is open: refused ("pay the open renewal invoice"). A plan change that replaces the renewal carrying the fee now carries the fee; a plan change cannot be paid once the fee is paid another way; the subscription keeps the plan's own price. | `supabase/tests/db/audit-run4.test.ts`, `signup-offer.test.ts` |
| 2 | Stores opened by link (`/s/<store>`) share one browser origin: a buyer's hashed email/phone from one store reached the next store's Meta/TikTok/Google pixels. | Hashes are stored per store (`ff_am:<merchant id>`), never on the platform site; the old shared key is removed. | `src/features/storefront/ad-pixels.test.ts` |
| 3 | Browser pixels sent buyers' hashes even with Advanced matching off (the server already honoured it). | Off = nothing kept, nothing sent with the browser pixels or the server copy. | same |
| 4 | Super Edit returned the order's cost to roles that may not see costs (when an owner gives Super Edit to such a role). The order edit log could also copy the cost. | Cost removed from Super Edit's answer unless the caller may see costs; the edit log never copies `cost_total`. | `audit-run4.test.ts` |
| 5 | Inbox staff without "view customers" could type a phone number and learn whether it is a customer and whether they ordered; and clear a link. | Linking by phone happens only for staff who may see customers; any change to the chat's customer needs that permission. | `audit-run4.test.ts` |
| 6 | Cloudflare database (staging only today): the HR rule "must check in to work" was not applied. | `has_permission` there now runs the same `_hr_gate` as Postgres (functions and row security). | `worker/db/hr-gate.test.ts`; the replayed HRM test now passes on Cloudflare |

## Open leads, hardened anyway

These depend on Cloudflare settings that are not in the code (request size limit, Workers plan,
Durable Object limits) or on the Cloudflare database, which is staging only. They stay open in the
audit record, but the code side is now closed:

- **Large anonymous requests**: the inbox now checks who is calling before reading the body (up to
  14 MB for uploads); the Clerk proxy reads at most 1 MB and the Clerk webhook 256 KB before anything
  else. Test: `supabase/functions/_shared/pre-auth-bodies.test.ts`.
- **Store phone pattern backtracking** (Cloudflare database): the guard (engine and Postgres trigger)
  also refuses bounded repeats of an open-ended group (`((\d*){10}){10}`) and more than three
  open-ended repeats in a row (`\d*\d*\d*\d*x`). Tests: `worker/db/pg/regex-guard.test.ts`, `audit-run4.test.ts`.
- **Live-update connections** (Cloudflare database): the per-visitor cap now counts IPv6 visitors by
  /48 network (50 sockets), not by single address. Test: `worker/db/realtime.test.ts`.
- **Store redirects**: an SEO redirect to `//host` or `/\host` (another site) is no longer followed.
  Test: `worker/storefront.test.ts`.

Still worth checking on the Cloudflare dashboard: the zone's maximum request body size and any WAF
rule for `/functions/v1/*` and `/__clerk/*`, and a rate rule for `/realtime/v1`.

## Migration

`supabase/migrations/20261122000100_audit_run4_fixes.sql` (safe to re-run): Super Edit costs, order
edit log, inbox customer link, setup fee on plan changes, phone-pattern rule. The Cloudflare database
snapshot (`worker/db/generated/`) is regenerated from all 172 migrations.

## Verification

Unit 941/941, Postgres DB 707/707, typecheck and production build clean. Replayed suite on the
Cloudflare database: 604 pass; the 94 failures are the same set as before these changes minus the
HRM check-in test, which now passes (no new failures).
