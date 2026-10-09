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
6. **Scheduled jobs** — `expire-unpaid-advance-orders` is created by the migrations. Add the HTTP jobs once; they send the
   shared secret kept in Vault:
   ```sql
   create extension if not exists pg_net;
   -- The migrations create a random 'cron_secret' in Vault; payment-webhook and notifications-dispatch accept it as is.
   -- For courier, set the CRON_SECRET function secret to the same value (or replace the Vault secret with yours).

   -- Sends waiting customer messages and fetches SMS delivery reports; calls the function only when there is work.
   select cron.schedule('notifications-dispatch', '* * * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/notifications-dispatch',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
       body := '{}'::jsonb)
     where exists (select 1 from public.notification_logs
                   where (status = 'QUEUED' and next_attempt_at <= now())
                      or (channel = 'SMS' and status = 'SENT' and delivery_status = 'PENDING'
                          and sent_at < now() - interval '1 minute'))
   $$);

   select cron.schedule('courier-sync', '*/30 * * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/courier',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
       body := '{"action": "sync_all"}'::jsonb)
   $$);

   -- Meta Ads: spend, impressions, clicks and conversions for the last 3 days, every 3 hours, only while connected.
   select cron.schedule('meta-ads-sync', '17 */3 * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/meta-ads',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
       body := '{"action": "sync", "days": 3}'::jsonb)
     where (select (value ->> 'connected')::boolean from public.settings where key = 'meta_ads')
   $$);

   -- Finishes bKash / PayStation payments whose customer paid but never came back to the store.
   -- Calls the function only while such a payment is waiting.
   select cron.schedule('payments-reconcile', '*/5 * * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/payment-webhook?reconcile=1',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
       body := '{}'::jsonb)
     where exists (select 1 from public.payments
                   where status = 'PENDING' and provider in ('bkash', 'paystation')
                     and created_at < now() - interval '3 minutes' and created_at > now() - interval '3 days')
   $$);
   ```
7. **Provider callbacks**
   - bKash and PayStation need nothing here: each payment carries its own callback URL
     (`https://<ref>.supabase.co/functions/v1/payments?callback=…`), and the reconcile job above covers customers who
     close the tab. Connect them in **Settings → Payments → Online payment gateways**.
   - SSLCommerz IPN: `https://<ref>.supabase.co/functions/v1/payment-webhook?provider=sslcommerz`
   - SMS: connect the provider on the **SMS** page (Alpha SMS / sms.net.bd, BulkSMSBD, SSL Wireless, or any gateway with
     an HTTP send URL). The key is tested (balance check where the provider has one) and stored in Vault; nothing is
     configured as a function secret. SSL Wireless only accepts whitelisted server IPs.
   - Meta Ads: **Ads → Meta Ads → Connect**. Paste a long-lived token (Business Settings → System users → Generate token)
     with `ads_read` (and `pages_show_list` for the Page / Instagram names), pick the ad account; it is tested, stored in
     Vault and the last 30 days are synced. Set the exchange rate (ad account currency → yours) and VAT % there.
     Paste the URL parameters from **Ads → Tracking setup** into every ad so orders carry the campaign, ad set and ad.
   - Pathao and Steadfast status webhooks: **Couriers → Connections → Webhook** shows the callback URL
     (`…/functions/v1/courier-webhook?courier=<id>&provider=pathao|steadfast`) and a secret to paste into the courier's
     panel. Pathao sends it in `X-PATHAO-Signature`, Steadfast as `Authorization: Bearer …`; it is kept in Vault.

### Edge Function secrets

