// dev-tooling-paths — path matcher for the "no developer graph tooling in the product" gate (ADR-025).
//
// Invariant: a packaged Métis contains no graphify, no code-review-graph and no bundled Python
// interpreter. The single exception is the runner script below; it is a plain script the app hands to
// a user-installed Python, not an interpreter or a graph tool.

/** Package-relative paths (lower-case, forward slashes) that are exempt from the matcher. */
// M2-0074 / M2-0169: resources/graphify_runner.py is the only graphify file allowed to ship.
export const ALLOWED_PATHS = ['resources/graphify_runner.py']

const PYTHON_INTERPRETER = /^(pythonw?\d*(\.\d+)*(\.exe)?|libpython\d.*|python\d+(\.dll|\.zip|\._pth)|python\d*\.framework)$/

/** Why a single path segment is forbidden, or null when it is fine. */
function segmentViolation(segment) {
  if (segment.includes('graphify')) return 'graphify'
  if (/code[-_]review[-_]graph/.test(segment)) return 'code-review-graph'
  if (segment === 'site-packages' || PYTHON_INTERPRETER.test(segment)) return 'bundled Python'
  return null
}

/** Normalise a path to lower-case forward slashes with no leading "./" or "/". */
function normalise(path) {
  return path.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase()
}

/** The forbidden-tooling findings in a list of package-relative paths: [{ path, reason }]. */
export function findDevTooling(paths) {
  const findings = []
  for (const path of paths) {
    const normalised = normalise(path)
    const allowed = ALLOWED_PATHS.some((entry) => normalised === entry || normalised.endsWith(`/${entry}`))
    if (allowed) continue
    for (const segment of normalised.split('/')) {
      const reason = segmentViolation(segment)
      if (reason) {
        findings.push({ path, reason })
        break
      }
    }
  }
  return findings
}
