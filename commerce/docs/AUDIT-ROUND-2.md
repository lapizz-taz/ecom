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

## 4. Fast web orders, capacity, caching, indexing (R5)

Load test: `scripts/load-test.mjs` builds its own database from every migration on the local PostgreSQL 16 (4 cores, load generator on the same machine) and never touches production. Each operation is one transaction with the caller's role, through the same database functions the app calls: storefront checkout (`record_fraud_check` + `place_storefront_order`), the owner approving (`approve_orders`) and moving orders on (`transition_order_status`), and the Search page's phone search as the signed-in owner. Results in `docs/load-test-results.json`.

| Measure (16 clients) | Result |
|---|---|
| Web orders placed | 134 per second, p50 70 ms, p95 390 ms, 0 errors |
| One client alone | 42 per second, p50 22 ms |
| Status changes (approve → processing → packing → ready to ship) | 561 per second, p95 46 ms, 0 errors |
| Phone search while orders keep arriving | 603 per second, p95 25 ms |
| Orders placed during that search load | 60 per second, p95 291 ms |

| Item | Finding | Status |
|---|---|---|
| **Deadlock between web orders** | Found by the load test: order creation reserved stock line by line in cart order, so two carts holding the same products in opposite order locked the same stock rows in opposite order and Postgres aborted one ("deadlock detected"). A customer's order failed. With every cart holding the same two products, 20 of 139 orders failed in 10 seconds. | **FIXED** (`20261109002400_stock_lock_order.sql`): order creation, item edits, shipping, releases and returns lock the stock rows they need in one fixed order (by variant) first. The functions are patched in place, so earlier patches (store imports without a district) stay. Same stress after the fix: 456 orders, **0 deadlocks**, and 77% more orders per second. New `stock-lock-order.test.ts` fails without the fix and passes with it. |
| What limits order speed | Waits sampled during the run: mostly row locks on the same few stock rows (every test order used the same 10 products) and CPU. That is the database keeping stock exact: two orders for the last unit cannot both win. Different products, and different stores, do not wait on each other. | By design |
| Admin refreshing on order bursts | Realtime sends one event per changed order, and every event refetched every open order list at once; a bulk approval of 200 orders sent hundreds of requests, and a store import popped one toast per order. | **FIXED**: events are gathered for 0.6 s, so a burst refetches once and shows one "N new orders" toast (`src/lib/batch.ts`, unit tests 2/2). |
| Indexes | Search: trigram indexes added for store order numbers, tracking and consignment IDs, payment transaction IDs and references (`20261109002200_search_indexes.sql`); name, phone and invoice number already had theirs. Order lists use the existing (merchant, status, created) indexes. | Added; applied to live in R11 |
| Pagination | Order lists are paged in the database (25 a page) through `search_orders`; exports stop at 5,000 rows; search returns 50. | PASS |
| Caching | Order lists: 15 s result cache in the browser plus realtime refresh; dashboards use their own stale times; Cloudflare caches the app's static files at the edge (hashed file names, long cache). Orders, stock and money are never cached in KV (owner's rule). | PASS |
| External API rate limits | Covered in §2: read calls to Meta, TikTok, Google and BD Courier retry on 429/5xx with back-off and Retry-After; one failing account never stops the others. | FIXED (§2) |
| Load balancing | The Worker runs in every Cloudflare location and scales by itself; there is no single server to balance. The database is one Supabase Postgres reached through Supabase's connection pooler; requests from the Worker and the browser go through PostgREST, which pools connections. A larger Supabase compute size is the lever if traffic grows past the numbers above. | Documented |
| Speed of store orders (Shopify/WooCommerce) | Webhooks are handled by the `channels` function on Supabase, one database call per order (`channel_ingest_order`, the same creation path as above, so the deadlock fix covers them). | PASS; the function itself is not redeployed (see §1 of round 1) |

## 5. Super Admin on phones, live users, capacity (R7)

Probe: `scratchpad/r2/run-mobile-all.cjs` runs the real Worker locally (site, the 22 functions, the Cloudflare database), signs in a store owner and a Super Admin, and opens 108 pages in Chromium at 390 × 844 (phone emulation). Overflow is measured against the screen width: a phone browser zooms out to fit a too-wide page, so comparing with the window width (as round 1 did) hid real overflow.

