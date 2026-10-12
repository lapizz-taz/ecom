# Fullfilio — full system audit (A–Z)

Started 2026-10-12. This file is the audit's working record: it is updated as
each phase runs so the audit can resume from here after any interruption.
Nothing here is marked PASS without an executed test and its evidence.

Statuses: **PASS** tested with evidence · **FAIL** executed and failed ·
**BLOCKED** cannot run (dependency or access) · **NOT TESTED** not yet executed.

## 0. Where the audit runs, and what it cannot reach

- Code: `/home/user/ecom/commerce` on branch `claude/optimistic-cray-c2d0fc`.
- Local Postgres (`localhost:5432`) runs the database suite against a fresh
  database built from every migration. The Cloudflare database engine
  (`worker/db`) runs the same suite in-process.
- A local Cloudflare Worker (`wrangler dev`) can serve the API and the built
  site on one address, so the admin can be driven in Chromium (Playwright).
- Live Supabase (`tcjdgiohmhjqppzwoztj`) is reachable read-only through the
  Supabase tools (SQL, advisors, migration list). Live Cloudflare: Workers,
  KV, R2 listings and the deployed Worker code.
- **Not reachable from this sandbox:** `https://fullfilio.com` and
  `https://*.supabase.co` over HTTP (the egress proxy refuses them), the Vercel
  team that holds the old `commerce` project (token lacks the scope), real
  e-mail delivery (OTP codes), and every live provider account (couriers,
  payments, SMS, ads) — those stay BLOCKED or sandbox-only below.

## 1. System inventory

### 1.1 Applications in the repository

