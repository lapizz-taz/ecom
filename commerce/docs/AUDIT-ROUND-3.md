# Fullfilio — audit round 3 (continuous A–Z verification)

Started 2026-10-21 04:10 UTC on branch `claude/optimistic-cray-c2d0fc`, after rounds 1
(`docs/AUDIT.md`, 2026-10-12) and 2 (`docs/AUDIT-ROUND-2.md`). This file is the working record
and is updated after every pass so the audit resumes here after an interruption.

Statuses: **PASS** (tested, with evidence) · **FAIL** (reproducible failure) · **FIXED** (failed,
fixed, retested) · **BLOCKED — OWNER** (needs the owner's access, setting or decision) ·
**BLOCKED — PROVIDER** (an outside service prevents checking) · **NOT TESTED**.
Severity: P0 security/data loss/outage · P1 core workflow or major integration · P2 important
feature or calculation · P3 minor.

Test kinds are named every time: *unit* (mocked providers), *db* (local PostgreSQL 16 built from
every migration), *browser* (local Worker + Chromium), *live-read* (read-only queries and logs on
production), *live-provider* (a real answer from the outside service).

## 0. What this session can reach

| Target | Reachable | Used for |
|---|---|---|
| Production database (Supabase `tcjdgiohmhjqppzwoztj`) | yes — SQL, logs, advisors (read-only by rule; no writes to merchant data) | live-read checks, error logs, cron history |
| Production Worker metadata (Cloudflare) | yes, read-only | deploy timestamps |
| `fullfilio.com`, store domains, `*.supabase.co` over HTTP | **no** from this sandbox (proxy refuses) | — ; the database's own `net.http_*` reaches them for safe probes |
| Courier, payment, SMS, Meta/TikTok/Google APIs | **no** | unit tests with mocked providers only; real answers are BLOCKED — PROVIDER |
| Local PostgreSQL 16, local Worker, Chromium | yes | db and browser tests |

## 1. Inventory (pass 1)

| Area | Count | Source |
|---|---|---|
| Page components | 133 (admin 80, Super Admin 27, storefront 16, marketing 8, start 2) | `src/pages/**` |
| Top-level routes | 42 (+ nested admin/Super Admin routes inside the layouts) | `src/routes/router.tsx` |
| Edge functions | 24 (+ `_shared`) | `supabase/functions` |
| Migrations | 171 | `supabase/migrations` |
| Scheduled jobs (live) | 16 | `cron.job` |
| TODO / FIXME markers in app code | 0 | grep |

Feature list per module: rounds 1–2 tables (`AUDIT.md` §2) stay the reference; this round adds a
row for everything built since 2026-10-13 (143 commits) as each module is re-tested below.

## 2. Baseline (pass 1, 04:15 UTC)

| Check | Result | Status |
|---|---|---|
| Type check (app + Worker) | 0 errors | PASS |
| Unit tests | 83 files, 929 passed, 2 skipped | PASS |
| Database tests (local PostgreSQL 16, every migration) | 97 files, 699 passed | PASS |
| Edge functions `deno check` (all 24) | clean | PASS |
| Production build (`build:cloudflare`) | built, 10 website pages prerendered | PASS |

## 3. Live logs and jobs (pass 1, live-read)

System log, last 7 days, ERROR/WARN grouped (14 groups):

| Finding | Cause | Severity | Status |
|---|---|---|---|
| "Could not find the function public.inbox_channel_remove" (17 Oct 17:30) | Page shipped before its migration ran; function exists now (`inbox_channel_remove(uuid,uuid)`) | P3 | PASS (recovered) |
| Cloudflare "Could not route to /zones/…%20/custom_hostnames" (16 Oct 14:24) | Space in the zone ID secret; fixed in `ee35509` 31 s later (`.trim()`) | P2 | PASS (recovered) |
| Super Admin finance error logged as **"[object Object]"** (18 Oct) | (a) page shipped 4 min before `platform_ads_report` migration — recovered. (b) **The client error logger wrote plain error objects as "[object Object]"**, losing the message for every database error | P3 | **FIXED** — `errorText()` in `src/lib/monitoring.ts` keeps message, code and details; unit test `src/lib/monitoring.test.ts` |
| "Could not verify a paystation billing return" (20 Oct 16:25, ৳99 subscription, merchant `64c2…e975`) | PayStation answered "Transaction found" without a final state; Super Admin rejected the payment by hand 10 min later; only one check on record. A later "paid" answer would still mark it paid (`billing_gateway_confirm` accepts success over REJECTED), but the reconcile job only re-asks PENDING payments | P2 | **PASS** — owner confirmed 21 Oct: a test, opened and left unpaid, so rejecting it was correct. Improvement **FIXED**: the message now carries PayStation's own payment state (`payment Processing`), so the reviewer can tell; unit test in `payments.test.ts` |
| Steadfast firewall / 403, PayStation "Invalid Credential", Meta token revoked, Meta `phone_numbers` on a non-WhatsApp ID, Meta delete of a missing object, courier history slow | Outside answers shown to the user with the real reason, as designed | — | PASS (handled) |

Scheduled jobs (16), live `cron.job_run_details`:

| Job | Finding | Status |
|---|---|---|
| `billing-run` | Failed 9× until 20 Oct 13:07 ("invalid input syntax for type integer: \"\"") — an empty billing setting. Fixed by `20261121001300_signup_offer.sql` (every reader treats an empty number as its default; the save refuses non-numbers; the Super Admin form requires all three). Last 15 hourly runs succeeded; each run catches up on everything due | PASS (recovered) |
| The other 15 | No failure in 7 days | PASS |

Open note (P3): plan and sign-up-offer `trial_days` are still cast without the empty-value guard
(`platform_plan_save`, `_signup_offer_apply`, `public_signup_options`). Both forms send numbers, so
it is not reachable from the UI today; listed for the next pass.

## 4. Module checks

Each module is re-tested in turn (orders, products/stock, finance, tracking, channels, couriers,
messaging, payments/Super Admin, security). Rows are added as they are executed.

| Module | Scenario | Kind | Result | Status |
|---|---|---|---|---|
| Ad tracking | Same event id twice → second dropped (`duplicate:true`) on atheron.shop | live | `{"ok":true,"duplicate":true}` | PASS |
| Ad tracking | Page view / add-to-cart / checkout / purchase fire once per real action | unit | 5 tests in `ad-pixels.test.ts` | PASS |
| Bundles | Live `_bundle_percent` with tiers 1/2/3 → 0/10/15/15 % for 1–4 pieces | live-read | as expected | PASS |
| Bundles | Atheron has no published Bundles block, so prices unchanged | live-read | `_bundle_rule()` null | PASS |
| Orders (data) | Duplicate store orders (same channel + external id, not merged); total ≠ subtotal − discounts + delivery + tax; subtotal ≠ sum of lines; >1 active shipment per order; same consignment twice; refunded > paid; returned/damaged > ordered | live-read | 0 of each (only 3 live orders — small sample; the db suite covers the logic) | PASS |
| Tenant isolation | Every public table has row security on (168 tables with `merchant_id`, 0 without) | live-read | 0 tables without | PASS |
| Tenant isolation | `tenant_isolation` is RESTRICTIVE on every merchant table; the only rows open to visitors are active delivery zones and settings marked public; `system_logs` read needs staff + `audit.view`, so platform rows (no merchant) never show to a store | live-read | as listed | PASS |
| Security | Functions a visitor (anon) may call, live = the allowlist in `function-grants.test.ts` (34) | live-read + db | identical | PASS |
| Security | Supabase security advisor: 0 errors; warnings are the known design (signed-in RPCs are security-definer with their own checks; 16 functions without a fixed search path; `pg_trgm` in public; leaked-password check off because sign-in is through Clerk) | live-read | 0 ERROR | PASS |
| Orders (browser + Worker) | **Pass 3** — `scripts/audit/order-lifecycle-e2e.cjs`: real Worker, Cloudflare database seeded from all 171 migrations, Chromium; 31/31 | browser | below | PASS |
| Orders | Storefront order (2 × ৳1,000); the same request sent twice → one order, stock reserved once (on hand 10, reserved 2) | browser | as expected | PASS |
| Orders | Total = subtotal + delivery | browser | 2,000 + 80 = 2,080 | PASS |
| Orders | Pending → Confirmed → Processing → Packing → courier → Ready → Shipped → Delivered, each saved; 6+ history rows; Delivered cannot go back to Pending | browser | as expected | PASS |
| Stock | Delivered: on hand 10 → 8, reserved 2 → 0 (once) | browser | as expected | PASS |
| Returns | Shipped → Failed delivery (reason) → Coming back → received (RESTOCK): order Returned, +1 on the shelf; receiving again adds nothing | browser | 7 → 8, then 8 | PASS |
| Cancel | Cancel without a reason refused; with a reason the 3 reserved units are released | browser | reserved 3 → 0 | PASS |
| Finance | P&L for the day, computed by hand: products 2,000 (delivered only) + delivery 80 − COGS 800 (2 × 400) − courier 140 (2 × 70) − return charge 50 = **1,090** | browser | report: 2,000 / 80 / 800 / 140 / 50 / **1,090**, gross margin 61.54 % | PASS |
| Call role | Sees the 3 orders; cannot read order cost, item cost, product cost or the P&L; cannot move a delivered order; `/admin/finance` shows no money | browser | refused each | PASS |
| Tenant isolation | A second store's owner, sending store one's id in `x-merchant-id`: 0 orders, 0 customers, no private settings, P&L without store one's sales, status change refused (order still Delivered) | browser | as expected | PASS |
| Admin UI | Order page at 1440 and 390 px: number, Delivered, customer, items; survives reload; no sideways scroll; no page errors; finance page shows figures | browser | as expected | PASS |
| Queues (live) | Store sync jobs, status pushes to stores, courier webhook events, ad event queue, notification log, store webhook deliveries | live-read | all finished or empty; 0 failed. One Shopify INVENTORY job for atheron waits since 00:54 because atheron sells on its **own store** now (only one sales channel runs at a time); it runs if Shopify becomes the active channel again | PASS (by design) |
| Stock | **Pass 4** — two shoppers buy the last unit at the same moment (two real transactions, own database): one order, the other refused "out of stock", stock 1 reserved / 0 available, never negative | db | new `supabase/tests/db/stock-race.test.ts` | PASS |
| Integrations (code) | Existing mocked tests read for pass 4: store sync 39, channels 19, catalog 9, Shopify sync 7, WooCommerce plugin 29, couriers 19 + panel 41 + webhooks 12 + history 31 + ops 11, payments 38 + gateway 8 + billing 22, SMS 39, inbox 14, store tracking 52, Meta/ads 35 | unit + db | all in the 931 + 700 passing | PASS (mocked) |
| Integrations (real providers) | Shopify, WooCommerce, Pathao, Steadfast, RedX, Carrybee, bKash, PayStation, SMS, Meta/TikTok/Google: this session cannot reach them; live usage records show Shopify webhooks arriving (8 deliveries 20 Oct, all handled) | live-read | — | BLOCKED — PROVIDER (from here) |

## 5. Fixes this round

| # | Fix | Files | Test |
|---|---|---|---|
| 1 | Client errors keep their real message instead of "[object Object]" | `src/lib/monitoring.ts` | `src/lib/monitoring.test.ts` (2) |
| 2 | PayStation "not confirmed" names PayStation's payment state | `supabase/functions/_shared/payments/paystation.ts` | `payments.test.ts` |
| 3 | The Cloudflare database's reference data was generated on 19 Oct, before the newest migrations: a store created on the Cloudflare database would start with old settings rows. Regenerated from all 171 migrations | `worker/db/generated/seed.sql` | worker tests 85/85; pass 3 runs on it |

## 6. Needs the owner

Nothing open. Resolved: PayStation invoice `BP-D45C8D2CC16346-TMVGW9MBT` was the owner's own test, never paid (confirmed 21 Oct).
