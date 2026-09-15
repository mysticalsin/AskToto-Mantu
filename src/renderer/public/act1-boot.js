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
  // FITO-185-AA: once React mounts HeroWelcome it sets [hidden]; also observe and remove
  // the static chrome so a specificity bug can never leave Next covering Act 2.
  function retireBootChrome() {
    var chrome = document.getElementById('act1-boot-chrome')
    if (!chrome) return
    chrome.setAttribute('hidden', '')
    chrome.style.display = 'none'
    chrome.style.pointerEvents = 'none'
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
      try {
        window.dispatchEvent(new CustomEvent('act1-boot-next'))
      } catch (_) {
        /* ignore */
      }
      // If React already mounted, drop the covering shell immediately.
      if (document.getElementById('root') && document.getElementById('root').childElementCount > 0) {
        retireBootChrome()
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
