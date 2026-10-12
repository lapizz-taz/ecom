# Fullfilio — audit round 2 (integrations, speed, design, security)

Started 2026-10-12 ~22:10 UTC. Requested by the owner after round 1
(`docs/AUDIT.md`). Rule from the owner: anything already tested in round 1 is
not tested again; this round covers what is new, changed, or reported broken.

Statuses: PASS / FAIL / BLOCKED / NOT TESTED / FIXED. BLOCKED and NOT TESTED
are never counted as PASS.

## 0. What this session can reach

| Target | Reachable from here | How it is tested instead |
|---|---|---|
| Live database (Supabase project `tcjdgiohmhjqppzwoztj`) | yes, through the database tools (SQL, logs, function deploys) | read-only queries; DDL only with approval |
| Live site `fullfilio.com`, Supabase HTTP, BD Courier, Meta, TikTok, SMS hosts | **no** — the session's network policy refuses them (HTTP 000) | local Postgres + local Worker (`wrangler dev`), and the database tools for live state |
| Google Ads API host | yes (answers 404 without credentials) | — |
| Cloudflare account | read-only (Worker metadata, code); no secrets or deploy | deploy by pushing the build branch |

## 1. Live state at the start (R0)

| Item | Finding | Status |
|---|---|---|
| System Health "Server functions: Degraded" | Caused only by `CRON_SECRET` being "required but not set" on the Worker. The database's scheduled jobs (`cron.job`, 12 jobs) call the Supabase-hosted functions directly with the secret kept in the database vault, so the Worker never needs it; `_shared/cron.ts` also accepts the service key or the vault secret. The check was wrong, not the jobs. | **FIXED** in code: `CRON_SECRET` moved to optional in `platform-admin`; `courier` scheduled sync now uses the shared check (it alone compared only against the env value); secret comparisons are constant-time. |
| "Application errors: 9 unresolved" | Read 24 rows (48 h). All but one come from outside: a WooCommerce store's API keys rejected (21:45 UTC), a Hostinger site unreachable, a Shopify app not installed, store orders with invalid phones/districts (correctly not imported, with reasons), Clerk upstream timeouts. One platform-side: a billing return with no app address (2026-10-11, before `PLATFORM_URL` was set; the Worker now has it). | Recorded; external ones need the merchant/owner |
| SMS provider "Not connected" | True on live: `platform_settings.sms` has no provider and `connected=false`, and the vault holds no SMS credentials. No SMS account was ever saved. | **BLOCKED** — needs the owner's SMS provider account (see R1) |
| BD Courier | Connected (`bdcourier`, since 2026-10-11), credentials in the vault, 10 successful lookups in 14 days, last 2026-10-12 08:51 UTC, 0 failed. | **PASS (live, from usage records)** |
| Payments to the platform | `billing_gateways`: bKash and PayStation both `enabled=false`, `sandbox=true`, no `connected` flag; the vault holds no billing gateway credentials. Never configured. | **BLOCKED** — needs the owner's bKash/PayStation merchant credentials (see R4) |
| Scheduled job targets | pg_cron calls Supabase-hosted `clerk-auth` (v6) and `payment-webhook` (v4) too. Compared with the repository: only the Cloudflare-portability changes since, so both are current in behaviour. | PASS |

## 2. Integrations (R1–R4)

