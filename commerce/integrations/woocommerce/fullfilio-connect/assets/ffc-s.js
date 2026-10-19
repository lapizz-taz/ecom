/* Fullfilio Connect — ad tracking, browser side.
 * Loads only the pixels the merchant turned on. Every funnel event (PageView,
 * ViewContent, AddToCart, InitiateCheckout) is fired here with an event id and
 * the same id goes to this store's own domain (t.server, a path random per site),
 * whose server sends the copy to Meta / TikTok — the platforms count it once, and
 * an ad blocker that stops the pixel does not stop the event. Each id is sent to
 * the store once; InitiateCheckout fires once per cart and the Purchase once per
 * order in this browser. The Purchase fires here only when it counts now (see
 * FFC_Tracking::enqueue), with the order's own id.
 * A first-party visitor id (ffc_vid) is the external_id for browser and server. */
(function () {
  'use strict'
  var t = window.ffcTrack || {}
  var am = t.am || null
  var ABC = 'abcdefghijklmnopqrstuvwxyz0123456789'

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
    try { return m ? decodeURIComponent(m[1]) : '' } catch (e) { return '' }
  }
  // The widest domain the browser accepts a cookie on (shop.example.com.bd → example.com.bd): the
  // one Meta's pixel uses, so the store's own cookies and the pixel's are the same cookie.
  var DOMAIN = (function () {
    var h = location.hostname
    if (!h || /^[\d.]+$/.test(h) || h.indexOf('.') < 0 || h.indexOf(':') >= 0) return ''
    var parts = h.split('.')
    for (var i = 2; i <= parts.length; i++) {
      var d = parts.slice(-i).join('.')
      document.cookie = 'ffc_cd=1; path=/; domain=.' + d
      if (cookie('ffc_cd') === '1') {
        document.cookie = 'ffc_cd=; path=/; domain=.' + d + '; expires=Thu, 01 Jan 1970 00:00:00 GMT'
        return d
      }
    }
    return ''
  })()
  function setCookie(name, value, days) {
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + new Date(Date.now() + days * 864e5).toUTCString() +
      '; path=/' + (DOMAIN ? '; domain=.' + DOMAIN : '') + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '')
  }
  function store(kind) { try { var x = window[kind]; x.setItem('ffc_t', '1'); x.removeItem('ffc_t'); return x } catch (e) { return null } }
  var session = store('sessionStorage'), local = store('localStorage')
  function rid(n) {
    var out = '', a = new Uint8Array(n), c = window.crypto || window.msCrypto
    if (c && c.getRandomValues) c.getRandomValues(a); else for (var j = 0; j < n; j++) a[j] = Math.floor(Math.random() * 256)
    for (var i = 0; i < n; i++) out += ABC.charAt(a[i] % 36)
    return out
  }
  function param(k) { try { return new URLSearchParams(location.search).get(k) } catch (e) { return null } }
  function sha256(s) {
    var c = window.crypto
    if (!c || !c.subtle || !window.TextEncoder) return Promise.resolve('')
    return c.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2) }).join('')
    }).catch(function () { return '' })
  }

  // ---- first-party ids: the same visitor for the browser and the server ----
  var vid = cookie('ffc_vid')
  if (!/^[a-z0-9]{12,40}$/.test(vid)) vid = rid(20)
  setCookie('ffc_vid', vid, 365)
  if (t.meta) {
    // Meta's own cookie formats; the pixel keeps them when they already exist.
    if (!/^fb\.\d\.\d+\.\d+$/.test(cookie('_fbp'))) setCookie('_fbp', 'fb.1.' + Date.now() + '.' + Math.floor(1e9 + Math.random() * 9e9), 90)
    var fbclid = param('fbclid')
    if (fbclid && cookie('_fbc').split('.').slice(3).join('.') !== fbclid) setCookie('_fbc', 'fb.1.' + Date.now() + '.' + fbclid, 90)
  }

  var started = false
  sha256(vid).then(start)
  setTimeout(function () { start('') }, 400) // never hold the pixels back for long

  function start(ext) {
    if (started) return
    started = true

    // ---- loaders (only the platforms with an id) ----
    if (t.meta) {
      !(function (f, b, e, v, n, s) {
        if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) }
        if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []
        s = b.createElement(e); s.async = !0; s.src = 'https://connect.facebook.net/en_US/fbevents.js'
        // A blocker may answer with an empty script: Meta's real script sets callMethod and its own version.
        s.onload = function () { pixel(typeof f.fbq.callMethod === 'function' || f.fbq.version !== '2.0' ? '1' : '0') }; s.onerror = function () { pixel('0') }
        var x = b.getElementsByTagName(e)[0]; x.parentNode.insertBefore(s, x)
      })(window, document, 'script')
      // Advanced matching: hashed customer data (signed-in customer / own thank-you page) + visitor id.
      var match = {}
      if (am) for (var k in am) if (k !== 'phE164' && Object.prototype.hasOwnProperty.call(am, k)) match[k] = am[k]
      if (ext) match.external_id = ext
      try { Object.keys(match).length ? window.fbq('init', t.meta, match) : window.fbq('init', t.meta) } catch (e) {}
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
          if (!t.meta) { s.onload = function () { pixel('1') }; s.onerror = function () { pixel('0') } }
          var a = d.getElementsByTagName('script')[0]; a.parentNode.insertBefore(s, a)
        }
        ttq.load(t.tiktok)
        var who = {}
        if (am && am.em) who.email = am.em
        if (am && am.phE164) who.phone_number = am.phE164
        if (ext) who.external_id = ext
        if (Object.keys(who).length) ttq.identify(who)
        ttq.page()
      })(window, document, 'ttq')
    }
    if (t.gads || t.ga4) {
      var g = document.createElement('script'); g.async = true
      g.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(t.ga4 || t.gads)
      document.head.appendChild(g)
      window.dataLayer = window.dataLayer || []
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments) }
      window.gtag('js', new Date())
      if (am && (am.em || am.phE164)) window.gtag('set', 'user_data', { sha256_email_address: am.em, sha256_phone_number: am.phE164 })
      if (t.ga4) window.gtag('config', t.ga4)
      if (t.gads) window.gtag('config', t.gads, { allow_enhanced_conversions: true })
    }

    funnel()
    purchase()
  }

  // ---- one event, browser + server, one id ----
  function meta(ev, data, id) { if (t.meta && window.fbq) try { window.fbq('track', ev, data || {}, { eventID: id }) } catch (e) {} }
  function tiktok(ev, data, id) { if (t.tiktok && window.ttq) try { window.ttq.track(ev, data || {}, { event_id: id }) } catch (e) {} }
  function gtag(name, data) { if (window.gtag && (t.ga4 || t.gads)) try { window.gtag('event', name, data || {}) } catch (e) {} }

  // Did the browser pixel load? '1' yes, '0' blocked or failed, '' not known. The store's copy waits
  // for the answer (at most 1.5 s, or until the page is left) so the store can report how much of
  // the traffic only its own route reached.
  var px = (t.funnel && (t.meta || t.tiktok)) ? null : ''
  var queue = [], sent = {}
  function pixel(state) { if (px === null) { px = state; flush() } }
  setTimeout(function () { pixel('') }, 1500)
  function server(ev, id, extra) {
    if (!t.server || sent[id]) return
    sent[id] = true // each event id goes to the store once
    queue.push([ev, id, extra])
    if (px !== null) flush()
  }
  function flush() {
    while (queue.length) {
      var q = queue.shift()
      try {
        var f = new FormData()
        f.append('ev', q[0]); f.append('id', q[1]); f.append('url', location.href.split('#')[0])
        f.append('px', px || ''); f.append('cd', DOMAIN)
        if (q[2]) for (var k in q[2]) f.append(k, String(q[2][k]))
        if (navigator.sendBeacon && navigator.sendBeacon(t.server, f)) continue
        fetch(t.server, { method: 'POST', body: f, credentials: 'same-origin', keepalive: true }).catch(function () {})
      } catch (e) {}
    }
  }
  window.addEventListener('pagehide', function () { if (px === null) px = ''; flush() })
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { if (px === null) px = ''; flush() } })
  function fire(ev, d) {
    var id = 'ffc_' + ev.slice(0, 2).toLowerCase() + '_' + rid(18)
    if (t.funnel) {
      meta(ev, d.meta, id)
      if (ev !== 'PageView') tiktok(ev, d.tiktok, id)
      if (d.ga) gtag(d.ga[0], d.ga[1])
    }
    server(ev, id, d.pid ? { pid: d.pid, qty: d.qty || 1 } : null)
    return id
  }
  // InitiateCheckout once per cart in this visit: reloading the checkout or coming back to it
  // with the same cart does not count a second checkout.
  function onceForCart(cart) {
    var sig = 'c:' + ((cart && cart.contents) || []).map(function (x) { return x.id + 'x' + x.quantity }).sort().join(',')
    if (!session) return true
    try { if (session.getItem('ffc_ic') === sig) return false; session.setItem('ffc_ic', sig) } catch (e) {}
    return true
  }
  function items(list) {
    return (list || []).map(function (c) { return { item_id: c.id, item_name: c.name, quantity: c.quantity, price: c.item_price } })
  }

  function funnel() {
    fire('PageView', {})
    if (t.page === 'product' && t.product) {
      var p = t.product
      fire('ViewContent', {
        pid: p.pid,
        meta: { content_type: 'product', content_ids: [p.id], content_name: p.name, value: p.price, currency: p.currency },
        tiktok: { content_type: 'product', contents: [{ content_id: p.id, content_name: p.name, price: p.price, quantity: 1 }], value: p.price, currency: p.currency },
        ga: ['view_item', { currency: p.currency, value: p.price, items: [{ item_id: p.id, item_name: p.name, price: p.price }] }],
      })
    }
    if (t.page === 'checkout' && onceForCart(t.cart)) {
      var c = t.cart || { value: 0, currency: t.currency, contents: [] }
      var ids = c.contents.map(function (x) { return x.id })
      fire('InitiateCheckout', {
        meta: { value: c.value, currency: c.currency, content_type: 'product', content_ids: ids, num_items: c.contents.reduce(function (n, x) { return n + x.quantity }, 0) },
        tiktok: { value: c.value, currency: c.currency, content_type: 'product', contents: c.contents.map(function (x) { return { content_id: x.id, content_name: x.name, quantity: x.quantity, price: x.item_price } }) },
        ga: ['begin_checkout', { currency: c.currency, value: c.value, items: items(c.contents) }],
      })
    }

    // Add to cart: WooCommerce's AJAX buttons, and the product page form.
    var last = {}
    function addToCart(pid, qty) {
      pid = parseInt(pid, 10); qty = Math.max(1, parseInt(qty, 10) || 1)
      if (!pid || (last[pid] && Date.now() - last[pid] < 2000)) return
      last[pid] = Date.now()
      var p = t.product && (t.product.pid === pid) ? t.product : null
      var value = p ? Math.round(p.price * qty * 100) / 100 : undefined
      fire('AddToCart', {
        pid: pid, qty: qty,
        meta: p ? { content_type: 'product', content_ids: [p.id], content_name: p.name, value: value, currency: p.currency } : { content_type: 'product' },
        tiktok: p ? { content_type: 'product', contents: [{ content_id: p.id, content_name: p.name, price: p.price, quantity: qty }], value: value, currency: p.currency } : {},
        ga: ['add_to_cart', p ? { currency: p.currency, value: value, items: [{ item_id: p.id, item_name: p.name, price: p.price, quantity: qty }] } : {}],
      })
    }
    if (window.jQuery) {
      window.jQuery(document.body).on('added_to_cart', function (e, fragments, hash, $button) {
        if ($button && $button.data) addToCart($button.data('product_id'), $button.data('quantity'))
      })
    }
    document.addEventListener('submit', function (e) {
      var f = e.target
      if (!f || !f.classList || !f.classList.contains('cart')) return
      var v = f.querySelector('[name="variation_id"]'), a = f.querySelector('[name="add-to-cart"]'), q = f.querySelector('[name="quantity"]')
      addToCart((v && v.value && v.value !== '0') ? v.value : (a && a.value), q && q.value)
    }, true)
  }

  // ---- the Purchase (only when it counts now) — the order's id de-duplicates with the server ----
  function purchase() {
    if (!t.purchase) return
    var o = t.purchase
    // Once per order in this browser: reloading or reopening the thank-you page fires nothing.
    if (local) {
      try {
        var done = (local.getItem('ffc_pu') || '').split(',')
        if (done.indexOf(o.event_id) >= 0) return
        local.setItem('ffc_pu', done.concat(o.event_id).filter(Boolean).slice(-30).join(','))
      } catch (e) {}
    }
    meta('Purchase', { value: o.value, currency: o.currency, content_type: 'product', content_ids: (o.contents || []).map(function (c) { return c.id }),
      contents: (o.contents || []).map(function (c) { return { id: c.id, quantity: c.quantity, item_price: c.item_price } }), order_id: o.txn }, o.event_id)
    tiktok('CompletePayment', { value: o.value, currency: o.currency, content_type: 'product',
      contents: (o.contents || []).map(function (c) { return { content_id: c.id, content_name: c.name, quantity: c.quantity, price: c.item_price } }) }, o.event_id)
    if (t.ga4) gtag('purchase', { transaction_id: o.txn, value: o.value, currency: o.currency, items: items(o.contents) })
    if (t.gads && t.gadsLabel) gtag('conversion', { send_to: t.gads + '/' + t.gadsLabel, value: o.value, currency: o.currency, transaction_id: o.txn })
  }
})()
