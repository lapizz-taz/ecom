# Commerce platform

A storefront plus the back office behind it: orders, stock, production, customers, couriers, fraud protection with
risk-based advance payments, finance (income, expenses, refunds, P&L, cash flow), marketing, reports, staff roles and an
audit log.

- **Frontend:** React 19 + TypeScript, Vite, React Router, Tailwind + shadcn/ui, TanStack Query, React Hook Form + Zod, Recharts.
- **Backend:** Supabase — PostgreSQL (business logic, RLS), Auth, Storage, Realtime and Edge Functions (Deno) for anything that
  needs a secret or talks to a provider.

This app lives in `commerce/` and is independent of the Next.js project at the repository root.

---

## How it fits together

```
Browser (React SPA)
  │  anon / user JWT only — no secrets ever reach the browser
  ├─► PostgREST ─► RLS-protected tables, views and RPCs ──┐
  ├─► Auth / Storage / Realtime                            │  PostgreSQL holds the business rules:
  └─► Edge Functions (service role + provider secrets) ────┤  order state machine, stock ledger,
        checkout · payments · payment-webhook ·            │  fraud scoring + rules, payment
        fraud-check · courier · courier-webhook ·          │  confirmation, finance postings,
        notifications-dispatch · admin-users               │  permissions, audit log
                                                            ┘
```

- **Business logic is in the database.** Every state change (create order, transition status, reserve / release / commit
  stock, record payment, refund, return, fraud decision, finance entry…) is a `SECURITY DEFINER` function that checks the
  caller's permission (`require_permission`) and validates the change. React only calls those functions, so a crafted API
  request can't skip a rule.
- **Deny by default.** `EXECUTE` is revoked from every function and granted back one by one
  (`20261001001200_api_grants.sql`); every table has RLS. Customers and anonymous visitors only reach `storefront_*` functions,
  which never return cost prices, risk scores or provider data.
- **Immutable ledgers.** `inventory_movements`, `finance_transactions`, `order_payments`, `payment_events`, `fraud_checks`,
  order history and `audit_logs` can't be updated or deleted. Mistakes are fixed with a reversing entry.
- **Edge Functions only do what needs a secret** (provider API keys, the service role) and then hand the verified result to a
  database function. Payment confirmations are re-verified with the provider server-side and deduplicated by event id.

### Error convention

Database functions raise `CODE: message` (`VALIDATION`, `INSUFFICIENT_STOCK`, `COUPON_INVALID`, `ORDER_BLOCKED`,
`PERMISSION_DENIED`, `NOT_FOUND`, `DUPLICATE`, `INVALID_TRANSITION`, `IMMUTABLE_RECORD`). `src/lib/errors.ts` turns those into
friendly messages; Edge Functions return `{ error: { code, message } }`.

---

## Layout

```
commerce/
  src/
    pages/storefront/     shop, product, cart, checkout, order tracking, account, policies
    pages/admin/          dashboard, orders, fraud review, products, inventory, purchases, production,
                          customers, couriers, finance/*, reports, marketing, coupons, settings, users, audit log
    features/             feature components (order dialogs, settings sections, report tables/charts…)
    services/             typed data access — one file per domain, all calls go through Supabase
    lib/                  formatting, dates, CSV export, error mapping, phone normalisation
    types/database.ts     generated from the schema (npm run db:types)
  supabase/
    migrations/           schema, RLS, functions, triggers, views, reference data, grants
    seed.sql              demo data created through the real functions (local only)
    functions/            Edge Functions + _shared provider adapters
    tests/                PostgreSQL integration tests (vitest)
    config.toml           local Supabase config
```

---

## Run it locally

