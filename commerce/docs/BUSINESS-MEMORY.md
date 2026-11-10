# Fullfilio: business memory

The one page to read before any product, pricing, marketing or sales decision.
Last updated: 10 Nov 2026.

## What Fullfilio is

**Order management for cash-on-delivery (COD) online sellers in Bangladesh.** One place for
orders, fake-order (fraud) checks, courier booking, returns, stock and real profit. Works on its
own, or with the seller's Shopify or WooCommerce store.

- Website: fullfilio.com. The admin and Super Admin live on the same site.
- One-line pitch: *"From the first order to a delivered parcel: sync, fraud checks, courier booking and returns."*
- Promise to the seller: fewer fake COD orders, fewer returned parcels (RTS), couriers booked in
  bulk, and the true profit of every order after courier, ad and product costs.

## Pricing (live in the database)

All prices are in BDT, per month. Checked against the live plans on 26 Oct 2026.

| Plan | Price | Limits | Extra features |
|---|---|---|---|
| Starter | ৳1,600 | 3 staff · 1 store · 100 products · 1,100 orders/month | Shopify, WooCommerce, two-way stock sync, SMS, reports, abandoned carts, courier history (fraud check) |
| Growth | ৳3,100 | 5 staff · 1 store · 300 products · 2,600 orders/month | + ad attribution, custom domain |
| Pro | ৳5,990 | 20 staff · 10 stores · 900 products · 6,000 orders/month | + website API, external API, Cloud Calling (phone system) |
| Founder | free, hidden | none | Everything. This is the original business on the platform. |

- **Free trial** (used when the new-business offer is off): 2 days on Starter and Growth, 14 days on Pro.
- **Product limit**: products added by hand stop at the limit. Products synced from Shopify or
  WooCommerce keep coming in, and the admin then shows an "over the limit" notice with a link to the plans.

- **New-business offer** (switched on): ৳99 for the first month plus 2 days. Then a one-time
  setup fee of ৳1,000 together with the first month at the plan price. After that, the plan price.
- **Per-order fee**: ৳1.5 for each approved order (Super Admin can change it). Switched off for now.
- **Sign-up**: open sign-up is switched off. New businesses send a sign-up request by WhatsApp,
  and the platform team opens the business from it (Super Admin can switch open sign-up back on).
- **Credits**: SMS is sold as credits. Top-ups are paid by bKash, PayStation or SSLCommerz.
- **Courier (fraud) checks**: free for every business since 29 Oct 2026 (0 credits per check, Super Admin usage
  setting), up to 2,000 checks a month per business.

## What we have (features)

**Orders**
- Web Orders and Approved Orders with filters, search and bulk actions. Web Orders → All lists approved orders too,
  marked Approved with their stage now (since 1 Nov 2026).
- Order numbers: a web order has none of ours yet. It shows its Shopify or WooCommerce number, or a
  web reference (W10501) for an order made in Fullfilio. On approval it gets the business's own
  number: 1000, 1001, … (since 30 Oct 2026). A prefix is optional ("ATH" gives ATH-1000); none by default.
- The Orders Dashboard lists every order with its status now (approved stages, and web orders by call status such as
  "No response"), with counts per status and a filter panel: date (approved, order, shipped or delivered) and time of day,
  product or SKU, source, courier, taken by, courier payment, order or courier invoice number, status, order tags, district
  (since 31 Oct 2026). Its charts are under Report.
- Scan parcels has Reset log: the log on that device starts fresh; scans are never deleted (since 31 Oct 2026).
- Partly delivered parcels (since 8 Nov 2026): scanning one in Scan parcels → Returned opens a popup listing the items with their
  size; staff tick what came back (Restock or Damaged) and only that goes back to stock. "Partial delivery…" on the order fills it in,
  and Pathao's return label finds the order too. A fully delivered parcel is still final.
- Approved Orders list (since 10 Nov 2026): the phone number is one button, always in full; tapping it gives Call (Cloud
  Calling or the phone, recorded for call tracking), WhatsApp and Copy number. Six columns on a computer: Order (date, who
  handled it, Printed, flags, tags), Customer (note under the address), Products, Total, Courier, and Open with a ⋯ menu.
