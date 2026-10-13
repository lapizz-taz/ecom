/* Fullfilio Connect — advanced ad tracking (browser side).
 * Loads only the pixels the merchant turned on and fires the FUNNEL events
 * (PageView, ViewContent, InitiateCheckout, AddToCart). The Purchase event is
 * held and sent server-side once the order is call-confirmed; it fires here
 * only when the merchant opted in, and then with the same event id as the
 * server so Meta/TikTok de-duplicate. No conversion is counted for an order
 * that is never confirmed. */
(function () {
  'use strict'
  var t = window.ffcTrack || {}
  var funnel = !!t.funnel

  // ---- loaders (only when an id is present) ----
  if (t.meta) {
    !(function (f, b, e, v, n, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) }
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []
      s = b.createElement(e); s.async = !0; s.src = 'https://connect.facebook.net/en_US/fbevents.js'
      var x = b.getElementsByTagName(e)[0]; x.parentNode.insertBefore(s, x)
    })(window, document, 'script')
    try { window.fbq('init', t.meta); window.fbq('track', 'PageView') } catch (e) {}
  }
  if (t.tiktok) {
    !(function (w, d, ti) {
      w.TiktokAnalyticsObject = ti; var ttq = w[ti] = w[ti] || []
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie']
      ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } }
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i])
      ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e }
      ttq.load = function (e, n) {
        var r = 'https://analytics.tiktok.com/i18n/pixel/events.js'; ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r
        ttq._t = ttq._t || {}; ttq._t[e] = +new Date(); ttq._o = ttq._o || {}; ttq._o[e] = n || {}
        var s = d.createElement('script'); s.type = 'text/javascript'; s.async = !0; s.src = r + '?sdkid=' + e + '&lib=' + ti
        var a = d.getElementsByTagName('script')[0]; a.parentNode.insertBefore(s, a)
      }
      ttq.load(t.tiktok); ttq.page()
    })(window, document, 'ttq')
  }
  if (t.gads || t.ga4) {
    var gid = t.ga4 || t.gads
    var g = document.createElement('script'); g.async = true
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gid)
    document.head.appendChild(g)
    window.dataLayer = window.dataLayer || []
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments) }
    window.gtag('js', new Date())
    if (t.ga4) window.gtag('config', t.ga4)
    if (t.gads) window.gtag('config', t.gads)
  }

  function meta(ev, data, id) { if (t.meta && window.fbq) try { window.fbq('track', ev, data || {}, id ? { eventID: id } : undefined) } catch (e) {} }
  function tiktok(ev, data) { if (t.tiktok && window.ttq) try { window.ttq.track(ev, data || {}) } catch (e) {} }

  // ---- funnel events ----
  if (funnel) {
    if (t.page === 'product' && t.product) {
      var p = t.product
      meta('ViewContent', { content_type: 'product', content_ids: [p.id], content_name: p.name, value: p.price, currency: p.currency })
      tiktok('ViewContent', { contents: [{ content_id: p.id, content_name: p.name, price: p.price }], value: p.price, currency: p.currency })
      if (window.gtag) window.gtag('event', 'view_item', { currency: p.currency, value: p.price, items: [{ item_id: p.id, item_name: p.name, price: p.price }] })
    }
    if (t.page === 'checkout') {
      meta('InitiateCheckout')
      tiktok('InitiateCheckout')
      if (window.gtag) window.gtag('event', 'begin_checkout')
    }
    // Add to cart: WooCommerce fires this jQuery event on AJAX add-to-cart.
    if (window.jQuery) {
      window.jQuery(document.body).on('added_to_cart', function () {
        meta('AddToCart'); tiktok('AddToCart')
        if (window.gtag) window.gtag('event', 'add_to_cart')
      })
    }
  }

  // ---- optional browser Purchase (deduped with the server via eventID) ----
  if (t.purchase) {
    var o = t.purchase
    var ids = (o.contents || []).map(function (c) { return c.id })
    meta('Purchase', { value: o.value, currency: o.currency, content_type: 'product', content_ids: ids, contents: (o.contents || []).map(function (c) { return { id: c.id, quantity: c.quantity, item_price: c.item_price } }) }, o.event_id)
    tiktok('CompletePayment', { value: o.value, currency: o.currency, contents: (o.contents || []).map(function (c) { return { content_id: c.id, content_name: c.name, quantity: c.quantity, price: c.item_price } }) })
    if (window.gtag && t.gads) {
      // Google Ads conversion (label is applied server-side via GA4 import; this is the client signal).
      window.gtag('event', 'conversion', { send_to: t.gads, value: o.value, currency: o.currency, transaction_id: o.event_id })
    }
  }
})()