Requirements: Node 20+, Docker, and the [Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
cd commerce
npm install                      # .npmrc sets legacy-peer-deps
supabase start                   # Postgres, Auth, REST, Storage, Realtime; applies migrations + seed.sql
supabase status                  # copy the API URL and anon (or publishable) key

cp .env.example .env.local       # VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
cp supabase/functions/.env.example supabase/functions/.env
supabase functions serve --env-file supabase/functions/.env

npm run dev                      # http://localhost:5173 (storefront) and /admin
```

Seeded logins (password `Password123!` for all):

| Email | Role |
| --- | --- |
| owner@example.com | Owner |
| orders@example.com | Order manager |
| warehouse@example.com | Inventory manager |
| finance@example.com | Finance manager |
| production@example.com | Production manager |
| customer@example.com | Storefront customer |

`supabase db reset` rebuilds the database from the migrations and seed.

---

## Deploy to a hosted Supabase project

1. **Database**
   ```bash
   supabase link --project-ref <ref>
   supabase db push                 # applies supabase/migrations (seed.sql is not pushed)
   ```
2. **Edge Function secrets** — never in the database or the frontend:
   ```bash
   supabase secrets set --env-file supabase/functions/.env
   supabase functions deploy        # deploys every function; verify_jwt settings come from config.toml
   ```
3. **Auth** — in the dashboard set the Site URL to the storefront origin and add
   `https://<your-domain>/reset-password` and `https://<your-domain>/admin/reset-password` as redirect URLs.
4. **First owner** — sign up (or invite yourself), then in the SQL editor:
   ```sql
   select public.grant_owner('you@example.com');
   ```
   After that, staff are managed from **Admin → Users & roles**.
5. **Frontend** — `npm run build` and host `dist/` on any static host with an SPA fallback to `index.html`. Set
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at build time.
6. **Scheduled jobs** — `expire-unpaid-advance-orders` is created by the migrations. Add the two HTTP jobs once, keeping the
   shared secret in Vault:
   ```sql
   create extension if not exists pg_net;
   select vault.create_secret('<same value as CRON_SECRET>', 'cron_secret');

   select cron.schedule('notifications-dispatch', '* * * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/notifications-dispatch',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
       body := '{}'::jsonb)
   $$);

   select cron.schedule('courier-sync', '*/30 * * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/courier',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
       body := '{"action": "sync_all"}'::jsonb)
   $$);
   ```
7. **Provider callbacks**
   - SSLCommerz IPN: `https://<ref>.supabase.co/functions/v1/payment-webhook?provider=sslcommerz`
   - Steadfast status webhook: `https://<ref>.supabase.co/functions/v1/courier-webhook?provider=steadfast` with
     `Authorization: Bearer <STEADFAST_WEBHOOK_TOKEN>`

### Edge Function secrets

| Secret | Used for |
| --- | --- |
| `ALLOWED_ORIGINS`, `STOREFRONT_URL` | CORS for public functions; links in emails and payment redirects |
| `CRON_SECRET` | Authenticates pg_cron calls to `notifications-dispatch` and `courier` |
| `FRAUD_API_URL` (with `{phone}`), `FRAUD_API_KEY`, `FRAUD_API_AUTH_HEADER`, `FRAUD_API_AUTH_SCHEME` | Optional courier-history fraud provider |
| `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD` | Card / mobile-banking payments |
| `STEADFAST_WEBHOOK_TOKEN` | Steadfast status webhooks |
| `STEADFAST_*`, `PATHAO_*`, `REDX_*` (optional) | Fallback courier keys. Normally couriers are connected in **Admin → Couriers**; keys entered there are tested with the courier, then stored encrypted in Supabase Vault by the service role and never returned to a browser |
| `SMS_API_URL`, `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_SUCCESS_PATTERN` | SMS notifications via an HTTP gateway |
| `NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET` | Forward notifications (e.g. to a WhatsApp BSP), HMAC-signed |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email notifications |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase. Which provider is *used* is
chosen in **Settings**; settings rows never contain credentials.

---

## Business rules in brief

**Orders.** Numbers come from a sequence with the configured prefix (`ISO-10001`, …). Status changes go through
`transition_order_status`, which only allows defined transitions and writes `order_status_history`:

```
PENDING → FRAUD_CHECK → CONFIRMED | ADVANCE_REQUIRED | FRAUD_REVIEW | CONFIRMATION_REQUIRED | REJECTED_FRAUD
CONFIRMED → PROCESSING → [PRODUCTION → QUALITY_CHECK →] PACKING → READY_TO_SHIP → SHIPPED → DELIVERED
SHIPPED → FAILED_DELIVERY → SHIPPED (re-attempt) | RETURNED
SHIPPED | DELIVERED → RETURN_REQUESTED → RETURNED
anything before SHIPPED → CANCELLED
```

The full list is the `order_status_transitions` table. Moving to PROCESSING creates a production job when production
applies (Settings → Orders & operations).

**Stock.** Placing an order reserves stock; cancelling or rejecting releases it; shipping commits it (on hand and reserved
both drop); returns restock or move units to damaged. Every change is an `inventory_movements` row with before/after
quantities. Overselling is refused unless enabled in Settings.

**Fraud and advance payments.** At checkout the `checkout` function asks every configured provider (store history, and
optionally a courier-history API) and records one merged check. The database scores it (0–100), maps it to a risk level with
the configurable thresholds, and evaluates the rules from **Settings → Fraud & advance**. The most severe matching decision
wins (BLOCK > REVIEW > ADVANCE_REQUIRED > ALLOW) and the largest advance applies. Customers only ever see the configured
message and the amount to pay. If no check can be recorded, the order follows `on_provider_error` (default: manual review),
never silent approval.

**Delivery success check (phone check at checkout).** As soon as the customer types a valid phone number, the checkout
runs the fraud check and the delivery-success policy (Settings → Fraud & advance → *Delivery success check*): the share of
the customer's past parcels that were actually received (store history plus the courier-history API) puts them in a tier —
Good, Medium, Low, New or Check failed — and each tier maps to cash on delivery, an advance, manual review or a block.
The default advance is a fixed ৳55, paid with bKash / Nagad *Send Money* right on the checkout page (sender number + TrxID);
it counts only after staff verify it. Customers see only what to do, never their rate. The tier is also available to
custom rules as `receive_rate_tier` / `receive_rate` / `parcel_count`.

**Repeat and duplicate orders.** A second checkout from the same phone and address within the merge window (default
3 minutes) is added to the first order — one parcel, one delivery charge — unless the merged order would need a stricter
risk decision, a coupon is involved, or the label was already printed. Other look-alike orders (same phone, or same address
in the same district, within 24 hours) are flagged *Possible duplicate*; staff merge them (items and stock reservations
move, the duplicate is cancelled without notifying the customer) or dismiss the warning. Every merge is kept in
`order_merges`.

**Labels and scanning.** Shipping labels (4×6 in, 3×4 in or four per A4 sheet) carry a Code 128 barcode of the order number
and, when booked, the courier tracking number. Printing records first print, reprints and who printed in the order history;
printed orders show *Printed* everywhere and reprints ask first. The scanner page (USB / Bluetooth scanner or phone camera)
marks parcels Ready to ship, Shipped (optionally assigning the courier) or Returned (restocked), refuses unconfirmed,
cancelled or still-in-production parcels, and writes every scan — including failures — to `parcel_scans`.

**Payments.** Online payments are confirmed only after the provider's validation API agrees; webhooks and redirects are
idempotent. Manual bKash/Nagad transfers wait for a staff member to verify the transaction ID.

**Finance.** Product revenue, delivery income and cost of goods are posted when an order is delivered (accrual). Advances, COD
settlements and online payments are cash movements, not revenue. Refunds on delivered orders reduce revenue; refunds of
advances on undelivered orders don't touch profit; kept advances are other income. Ad spend logged in Marketing posts to
Advertising automatically. System postings are idempotent (`source_key`), so retries never double-count.

---

## Tests and checks

```bash
npm run typecheck                 # TypeScript (app + config)
npm run test:unit                 # pure logic + provider adapters

# PostgreSQL integration tests: need a disposable PostgreSQL 16+ server you can create databases on.
# The harness creates a fresh database, applies supabase-stub.sql + every migration, and runs each
# test in a rolled-back transaction.
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db

npm run functions:check           # deno check for every Edge Function
npm run build                     # production bundle
```

The database suite covers the order state machine, stock reserve/release/commit/return, coupons, pricing and delivery
zones, fraud scoring and rule decisions, checkout advance requirements, payment idempotency, refunds and finance postings,
RLS / permission boundaries and privilege escalation, and that the seed loads through the real functions.

### Regenerating database types

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres npm run db:types
```

---

## Extending

- **Another courier:** implement `CourierProvider` (`createShipment`, `cancelShipment`, `getShipmentStatus`, `getTracking`,
  `getDeliveryCost`) in `supabase/functions/_shared/courier/providers.ts`, register it in `registry.ts`, and add its status
  mapping for the webhook.
- **Another payment gateway:** implement `PaymentProvider` in `_shared/payments/providers.ts` and register it; confirmations
  must go through `recordVerifiedPayment`.
- **Another fraud data source:** implement `FraudProvider` in `_shared/fraud/providers.ts` and add it to
  `providersFromSettings`; return outcome counts and let the database do the scoring.
- **Another notification channel/provider:** implement `NotificationProvider` in `_shared/notifications/providers.ts`.