| App | Path | Role | In this audit |
|---|---|---|---|
| Fullfilio web app (website, stores, merchant admin, Super Admin) | `commerce/src` | React 19 + Vite SPA | Yes |
| Database | `commerce/supabase/migrations` (102 files) | PostgreSQL on Supabase; all business rules | Yes |
| Edge functions | `commerce/supabase/functions` (22) | Deno; secrets and outside services | Yes |
| Cloudflare Worker | `commerce/worker` | Serves the site, relays `/functions/*`, `/__clerk`, files; hosts the 22 functions and 12 cron jobs; optional Cloudflare database (off: `DATABASE_BACKEND=supabase`) | Yes |
| WooCommerce plugin "Fullfilio Connect" 1.2.0 | `commerce/integrations/woocommerce` | WP ≥ 6.2, PHP ≥ 7.4, WC 7.8–9.9 | Yes (plugin logic via its tests; a live WordPress is BLOCKED here) |
| PBX gateway (Asterisk + controller + coturn) | `commerce/pbx-gateway` | Deployed separately for VoiceDrive | Controller unit tests only |
| "Isolation AI assistant" | repository root (`src/`, `prisma/`, Next.js) | A separate product (AI sales assistant for Isolation's DMs); last change 2026-10-01 | Out of scope — not Fullfilio. Listed so it is not mistaken for dead code. |

### 1.2 Frontend routes

Which audience a visitor gets is decided at start-up (`storefront_resolve`):
the platform address shows the website, `/s/<store>`, `<store>.fullfilio.com`
or a custom domain shows that store.

**Merchant admin (`/admin`, 79 routes, 71 page files)** — every route names
the permission the layout and the database both check (blank = any signed-in
staff):

| Route | Page | Permission |
|---|---|---|
| `/admin` | dashboard | dashboard.view |
| search | search | orders.view |
| orders, orders/web, orders/approved, orders/block-list, orders/auto-pick, orders/call-center, orders/abandoned, orders/dashboard, orders/:id, orders/:id/invoice, orders/:id/packing-slip | orders, web-orders, approved-orders, block-list, auto-pick, call-center, abandoned-carts, orders-dashboard, order-detail, order-print | orders.view |
| orders/new | order-new | orders.create |
| orders/:id/edit | order-edit | orders.update |
| orders/fraud | fraud-review | fraud.view |
| orders/super-edit | super-edit | orders.override |
| labels, orders/sheets, scan | labels, order-sheets, scan | orders.fulfill |
| products, products/:id | products, product-edit | products.view |
| products/new | product-edit | products.manage |
| inventory, inventory/movements, inventory/adjustments, store/sync, store/shopify-sync | inventory, inventory-movements, inventory-adjustments, shopify-sync | inventory.view |
| purchases, purchases/:id | purchases, purchase-edit | purchases.view |
| purchases/new | purchase-edit | purchases.manage |
| production, production/:id | production, production-detail | production.view |
| customers, customers/:id | customers, customer-detail | customers.view |
| couriers, courier-management, courier-invoices | couriers, courier-management, courier-invoices | couriers.view |
| store/website, label-builder, channels, settings, settings/billing, settings/apps, settings/developers | website, label-builder, sales-channels, settings, plan-billing, app-integrations, developers | settings.view |
| store/theme | store-theme | settings.manage |
| finance, finance/income-expense, finance/income, finance/expenses, finance/accounts, finance/refunds, finance/profit-loss, finance/cash-flow | finance, finance-ledger, redirects, finance-accounts, finance-refunds, finance-pnl, finance-cash-flow | finance.view |
| reports | reports | reports.view |
| ads, marketing, marketing/tiktok, marketing/google | ads-hub, marketing, tiktok-ads, google-ads | marketing.view |
| sms | sms | sms.view |
| coupons | coupons | coupons.manage |
| settings/devices | device-approvals | devices.manage |
| settings/pbx | pbx | orders.view |
| settings/voicedrive-pbx | voicedrive-pbx | pbx.call |
| users | users | users.manage |
| hr, hr/attendance | hr | (any staff) |
| hr/report, hr/shifts, hr/departments, hr/settings | hr | hr.view |
| audit-logs, system-logs | audit-logs, system-logs | audit.view |
| help, updates, announcements, support/bugs, support/feedback, status, account | help-center, updates, announcements, support-tickets, system-status, account | (any staff) |

**Super Admin (`/super-admin`, 23 page files)**: login, overview, merchants
(list/new/:id), employees, subscriptions, credits, sms, bd-courier,
integrations, features, support, pbx, usage, automation, health, incidents,
notifications, audit, security, data, settings — each gated by its platform
module. Entry is a secret path (`VITE_SUPER_ADMIN_PATH`).

**Storefront (16 page files)**: `/`, shop, collection/:slug, search,
product/:slug, cart, checkout, order-success, track-order, login, register,
forgot-password, reset-password, account, account/orders/:id, contact,
policies, policies/:policy, not-found.

**Website (6)**: `/`, contact, blog, blog/:slug, not-found, `/login` →
`/admin/login`. **Onboarding (2)**: `/start`, `/start/finish`. **Auth**:
`/admin/login`, `/admin/forgot-password`, `/admin/reset-password`.

Navigation (`features/shell/nav-config.tsx`) exposes 90 labelled entries;
every one maps to a route above (checked when the crawl runs — §7).

### 1.3 Backend: edge functions (22) and the Worker

| Function | Actions / purpose |
|---|---|
| ad-platforms | auth_url, disconnect, save_app, sync (TikTok, Google Ads) |
| admin-users | create, deactivate, list, reactivate, set_role |
| api | public REST API for merchants (API keys) |
| billing | subscription billing run, invoices, gateway payments |
| channels | shopify_connect, shopify_token, shopify_client, woo_connect, woo_keys, plugin_pair/code/config/status, import_catalog, sync, process_jobs, retry_import, order_action, abandoned_sync, test, webhooks (inbound Shopify + plugin), disconnect, reconnect |
| checkout | storefront checkout (fraud check + order) |
| clerk-auth, clerk-proxy, clerk-webhook | Clerk session exchange, Clerk front-end relay, Clerk user webhooks |
| courier | connect, test_connection, create_shipment(s), cancel_shipment, tracking, sync_status, sync_all, delivery_cost, courier_stores, save_options, set_webhook_secret, disconnect |
| courier-webhook | inbound courier status events (Pathao signed webhooks; Steadfast/RedX polled) |
| domains | add, check, list, primary, remove (custom store domains, Cloudflare for SaaS) |
| fraud-check | phone risk check (internal history + courier-history provider) |
| meta-ads | save, test, sync, disconnect |
| notifications-dispatch | outbound notifications (Resend e-mail, webhooks) |
| payment-webhook | bKash, PayStation, SSLCommerz, manual confirmations |
| payments | gateway payment creation/verification (bKash, PayStation) |
| pbx, voicedrive | VoiceDrive PBX: gw_inbound_start, gw_outbound_start, gw_answered, gw_ended, gw_ping, gw_trunks; credentials, TURN, packages |
| platform-admin | create_merchant, set_owner, invite_employee, sms_connect/disconnect/send_test/balance, bd_courier_connect/disconnect/test, gateway_connect/disconnect, pbx_gateway_token/trunk_secret/turn_secret, backups, health |
| site-api | custom-coded website API (storefront data for merchants' own sites) |
| sms | send / provider relay |

Worker (`worker/index.ts`): `fetch` (site assets, `/functions/*`, `/__clerk`,
`/oauth/shopify/callback`, `/files/*`, `/rest|/auth|/realtime` when the
Cloudflare database is on) and `scheduled` (every minute; 12 jobs:
billing-run 7 * * * *, platform-ops */10, courier-webhook-retry */5,
expire-unpaid-advance-orders */15, voicedrive-sweep *, account-removals *,
channel-sync-jobs *, channels-sync 37 * * * *, meta-ads-sync 17 */3,
ad-platforms-sync 47 */3, notifications-dispatch *, payments-reconcile */5).
Bindings: ASSETS, DATABASE (Durable Object), CACHE (KV), FILES (R2
`fullfilio-files`), plus a staging environment with its own KV/R2.

Supabase `pg_cron` (what runs today, database on Supabase): billing-run,
courier-webhook-retry, expire-unpaid-advance-orders, platform-ops,
voicedrive-sweep. The other 7 jobs are invoked by the Worker's scheduler
calling the edge functions (channels sync, ads sync, notifications,
payments reconcile, account removals).

### 1.4 Database

167 tables (all in `public`), 882 function definitions (≈450 distinct),
12 views, 129 triggers, 137 policies, 266 indexes, 39 enums.

- **Row security:** enabled on 151 tables. The 16 without it: api_keys,
  api_request_logs, billing_invoices, billing_payments, credit_balances,
  credit_ledger, credit_lot_usage, credit_lots, merchant_features,
  merchant_order_fees, merchant_service_overrides, order_fee_charges,
  service_usage, subscription_addons, subscription_events, subscriptions.
  Whether any of these is reachable through the API is checked in §5 (F-003).
- **Order statuses (enum `order_status`, 28):** PENDING, FRAUD_CHECK,
  ADVANCE_REQUIRED, FRAUD_REVIEW, CONFIRMATION_REQUIRED, CONFIRMED,
  PROCESSING, PRODUCTION, QUALITY_CHECK, PACKING, READY_TO_SHIP, SHIPPED,
  OUT_FOR_DELIVERY, DELIVERED, PARTIALLY_DELIVERED, FAILED_DELIVERY,
  RETURN_REQUESTED, RETURN_INITIATED, RETURNING, RETURNED, CANCELLED,
  PENDING_CANCEL, LOST, REJECTED_FRAUD, PRE_ORDER, PRE_ORDER_CONFIRMED,
  PAYMENT_FAILED, PAYMENT_RECEIVED.
- **Allowed transitions (table `order_status_transitions`, 84 rows):**
  PENDING→{ADVANCE_REQUIRED, CANCELLED, CONFIRMATION_REQUIRED, CONFIRMED, FRAUD_CHECK};
  FRAUD_CHECK→{ADVANCE_REQUIRED, CANCELLED, CONFIRMATION_REQUIRED, CONFIRMED, FRAUD_REVIEW, REJECTED_FRAUD};
  FRAUD_REVIEW→{ADVANCE_REQUIRED, CANCELLED, CONFIRMATION_REQUIRED, CONFIRMED, FRAUD_CHECK, REJECTED_FRAUD};
  ADVANCE_REQUIRED→{CANCELLED, CONFIRMATION_REQUIRED, CONFIRMED, FRAUD_CHECK, FRAUD_REVIEW, REJECTED_FRAUD};
  CONFIRMATION_REQUIRED→{ADVANCE_REQUIRED, CANCELLED, CONFIRMED, FRAUD_CHECK, FRAUD_REVIEW};
  REJECTED_FRAUD→FRAUD_REVIEW; CONFIRMED→{CANCELLED, PRE_ORDER, PROCESSING};
  PRE_ORDER→{CANCELLED, PACKING, PROCESSING, PRODUCTION, READY_TO_SHIP};
  PROCESSING→{CANCELLED, PACKING, PRE_ORDER, PRODUCTION, READY_TO_SHIP};
  PRODUCTION→{CANCELLED, PACKING, QUALITY_CHECK}; QUALITY_CHECK→{CANCELLED, PACKING, PRODUCTION};
  PACKING→{CANCELLED, READY_TO_SHIP}; READY_TO_SHIP→{CANCELLED, PACKING, PENDING_CANCEL, SHIPPED};
  SHIPPED→{DELIVERED, FAILED_DELIVERY, LOST, PARTIALLY_DELIVERED, PENDING_CANCEL, RETURNING, RETURN_REQUESTED};
  PENDING_CANCEL→{CANCELLED, DELIVERED, LOST, READY_TO_SHIP, RETURNED, RETURNING, SHIPPED};
  FAILED_DELIVERY→{LOST, PARTIALLY_DELIVERED, RETURNED, RETURNING, SHIPPED};
  RETURN_REQUESTED→{DELIVERED, LOST, RETURNED, RETURNING}; RETURNING→{LOST, RETURNED};
  LOST→{DELIVERED, RETURNED}. **Final by table:** DELIVERED, PARTIALLY_DELIVERED,
  RETURNED, CANCELLED (only Super Edit's override may leave them; it must not
  be reachable through the normal transition — tested in §6).
- Order sources: STOREFRONT, ADMIN, IMPORT, API. Order intake functions:
  `place_storefront_order` (fraud-checked checkout), `_create_order`,
  `admin_create_order`, `site_api_place_order`, channel imports
  (`channels` function → `_create_order` with source IMPORT and the
  source-store ids). Stock: `_reserve_order_item`, `_release_order_stock`.
- Roles per merchant (8): OWNER, ADMIN, MANAGER, ORDER_MANAGER,
  INVENTORY_MANAGER, PRODUCTION_MANAGER, FINANCE_MANAGER, VIEWER. 44
  permission codes (`orders.view`, `orders.fulfill`, `orders.override`,
  `finance.manage`, `settings.manage`, …). Super Admin: 20 platform modules.

### 1.5 Integrations

| Area | Providers | Direction |
|---|---|---|
| Sales channels | Shopify (OAuth/client-credentials app; webhooks orders/updated, products/create, products/update; GraphQL fulfilment, inventory, draft orders, returns), WooCommerce (REST keys + "Fullfilio Connect" plugin events), built-in store, custom site API | in + out |
| Couriers | Pathao (API + signed webhook), Steadfast (API, polling), RedX (API, polling); BD Courier (platform-level rate/history lookups) | out + in |
| Payments | bKash, PayStation (gateways); SSLCommerz and manual webhook confirmations | out + in |
| Fraud | internal order/phone history; courier-history provider (LLCG) | out |
| SMS | provider registry (merchant or platform credentials) | out |
| Ads | Meta Graph, TikTok, Google Ads | out |
| Notifications | Resend (e-mail), generic webhooks | out |
| Sign-in | Clerk (sessions, OTP e-mail codes) ↔ Supabase Auth users | in + out |
| Telephony | VoiceDrive PBX (Asterisk gateway, TURN) | in + out |
| Hosting | Cloudflare (Worker, KV, R2, custom domains); Supabase (Postgres, Auth, Storage, Edge, cron); Vercel (legacy `commerce` project) | — |

### 1.6 Configuration (names only, never values)

Browser (`VITE_*`): SUPABASE_URL, SUPABASE_ANON_KEY, SUPER_ADMIN_PATH,
CLERK_PUBLISHABLE_KEY, CLERK_PROXY_URL, DATABASE_BACKEND, FUNCTIONS_URL,
FILE_STORE, SENTRY_DSN/ENVIRONMENT/RELEASE.
Worker vars: PLATFORM_URL, FUNCTIONS_URL, CLERK_PROXY_URL,
CLERK_AUTHORIZED_PARTIES, CUSTOM_DOMAIN_TARGET, DATABASE_BACKEND,
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_FUNCTIONS. Worker secrets read:
SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY, AUTH_JWT_SECRET,
FILES_SIGNING_KEY, FILES_PUBLIC_URL, SUPABASE_DB_URL (copy only).
Edge functions read secrets through `_shared/env.ts`; merchant and platform
provider credentials are stored in Vault (`vault.secrets`), never in tables.

### 1.7 Existing automated tests

| Suite | Files / tests | Command |
|---|---|---|
| Unit (app, worker, edge `_shared`, PBX controller) | 47 files / 351 tests | `npm run test:unit` |
| Database on Postgres | 63 files / 441 tests | `TEST_DATABASE_URL=… npm run test:db` |
| Same suite on the Cloudflare engine | 63 / 441 | `CF_DB_TESTS=1 vitest run --project cfdb` |
| Worker runtime end-to-end (workerd) | 18 checks | `npm run db:e2e` |
| Edge function type-check | 22 functions | `npm run functions:check` |
| Browser (admin UI) | none existed; this audit adds a Playwright crawl (§7) | — |

Database test files by area: checkout-fulfillment(23), tenancy(23),
fraud(22), finance-payments(19), plans-features(15), inventory(14),
pricing(13), voicedrive-pbx(12), courier-ops(11), credits-usage(11),
security(11), sms(11), workflow(11), order-sync-v3(10), platform-admin(10),
store-import-fixes(10), coupons(9), order-queues(9), woo-plugin(9),
attribution(8), gateway-payments(8), meta-ads(8), order-tools(8),
returns-bulk(8), sales-channels(8), shopify-sync(7), store-addresses(7),
platform-operations(7), store-sync-v2(6), ad-platforms(5), courier-history(5),
meta-accounts(5), order-fee-reset(5), order-financials(5), shell(5),
support-center(5), abandoned-carts(4), data-security(4), merchant-delete(4),
order-lists(4), seed(4), settings-support(4), sites-domains(4), smart-merge(4),
store-numbers(4), business-analytics(3), channel-catalog(3), external-api(3),
file-access(3), pbx-platform(3), platform-cleanup(3), self-onboarding(3),
site-contact(3), store-mode-products(3), courier-parcels(2),
customer-districts(2), finance-ads-report(2), hrm(2), merchant-user-delete(2),
one-store(2), system-logs(2), district-reader(1), inventory-insights(1).

## 2. Architecture and data flow (Phase 2)

See `docs/ARCHITECTURE.md` for the layering (screens → services → database
functions). Order flows traced in this audit:

1. **Storefront checkout:** browser → `checkout`/`fraud-check` function →
   `record_fraud_check` → `place_storefront_order` (atomic: customer upsert,
   stock reservation, fraud verdict → PENDING / FRAUD_REVIEW /
   ADVANCE_REQUIRED, payment requirement) → Web Orders.
2. **Shopify:** webhook `orders/updated` (HMAC-verified) or hourly
   `channels-sync` → `channel_order_imports` row keyed by the Shopify order id
   (idempotent) → `_create_order` (source IMPORT) or safe update → Web Orders;
   status changes back to Shopify through `channel_sync_jobs`.
3. **WooCommerce:** plugin events (paired secret, HMAC) or REST import →
   same import table and idempotency key → orders; status/stock pushed back.
4. **Admin/API:** `admin_create_order`, `site_api_place_order` (API keys).
5. **Fulfilment:** CONFIRMED → PROCESSING → READY_TO_SHIP → `assign_courier`
   (courier function creates the shipment) → SHIPPED → courier webhooks /
   polling (`apply_shipment_status`) → DELIVERED / FAILED_DELIVERY / RETURN… →
   finance ledger (`finance_transactions`) and stock release/restock.

(Each step's tests and results are recorded in §4–§7.)

**Deployment architecture, as actually found (not as documented):**

```
browser ──► Cloudflare Worker "fullfilio" (routes fullfilio.com/*, *.fullfilio.com/*)
             ├─ static site (Workers Static Assets, SPA fallback)
             ├─ /functions/v1/<17 functions> run in the Worker (checkout, fraud-check, payments, clerk-auth, …)
             ├─ /functions/v1/{channels, courier, meta-ads, ad-platforms, notifications-dispatch} relayed to Supabase Edge Functions
             ├─ /__clerk proxy → Clerk (sign-in); KV "fullfilio-cache"; R2 "fullfilio-files"
             ├─ cron every minute → 12 scheduled jobs (in-process)
             └─ DATABASE_BACKEND=supabase → Supabase Postgres (tcjdgiohmhjqppzwoztj): REST, Auth bridge, Realtime, RLS + SECURITY DEFINER functions
                 (DATABASE_BACKEND=cloudflare → Durable Object SQLite engine: built, tested, switched off)
Shopify / WooCommerce plugin / couriers / payment gateways ──► webhooks ──► the same function URLs
```

Deploys: the Worker is deployed by hand (`wrangler deploy`); Workers Builds
is **not** deploying pushes (F-005). Database changes go through Supabase
migrations applied by hand (three pending, §4.5). The five relayed functions
are deployed to Supabase separately (five behind, F-007).

## 3. Baseline: existing tests as found (Phase 3)

| Suite | Result | Evidence |
|---|---|---|
| Unit | 349 passed, 2 skipped, 0 failed | `npx vitest run --project unit` 2026-10-12 |
| Database on Postgres | **441 passed / 441** | `audit-db-pg.log` |
| Database on the Cloudflare engine | 436 passed, 1 failed, 4 skipped | `audit-db-cf.log`: the failure is `voicedrive-pbx › seats limit agents…` (engine-only, known since the port; Postgres passes); the 4 skipped are `seed.test.ts`, which needs Postgres |
| Edge function type-check (Deno 2.9.6) | all 22 pass | `npm run functions:check` |
| Typecheck (app + worker) | pass | `npm run typecheck` |
| Production build / Cloudflare build | pass (20 s; chunk-size warning only) | `npx vite build`, `npm run build:cloudflare` |
| Worker runtime e2e | see `audit-db-e2e.log` | `npm run db:e2e` |

## 4. Feature matrix

Legend per feature: **Logic** = business rules exercised by database/unit
tests (file named); **UI** = driven in a browser; **Live** = verified against
production. A feature is PASS only when every applicable column is PASS.

_Filled in as phases 4–7 run; the first version lists every module with its
starting status._

| # | Module / feature | Logic | UI | Live | Status | Notes |
|---|---|---|---|---|---|---|
| A1 | Sign-up, Clerk OTP, sign-in, sessions, password reset | PASS — unit: clerk-link-notice, clerk-proxy, auth-links; db: self-onboarding, security, tenancy; Worker e2e: sign-in token once, session renew, sign-out, forged token refused (19/19) | Sessions injected (Clerk unreachable here): login/sign-up pages render only Clerk's component (F-013); `/admin/login`, `/super-admin/login` reachable at all widths | BLOCKED (real OTP e-mail and Clerk sign-in need a mailbox + Clerk test instance) | **PASS (logic) / BLOCKED (live OTP)** | |
| A2 | Roles, permissions, device approvals, staff sessions | PASS — db: tenancy(23), security(11), settings-support, plans-features, status-matrix › roles, finance-reconciliation › permissions (VIEWER / FINANCE_MANAGER / ORDER_MANAGER refused by the database) | PASS — VIEWER kept out of finance, users, settings, new order/product, theme; navigation trimmed (§4.4) | — | **PASS** | permissions enforced in the database and mirrored in the UI |
| A3 | Tenant isolation (cross-merchant reads/writes) | PASS — db: tenancy(23: every table has row security, every definer function is `app_owner`-owned, cross-merchant reads empty / writes refused), security, data-security, function-grants (no PUBLIC grant; visitors limited to 27 helpers) | — | Live: every table has RLS (F-003 closed); but 279 definer functions are still `postgres`-owned (F-002) and `anon` can still read plan/usage helpers until `002100` is applied (F-008) | **PASS (repository) / OPEN on live (F-002, F-008)** | |
| A4 | Super Admin modules (20) | PASS — db: platform-admin(10), platform-operations(7), platform-cleanup, credits-usage, plans-features, pbx-platform | PASS — all 23 routes render as SUPER_ADMIN at 3 widths; made-up path handled; `device_register` 403 noise (F-012) | — | **PASS** | |
| S1 | Shopify connect, import, webhooks, sync back | PASS — db: shopify-sync(7), order-sync-v3(10), store-sync-v2(6), channel-catalog(3), smart-merge(4), store-import-fixes(10), ingest-concurrency(1); unit: channels, channel-sync, channel-catalog; scenario map §4.3 | PASS — Sales channels, Store sync pages render | Read-only (§4.2): 62 webhook deliveries in 7 days, 7 imported / 31 skipped with reasons / 0 failed in 30 days; Shopify paused by configuration; live `channels` function predates the repository (F-007) | **PASS (logic) / OPEN on live (F-007)** | no real Shopify order was created |
| S2 | WooCommerce connect, plugin, import, sync | PASS — db: woo-plugin(9), sales-channels(8), one-store(2); unit: woo-plugin | PASS — channel pages render | Read-only: live plugin deliveries this week (`plugin.order` 2, `plugin.lead` 2, `order.created/updated`, `product.updated`); merchant 1 sells through WooCommerce now | **PASS (logic) / BLOCKED (no WordPress to drive here)** | |
| S3 | Built-in store: catalog, cart, checkout, theme, domains | PASS — db: checkout-fulfillment(23), pricing(13), coupons(9), store-addresses(7), sites-domains(4), store-mode-products(3); unit: theme, storefront | **PASS — real checkout in Chromium on a phone through the full Worker: product → cart → form → phone check → confirm → success → tracking → admin (§4.4, 17/18; the one failure is the engine-only F-011, fixed)**; all 15 storefront pages at 3 widths; theme editor browser run 14/14 (F-001) | DNS/SSL BLOCKED (host unreachable) | **PASS** | |
| S4 | Channel selection (Our store / Shopify / Woo / none) persisted and enforced | PASS — db: one-store(2: only the picked store syncs, others pause and catch up), store-mode-products, sales-channels; theme run switched SHOPIFY → OWN and the storefront followed | PASS — Sales channels page renders; mode badge in the theme editor ("Selling on Shopify" / "Online") | Live: mode WOOCOMMERCE, Shopify paused as configured (§4.2) | **PASS** | |
| O1 | No order lost: idempotency, duplicates, out-of-order, retries, dead-letter | **PASS** — every scenario of the brief mapped to a passing test in §4.3 (order-sync-v3, store-import-fixes, shopify-sync, one-store, smart-merge, **ingest-concurrency** for the same-instant race); browser: two checkouts → two orders, stock reserved exactly 2 (§4.4) | — | Live: 0 FAILED imports in 30 days; every skip has a reason (§4.2) | **PASS** | |
| O2 | Status matrix (23 statuses, every pair), roles, stock, courier, sync, finance per transition | **PASS** — db: workflow(11), order-tools(8), order-queues(9), returns-bulk(8), checkout-fulfillment; **new status-matrix(3)**: all 23×22 moves, roles, repeated move; **finance-reconciliation(4)**: money and stock per outcome (§4.1) | crawl §4.4 | — | PASS (logic) / UI see §4.4 | F-010 found and fixed by the matrix test |
| O3 | Bulk updates, scan-to-update, Super Edit override, courier webhook updates, concurrency | PASS — db: returns-bulk(8), order-tools(8), courier-ops(11), status-matrix (Super Edit route finder; F-010 fixed), Worker e2e "20 people taking the last 10 at once" | PASS — Super Edit, Scan, Bulk pages render at 3 widths | Live: `_order_status_path` still lacks `001700` + `002000` (§4.5) | **PASS (repository) / OPEN on live (migrations pending)** | |
| I1 | Products/variants, stock ledger, reservations, exactly-once restock, concurrency | PASS — db: inventory(14), inventory-insights, checkout-fulfillment, store-sync-v2, store-import-fixes ("moves stock exactly once at each step"), finance-reconciliation (stock per outcome: 17/1 and 19/0), status-matrix (cancel releases the reservation); Worker e2e: 20 parallel takers of 10 units → exactly 10 succeed | PASS — products, inventory, movements, adjustments pages render; product saved via the admin function with opening stock, shown "In stock" on the storefront | — | **PASS** | |
| C1 | Couriers: connect, book, cancel, track, labels, webhooks, invoices, reconciliation | PASS — db: courier-ops(11), courier-parcels(2), courier-history(5), status-matrix (courier required before SHIPPED), finance-reconciliation (courier 80 / return 60 / lost-parcel cost per outcome); unit: courier, courier-webhooks, statement-parse | PASS — couriers, courier management, invoices, labels, label builder pages render at 3 widths | BLOCKED — no sandbox credentials; a live booking would create a real parcel | **PASS (logic) / BLOCKED (live provider calls)** | |
| F1 | Fraud checks, block list, duplicates, advance payment | PASS — db: fraud(22), gateway-payments(8), finance-payments (advance refund without P&L effect); unit: providers, courier-history; browser: the checkout's phone check ran through the `checkout` + `fraud-check` functions on the full Worker (§4.4) | PASS — fraud review, block list, duplicates pages render | BLOCKED — the BD Courier history provider and bKash/PayStation need live credentials; never called | **PASS (logic) / BLOCKED (live providers)** | |
| M1 | Abandoned carts, auto-pick, call centre, messages/SMS, purchases, production, HRM, customers/districts, coupons, ads/attribution, support, announcements | PASS — db: abandoned-carts, sms(11), hrm(2), customer-districts, attribution(8), meta-ads(8), ad-platforms(5), support-center(5), coupons(9), purchasing, production | PASS — every one of these pages renders at 3 widths as OWNER (§4.4); customer detail with the checkout's customer; missing purchase/production ids handled | BLOCKED — SMS, Meta/TikTok/Google ads need live credentials; never called | **PASS (logic + UI) / BLOCKED (live providers)** | |
| $1 | Finance: ledger, P&L, order financials, refunds, COD, courier charges, cash flow, exports | **PASS** — db: finance-payments(19), order-financials(5), finance-ads-report(2), business-analytics(3), gateway-payments(8); unit: order-financials; **new finance-reconciliation(4)**: hand count of 7 outcomes equals statement, order financials and dashboard (§4.1) | crawl §4.4 | — | PASS (logic) / UI see §4.4 | independent recomputation done (§4.1) |
| X1 | Public API (API keys, rate limits) | PASS — db: external-api(3: key issue/revoke, feature gate, request logging); function-grants (helpers not public) | PASS — Developers page renders | — (no live key used) | **PASS (logic)** | |
| D1 | Deployment: Cloudflare Worker build/branch, Supabase migrations, secrets present, cron, webhooks, DNS/SSL | builds: `vite build`, `build:cloudflare`, `wrangler deploy --dry-run` (§3, §9) | — | Worker `fullfilio` exists, KV + R2 bindings exist, DO declared; **pushes do not deploy** (F-005); live DB behind by 3 migrations and 5 relayed functions behind (F-007); secrets present only by name (never read); DNS/SSL BLOCKED (host unreachable from here) | **FAIL (F-005: no build on push) / OPEN (F-002, F-007, migrations)** | §4.5 |

### 4.1 Tests added by this audit (Phase 4)

| Test | What it proves | Result |
|---|---|---|
| `status-matrix.test.ts` › every allowed move works or names its precondition… | All 23 order statuses reached from a plain order; 23×22 moves tried: every pair in `order_status_transitions` succeeds or fails only with a stated precondition (courier before shipping, items kept, picked-up rules); every other pair is refused with INVALID_TRANSITION; DELIVERED, PARTIALLY_DELIVERED, RETURNED, CANCELLED lead nowhere | PASS (Postgres) |
| `status-matrix.test.ts` › roles | VIEWER and FINANCE_MANAGER cannot move orders (`orders.status`); ORDER_MANAGER can; cancelling needs a reason; partial delivery needs the kept items; cancelling releases the reservation (reserved 0, on hand back to 100) | PASS |
| `status-matrix.test.ts` › a repeated move | A second DELIVERED (courier callback twice) is a no-op: stock, ledger and history identical; going backwards is refused | PASS |
| `ingest-concurrency.test.ts` | The same Shopify order ingested at the same instant on two connections: one IMPORTED, one DUPLICATE, one order, one import row, `orders_imported` = 1 | PASS |
| `function-grants.test.ts` › no function is callable by everyone | No public-schema function carries a PUBLIC grant; a function created now is not executable by `anon`/`authenticated` (service role yes) | PASS (Postgres; skipped on the engine, which has no pg_proc ACLs) |
| `function-grants.test.ts` › store visitors | The exact list of 27 functions `anon` may execute (storefront, sign-up, session helpers) — anything added shows up here | PASS (Postgres) |
| `function-grants.test.ts` › plan, usage and limits | `anon` and an OWNER get `permission denied` on `merchant_usage/limits/entitlements` and `feature_enabled`, with or without a merchant id; `my_plan()` still returns limits, usage and features; the service role still works | PASS (Postgres + engine) |
| `finance-reconciliation.test.ts` › ledger rows | Seven orders, one per money outcome (delivered; waiting; cancelled; delivered then refunded; partial delivery with one unit back; lost in transit; failed delivery returned to stock). Every order's ledger rows match a hand count exactly: waiting and cancelled orders post nothing; a refund after delivery is contra revenue and the goods stay sold; the partial delivery recognises the full sale, books 500 contra revenue and reverses 200 of cost when the unit is restocked; the lost parcel is a 400 cost and no sale; the failed delivery costs courier 80 + return 60 and nothing else. Stock agrees (X 17 on hand / 1 reserved, Y 19 / 0) | PASS (Postgres + engine) |
| `finance-reconciliation.test.ts` › the statement | `report_profit_loss` delta equals the hand count: revenue 3,360, refunds 1,500, net revenue 1,860, COGS 1,400, gross profit 460, operating expenses 440, net profit 20 | PASS (Postgres + engine) |
| `finance-reconciliation.test.ts` › three reads agree | `report_order_financials` totals (sales 3,360, refunds 1,500, product cost 1,400, delivery cost 440, profit 20, 3 orders sold) equal the statement; `dashboard_overview.finance` equals the statement key by key; dashboard counts (7 orders, 1 cancelled, 3 delivered, 0 returned, 1 failed, 5 shipped) and `gross_sales` equal a direct SQL recount over the same orders | PASS (Postgres + engine) |
| `finance-reconciliation.test.ts` › permissions | An ORDER_MANAGER is refused `report_profit_loss`, `report_order_financials`, `report_cash_flow` by the database (PERMISSION_DENIED) and gets a dashboard without the finance block | PASS (Postgres + engine) |

### 4.2 Live sales-channel state (read-only, 2026-10-12)

Read with SELECT only; nothing was changed. Merchant 1 sells through
WooCommerce right now, so the Shopify channel is **paused by configuration**
and its new orders are not imported — expected, and the catch-up path
(`sync_channel` after switching back) is covered by `one-store` and
`order-sync-v3`.

| Measure | Value | Reading |
|---|---|---|
| `channel_order_imports`, last 30 days | 24 SKIPPED (SYNC, "Cancelled in Shopify before it was imported"), 7 SKIPPED (SYNC, "Already fulfilled in Shopify before it was imported"), 5 IMPORTED (WEBHOOK), 2 IMPORTED (RETRY), **0 FAILED** | Every skip has a stated reason and matches the "unfulfilled orders only" rule; no import ended in FAILED, so no order is sitting in the dead-letter state |
| `channel_webhook_deliveries`, last 7 days | 62 deliveries: Shopify `orders/updated` 23, `inventory_levels/update` 10, `products/update` 10, `orders/create` 4, `orders/cancelled` 3, `fulfillments/create` 2, `fulfillments/update` 2; WooCommerce plugin `plugin.order` 2, `plugin.lead` 2, `order.updated` 2, `order.created` 1, `product.updated` 1 | Both channels deliver; the dedupe table records every delivery once |
| Shopify store orders today vs imported | ~50 orders in the store (#11005–#11054), ~15 since the 16:37 UTC sync not imported | Expected while Shopify is paused; **tell the merchant** — switching the channel back imports them (tested) |

### 4.3 "No order may be lost" — every scenario of the brief and the test that proves it

All on Postgres and on the Cloudflare engine unless noted. The mechanism:
`channel_ingest_order` takes a per-order advisory lock, records one
`channel_order_imports` row per (channel, external id) with IMPORTED /
DUPLICATE / SKIPPED(reason) / FAILED(error, attempts), and
`channel_delivery_first/seen` make every webhook delivery id count once.

| Scenario | Test | Result |
|---|---|---|
| Normal order | shopify-sync › imports…; woo-plugin › plugin.order | PASS |
| Duplicate webhook delivery | order-sync-v3 › "is not counted twice: the marker moves with it…"; `channel_delivery_first` tests in sales-channels | PASS |
| Same order from webhook and sync at the same instant | **ingest-concurrency** (two connections): one IMPORTED, one DUPLICATE | PASS (Postgres; the engine runs one statement at a time by design) |
| Retried delivery after a failure | order-sync-v3 › "claims each due job once, backs off on retry and keeps failures for a person"; store-import-fixes › "says why an order without a usable phone cannot come in, and imports it once a phone is added" (FAILED → RETRY → IMPORTED) | PASS |
| Out-of-order events (updated before created; cancel before import) | order-sync-v3 › "an order imported before Shopify had its journey ready is filled in later, never overwritten after"; store-import-fixes › "an order placed before the first sync and then cancelled here leaves stock right" | PASS |
| Edited after import (quantities, address) | order-sync-v3 › "a change made in Shopify is applied here as the difference, keeping a change made here at the same time"; store-import-fixes › "a store order through edits and cancels moves stock exactly once at each step" | PASS |
| Missing or bad address / district / phone | store-import-fixes › "never holds a store order back for its address…"; "…without a usable phone…" | PASS |
| Channel paused / switched (orders arriving while another store is selected) | one-store › "only the store picked … syncs; the others pause and pick up again when picked" | PASS (logic). Live: Shopify is paused by configuration (§4.2); the `channels` function on live predates the paused-store handling (F-007) |
| Job runner crash mid-run | order-sync-v3 › "is not lost: the job runs again with fresh data once the current run ends" | PASS |
| Merge of two orders from one customer | smart-merge(4); order-sync-v3 › "a second Shopify order from the same phone merges…; stock moves once" | PASS |
| Dead letter visible to a person | `channel_order_imports.status = 'FAILED'` with `error` and `attempts`; shown on Sales channels → Import log; live has **0 FAILED** in 30 days (§4.2) | PASS |

### 4.4 Browser: every route at three widths, and the checkout as a customer (2026-10-12)

Both runs use Chromium (Playwright 1.56) against the built site served by a
local Worker on one address with the Cloudflare database engine seeded from
`worker/db/generated/seed.sql` — the same pages and SQL functions as
production, with no external service reachable (the sandbox blocks Clerk and
every provider). Scripts and screenshots: scratchpad `crawl/` and
`checkout-e2e/`.

**Crawl** (`crawl/run.cjs`): 125 routes × 1440 / 834 / 390 px = **392 page
visits** as a visitor, a store OWNER, a platform SUPER_ADMIN and a VIEWER;
every admin and Super Admin route of §1.2, every storefront and website page,
the `:id` pages with a real product / order / customer and with a missing id,
and a made-up path in each area.

| Check | Result |
|---|---|
| React error boundary ("Something went wrong" / unexpected application error) | **0 of 392** |
| Uncaught page errors | **0** |
| Server errors (5xx) | **0** on the e2e Worker (the one 500 below came from the full Worker) |
| Horizontal overflow at 390 / 834 / 1440 | **0 pages** |
| Website `/`, `/contact`, `/blog`, `/fullfilio`, made-up path | PASS (made-up path → "This page doesn't exist") |
| Storefront: home, shop, collection, search, product, cart, checkout (empty → cart), track order, login, register, forgot password, contact, policies, made-up path | PASS at all widths ("Page not found" for the made-up path) |
| Merchant admin, 79 routes as OWNER | PASS: every page renders its content; made-up path → the admin's own 404 ("Page not found · Back to dashboard"); a missing purchase / production id → `ErrorState` NOT_FOUND after its query (code: `purchase-edit.tsx:78`, `production-detail.tsx:39`) |
| Super Admin, 23 routes as SUPER_ADMIN | PASS: every module renders |
| VIEWER on finance, P&L, users, settings, new order, new product, theme | **kept out**: "You don't have access to this page", navigation trimmed to permitted items; the database refuses `report_profit_loss` too (PERMISSION_DENIED); `is_platform_staff()` = false; `/super-admin` sends the viewer to its login |
| Flagged by the first pass, re-checked | 29 visits were captured while the shell still said "Loading your workspace…". Cause (measured with `crawl/viewer-probe.cjs`): every page waits the full **10 s Clerk give-up timeout** (`features/auth/clerk.tsx:124`) because Clerk's script cannot load here; the access RPCs themselves answer in 5–30 ms. With a 45 s wait all of them render (screenshots `viewer-probe-*.png`). Not a product defect; in production Clerk loads. |
| Login / sign-up pages at ≤ 834 px with Clerk unreachable | Blank (only the marketing side panel shows at 1440). The page does show `clerkError` when Clerk reports one, but a script that never loads gives no message for 10 s → F-013 (Low) |
| `/admin/forgot-password` → `/admin/login` | By design with Clerk (`forgot-password.tsx:18`); Clerk's own flow handles resets |
| 66 × `POST /rest/v1/rpc/device_register` → 403 on Super Admin pages | Platform staff without a store profile trigger the merchant device registration on every page → F-012 (Low, console noise only; the database refuses it correctly) |
| Chunk requests `net::ERR_ABORTED` on the Super Admin overview | The next navigation cancelled still-loading chunks; not an error |

**Checkout as a customer on a 390 px phone** (`checkout-e2e/run.cjs`, the
**full** Worker: site + all 22 backend functions + database in one process,
`DATABASE_BACKEND=cloudflare`, no secrets) — **17 of 18 steps PASS**:

| Step | Result |
|---|---|
| `checkout` function: quote with one item → 200 with `payment_requirement`; empty cart → 422 VALIDATION (not a crash) | PASS |
| Product page: "In stock", price 1,000; Add to cart; cart holds the item | PASS |
| Checkout form: name, phone, address, district (Dhaka) chosen from the picker; the phone check and delivery quote return; "Confirm order" enabled | PASS |
| Confirm → `/order-success?order=ISO-10001` | PASS |
| Database: one order, source STOREFRONT, COD, subtotal 1,000, total = 1,000 + delivery charge, customer name/phone/district as typed | PASS |
| Stock: 10 on hand, 1 reserved; exactly one order created | PASS |
| Customer's tracking page finds the order by number and phone | PASS |
| Owner's admin: order detail shows name, phone, address, item, total | PASS |
| Owner confirms via `transition_order_status` → CONFIRMED with `confirmed_at`; stock unchanged (10 / 1 reserved) | PASS |
| A second checkout from the same phone: second order ISO-10002, stock reserved exactly 2, nothing double-counted | PASS |
| Owner's **Web Orders list** | **FAIL on the Cloudflare engine only**: `admin_search_orders` → 500 "variable number must be between ?1 and ?100" (F-011). Production runs on Supabase Postgres, where the Postgres suite covers the same call (order-lists, checkout-fulfillment). Fixed in `worker/db/pg/compile.ts`; verified by `npm run db:e2e` (new check "the order lists … answer on the Durable Object") — see F-011 |

### 4.5 Live database and Worker vs. the repository (read-only, 2026-10-12)

| Check | Live | Repository | Gap |
|---|---|---|---|
| Last applied migration (Supabase `list_migrations`) | `theme_preview_resolve` (= `20261109001900`) | up to `20261109002100` | **Not on live:** `001700_status_path_via_shipped`, `002000_status_path_prefers_processing`, `002100_function_grants_not_public` |
| `_order_status_path` | has neither the SHIPPED rule nor the PRE_ORDER detour | both | Super Edit on live can still walk an unshipped order to DELIVERED without SHIPPED, and CONFIRMED → … via PRE_ORDER (F-010) |
| `has_function_privilege('anon', 'merchant_usage(uuid)')` | **true** | false | F-008 is live until `002100` is applied |
| Functions with a PUBLIC execute grant | **27** | 0 | F-008a |
| SECURITY DEFINER functions not owned by `app_owner` | **279** | 0 | F-002 |
| Worker `fullfilio` last modified (Cloudflare API) | 19:29:08 UTC (manual deploy) | last push 19:33:05 UTC (7f092bd) | F-005: pushes do not deploy |
| Edge functions relayed to Supabase (`channels, courier, meta-ads, ad-platforms, notifications-dispatch`) | versions deployed before today's repository changes | — | F-007 |
| Worker bindings named in `wrangler.jsonc` | KV `fullfilio-cache` (`bd50f9bf…`) and R2 `fullfilio-files` exist (plus their `-staging` twins); Durable Object class `Database` is declared | same | none — the production Worker's bindings resolve |
| Live edge functions | 23 deployed: the 22 of the repository plus `setup-runner` (a 404 stub, F-006). `channels` v15, `courier` v7, `checkout` v8, `payments` v7, `clerk-auth` v6, `admin-users` v6, `fraud-check` v5, `payment-webhook` v4, `clerk-proxy` v3, `domains` v3, `meta-ads` v3, the rest v1–v2 | — | only the five relayed ones matter while the Worker hosts the other 17 |

## 5. Findings log

| ID | Severity | Area | Finding | Status |
|---|---|---|---|---|
| F-001 | Medium | Theme editor | Preview showed the Fullfilio website instead of the store whenever the online store was off or selling through Shopify/WooCommerce (frame fell back to `/`). | **Fixed** 2026-10-12: `storefront_resolve_preview()` (staff-only), preview at site root, state badge, error bar. Tests: store-addresses(+1), browser run 14/14. DB function applied to live; code pushed to both branches. |
| F-002 | High (defence in depth) | Live database | On live Supabase, 278 SECURITY DEFINER functions (279 after the theme fix, re-checked 2026-10-12) are owned by `postgres` instead of `app_owner`, so inside them row security does not apply (the test database enforces `app_owner` ownership via `_tenancy_own_functions()`; live never got that hand-off). Every function still filters by `current_merchant_id()` explicitly. | Open — needs a planned, verified re-ownership on live (not done during the theme deploy on purpose). |
| F-003 | — | Database | 16 billing/credits/subscription/API-key tables looked unprotected from the migration text. | **Closed, no issue**: on live and in the test database all 16 have row security on (enabled by a loop in `external_api.sql`) with `tenant_isolation` + `staff_read`/`app_owner` policies; `anon`/`authenticated` hold SELECT only, filtered by those policies. Evidence: live `information_schema.role_table_grants` + `pg_class.relrowsecurity`; test DB `pg_policy`. |
| F-006 | Info | Live Supabase | An edge function `setup-runner` (v2, created at the first deploy, `verify_jwt` on) is deployed but does not exist in the repository. | **Closed, harmless**: its source (read 2026-10-12) is a one-line stub that answers 404 ("Retired setup helper. Safe to delete"). Housekeeping: delete it from the dashboard when convenient. |
| F-007 | High | Live Supabase functions | The production Worker relays `channels, courier, meta-ads, ad-platforms, notifications-dispatch` to Supabase, and all five deployed versions predate repository changes. Concretely, live `channels` (v15, 2026-10-12 09:26 UTC) was deployed 3 minutes before commit e0e64a0, which makes events from a *paused* second store be acknowledged and dropped ("one sales channel at a time"); live still processes them. | Open — redeploy the five functions (needs approval, §10). |
| F-008 | Medium (information disclosure) | Database grants | `merchant_usage(p_merchant)`, `merchant_entitlements(p_merchant)` and `merchant_limits(p_merchant)` are SECURITY DEFINER, executable by `anon`, and have no staff check: an anonymous visitor who knows a store id (which `storefront_resolve` returns for any store) gets that store's monthly order count, staff and product counts and plan features. Reproduced on the test database as `anon` with a merchant header. `my_plan()` correctly refuses. | **Fixed in the repository** (`20261109002100_function_grants_not_public.sql`): `merchant_usage`, `merchant_limits`, `merchant_entitlements`, `feature_enabled`, `require_feature`, `require_limit` are no longer executable by `anon` or `authenticated`; they are reached only inside SECURITY DEFINER functions (`my_plan`, `platform_merchant_*`, the limit/feature guards) and by the service role. Regression test `function-grants.test.ts` › plan, usage and limits (anon and OWNER refused with and without a merchant id; `my_plan()` still answers; service role still works). `plans-features.test.ts` now reads a merchant's feature through `my_plan()` (the real staff path) and probes the helper as the owner. Catalog for the Cloudflare engine regenerated (`npm run db:convert`). **Not on live** until the migration is applied (needs approval, §10) — re-checked on live 2026-10-12: `anon` can still execute `merchant_usage(uuid)` (§4.5). |
| F-008a | High (systemic cause of F-008) | Database grants | `api_grants.sql` tries to stop new functions being public with `alter default privileges in schema public revoke execute on functions from public`, but PostgreSQL applies per-schema default privileges *in addition to* the built-in default (EXECUTE to PUBLIC); only a global `alter default privileges … revoke` removes it. Reproduced: a function created now as `postgres` gets `=X/postgres` (PUBLIC execute). So every function created after the last manual hardening sweep is callable by anyone unless its migration revokes explicitly. Test database: 46 functions carry a PUBLIC grant (list in §5.1). | **Fixed in the repository** (`20261109002100`): `alter default privileges for role postgres revoke execute on functions from public` (role-wide, so a new function is private by default — proven by creating one in the test), explicit revoke of the 27 functions that still carried `=X/`, explicit re-grants for the session/storefront helpers that policies and visitors need. `function-grants.test.ts` fails if any public-schema function ever gets a PUBLIC grant again, and pins the exact list of 27 functions `anon` may call. Postgres-only assertions (pg_proc ACLs) are skipped on the Cloudflare engine, which enforces the copied grants itself (`worker/db/rpc/index.ts:62`, `worker/db/pg/engine.ts:231`). **Not on live** until applied (§10). |
| F-010 | Medium | Orders (Super Edit) | `_order_status_path` breaks ties alphabetically, so from CONFIRMED it walks orders through PRE_ORDER instead of PROCESSING (`PENDING→SHIPPED` = CONFIRMED, PRE_ORDER, READY_TO_SHIP, SHIPPED). PRE_ORDER has no side effects while PROCESSING queues production for made-to-order goods, so a Super Edit walk could skip production. Found by the new status-matrix test. | **Fixed** in `20261109002000_status_path_prefers_processing.sql` (PRE_ORDER counts as a detour); verified below. |
| F-009 | Info | Live Supabase | Security advisor: no ERROR-level lints. WARN: 437 security-definer functions executable by `authenticated` and 34 by `anon` (by design for storefront/session helpers; reviewed — see F-008), `pg_net` in `public`, leaked-password protection off. INFO: 30 tables with RLS and no policy (default deny; reached through definer functions only). Performance: 15 tables with multiple permissive policies, 98 unindexed foreign keys, 109 unused indexes. | Recorded; indexes considered under §7 performance. |
| F-011 | High for the Cloudflare switch-over, none for production today | Cloudflare database engine | In the real Worker runtime (Durable Object SQLite) `admin_search_orders` — the Web Orders, Approved Orders and All Orders lists — failed with 500 "variable number must be between ?1 and ?100": the compiled statement binds more than 100 constants (several inlined functions), and the Durable Object's SQLite caps bound parameters at 100. The engine test suite did not catch it because Node's SQLite has no such cap. Found by the browser checkout run (§4.4), reproduced with `checkout-e2e/probe.cjs` for all three lists. | **Fixed** in `worker/db/pg/compile.ts` (`bind()` writes constants out as literals past the 90th, the way inlined views already do). Regression check added to `scripts/db-e2e.mjs` ("the order lists (web, approved, all) answer on the Durable Object"); `npm run db:e2e` 19/19 in workerd. Production (Supabase) unaffected. |
| F-012 | Low | Super Admin shell | Every Super Admin page call `device_register` (merchant staff device tracking) for platform staff who have no store profile; the database refuses it (403) on every page — correct, but 66 refused requests in one crawl and console noise. | Open — skip `device_register` when the signed-in person has no merchant access (`src/lib/device.ts`). Cosmetic. |
| F-013 | Low | Sign-in / sign-up pages | `/admin/login`, `/start` and the Super Admin login render Clerk's hosted component; when Clerk's script cannot load (offline, blocked, slow CDN) the page shows nothing for the 10 s give-up window at ≤ 834 px (the 1440 layout at least shows the side panel), then falls back. `clerkError` is shown only when Clerk itself reports an error. | Open — show a "Sign-in is taking longer than usual… retry" message while waiting. Cosmetic; production Clerk loads. |
| F-004 | Low | Cloudflare engine | `voicedrive-pbx › seats limit agents` fails on the engine only (Postgres passes). Engine is not in production use. | Open (engine) |
| F-005 | High (operational) | Deployment | `docs/CLOUDFLARE.md` says Cloudflare builds the live Worker from `claude/optimistic-cray-c2d0fc`, yet the deployed Worker code (fetched 2026-10-12 19:35 UTC) contains none of today's pushes to that branch (no engine, no `DATABASE_BACKEND`, no SHIPPED change). Either builds run from the old Vercel-era branch or builds have been failing. Until resolved, nothing pushed is known to be live. **Re-checked 2026-10-12 via the Cloudflare API**: Worker `fullfilio` `modified_on` = 19:29:08 UTC (the manual `wrangler deploy` of the theme fix); the last push to the production branch (7f092bd) was at 19:33:05 UTC and no new Worker version followed it. So pushes to `claude/optimistic-cray-c2d0fc` do **not** deploy today; the live Worker is whatever was last deployed by hand. | Open — connect Workers Builds to the branch (or document manual deploys as the process); see §10 |

## 6. Blocked items (why, and what would unblock)

| Item | Why blocked | Unblock |
|---|---|---|
| Live HTTP checks of fullfilio.com (routes, SSL, redirects, webhook URLs) | Egress proxy refuses the host | Run from a machine with internet, or allow the host for this environment |
| Real OTP e-mail, Clerk sign-up/sign-in in production | No mailbox; Clerk live keys not for test accounts | A test mailbox + Clerk test instance |
| Courier/payment/SMS/ads live calls | No sandbox credentials; live calls would create real parcels/charges | Provider sandbox accounts |
| WooCommerce live plugin on a WordPress | No WordPress reachable | Staging WordPress with the plugin |
| Vercel `commerce` project state | Token lacks the team scope | Re-authorise the Vercel connector for the team |

## 7. Commands used (so far)

```
npx vitest run --project unit
TEST_DATABASE_URL=postgres://… npx vitest run --project db
CF_DB_TESTS=1 npx vitest run --project cfdb
npm run functions:check
npm run typecheck
npx vite build ; npm run build:cloudflare
npm run db:e2e
node scratchpad/theme-e2e/run.cjs        # theme editor in Chromium on the local Worker
TEST_DATABASE_URL=… npx vitest run --project db supabase/tests/db/function-grants.test.ts supabase/tests/db/plans-features.test.ts supabase/tests/db/status-matrix.test.ts
TEST_DATABASE_URL=… npm run db:convert   # regenerate worker/db/generated after a migration (reads commerce_test)
CF_DB_TESTS=1 npx vitest run --project cfdb <same files>
```

## 8. Resume pointer

Done: Phases 1, 3, 4 (status matrix, ingest concurrency, function grants),
5 (grants fixed in the repo: F-008/F-008a; F-002 live ownership still open),
live sales-channel read (§4.2).

Next, in order: Phase 7 finance recomputation test (dashboard / P&L / order
financials vs. direct SQL over fixtures with pending, cancelled, returned,
partial and lost orders); Phase 7 browser crawl of every admin, Super Admin,
storefront and website route at 1440/834/390 on the local Worker (harness:
scratchpad `theme-e2e/run.cjs`); Phase 9 full regression (unit, Postgres,
engine, deno, typecheck, builds, `db:e2e`); Phase 10 deployment checks
(which branch Cloudflare builds, `setup-runner`, redeploy of the five
Supabase-hosted functions, apply migrations 20261109001700…002100 — each
needs the user's approval); Phase 11 report + GO/NO-GO. Commit the audit
files only after the user agrees (the work branch deploys on push).

**Update:** Phases 6, 7, 8 (repository fixes), 9 and the read-only part of
10 are done (§4.4, §4.5, §9). Phase 11 report published (private page):
https://claude.ai/artifact/HeNiUNspwovqrejKTdHQXY. Left: the live actions
that need approval (§10) and the user's decision on committing/pushing.

## 9. Final regression (Phase 9, after every change of this audit)

| Suite | Result | Log |
|---|---|---|
| Unit (`vitest --project unit`) | **351 / 351 passed** (47 files) | `final-unit.log` |
| Database on Postgres (`--project db`, 67 files) | **452 / 452 passed** — 441 baseline + 11 new (status matrix 3, ingest concurrency 1, function grants 3, finance reconciliation 4) | `final-db-pg.log` |
| Database on the Cloudflare engine (`--project cfdb`) | 444 passed, 6 skipped (seed 4 + the 2 Postgres-catalog checks), **1 failed** = the known engine-only `voicedrive-pbx › seats limit agents` (baseline); the concurrency test is now skipped there by design (one statement at a time, no replica mode) | `final-db-cf.log` |
| Deno `functions:check` (22 functions) | passed | `final-deno.log` |
| `npm run typecheck` (`tsc -b` + Worker) | passed | `typecheck-2.log` |
| `vite build` | passed (24.9 s) | `final-build.log` |
| `npm run build:cloudflare` | passed (22.5 s) | `final-build-cf.log` |
| Worker runtime e2e (`npm run db:e2e`, workerd) | **19 / 19** incl. the new order-lists check (F-011) | `audit-db-e2e-2.log` |
| Browser crawl (392 visits) + checkout e2e (18 steps) | §4.4 | `crawl/report.md`, `checkout-e2e/results.json` |

## 10. What the audit could not do, and what needs the user's approval

Nothing below was executed. Each item changes production and needs an explicit go-ahead; all are prepared.

| # | Action | Why | Risk / rollback |
|---|---|---|---|
| L1 | Apply migrations `20261109001700`, `002000`, `002100` to live Supabase (`supabase/migrations/`) | Super Edit route fixes (F-010 + SHIPPED rule) and the grants hardening (F-008, F-008a) are only in the repository | DDL on functions and grants only; no data touched; reversible by re-running the previous definitions. Take a backup first (brief). |
| L2 | Re-own the 279 SECURITY DEFINER functions to `app_owner` on live (`select public._tenancy_own_functions()`) | F-002: row security inside those functions is bypassed as `postgres` | One statement; reversible (`alter function … owner to postgres`). Test database proves the app runs this way (452/452). |
| L3 | Redeploy the five Supabase-hosted functions (`channels, courier, meta-ads, ad-platforms, notifications-dispatch`) from the repository | F-007: live `channels` predates the "one store at a time" event dropping and other fixes | Supabase keeps previous versions; redeploy the old version to roll back |
| L4 | Connect Workers Builds to `claude/optimistic-cray-c2d0fc` (or state that deploys are manual) and deploy the current head | F-005: pushes do not deploy; the live Worker is a hand deploy from before 7f092bd | `wrangler deploy` of the previous version rolls back |
| L5 | Delete the `setup-runner` stub function | F-006 housekeeping | none |
| L6 | Tell the merchant: ~15 Shopify orders since 16:37 UTC are not imported because the store is set to WooCommerce (§4.2) | expected behaviour, but money on the table | switching the channel back imports them (tested) |
| — | Live OTP/Clerk sign-up, courier bookings, payments, SMS, ads calls | need test accounts / sandboxes; real calls would create parcels or charges | BLOCKED (§6) |

## 11. Risk register and production readiness

| Risk | Likelihood | Impact | Where | Mitigation |
|---|---|---|---|---|
| A push to the production branch does not reach customers (or a hand deploy ships untested code) | certain today | high | F-005 | L4 |
| Live `channels` function drops nothing for a paused second store; old courier/meta/ads code paths | happening | medium | F-007 | L3 |
| Super Edit on live can walk an unshipped order to DELIVERED without SHIPPED, or through PRE_ORDER | on every Super Edit of such an order | medium (wrong stock/finance side effects) | F-010 / 001700 | L1 |
| A visitor can read any store's monthly order count, staff/product counts and plan | low effort, needs a store id | medium (information disclosure) | F-008 | L1 |
| Definer functions run as `postgres` on live (RLS bypass inside them) | latent | high if a function ever forgets its merchant filter (none found) | F-002 | L2 |
| Cloudflare database switch-over: order lists failed in the real runtime until today | n/a (engine off) | high for the switch-over only | F-011 fixed | keep `db:e2e` in the pre-deploy checks |
| Login page shows nothing while Clerk's script is unreachable | rare | low | F-013 | small UI change |

**Decision: NO-GO for "everything pushed is live and correct" — GO for the
application itself.** The code in the repository passes every test the audit
could run (1,266 automated checks across unit, two database backends, the
Worker runtime, 392 page visits and a real checkout); money, stock and order
flow reconcile exactly; permissions hold in the database and the UI. What
blocks a clean GO is operational, not functional: production is behind the
repository (no build on push, three migrations and five functions pending)
and two live-database hardening steps (F-002, F-008) wait for approval. Once
L1–L4 are done and verified (re-run §4.5's read-only checks: migrations
applied, `anon` denied, 0 postgres-owned definers, Worker `modified_on` after
the push), the decision is GO.