| Feature | What was done | Result |
|---|---|---|
| SMS provider: Super Admin → merchant screens | New `platform-connections.test.ts` › first test: a provider saved by the server (`platform_sms_set_connection`, called only after the provider accepted the keys) shows to the merchant (`sms_overview`) as connected with the platform sender ID; the merchant's answer contains neither the provider name nor the key hint; Super Admin's overview shows provider and balance; staff and merchants cannot connect an account directly; disconnect turns the merchant view off again. | **PASS** (local Postgres, 2/2) |
| SMS provider: live connection | No SMS account was ever saved on live (§1). The four supported providers (sms.net.bd, BulkSMSBD, SSL Wireless, generic HTTP gateway) are covered by round-1 unit tests (`sms.test.ts`), and sending, retries, charging and refunds by the database suites (`sms`, `credits-usage`). | **BLOCKED** — needs the owner to connect an SMS account in Super Admin → SMS Management; this session also cannot reach any SMS host |
| BD Courier | Live: connected, 10 lookups in 14 days, 0 failures (§1). Round 1: lookups, free allowance, charging, refunds (`credits-usage`), rate-only couriers (`courier-history`). New: lookups retry once on a busy or briefly unavailable BD Courier (max 0.8 s extra) — checkout waits on it, so only one quick retry. | **PASS (live usage)**; HTTP from here BLOCKED |
| Courier bookings, webhooks, status updates, returns | Round 1 covered: Pathao/Steadfast webhooks move orders once, out-of-order updates ignored, unknown parcels applied later, return charges once, "Return pending" for refused/returning/return-asked, scanner Returned restocks, delivered stays final (`courier-ops` 11, `returns-bulk` 8, `finance-reconciliation` partial returns). Not re-run (owner's rule). | PASS (round 1); live bookings BLOCKED (would create real parcels) |
| Meta / TikTok / Google Ads | Live: nothing connected (no Meta account rows, `meta_ads.connected=false` for both stores with the setting, no TikTok/Google connections). Code: token/permission/rate-limit errors are told apart per account and one failing account never stops the others. **New:** read calls retry on HTTP 429/502/503/504 and dropped connections, honouring Retry-After, at most 3 tries and 4 s per wait (`_shared/fetch-retry.ts`, used by default in the Meta, TikTok, Google and BD Courier clients; never for calls that create something). Tests: `fetch-retry.test.ts` 6/6, existing ads/Meta/BD Courier tests 27/27. | **FIXED (rate limits)**; live sync **BLOCKED** — no ad account connected, and the hosts are unreachable from here |
| Payments to the platform | New `platform-connections.test.ts` › second test: Super Admin cannot switch on a gateway that was never connected; once the server records a verified gateway it appears in the merchant wallet (`my_credits().gateways`); switching it off removes it; merchants can neither connect nor switch. Live: never configured (§1). | **PASS** (logic); live **BLOCKED** — needs the owner's bKash/PayStation merchant credentials in Super Admin → Subscriptions → Rules |
| Credit wallet | Round 1: ledger balance = lots, once per request, expiring lots first, second-person approval for large changes, recharge only after a verified payment, SMS/BD Courier charging and refunds (`credits-usage` 11). Not re-run. | PASS (round 1) |

## 3. Order search, status updates, scanner (R6)

| Item | What changed | Test (local Worker + Chromium, `scratchpad/r2/run-search.cjs`) | Result |
|---|---|---|---|
| Search page redesign | New page: large search box with field chips, "looks like a mobile number" hint, recent searches, "/" shortcut, **Scan** to search by label, customer panel (orders, delivered %, returned/cancelled, courier record, call/WhatsApp) when all results are one customer, results split into **Web orders** and **Approved orders** (like EcomDrive), list filter and sort, cards on phones and rows on desktop. | Rahim's web and approved orders land in the right lists with the customer panel, at 1440 and 390 px; no sideways scroll at either width; tracking-ID search finds the parcel. | **PASS** |
| Status update from search | `OrderStatusMenu`: the order page's own next steps (`NEXT_ACTIONS`), cancel with a reason; web orders get **Approve** (through `approve_orders`, so fraud/limit checks and the per-order charge still apply), their review statuses and Cancel. The database still checks every move and permission. | Confirmed → Processing saved; web order cancelled with a reason and its reserved stock released. | **PASS** |
| Search speed | One request per field with the parcel included (was two round trips); 250 ms debounce (was 350); 15 s result cache. New trigram indexes for tracking/consignment IDs, store order numbers and payment transaction IDs (`20261109002200_search_indexes.sql`; name/phone/invoice already had theirs). | Results on screen **623 ms** (desktop) and **563 ms** (phone) after typing, debounce included. | **PASS** |
| Scanner speed + torch | Camera: own stream at 1280×720 with continuous focus; reads only the guide band; every frame on Chrome/Android (was 5 a second); on iPhone ZXing tries every 40 ms (was 500 ms); only label formats; vibration and a green flash on a read; **torch button** where the camera has one. Scan page: codes are **queued** instead of dropped while the previous one saves, and lists refresh once after a burst (was 3–4 refreshes per scan). | Three codes entered back to back: all three saved in **181 ms**. Camera and torch need a real phone: NOT TESTED here (no camera in this sandbox). | **PASS** (queue); camera/torch **NOT TESTED** |
