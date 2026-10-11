=== Fullfilio Connect for WooCommerce ===
Contributors: fullfilio
Tags: woocommerce, orders, courier, cod, abandoned checkout
Requires at least: 6.2
Tested up to: 6.8
Requires PHP: 7.4
WC requires at least: 7.8
Stable tag: 1.0.0
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

= 1.0.0 =
* First release.