- Super Edit, merge, duplicate detection and smart auto-merge.
- Incomplete orders and abandoned carts. A Shopify or WooCommerce abandoned checkout has an Order button (since 8 Nov 2026): New order opens
  with the customer, address, district and products (matched by the store's variant link, then SKU); once created, the checkout counts as recovered.
- The Auto-pick queue.
- Order Financials (profit and loss per order).
- Call Tracking (since 3 Nov 2026), for the Owner and Admins only (permission calls.view): every tap on Call for an
  order, every call status set and every approval, with who and when. Web Orders → Call Tracking shows per staff
  member taps, call statuses, not reached, approved, cancelled and "closed without a call", the orders approved or
  cancelled without a tap, and web orders waiting over an hour that nobody tapped Call on. Each order has a Call
  history card. Employees see no call counts anywhere, and no "What's new" note was written so they are not told.
  A tap proves the button was used, not that the customer answered; Cloud Calling will record real calls.
- The dashboard's profit counts an order from the day it is approved (since 30 Oct 2026): its sale less product cost
  and courier charge. A returned order costs the courier's delivery and return charges, less what the customer paid
  (an advance, or cash at the door that the courier's webhook reports): a paid return charge is no loss, an unpaid one is. Finance → Profit & loss still counts a sale on delivery.

**Fake-order protection**
- A courier-history fraud check on every order, with a risk label, reasons and success % per courier.
- A risk-based advance (for example ৳55) at checkout, paid by bKash or PayStation.
- Duplicate-order and IP checks.

**Couriers**
- Steadfast, Pathao, RedX and Carrybee: connect, book in bulk with live progress, status webhooks, retries.
  Before a bulk upload, orders a courier already has are found in one check and skipped at once (since 31 Oct 2026);
  the rest go up three at a time.
- A parcel's journey (since 5 Nov 2026): Approved Orders → Journey (and the order page) shows every step from the courier,
  grouped by stage, with hubs, the rider's name and phone, and the time. Pathao's comes from its public tracking page
  (consignment id only; its API has just the status), RedX's from its tracking API; other couriers show the updates
  Fullfilio received. Anyone who can see orders can open it.
- Delivered, RTS and return handling.
- Courier invoice upload and checking, courier charges, labels and invoices with a label builder, a barcode scanner.
  The check matches each parcel to the order and compares the payout with your records; since 30 Oct 2026 it also
  compares the money received (typed at Mark paid), expects cash paid at the door on a returned parcel (kept as income
  when paid out), and a wrong upload can be deleted until it is verified.

**Sales channels**
- Shopify, two-way: orders, fulfilment, status, stock, cost, products, collections, returns.
  Every Shopify order imported into Fullfilio gets the tag "Fullfilio" in Shopify (since 30 Oct 2026; a
  switch per store, on by default), so Shopify's "Tagged with: Fullfilio" filter shows what came in.
- WooCommerce, through our WordPress plugin "Fullfilio Connect": order sync, stock, a risk-based
  advance at checkout, first-party ad tracking.
- Only one channel can be active at a time.

**Own online store** (for sellers without Shopify or WooCommerce)
- Theme editor like Shopify's: sections, drafts and publish.
- Mobile checkout like Shopify's.
- Cart drawer with upsells, bundles and quantity breaks.
- Search engine features: titles, sitemap, structured data, redirects.
- Custom domain, own favicon.
- Meta, TikTok and Google pixels plus server-side events.

**Marketing**
- Meta, TikTok and Google Ads connections.
- An ads hub: spend, profit, campaign quality.
- Attribution of each order to Paid, Organic, Direct or Referral.
- SMS automation.

**Messaging**
- One inbox for Facebook, Instagram and WhatsApp, with comments, auto-replies, moderation and follow-ups.
- Orders can be created from a chat.
- Bring old chats (since 9 Nov 2026): a button on each connected Facebook Page / Instagram account copies its chats from Meta
  (30 days, 90 days or a year; the last 25 messages of each) into the inbox. Only when pressed; no duplicates; nobody is messaged. Not for WhatsApp.

**Operations**
- Inventory: low-stock alerts, dead stock, ABC analysis, a forecast, purchases.
- Customers, with a district map.
- Finance: income and expenses.
- Multi-branch.

**On the phone** (since 1 Nov 2026)
- Fullfilio installs as an app (iPhone: Safari → Share → Add to Home Screen; Android: Chrome → Install app) and opens on
  the dashboard. A guide shows how once per phone; account menu → Install the app opens it again.
- New-order push notifications per device (My account → App and notifications): within about 15 seconds, one per order or
  one for a burst, never for an order the person made. Built-in web push, no outside service; its keys sit in Vault and
  were made by the server itself. On iPhone it needs the Home Screen app (iOS 16.4 or later).
- A "ka-ching" for each new order while the admin is open (one per burst, not for the person's own orders, one across tabs;
  on by default, per device in My account → App and notifications). Our own synthesized sound, `public/media/new-order.mp3`
  (`scripts/make-order-sound.mjs`). With the app closed the notification uses the phone's own sound (a website cannot set
  one); on Android the sound can be downloaded and picked as the app's notification sound.

**Team**
- Roles and permissions, including the Call role, which sees no costs or profit, and the Moderator
  role, which only answers messages and comments and creates orders from them.
- HR: attendance, breaks, shifts, an SOP checklist, "must check in to work", the live team.
- Device approval.

**Platform (Super Admin)**
- Merchants, plans and billing, credits, Fullfilio Payments, domains, support, health, incidents, finance.
- Two-person approval to delete a merchant.
- Error tracker (since 10 Nov 2026; Super Admin → Error Tracker, permission health): every error from the admin, the panel,
  server functions, webhooks and jobs, one entry per error across businesses. Status New → Investigating → Fixed or Ignored,
  a note and "fixed in"; a fixed error that happens again reopens as "came back" (not when it comes from a tab older than the
  fix). Each entry keeps its last 20 occurrences with the steps the person took before it (pages, buttons, API calls), the
  page and the app version, a count per day, the server side of a browser error (same request id), a likely cause, and a
  "Copy for Claude" report. Uncaught browser errors and "Something went wrong" messages are reported too.

**Coming soon / in progress**
- Cloud Calling (the built-in phone system; called VoiceDrive PBX in the code and database) is shown as "coming soon".
- The move from Supabase to a Cloudflare-only database runs on staging only.

## Ideal customer

**Primary target: Bangladeshi COD brands that sell through a Facebook page or Instagram and are growing.**

- Sell fashion, cosmetics, gadgets, home goods, food or gifts.
- 30 to 300 orders a day (about 1,000 to 9,000 a month). Up to about 85 a day fits Growth (2,600 a month),
  up to about 200 a day fits Pro (6,000 a month). The top of this range is above every public plan's order limit.
- A small team of 3 to 15: page moderators or call agents who confirm orders, packers, and an owner who watches money.
- Spend real money on Meta ads, and want to know which ads make *profit*, not just orders.
- Ship mainly by Steadfast, Pathao, RedX or Carrybee, almost all COD.
- Their pain:
  - fake or prank orders;
  - high RTS (returned parcels: 15–30% is common);
  - copying orders into courier panels by hand;
  - stock mismatches;
  - not knowing the real profit after courier and ad costs.

**Secondary targets**
1. **Shopify or WooCommerce store owners in Bangladesh.** They already have a website but run COD
   operations in Excel and courier panels. Selling point: "Connect in a minute; everything syncs back to your store."
2. **New sellers starting out.** One person, under 30 orders a day. Hook: the ৳99 first month,
   the Starter plan, and a free own store so they need no Shopify bill.
3. **Multi-brand owners and small agencies running several shops.** This is the Pro plan (10 stores, 20 staff).

**Not a good fit** (don't spend ad money here)
- Sellers paid up front only, with no COD.
- Sellers on marketplaces only (Daraz).
- B2B or wholesale sellers.
- Sellers outside Bangladesh: the couriers, payments and fraud checks are Bangladesh-specific.

## How to reach them

- **Where they are:**
  - Bangladeshi e-commerce Facebook groups (for example e-CAB and Women and e-Commerce Forum (WE) circles);
  - courier merchant communities;
  - YouTube tutorials in Bangla;
  - Shopify and WooCommerce developers and agencies in Dhaka.
- **Meta ads:** Bangladesh, ages 20–40, people who manage Facebook pages or ad accounts, with
  interests in online business, Shopify, WooCommerce and the courier brands. Retarget website visitors.
- **Messages that work** (lead with the pain, in Bangla and English):
  - "Stop fake COD orders before you ship."
  - "Cut your RTS. See each customer's courier success rate first."
  - "Book 100 parcels to Steadfast, Pathao or RedX in one click."
  - "See real profit per order after courier and ad costs."
- **Partners:**
  - courier companies (co-marketing to their merchants);
  - Shopify and WooCommerce agencies (referral share);
  - Facebook-page trainers.
- **Proof to show:**
  - the interactive dashboard demo on the website;
  - the demo account (demo@gmail.com), a look-only admin full of sample data;
  - a before/after RTS rate from the Founder store;
  - a short Bangla video of one order going from Facebook to delivered.

## Facts to keep straight

- Payments to Fullfilio: bKash, PayStation, SSLCommerz. The currency is BDT.
- Messaging (the inbox and "Continue with Facebook") uses the Meta app "Fullfilio", 1733096427752798.
  Do not change the old app, 1653473169830242.
- fullfilio.com has its own Meta pixel, sent from the browser and from our server with one event id:
  PageView, ViewContent (the prices), Lead (contact form, WhatsApp sign-up), CompleteRegistration and
  StartTrial (a new store). Pixel: the "FullFilio" dataset, 1871039407582107 (`SITE_META_PIXEL` in `src/features/site/site-meta.ts`); server
  token: Worker secret `SITE_META_CAPI_TOKEN`. Not on the admin or on stores.
- fullfilio.com must never point at 144.24.232.70.
- The demo account demo@gmail.com opens the business "Demo": look only (view and export, no changes, sign-in
  details locked) and kept out of the Super Admin figures. Since 29 Oct 2026 it holds sample data from
  `supabase/demo-sample-data.sql`: a fashion shop with 12 products and 60 orders (prefix DEMO) over 30 days.
- Security: six audits so far (the last one is `docs/SECURITY-AUDIT-RUN-6.md`). Nothing critical or high was found; run 6's
  four medium and nine low findings are fixed and live (database and functions 28 Oct, website and Worker 29 Oct 2026).
