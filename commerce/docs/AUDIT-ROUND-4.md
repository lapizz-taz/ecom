# Fullfilio — audit round 4 (A–Z: every function, every role)

Started 2026-10-24 06:40 UTC on branch `claude/optimistic-cray-c2d0fc`, after rounds 1–3
(`docs/AUDIT.md`, `docs/AUDIT-ROUND-2.md`, `docs/AUDIT-ROUND-3.md`) and security runs 4–5. This file is
the working record, updated after every pass; `docs/audit-round-4.json` holds the same rows for tools.

Statuses: **PASS** (tested, with evidence) · **FAIL** (reproducible failure, open) · **FIXED** (failed,
fixed, retested) · **WATCH** (intermittent, diagnostics added, not yet explained) · **BLOCKED — OWNER** /
**BLOCKED — PROVIDER** · **NOT TESTED**. Severity: P0 security/data loss/outage · P1 core workflow or
major integration · P2 important feature or calculation · P3 minor.

Test kinds: *unit* (mocked providers) · *db* (local PostgreSQL 16 built from every migration) · *cfdb*
(the same tests on the Cloudflare database engine) · *browser* (local Worker + Chromium) · *live-read*
(read-only SQL, logs, advisors on production) · *live-probe* (a harmless request to production through
the database's HTTP client).

## 0. What this session can reach

Unchanged from round 3 §0: production database read-only (SQL, logs, advisors) and Worker metadata;
`fullfilio.com` and `*.supabase.co` only through the database's HTTP client; no courier, payment, SMS
or ads provider; local PostgreSQL 16, local Worker and Chromium for db and browser tests.

## 1. Architecture and inventory

Reference map: `docs/ARCHITECTURE.md`; feature-by-feature inventory: `docs/AUDIT.md` §1–2 (round 1) with
round 3 additions. Since round 3 (43 commits) these were added and are re-tested in this round:

| Area | What is new | Where |
|---|---|---|
| Customer messages | Email module (own mailbox or Fullfilio service, Liquid templates, design, test send), WhatsApp module (Meta templates, review, costs), confirm/cancel buttons + public confirm page, RTS-saver messages, WhatsApp→SMS fallback, cart reminders, review requests, Bangla/English, daily owner summary, unsubscribe link + one-click, 30-day numbers | `src/pages/admin/email*.tsx`, `whatsapp*.tsx`, `src/pages/customer/*`, `supabase/functions/messaging`, `notifications-dispatch`, migrations `2026112500…`–`2026112700…` |
| Roles | Moderator role (messages, replies, new orders only) | migration + `moderator-role.test.ts` |
| Website | Meta pixel + server copy on fullfilio.com, white version, glow buttons, pricing rollback | `src/features/site/*`, `worker/site*.ts` |
| Store | Ready-made themes, cart page/drawer in the editor | `src/features/theme/*` |
| Security run 4–5 fixes | per-store browser storage, setup fee on plan change, theme editor id checks, phone-pattern guard | see `docs/SECURITY-AUDIT-RUN-5.md` |

Inventory now: 25 edge functions, 179 migrations, 104 database test files (735 tests), 99 unit test
files (1,018 tests), 18 scheduled jobs (live).

## 2. Baseline (pass 1, 06:43 UTC)

| Check | Result | Status |
|---|---|---|
| Type check (app + Worker) | 0 errors | PASS |
| Unit tests | 1015 passed, **1 failed** (`domain-panel-r4` "fresh add"), 2 skipped | **FIXED** → 1016 passed (§4 #1) |
| Database tests (local PostgreSQL 16, every migration) | 734 passed, **1 failed** (`stock-lock-order`); rerun 735/735 | **WATCH** (§4 #2) |
| Edge functions, `deno check --config deno.json */index.ts` (all 25, the repo's `functions:check`) | **1 type error** `_shared/clerk.ts:285` | **FIXED** (§4 #3) |
| Production build (`build:cloudflare`) | built, 10 website pages prerendered | PASS |
| Same database tests on the Cloudflare database engine (`CF_DB_TESTS=1`) | 629 passed, **97 failed**, 9 skipped | **FAIL — staging track only** (§5) |

## 3. Live health (pass 1, live-read)

| Check | Result | Status |
|---|---|---|
| System log, ERROR/WARN since round 3 (21 Oct 05:00) | 2 entries, both one WhatsApp template submit at 04:33 today: "The access token expired or was revoked. Reconnect this channel" | PASS (true message) — led to §4 #4 |
| Scheduled jobs | 18 jobs, all active, last run succeeded, 0 failed runs in 3 days | PASS |
| Security advisor | 0 ERROR. 32 functions open to visitors = the reviewed allowlist (`function-grants.test.ts`). 17 functions without a fixed search path: all plain (not security definer), not callable by visitors, 15 immutable | PASS |
| Data integrity (3 live orders — small sample) | total ≠ subtotal − discounts + delivery − delivery discount + tax: 0; subtotal ≠ lines: 0; duplicate channel orders: 0; refunded > paid: 0; returned > ordered: 0; negative stock / reserved > on hand: 0 | PASS |
| Queues | notifications stuck > 1 h: 0; billing payments pending > 1 day: 0; store sync jobs in 3 days: none | PASS |
| Production WhatsApp channel | status **FAILED** since 20 Oct (Meta token expired/revoked) | **BLOCKED — OWNER**: reconnect in Messaging → Channels |

## 4. Findings and fixes

| # | Module | Finding | Severity | Root cause | Fix | Test | Status |
|---|---|---|---|---|---|---|---|
| 1 | Domains (test) | `domain-panel-r4` "fresh add" expects "every 10 minutes", page says "every hour" | P3 | Not a product bug: the panel promises "every 10 minutes" for 3 days after a change, then "every hour" (true: `domains-recheck` runs every 10 min, `dueForRecheck` goes hourly). The fixtures are dated 20 Oct, so after 23 Oct 08:00 the real clock made the fresh domain look 4 days old | Test clock pinned to the fixtures' date (`vi.setSystemTime`) | 75/75 | FIXED |
| 2 | Stock (test) | `stock-lock-order` "the order never waited for the held stock row" in one full run, passes alone and in the next full run | P3 | Not yet explained: the old helper waited 5 s and reported every outcome (order failed, placed without waiting, waiting on something else) as the same timeout | Helper now waits 10 s and reports the real outcome and the backend's wait state | 735/735 in rerun | WATCH |
| 3 | Edge functions | `npm run functions:check` fails: `Uint8Array<ArrayBufferLike>` is not a `BodyInit` in the Clerk proxy | P3 (type only; runtime unaffected) | Deno 2.9's TypeScript types byte arrays by their buffer; `readBytes` always returns a fresh `Uint8Array` over an `ArrayBuffer` | `readBytes` and `proxyRequest` typed `Uint8Array<ArrayBuffer>` | deno check all 25 clean; tsc clean; clerk + http tests 23/23 | FIXED |
| 4 | WhatsApp page | With the sending number's token dead (status FAILED, live since 20 Oct) the page said "On…" and ticked "Connect your number"; only Messaging → Channels said "Needs reconnecting", while every message failed (or went by SMS) | P2 | The page treated any connected number as working (`numbers.length > 0`, `ready` ignores FAILED) | Warning with **Reconnect** at the top; checklist step done only for a working number; "On" only when the number works; number list marks "(needs reconnecting)" | typecheck; browser check in pass 3 | FIXED (browser re-check pending) |
| 5 | Messaging (test) | My 24 Oct change to the cart-reminder test helper used SQL the Cloudflare engine cannot parse; both messaging test files used a zone from a column (unsupported there) | P3 | Test helper | `storeZone()` in `supabase/tests/support/fixtures.ts` picks the zone in JavaScript | db 12/12; cfdb 11/12 (the 12th is engine bug §5 E5) | FIXED |

## 5. Cloudflare database engine (staging only — production runs on Supabase)

`DATABASE_BACKEND=supabase` in production; the Cloudflare database is the planned move (task D1-8,
"staging only" in the business memory). 97 of 735 tests fail there today. Grouped by cause:

| # | Cause | Tests | Effect if the engine went live today |
|---|---|---|---|
| E1 | The engine's regular expressions refuse nested repeats used by the domain-name checks (`(a+)+`-style) | 75 (domain-audit-db 44, domain-lifecycle-r3 21, domain-ownership-r2 10) + audit-run3 domain rows | Custom domains could not be added or resolved |
| E2 | Column-level permissions are not enforced (`order_items.unit_cost`, `orders.cost_total` readable) | call-role 2, moderator-role 1 | **The Call and Moderator roles would see costs and profit** — must be fixed before any switch-over |
| E3 | Missing Postgres functions/forms: `regexp_split_to_table`, `daterange`, `has_column_privilege`, interval `'1 month - 1 day'`, `AT TIME ZONE` with a zone from a column, per-row functions on unreachable columns (`_platform_leads`), `pg_proc.prorettype`, `ALTER TABLE … DISABLE TRIGGER`, `pbx_gw` schema | ~12 | HR month review, platform leads/finance reports, PBX gateway views would fail |
| E4 | Signup network limit not applied on the engine (`public_signup_request` from the same network) | 1 | Sign-up flood limit missing |
| E5 | `messaging_due_carts` returns the cart's source in the `step` column (wrong column mapping) | messaging-v2 1 | Second cart reminder never queued |

Status: **FAIL — BLOCKED for switch-over**, not a production defect. Recorded for D1-8; not fixed in
this round (an engine change is not a small, safe fix).

## 6. Needs the owner

| What | Why | Where |
|---|---|---|
| Reconnect the WhatsApp Business number | Its Meta access token expired or was revoked on 20 Oct; no WhatsApp message (or template submission) can go out until it is reconnected | Admin → Messaging → Channels → WhatsApp → Reconnect |

## 7. Plan for the next passes

1. Browser suites on the local Worker: every admin page, every Super Admin page, storefront + checkout,
   order lifecycle + P&L, messaging (incl. the new unsubscribe page and the WhatsApp reconnect warning).
2. Module deep checks for everything since round 3: messaging v2 end to end (queue → render → send plan
   → unsubscribe → stats), Moderator and Call roles, Super Admin billing/plan change with setup fee,
   theme presets, website pixel events (browser + server, one event id).
3. Money: re-derive the P&L, plan/offer billing (৳99 → ৳1,000 + plan → plan) and the per-order fee by
   hand and compare with the database.
4. Security: IDOR sweep on every RPC that takes an id, for a second store and for each role.
5. Load: repeat the round-3 load test on today's code.
