# Security audit run 5 (cloudflare/security-audit-skill)

Scope: everything changed since run 4 (f8531a7..5371b2d: 17 commits, 85 files): the ready-made themes,
cart drawer and cart page settings, exact corners, theme editor, Worker `?theme_preview` route, blue
glow buttons, cart checkout gating, Sales channels loading, Cloud Calling rename and support e-mail,
plus the run-4 fixes and open leads. Profile quick, 9 agents (3 hunters, 1 coverage critic, 5
verifiers). Every confirmed problem was reproduced in a sandbox (no network, throwaway Postgres
built from the migrations) and checked by a verifier that did not find it.
Full records: `/srv/security-audit/run-5/` (REPORT.md, FINDINGS-DETAIL.md, NEEDS-VALIDATION.md).

**Result: no critical, high or medium problems. 2 low ones confirmed, both fixed.** The new theme,
editor and button code had no vulnerabilities (one editor crash from a crafted link was fixed).

## Confirmed and fixed

| # | Problem (low) | Fix | Test |
|---|---|---|---|
| 1 | Stores opened by link (`/s/<store>`) shared one cart in the browser: store A's cart showed in store B, and "Buy now" sent store A's product names and prices to store B's ad pixels. | Every store keeps its own browser storage (`storeKey()` in `src/lib/merchant.ts`): cart, visitor id, ad clicks, pixel de-duplication, last order. The old shared keys are dropped. | `src/features/cart/cart-store.test.ts`, `scripts/audit/theme-round-e2e.cjs` |
| 2 | The run-4 setup-fee fix was incomplete: a plan change chosen before the renewal carried no fee, so switching plan every period skipped the one-time ৳1,000 fee; a fee-less plan change could also replace the renewal and lift the "pay to continue" block. | The fee stays due until a live invoice charges it, so any plan change carries it; a plan change without it cannot be paid while it is due. | `supabase/tests/db/audit-run5.test.ts` (fails without the migration) |

Behaviour change: a plan change made while the setup fee is still due now includes the fee
(after the ৳99 offer month, GROWTH is ৳2,490 + ৳1,000).

## Open leads, hardened anyway

These depend on Cloudflare settings or on the Cloudflare database (staging only today):

- **Store phone patterns** (Cloudflare database): `a{0}`, `\d?` or `\d{0,2}` between open-ended
  repeats no longer count as separators, and a pattern may have at most 8 variable repeats (JS
  engine and Postgres trigger). Tests: `worker/db/pg/regex-guard.test.ts`, `audit-run5.test.ts`.
  Follow-up after the live check: the guard read `{0}` / `{0,2}` one character at a time, so the
  digits inside reset the "in a row" count (`^\d*a{0}\d*a{0}\d*a{0}\d*x$` passed). It now skips
  the whole quantifier.
- **Live-update connections** (Cloudflare database): sockets that never join close after 30 s,
  visitor sockets after 30 minutes, at most 1,000 visitor sockets at once. Test: `worker/db/realtime-expiry.test.ts`.
- **Inbox uploads**: staff access is checked before the body is read; only staff who may reply get
  the 14 MB upload size, everyone else 64 KB. Test: `supabase/functions/_shared/pre-auth-bodies.test.ts`.

Also fixed: the inbox thread no longer looks up a customer from a phone typed by an agent without
"view customers"; the theme editor ignores non-id `?section=` / `?block=` values.

Still worth checking on the Cloudflare dashboard (unchanged from run 4): the zone's maximum request
body size, WAF/rate rules for `/functions/v1/*`, `/__clerk/*` and `/realtime/v1`.

## Migration

`supabase/migrations/20261123000100_audit_run5_fixes.sql` (safe to re-run): setup fee on plan
changes, phone-pattern rule, inbox thread lookup. Applied.
`supabase/migrations/20261123000200_audit_run5_regex_quantifier.sql` (safe to re-run): the
phone-pattern follow-up. The Cloudflare database snapshot (`worker/db/generated/`) is regenerated
from all 174 migrations.

## Verification

Typecheck and lint clean. Unit 958 passed. Postgres DB 710/711: the one failure is the timing test
`stock-lock-order` ("no deadlock"), which fails the same way on the commit before these changes in this
sandbox and passes when run alone. audit-run4 and audit-run5 also pass on the Cloudflare engine.
Browser end-to-end: theme round 36/36, ready-made themes 11/11, storefront 33/33.
