/**
 * FITO-185-Z — no-JS Act1 first paint. Marks Act1 shell ready immediately
 * (Métis + Next are in HTML). Poster decode must never gate visibility.
 * Does not load or wait on the hero mp4.
 */
(function () {
  // The static shell exists solely for main's explicit exclusive-onboarding URL. A normal overlay
  // starts transparent and must not run a stale shell observer before React paints its own surface.
  if (!document.documentElement.classList.contains('exclusive-onboarding-boot')) return
  function markPainted() {
    document.documentElement.classList.add('act1-first-paint')
    document.documentElement.dataset.act1FirstPaint = '1'
  }
  // The static Next is only for first paint. Remove it, rather than hiding it, so a hidden
  // duplicate cannot receive programmatic clicks after React owns onboarding.
  function retireBootChrome() {
    var chrome = document.getElementById('act1-boot-chrome')
    if (!chrome) return
    var next = document.getElementById('act1-boot-next')
    if (next) next.disabled = true
    chrome.remove()
  }
  function watchReactRetire() {
    var root = document.getElementById('root')
    if (!root) return
    var obs = new MutationObserver(function () {
      if (root.childElementCount > 0) {
        retireBootChrome()
        try { obs.disconnect() } catch (_) {}
      }
    })
    obs.observe(root, { childList: true, subtree: true })
    if (root.childElementCount > 0) retireBootChrome()
  }
  function wireNext() {
    var btn = document.getElementById('act1-boot-next')
    if (!btn || btn.getAttribute('data-wired') === '1') return
    btn.setAttribute('data-wired', '1')
    btn.addEventListener('click', function (e) {
      e.preventDefault()
      window.__act1BootNextQueued = true
      // Always drop the static shell on click — never wait on React (Tony: Next → forever Loading).
      retireBootChrome()
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
  watchReactRetire()
  var img = document.getElementById('boot-bed-img')
  if (img && !img.complete) {
    img.addEventListener('load', markPainted, { once: true })
    img.addEventListener('error', markPainted, { once: true })
  }
})()
