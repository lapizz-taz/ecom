/* Fullfilio Connect: checkout protection helpers. The decisions are made on the
 * server; this only tells the server that a person typed or tapped on the
 * checkout, and shows a hint under the phone field before the order is sent. */
(function () {
  'use strict'
  var cfg = window.ffcProtect || {}

  // --- a real person on the page ---
  if (cfg.humanUrl) {
    var sent = false
    var mark = function () {
      if (sent) return
      sent = true
      ;['keydown', 'pointerdown', 'touchstart'].forEach(function (t) { document.removeEventListener(t, mark, true) })
      try {
        fetch(cfg.humanUrl, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'h=1' })
      } catch (e) { /* the server decides; nothing to do here */ }
    }
    ;['keydown', 'pointerdown', 'touchstart'].forEach(function (t) { document.addEventListener(t, mark, true) })
  }

  // --- phone hint (same rule as the server) ---
  if (!cfg.phoneCheck) return
  function normalize(v) {
    var d = String(v || '').replace(/\D/g, '')
    if (d.indexOf('00880') === 0) d = d.slice(2)
    if (d.indexOf('880') === 0) d = '0' + d.slice(3)
    else if (d.length === 10 && d[0] === '1') d = '0' + d
    return /^01[3-9]\d{8}$/.test(d) ? d : null
  }
  function hint(input) {
    var id = 'ffc-phone-hint'
    var box = document.getElementById(id)
    var ok = !input.value || normalize(input.value)
    if (ok) { if (box) box.remove(); return }
    if (!box) {
      box = document.createElement('small')
      box.id = id
      box.setAttribute('role', 'alert')
      box.style.cssText = 'display:block;color:#b32d2e;margin-top:4px'
      input.insertAdjacentElement('afterend', box)
    }
    box.textContent = cfg.phoneMessage || 'Please enter a valid Bangladeshi mobile number, for example 01712345678.'
  }
  document.addEventListener('focusout', function (e) {
    var t = e.target
    if (t && t.tagName === 'INPUT' && /(^|[-_])phone$/.test(t.id || '')) hint(t)
  }, true)
})()
