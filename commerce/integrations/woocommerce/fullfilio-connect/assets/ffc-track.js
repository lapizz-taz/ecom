/* Fullfilio Connect: pages a page cache saved before 1.6.0 still ask for this file.
 * It loads the renamed script (ffc-s.js), which reads the same window.ffcTrack settings. */
(function () {
  var s = document.currentScript
  if (!s || !s.src || window.ffcTrackLoaded) return
  window.ffcTrackLoaded = true
  var n = document.createElement('script')
  n.src = s.src.replace(/ffc-track\.js/, 'ffc-s.js')
  n.async = false
  ;(document.head || document.documentElement).appendChild(n)
})()
