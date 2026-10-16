=== Fullfilio Connect for WooCommerce ===
Contributors: fullfilio
Tags: woocommerce, orders, courier, cod, abandoned checkout
Requires at least: 6.2
Tested up to: 6.8
Requires PHP: 7.4
WC requires at least: 7.8
Stable tag: 1.5.2
License: GPLv2 or later

Connects your WooCommerce store to Fullfilio.

== Description ==

Fullfilio reads orders and products through WooCommerce's own REST API with the keys you approve, and WooCommerce webhooks tell it about changes. This plugin adds:

* Instant order events with a retrying delivery queue (nothing is lost while Fullfilio is unreachable; nothing is imported twice).
* Unfinished checkouts: phone, name, address and cart of checkouts that were not completed, so your team can call back.
* Ad attribution: UTM tags, click ids (fbclid, gclid, ttclid) and Meta cookies saved on each order.
* Order shield: block-listed numbers are refused at checkout; customers with a poor courier delivery record are asked to pay in advance. If Fullfilio cannot answer within a few seconds the order goes through.
* Delivered and Returned order statuses, set by Fullfilio when the courier reports them.
* A health report, troubleshooting checks and a debug log under WooCommerce → Fullfilio.

Works with the classic and the block checkout, and with WooCommerce's order storage (HPOS).

== Installation ==

1. Plugins → Add New → Upload Plugin → choose fullfilio-connect.zip → Install → Activate.
2. In Fullfilio: Sales channels → WooCommerce → Connect, enter your store address and approve.
3. Fullfilio connects the plugin by itself. Check WooCommerce → Fullfilio: it shows "Connected".

== Privacy ==

The plugin sends Fullfilio the order and checkout details your staff need to process orders (customer name, phone, address, cart) and the visit information listed above. It sends nothing to any other service.

== Changelog ==

= 1.5.2 =
* The advance payment follows Fullfilio (Settings → Fraud) whenever the order shield is on: the customer pays the advance online and the rest on delivery. Your own per-level amounts on this site are now an optional extra.
* Fullfilio sees whether an online payment method is ready to take the advance.
* The Fullfilio icon shows on the Plugins and Updates screens.

= 1.5.1 =
* The order shield checks the phone number as soon as it is typed (classic and block checkout), so the courier record is ready when the order is placed — even with the advance payment off.
* The advance Fullfilio asks for is the real amount for this order (it now includes the cart's shipping); before, an "advance" could show as 0.
* A courier check that is still running or failed follows your Fullfilio "Couldn't check" policy (for example ask for the advance) instead of letting cash on delivery through, and is asked again after 30 seconds instead of being remembered for 10 minutes.

= 1.5.0 =
* Advance payment by delivery level: Fullfilio tells the checkout how reliable the customer is (Good, Medium, Low, New customer or Couldn't check), and you choose for each level: cash on delivery, the full delivery charge, a fixed amount, or a percentage of the order or of the delivery charge.
* The advance is taken by an online payment method you pick; a "Pay on delivery (cash)" line holds the rest, so the gateway charges only the advance. Cash on delivery is hidden while an advance is needed.
* The amount shows as soon as the phone number is typed (classic and block checkout) and is checked again on the server when the order is placed — a smaller payment or cash on delivery is refused.
* Fullfilio records the full order value, the advance as paid (only once WooCommerce confirms the payment) and the rest as cash to collect.

= 1.4.2 =
* Cleaner, minimal look in the Poppins typeface (bundled with the plugin, nothing loaded from outside).
* The Fullfilio logo in the page header, linking to your Fullfilio account.
* Quieter tabs, cards, buttons and switches that work the same at phone width.
* Updates read version numbers with two or three parts and any number of digits (1.5, 1.4.3, 1.4.10).

= 1.4.0 =
* New look: a clean WordPress-style page with module cards, status and switches, and pill buttons.
* Ad tracking, browser and server: PageView, ViewContent, AddToCart and InitiateCheckout fire in the browser and are sent from the server too, with one event id, so ad blockers lose nothing and nothing is counted twice.
* Better matching for a higher Event Match Quality: hashed email, phone, name, city, district, postcode, country and a first-party visitor id, plus fbc/fbp (created when missing), ttclid/_ttp, gclid, IP and browser. The page shows an estimate from the keys actually sent.
* "When the order is placed" sending rule (the normal way), next to call confirmation and delivery.
* Duplicate orders are not counted twice: the same customer again within 24 hours (you choose the hours).
* "Save & test connection" for Meta, TikTok and Google.
* Updates: WordPress now shows when a new Fullfilio Connect version is available, with Update now, View details and auto-updates. Each download is checked against its published SHA-256 before it is installed.

= 1.3.1 =
* Ad tracking works without connecting to Fullfilio: pixels load, click ids and browser cookies are saved on the order, and the conversion is sent when you mark the order Confirmed (or Delivered) yourself.
* When connected, Fullfilio now sends the customer's courier receive rate with the confirmation, so "Skip low-receive-rate customers" uses the real rate.
* Better matching: TikTok _ttp cookie and hashed customer id, GA4 client id from the _ga cookie, Google phone in E.164 format, Meta city normalised.

= 1.3.0 =
* Advanced ad tracking: Meta (Pixel + Conversions API), TikTok (Pixel + Events API) and Google (Ads gtag + GA4 Measurement Protocol / Enhanced Conversions), each a card you switch on with your own ids and tokens.
* Click ids matched server to server (fbc/fbp, ttclid, gclid/wbraid) with one event id per order so the browser Pixel and the server event de-duplicate.
* The conversion is held and sent only once the order is call-confirmed (or delivered), and never for a low-receive-rate customer — so your ad platforms learn from orders that are actually received, not from cancelled cash-on-delivery.

= 1.2.0 =
* New dashboard: orders and value of the last 14 days, unfinished checkouts, checkouts stopped or flagged, recent orders, stock and delivery health.
* Checkout protection: Bangladeshi mobile number check (Normal, or Strict that also refuses made-up numbers); the order keeps the clean 01XXXXXXXXX number.
* Bot protection: flags or blocks checkouts without any typing or tapping, sent within seconds, from scripts, filling a hidden field, or many orders from one IP; optional Cloudflare Turnstile.

= 1.1.0 =
* Order statuses follow Fullfilio: Confirmed, Shipped, Delivered, Partially delivered, Return in transit, Returned, Cancelled.
* Stock: items that come back (return, partial delivery) are put back in stock once; no double restock when Fullfilio keeps the stock.
* Stock section on the plugin page: who keeps the count, low and out-of-stock items, what was put back.
* Your logo from Fullfilio on the plugin page.
* Fix: unfinished checkouts without ad tags were refused.

= 1.0.0 =
* First release.
