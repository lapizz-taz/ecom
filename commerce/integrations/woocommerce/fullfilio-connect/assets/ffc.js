/* Fullfilio Connect: remembers where the visitor came from and, on the checkout,
 * sends what they have typed so far (phone, name, address) to this site, which
 * forwards it to Fullfilio with the cart. No third-party requests are made here. */
(function () {
  'use strict'
  var cfg = window.ffcConfig || {}
  var PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'msclkid']
  var DAYS = 90

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }
  function writeCookie(name, value) {
    var secure = location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = name + '=' + encodeURIComponent(value) + '; Max-Age=' + DAYS * 86400 + '; Path=/; SameSite=Lax' + secure
  }

  // --- attribution: first visit is kept; the latest visit with a campaign or click id replaces "last" ---
  if (cfg.attribution && cfg.cookie) {
    try {
      var q = new URLSearchParams(location.search)
      var params = {}
      PARAMS.forEach(function (k) { var v = q.get(k); if (v) params[k] = v.slice(0, 200) })
      var ref = document.referrer && document.referrer.indexOf(location.origin) !== 0 ? document.referrer.slice(0, 300) : null
      var stored = null
      try { stored = JSON.parse(readCookie(cfg.cookie) || 'null') } catch (e) { stored = null }
      var touch = { at: new Date().toISOString(), landing: (location.origin + location.pathname).slice(0, 300), referrer: ref, params: params }
      var tagged = Object.keys(params).length > 0 || !!ref
      if (!stored || !stored.first) {
        writeCookie(cfg.cookie, JSON.stringify({ first: touch, last: touch }))
      } else if (tagged) {
        stored.last = touch
        writeCookie(cfg.cookie, JSON.stringify(stored))
      }
    } catch (e) { /* attribution never breaks the page */ }
  }

  // --- unfinished checkout capture ---
  if (!cfg.capture || !cfg.leadUrl) return

  // Classic checkout uses billing_phone; the block checkout uses billing-phone / shipping-phone.
  var FIELDS = {
    phone: ['billing_phone', 'billing-phone', 'shipping-phone', 'shipping_phone'],
    first_name: ['billing_first_name', 'billing-first_name', 'shipping-first_name'],
    last_name: ['billing_last_name', 'billing-last_name', 'shipping-last_name'],
    email: ['billing_email', 'email'],
    address_1: ['billing_address_1', 'billing-address_1', 'shipping-address_1'],
    address_2: ['billing_address_2', 'billing-address_2', 'shipping-address_2'],
    city: ['billing_city', 'billing-city', 'shipping-city'],
    state: ['billing_state', 'billing-state', 'shipping-state'],
    postcode: ['billing_postcode', 'billing-postcode', 'shipping-postcode'],
    country: ['billing_country', 'billing-country', 'shipping-country'],
    note: ['order_comments']
  }
  function value(ids) {
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i])
      if (el && el.value) return String(el.value).trim()
    }
    return ''
  }
  function collect() {
    var out = {}
    Object.keys(FIELDS).forEach(function (k) { out[k] = value(FIELDS[k]) })
    return out
  }
  function ready(d) { return d.phone.replace(/\D/g, '').length >= 10 }

  var last = ''
  var timer = null
  function send(useBeacon) {
    var d = collect()
    if (!ready(d)) return
    var body = new URLSearchParams(d).toString()
    if (body === last) return
    last = body
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(cfg.leadUrl, new Blob([body], { type: 'application/x-www-form-urlencoded' }))
      return
    }
    fetch(cfg.leadUrl, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body })
      .catch(function () { last = '' })
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(function () { send(false) }, 1500) }

  document.addEventListener('input', function (e) { if (e.target && e.target.id && /phone|name|address|city|state|postcode|email|order_comments/.test(e.target.id)) schedule() }, true)
  document.addEventListener('change', function (e) { if (e.target && e.target.id && /phone|name|address|city|state|postcode|country/.test(e.target.id)) schedule() }, true)
  window.addEventListener('pagehide', function () { send(true) })
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send(true) })
  // Fields filled in by the browser or from a saved account.
  setTimeout(schedule, 2500)
})()
