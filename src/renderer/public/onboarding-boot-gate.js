/*
 * Keep the static Act 1 shell out of every non-exclusive startup frame. This is intentionally a
 * tiny, same-origin parser-time script: the renderer CSP permits self-hosted scripts but blocks
 * inline script, and React has not loaded yet. It records no URL or page content.
 */
;(function () {
  try {
    if (new URLSearchParams(location.search).get('exclusiveOnboarding') !== '1') return
    document.documentElement.classList.add('exclusive-onboarding-boot')
  } catch (_) {
    // A malformed location must fail closed: no full-screen onboarding shell on a normal overlay.
  }
})()
