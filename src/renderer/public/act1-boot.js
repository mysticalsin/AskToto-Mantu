/**
 * FITO-185-Y — no-JS Act1 first paint. Marks when the lady poster is ready and
 * queues Next so React can consume a click that landed before hydrate.
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
  function onPoster() {
    var img = document.getElementById('boot-bed-img')
    if (!img) {
      markPainted()
      return
    }
    if (img.complete) {
      markPainted()
      return
    }
    img.addEventListener('load', markPainted, { once: true })
    img.addEventListener('error', markPainted, { once: true })
  }
  wireNext()
  onPoster()
})()
