/* Fullfilio Connect: order shield and advance payment. When the phone number is
 * typed, asks this site (never Fullfilio directly) to check it, so the courier
 * record is ready when the order is placed. With the advance payment on, the
 * checkout is then recalculated so the "Pay on delivery" line and the advance show
 * before the order is placed. The site checks everything again on placing it. */
(function () {
  'use strict'
  var cfg = window.ffcAdvance || {}
  var last = ''

  function digits(v) { return String(v || '').replace(/\D/g, '') }
  function fresh(value) {
    var d = digits(value)
    if (d.length < 10 || d === last) return false
    last = d
    return true
  }

  // Classic checkout (jQuery, wc-ajax).
  var $ = window.jQuery
  if ($ && cfg.quoteUrl) {
    var refresh = function () { $(document.body).trigger('update_checkout') }
    $(document.body).on('change', '#billing_phone, #shipping_phone', function () {
      if (!fresh(this.value)) return
      var asked = $.post(cfg.quoteUrl, { phone: this.value })
      if (cfg.advance) asked.always(refresh)
    })
    // After a refused order the totals may have changed: show them.
    if (cfg.advance) $(document.body).on('checkout_error', refresh)
    $(function () {
      var el = document.getElementById('billing_phone')
      if (el && el.value) $(el).trigger('change')
    })
  }

  // Block checkout: the Store API recalculates the cart with the plugin's callback.
  document.addEventListener('change', function (e) {
    var t = e.target
    if (!t || (t.id !== 'billing-phone' && t.id !== 'shipping-phone')) return
    if (!fresh(t.value)) return
    var blocks = window.wc && window.wc.blocksCheckout
    if (cfg.advance && blocks && typeof blocks.extensionCartUpdate === 'function') {
      blocks.extensionCartUpdate({ namespace: 'ffc-advance', data: { phone: t.value } })
    } else if (cfg.quoteUrl && window.fetch) {
      var body = new FormData()
      body.append('phone', t.value)
      fetch(cfg.quoteUrl, { method: 'POST', body: body, credentials: 'same-origin' }).catch(function () {})
    }
  }, true)
})()
