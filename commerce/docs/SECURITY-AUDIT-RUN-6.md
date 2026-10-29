# Security audit run 6 (cloudflare/security-audit-skill)

Scope: everything changed since run 5 (5371b2d..bce37dc): email and WhatsApp messages, Confirm /
Cancel links, cart reminders, review requests and the owner's daily summary, the Moderator role,
the Fullfilio website pixel and its server copy, smart order merging, platform announcements,
billing, plus the run-5 fixes, leads and its one deferred unit. Profile standard, 28 agents
(hunters, coverage critics, verifiers). Every confirmed problem was reproduced in a sandbox (no
network, throwaway Postgres built from the migrations) and checked by a verifier that did not
find it. Full records: `/srv/security-audit/run-6/` (REPORT.md, FINDINGS-DETAIL.md, NEEDS-VALIDATION.md).

**Result: no critical or high problems. 4 medium and 9 low confirmed, all fixed. The 5 leads that
need a fact from outside the code are hardened anyway.** Everything stays inside one store, except
the browser ids of stores opened by link, which mixed opaque ids across stores.

## Confirmed and fixed

| # | Problem | Fix | Test |
|---|---|---|---|
| 1 | (medium) A Moderator (create orders only) could send another order's key to "create order" and get that order back, or confirm it, even one held for a fraud check or an advance; an order that joined an earlier one showed the Moderator that order. | An existing order is opened only with orders.view, confirmed only with orders.status (+ fraud.review for held orders). Without orders.view a merge returns only the order's number and status. | `audit-run6.test.ts` |
| 2 | (medium) The customer's secret Confirm / Cancel link was kept in the message log, where read-only staff could copy it and cancel or confirm orders. | The log keeps only "has buttons"; the token is made when the message is sent. The kept copy of an email shows `…/hidden` instead of the token and "Send again" puts it back. Saved rows were cleaned. | `audit-run6.test.ts`, `senders.test.ts` |
| 3 | (medium) Anyone typing an existing customer's phone at checkout (or through the website API) was shown that customer's open order: name, address, items, order number. | A checkout that joins an earlier order is told only "added to your earlier order" with its own lines; never the earlier order's number or details. A checkout key used with another phone is refused instead of replayed. The thank-you page shows just the added items. | `audit-run6.test.ts`, `smart-merge.test.ts`, `checkout-fulfillment.test.ts` |
| 4 | (medium) An admin could point the Email page at their own mail server and leave the password empty; Fullfilio then signed in there with the owner's saved mailbox password. | The saved password is kept with its server and used only for that server, port, security and username. Any change needs the password typed again; sending refuses a changed server. | `senders.test.ts` |
| 5 | (low) The Moderator's order quote carried product cost prices. | Costs are left out of the quote for staff who may not see them. | `audit-run6.test.ts` |
| 6 | (low) Run-5 setup-fee regression: an unpaid plan change carrying the ৳1,000 fee made the renewal leave the fee out. | An open, unpaid plan change no longer counts as "fee invoiced", for the renewal and for the plan page. | `audit-run6.test.ts` |
| 7 | (low) "Send again" re-queued emails skipped for the Fullfilio email service's daily limit, so the limit did not hold. | Sending again counts against today's limit like a new email. | `audit-run6.test.ts` |
| 8 | (low) The owner's daily summary (profit, ad spend) was readable in the message log by staff without finance access, including the Call role. | Summary rows need finance.view. | `audit-run6.test.ts` |
| 9 | (low) Each anonymous cart with the same phone queued its own paid SMS / WhatsApp reminder. | One cart reminder per phone number or address per 24 hours (the cart's own second reminder still goes). | `audit-run6.test.ts` |
| 10 | (low) Cart reminder emails went to whatever address an earlier order with that phone typed. | Reminder emails go only to the signed-in customer's own address. Names are cleaned (one line, 100 characters). | `audit-run6.test.ts` |
| 11 | (low) Platform employees limited to some stores could read every recipient store of an announcement, withdraw all-store announcements and edit any draft. | Get shows only their stores; withdraw and edit need the announcement to be within their stores. | `audit-run6.test.ts` |
| 12 | (low) The `ff_vid` and `_fbc` cookies are shared by every page of fullfilio.com, so one store's visitor id and ad click travelled with another store's orders and with the website pixel. | The `ff_vid` cookie is used only on a store's own address. Stores opened by link keep their Meta ids per store and do not send the host's TikTok / Google cookies. The website pixel has its own id and does not forward `_fbc`. | `store-identity.test.ts`, `ad-pixels.test.ts` |
| 13 | (low) Browser storage was keyed by the store name, which another business can take after a rename: the new owner's store loaded the old cart and attribution. | Each address remembers which business wrote its entries; when that changes, the old entries are dropped (and the page reloads once). | `store-identity.test.ts` |

Also locked: `admin_update_setting` refuses the `notifications` key (it could overwrite the template
switches and the owner summary without the checks of the Email and WhatsApp pages).

## Open leads, hardened anyway

- **Email template engine** (`liquid.ts`): values kept by `assign`, `capture` and filters now count
  against the 600,000-character limit (and all filter output against 6 million), checked before
  `append`, `replace` and `join` build the text. The tokenizer, condition and range parsing and the
  plain-text version (`htmlToText`) read each part once instead of quadratic regexes (a 100,000
  character test took 22 s before, under 1 s now). Output of the built-in templates is unchanged.
- **Website event relay** (`worker/site-events.ts`): refuses a declared body over 4 KB and stops
  reading a streamed one at 4 KB.
- **Live-update sockets** (Cloudflare database, staging only): signed-in sockets close 5 minutes
  after their token expires, when the page sends a token that no longer verifies, and past 20
  sockets for one account.
- **Fullfilio email service**: the per-recipient cart bound (#9) and the limit on "Send again" (#7)
  apply here too. A platform-wide bound depends on the Resend plan (owner check).

## Behaviour changes

- A repeat checkout that joins the customer's open order now shows "Added to your earlier order"
  with only the items just added; the order number and details come by SMS. Orders still merge
  by phone (the business rule), and the other address is noted for the confirmation call.
- Changing the mail server, port, security or username on the Email page needs the mailbox
  password again. Mailboxes connected before this change keep working on the same server.
- Cart reminders: at most one per phone number or email address per 24 hours per store.
- The website pixel's external id is new for every visitor once (its own `ffw_vid`).

Not fixable in code while stores share fullfilio.com by link: Meta's, TikTok's and Google's own
scripts write their cookies for the whole host. Our server copies no longer use them on such stores.

## Migration

Run in this order, before deploying the functions (both safe to re-run):

1. `supabase/migrations/20261206000100_audit_run6_orders_billing_platform.sql`: orders (#1, #3, #5),
   billing (#6), announcements (#11), settings lock.
2. `supabase/migrations/20261206000200_audit_run6_messaging.sql`: reply tokens (#2), summary
   rows (#8), "Send again" limit (#7), cart reminders (#9, #10); cleans the saved rows.

Then deploy the `messaging`, `notifications-dispatch`, `checkout` and `site-api` functions and the
Worker / website. The Cloudflare database snapshot (`worker/db/generated/`) is regenerated.

**Deployed:** both migrations run in production and `messaging` (v6) and `notifications-dispatch` (v9)
deployed on Supabase on 28 Oct 2026; both functions answer and refuse signed-out calls. `checkout`,
`site-api`, the Worker and the website went to the live branch the same day; Cloudflare's first build
of it failed (the same commit builds, fits the size limit and starts in under 100 ms locally). The
retried build succeeded on 29 Oct 2026 and fullfilio.com serves the new code.

## Verification

Typecheck, lint and the Deno check of all functions clean; production build passes. Unit 1048
passed (2 skipped). Postgres DB 790/790 from all 191 migrations, including the new
`audit-run6.test.ts`; the new tests fail on the code before these fixes. On the Cloudflare engine
(staging only) the changed suites pass except one cart-reminder test, which fails the same way on
the commit before these changes (`messaging_due_carts` returns the wrong step there).
Email templates: the built-in templates render the same text and HTML before and after (188
comparisons).