| Item | Finding | Fix | Result |
|---|---|---|---|
| Super Admin pages scrolled sideways on phones | The header's search button had no `min-w-0`, so its placeholder pushed every page wider than the phone. Tables in Super Admin scrolled sideways inside cards. The new-merchant stepper and System Health cards were too wide. | Header fixed; Super Admin tables stack into label/value cards under 640 px (labels taken from each column's header automatically, `useCellLabels`); stepper shows only the current step's name on phones; Health cards wrap long values; tab bars wrap instead of overflowing. | **PASS**: 27 Super Admin pages (all sections, tabs, a merchant, new merchant, Live): 0 px page overflow and 0 sideways scrollers |
| Rest of the app on phones | Same probe over 81 site, store and admin pages. | — | **PASS**: 0 px page overflow on all. 17 pages have a sideways strip inside the page, all deliberate: swipeable chip rows (status tabs, quick actions) and wide data tables scrolling inside their own card. |
| "Who is using our SaaS" | New **Super Admin → Live & Capacity**: online now (last 2 minutes), stores working now, last 15 minutes, today, each person with role, store, section and device, and store visitors in the last 5 minutes. The admin and Super Admin send a heartbeat once a minute while a tab is visible and on each new section (at most every 20 s); ids in paths are blanked. Only people with the merchants permission can read it. | `20261109002300_presence_capacity.sql`, `src/lib/presence.ts`, `src/pages/super-admin/live.tsx` | **PASS**: probe shows the owner and the Super Admin online with their sections; `presence-capacity.test.ts` 4/4 (staff can only ping, a limited role cannot read, ids blanked, numbers right) |
| "How many orders can it take" | Same page: orders in the last hour, 24 h, 7 days, busiest minute and hour, status changes, orders in each status, database connections and size, and the load-test result (§4) with today's headroom. | `platform_capacity()`, `capacity-benchmark.ts` | **PASS** (local); live after the migration in R11 |

## 6. Design: buttons, quick actions, toasts, custom domain (R8)

Check: `scratchpad/r2/run-design.cjs` on the local Worker in Chromium, 14 of 14 passed.

| Item | What changed | Result |
|---|---|---|
| Buttons everywhere | Every filled and outlined button in the admin, Super Admin and website is raised like the sample: a light top edge, a darker bottom lip, a soft glow, and it presses down when clicked (`.btn-3d` in `index.css`, used by the shared `Button`). **Black** was chosen over blue: the admin, Super Admin and the default website are black and grey, and blue is kept for links and status. Blue (brand) and red (delete) buttons get the same treatment; in dark mode the black button turns white with a grey lip. Plain text and icon buttons stay flat. | **PASS**: computed shadow checked on the website and admin; screenshots |
| Quick actions (New order, Add product, …) | Same raised design, white, same size (32 px) and round shape, not blue. | **PASS** |
| Toasts in Poppins | The toast library set the system font on its wrapper; it now uses Poppins like the rest of the app. | **PASS**: computed font of a real toast is Poppins |
| Custom domain add + toast | Round 1 tested the domain functions (`sites-domains` 4, DNS/HTTPS checker unit tests); not re-run. Adding a domain in the browser saves it and shows the success toast. No domain has ever been added on live (`store_domains` is empty). | **PASS** (local); live DNS/HTTPS **BLOCKED** (no domain added; hosts unreachable from here) |
| Domain status popup | The screen recording shared was a reference for a 3D globe. The popup now shows a dark globe that turns slowly: drag to turn it, hover a country to see its name, one pin per DNS-check region (blue = sees the domain, red = not yet), over the red/blue status band. The world map (100 KB) loads only on this page. | **PASS**: globe drawn, hover shows country names |

## 7. Website, logo, promo video, sign-up WhatsApp (R9)

| Item | What changed | Result |
|---|---|---|
| New logo | Wordmark redrawn from the new artwork, measured from its pixels: the "i" after "f" cut on the F's slant, a round dot on the last "i", the "o" drawn as the cube from the app icon, an even 16-unit gap between letters. Used in the admin, Super Admin, sign-up, website and `public/fullfilio-wordmark.svg`. | **PASS**: traced paths overlaid on the artwork within 1–2 px |
| "See it in 30 seconds" video | Replaced with the new promo (38 s): 1280×720 MP4 (1.7 MB, was 19 MB uploaded) and WebM (1.3 MB), new poster. New file names, because media is cached for a week and returning visitors would otherwise keep the old video. | **PASS**: served, plays; label reads 0:38 |
| White version of the website | Every website page now draws from colour tokens with a black set (default) and a white set; a sun/moon button in the header switches, and the choice is remembered in the browser. Product demos stay dark in both. | **PASS**: opens black, switches to white, remembered after reload, fits a phone |
| Sign-up asks for WhatsApp | New field under the mobile number: "Same as my mobile number" (default) or another number (Bangladesh or international). Checked in the browser and in the database (`20261109002500_signup_whatsapp.sql`, patched in place), stored with the business's onboarding details, and shown in Super Admin → Merchant → Profile with an "open chat" link for creating the group. | **PASS**: `self-onboarding.test.ts` 4/4 (default, +880 written short, international kept, nonsense refused) |
