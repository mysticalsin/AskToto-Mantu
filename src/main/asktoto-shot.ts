/**
 * Canonical URL matcher shared by bounded renderer diagnostics.
 *
 * This module deliberately no longer implements the historic `ASKTOTO_SHOT` capture path. A main
 * process diagnostic must not capture pages, execute content-reading DOM expressions, or write to a
 * caller-selected path: a packaged app can inherit environment variables from the user's account.
 * The release launch gate uses renderer-readiness metadata instead.
 */

/** Reject about:blank, unrelated origins, and different packaged documents. */
export function isRealRendererShotUrl(url: string, expectedUrl: string): boolean {
  if (!url || !expectedUrl) return false
  if (url === 'about:blank' || url.startsWith('about:')) return false
  if (url === expectedUrl) return true

  try {
    const actual = new URL(url)
    const expected = new URL(expectedUrl)
    if (actual.protocol !== expected.protocol) return false
    // `file:` has an opaque origin, but an authority is still part of the URL. Do not accept a
    // same-path document from another file host as the trusted packaged renderer.
    if (actual.host !== expected.host) return false
    if (actual.protocol !== 'file:' && actual.origin !== expected.origin) return false

    // Electron can percent-encode an asar path in getURL(). Compare decoded paths, never merely the
    // `index.html` tail, so a different file: document cannot satisfy a trusted renderer probe.
    const decodedPath = (value: string): string => {
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
    if (decodedPath(actual.pathname) !== decodedPath(expected.pathname)) return false

    // Hashes are client-side state and do not change the loaded document. An expected URL without a
    // query may accept a harmless renderer-added query; an expected query must be retained exactly.
    return !expected.search || actual.search === expected.search
  } catch {
    return false
  }
}
