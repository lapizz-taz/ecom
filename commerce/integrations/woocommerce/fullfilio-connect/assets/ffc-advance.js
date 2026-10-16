/* Fullfilio Connect: advance payment. When the phone number is typed, asks this
 * site (never Fullfilio directly) what the order needs, then has the checkout
 * recalculated so the "Pay on delivery" line and the advance show before the
 * order is placed. The site checks everything again when the order is placed. */
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
      $.post(cfg.quoteUrl, { phone: this.value }).always(refresh)
    })
    // After a refused order the totals may have changed: show them.
    $(document.body).on('checkout_error', refresh)
    $(function () {
      var el = document.getElementById('billing_phone')
      if (el && el.value) $(el).trigger('change')
    })
  }

  // Block checkout: the Store API recalculates the cart with the plugin's callback.
  document.addEventListener('change', function (e) {
    var t = e.target
    if (!t || (t.id !== 'billing-phone' && t.id !== 'shipping-phone')) return
    var blocks = window.wc && window.wc.blocksCheckout
    if (!blocks || typeof blocks.extensionCartUpdate !== 'function' || !fresh(t.value)) return
    blocks.extensionCartUpdate({ namespace: 'ffc-advance', data: { phone: t.value } })
  }, true)
})()
