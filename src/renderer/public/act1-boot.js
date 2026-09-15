/**
 * FITO-185-Z — no-JS Act1 first paint. Marks Act1 shell ready immediately
 * (Métis + Next are in HTML). Poster decode must never gate visibility.
 * Does not load or wait on the hero mp4.
 */
(function () {
  function markPainted() {
    document.documentElement.classList.add('act1-first-paint')
    document.documentElement.dataset.act1FirstPaint = '1'
  }
  function wireNext() {
    var btn = document.getElementById('act1-boot-next')
    if (!btn || btn.getAttribute('data-wired') === '1') return
    btn.setAttribute('data-wired', '1')
    btn.addEventListener('click', function (e) {
      e.preventDefault()
      window.__act1BootNextQueued = true
      try {
        window.dispatchEvent(new CustomEvent('act1-boot-next'))
      } catch (_) {
        /* ignore */
      }
    })
  }
  // FITO-185-Z: mark on script run — shell chrome is already in the DOM.
  // Poster load is best-effort only; never block Act1 visibility on img decode.
  wireNext()
  markPainted()
  var img = document.getElementById('boot-bed-img')
  if (img && !img.complete) {
    img.addEventListener('load', markPainted, { once: true })
    img.addEventListener('error', markPainted, { once: true })
  }
})()
