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
  // FITO-185-AA / GH #196: once React mounts (or Next is clicked), remove the static chrome
  // so Dig/CDP cannot click zombie #act1-boot-next and Act 2 actually advances.
  // GH #196: Dig CDP click() fires on hidden nodes. Hide is not enough — REMOVE the
  // zombie #act1-boot-next (bare class "onboard-cta") so harness hits React's real Next
  // ("onboard-cta no-drag focus-ring") and advance()/onContinue() actually run.
  function retireBootChrome() {
    var chrome = document.getElementById('act1-boot-chrome')
    if (!chrome) return
    var next = document.getElementById('act1-boot-next')
    if (next) {
      try { next.disabled = true } catch (_) {}
      try {
        if (typeof next.remove === 'function') next.remove()
        else if (next.parentNode) next.parentNode.removeChild(next)
      } catch (_) {}
    }
    try {
      if (typeof chrome.remove === 'function') chrome.remove()
      else if (chrome.parentNode) chrome.parentNode.removeChild(chrome)
    } catch (_) {}
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