| Secret | Used for |
| --- | --- |
| `ALLOWED_ORIGINS`, `STOREFRONT_URL` | CORS for public functions; links in emails and payment redirects. Without `STOREFRONT_URL` the *Website* from **Settings → Store** is used |
| `CRON_SECRET` | Authenticates pg_cron calls to `notifications-dispatch`, `courier` and `payment-webhook?reconcile=1`. `payment-webhook` and `notifications-dispatch` also accept the `cron_secret` the migrations keep in Vault, so their jobs need no extra secret |
| `BDCOURIER_API_KEY`, `BDCOURIER_API_URL` (optional) | BD Courier (api.bdcourier.com) key for the courier history check, used when no key is saved in Settings |
| `META_APP_SECRET` (optional) | Adds `appsecret_proof` to Meta Graph API calls (recommended when the app requires it). `META_GRAPH_VERSION` overrides the API version (default v23.0) |
| `COURIER_HISTORY_API_KEY`, `COURIER_HISTORY_URL` (optional) | Fallback LLCG key for the courier history check. Normally it is connected in **Settings → Fraud & advance → Courier history check**: the key is tested with a real lookup, then stored encrypted in Supabase Vault and never returned to a browser |
| `FRAUD_API_URL` (with `{phone}`), `FRAUD_API_KEY`, `FRAUD_API_AUTH_HEADER`, `FRAUD_API_AUTH_SCHEME` | Optional other courier-history API with configurable field mapping |
| `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_BASE_URL` (all optional) | Fallback bKash Merchant API (tokenized checkout) credentials. Normally connected in **Settings → Payments**: tested by granting a token, then stored encrypted in Supabase Vault |
| `PAYSTATION_MERCHANT_ID`, `PAYSTATION_PASSWORD`, `PAYSTATION_TOKEN`, `PAYSTATION_BASE_URL` (all optional) | Fallback PayStation credentials, likewise normally connected in **Settings → Payments** |
| `ALLOW_INSECURE_GATEWAY_URL` | Local testing only: lets a payment or SMS gateway's *API address* be `http://` (a mock). Never set it in production |
| `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD` | Card / mobile-banking payments |
| `PATHAO_WEBHOOK_SECRET`, `STEADFAST_WEBHOOK_TOKEN` (optional) | Webhook secrets for provider-wide URLs (`?provider=…` without `courier=`). Normally set per courier under **Couriers → Webhook** |
| `PATHAO_WEBHOOK_INTEGRATION_SECRET` (optional) | Overrides the value returned in Pathao's `X-Pathao-Merchant-Webhook-Integration-Secret` handshake header, should Pathao change it |
| `STEADFAST_*`, `PATHAO_*`, `REDX_*` (optional) | Fallback courier keys. Normally couriers are connected in **Admin → Couriers**; keys entered there are tested with the courier, then stored encrypted in Supabase Vault by the service role and never returned to a browser |
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
The default advance is a fixed ৳55, paid right on the checkout page: online with bKash or PayStation when connected
(confirmed instantly by the gateway), or by bKash / Nagad *Send Money* with the sender number and TrxID, which counts only
after staff verify it. Customers see only what to do, never their rate. The tier is also available to
custom rules as `receive_rate_tier` / `receive_rate` / `parcel_count`.

**Courier history check.** With a key connected, the phone check also asks the courier fraud-check service (the one behind
the [`fraud_checker`](https://github.com/Almas-Ali/fraud_checker) library) how many parcels each courier — Pathao,
Steadfast, RedX, Paperfly — carried for the number and how many were cancelled at the door. Those counts are merged with the
store's own history (the larger count wins) before the tier is worked out. Staff see the per-courier table on each order;
customers never do. A lookup times out after 5 seconds; a failed lookup counts as *Check failed* (default: advance) for
numbers with no history of their own and is retried after 2 minutes, while a successful one is reused for
`cache_minutes`.

**Repeat and duplicate orders.** A second checkout from the same phone and address within the merge window (default
3 minutes) is added to the first order — one parcel, one delivery charge — unless the merged order would need a stricter
risk decision, a coupon is involved, or the label was already printed. Other look-alike orders (same phone, or same address
in the same district, within 24 hours) are flagged *Possible duplicate*; staff merge them (items and stock reservations
move, the duplicate is cancelled without notifying the customer) or dismiss the warning. Every merge is kept in
`order_merges`.

**Courier updates, charges and statements.** Every courier webhook lands in the Webhooks log with the parcel, the old and
new status, the result and any error. Each event is applied once (a repeat is counted, not re-applied), an update older
than the parcel's current state is ignored, an event for a parcel not booked yet waits and is retried automatically
(`courier-webhook-retry`, every 5 minutes, up to 6 tries), and a failure leaves nothing half-applied. Courier costs per
parcel — delivery fee, return charge, COD fee (Couriers → edit → *COD fee %*) and other fees — start as estimates and
are replaced by what the courier reports, first in webhooks and finally in its statement; each correction is a separate
finance entry, so nothing is charged twice. **Couriers → Statements** takes the courier's invoice or payment statement
(CSV or Excel; columns are detected and can be changed), matches every line to a parcel by consignment ID or order
number, and flags unknown parcels, duplicates and any collected amount or fee that differs from our records, with the
expected payout next to the courier's. *Verified* makes the statement's fees the parcels' actual charges; *Paid* also
marks the cash it collected as received on each order. **Couriers → Performance** shows shipped, delivered, returned and
cancelled parcels, delivery and return rates, and total and per-order courier cost for any period.

**Labels and scanning.** Shipping labels (4×6 in, 3×4 in or four per A4 sheet) carry a Code 128 barcode of the order number
and, when booked, the courier tracking number. Printing records first print, reprints and who printed in the order history;
printed orders show *Printed* everywhere and reprints ask first. The scanner page (USB / Bluetooth scanner or phone camera)
marks parcels Ready to ship, Shipped (optionally assigning the courier) or Returned (restocked), refuses unconfirmed,
cancelled or still-in-production parcels, and writes every scan — including failures — to `parcel_scans`.

**Payments.** Online payments are confirmed only after the provider's validation API agrees; webhooks and redirects are
idempotent. With bKash the store executes the payment server-side and counts it only when bKash reports it *Completed*
for that paymentID; with PayStation the transaction-status API must report it successful. Either way `confirm_payment()`
checks the amount against what is due (a short payment is held for review) and ignores a repeated confirmation, so a
callback, a retry and the reconcile job can all arrive without paying twice. A `status=success` in the return URL is never
trusted on its own. Customers who cancel can try again from the order page; staff can ask the gateway about any pending
attempt from the order (*Check with bKash*). The bKash access token is granted once an hour and shared between function
instances through Vault. Manual bKash/Nagad transfers wait for a staff member to verify the transaction ID.

**SMS.** The **SMS** page connects one SMS provider and turns automatic SMS on or off. *Automations* pick the event
(order placed, approved, pre-order confirmed, advance needed, payment received or failed, shipped, out for delivery,
delivered, return initiated, returned, cancelled), optional conditions (payment method, order total, district, first
order or repeat customer, courier, where the order was placed) and the message, with variables such as
`{{order_number}}`, `{{total}}` and `{{tracking_url}}`. Several automations may share an event. A customer gets at most
one message per automation, order and event (out-for-delivery at most once a day), so a status set twice or a repeated
courier webhook never texts twice. Amounts are written "Tk 1,250" so messages stay in the cheaper GSM encoding (a ৳,
Bangla or emoji makes the whole message Unicode: 70 instead of 160 characters per SMS); the editor shows the part count
and cost as you type. Messages are sent within a minute (the dispatcher is also nudged after checkout, payments and
courier updates), retried twice on temporary errors and failed at once on permanent ones (an invalid number, an
unapproved sender ID); a message left half-sent is marked failed rather than sent again. Failures appear in the
Messages tab and the System log. Delivery reports are fetched where the provider offers them (Alpha SMS). Each sent
SMS posts its cost to Finance (category *SMS*) against its order — the estimate from *Cost per SMS* first, then one
adjustment when the provider reports the actual charge — so don't add SMS top-ups as expenses. A problem while
queueing a message is written to the System log and never stops the order change itself.

**Ads & attribution.** Every order keeps where it came from (first and last touch: UTM tags, fbclid / gclid / ttclid,
referrer, landing page). An order belongs to a Meta campaign, ad set or ad only when its link carried that id; orders without
tracking data stay *Unknown* and never get ad spend. Meta spend is synced per ad, day and placement (Facebook, Instagram,
Messenger…) and converted with the rate and VAT set on the Meta Ads tab; it posts to *Advertising* in Finance. The
*Attribution & profit* report groups orders by source, medium, campaign, ad set, ad, day or product and shows orders,
approved, shipped, delivered, cancelled and returned counts, delivered revenue, ad spend, courier delivery / COD / return
charges, the cost of the goods kept, net profit, cost per (delivered) order and ROAS — all from real orders and deliveries.
Gateway fees: set *bKash / PayStation fee you pay (%)* under **Settings → Payments**; each successful payment posts it to
*Payment fees*.

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
RLS / permission boundaries and privilege escalation, courier webhooks, charges and statements, SMS automation (dedupe,
conditions, retries, delivery reports, costs in Finance), and that the seed loads through the real functions.

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
- **Another SMS provider:** implement `SmsProvider` (`send`, `balance`, `report`) in `_shared/sms/providers.ts`, add its
  code and required fields there and in `src/features/sms/sms-provider.tsx`. Throw `SmsError(…, true)` for errors that
  retrying can't fix.
- **Another notification channel/provider:** implement `NotificationProvider` in `_shared/notifications/providers.ts`.
