#!/usr/bin/env node
/**
 * check-no-scratch-paths.mjs — CI gate. Fails when a tracked source file contains an absolute
 * per-user path or an agent-session scratch path. The scratch-path pattern matches both the
 * symlinked form macOS resolves it to and the plain form agents actually receive as $TMPDIR —
 * both local-machine specifics that must never be committed. (Deliberately not spelled out here
 * as a literal: this file is itself scanned, and a literal would be its own new violation.)
 *
 * Scans every tracked .ts/.tsx/.js/.mjs/.cjs/.json/.yml/.sh/.command/.ps1/.py/.yaml/.swift file —
 * committed scripts and source, not just the JS/TS/JSON family — except *.test.ts/*.test.tsx/
 * *.test.mjs. Of those exclusions, only check-no-scratch-paths.contract.test.ts deliberately
 * carries such literals to exercise this exact check; the rest are redaction and path-handling
 * fixtures that need realistic home-directory paths to test what they test.
 *
 * BASELINE_VIOLATIONS grandfathers hits that predate this gate, keyed by file path to an expected
 * hit COUNT rather than exact line numbers: a file's line numbers drift on every unrelated edit to
 * it, and a line-keyed baseline would go stale — and this gate red — on every one of them. Tracked
 * by ticket M2-0225. compareViolations() fails on a file whose actual count exceeds its baseline (a
 * genuinely new violation) and on one whose count has dropped below it (the file was fixed; the
 * baseline must shrink to match), so the set can only ever track reality, never drift from it
 * silently in either direction.
 *
 * Run: `npm run check:scratch-paths`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TRACKED_GLOBS = [
  '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.json', '*.yml',
  '*.sh', '*.command', '*.ps1', '*.py', '*.yaml', '*.swift'
]

const FORBIDDEN = [
  /\/tmp\/claude-/,
  /\/Users\/[A-Za-z]/
]

/** Pre-existing hits this gate grandfathers, one entry per file with its expected violation
 *  COUNT — tracked by ticket M2-0225. Remove a file's entry the moment its count reaches zero. */
export const BASELINE_VIOLATIONS = new Map([
])

/** One "path:line" string per line in `files` (an array of {path, content}) matching a forbidden
 *  pattern. Exported so a fixture can be checked directly, with no filesystem or git access. */
export function findViolations(files) {
  const violations = []
  for (const { path, content } of files) {
    content.split('\n').forEach((line, i) => {
      if (FORBIDDEN.some((pattern) => pattern.test(line))) {
        violations.push(`${path}:${i + 1}`)
      }
    })
  }
  return violations
}

/**
 * Compares `violations` ("path:line" strings, e.g. from findViolations()) against a per-file
 * `baseline` (path -> expected hit count) and returns:
 *  - unexpected: every "path:line" belonging to a file whose current hit count exceeds its
 *    baseline count (0 for a file the baseline does not mention at all) — a real new violation.
 *  - stale: "path (expected N, found M)" for a baselined file whose current count is BELOW N, so
 *    the entry no longer matches reality and must shrink or be dropped.
 * A file whose current count still equals its baseline produces neither, however its specific
 * line numbers moved. Pure and dependency-free so a fixture can exercise it directly.
 */
export function compareViolations(violations, baseline) {
  const linesByPath = new Map()
  for (const violation of violations) {
    const path = violation.slice(0, violation.lastIndexOf(':'))
    const lines = linesByPath.get(path) ?? []
    lines.push(violation)
    linesByPath.set(path, lines)
  }

  const unexpected = []
  for (const [path, lines] of linesByPath) {
    if (lines.length > (baseline.get(path) ?? 0)) unexpected.push(...lines)
  }

  const stale = []
  for (const [path, expected] of baseline) {
    const found = linesByPath.get(path)?.length ?? 0
    if (found < expected) stale.push(`${path} (expected ${expected}, found ${found})`)
  }

  return { unexpected, stale }
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z', '--', ...TRACKED_GLOBS], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx') && !path.endsWith('.test.mjs'))
}

/** findViolations() over every tracked file in the repo at `root`. */
export function findRepoViolations(root = REPO_ROOT) {
  const files = trackedFiles(root).map((path) => ({ path, content: readFileSync(join(root, path), 'utf8') }))
  return findViolations(files)
}

// realpathSync() both sides before comparing: import.meta.url is Node's own resolution of the
// main module's path, which resolves a symlink in it (e.g. macOS's /tmp -> /private/tmp), while
// process.argv[1] is the argument exactly as invoked, unresolved. Comparing the two raw mismatches
// — and silently no-ops (exit 0, nothing runs) — the instant this script is invoked through a
// symlinked path, which is a CI gate failing open.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
if (isMain) {
  const { unexpected, stale } = compareViolations(findRepoViolations(), BASELINE_VIOLATIONS)
  if (unexpected.length || stale.length) {
    if (unexpected.length) {
      console.error('Absolute per-user path or agent scratch-path literal(s) found outside the baseline:\n')
      for (const v of unexpected) console.error('  ' + v)
      console.error('\nUse an env override, a repo-relative path, or os.tmpdir() instead.')
    }
    if (stale.length) {
      if (unexpected.length) console.error('')
      console.error('Baseline entries no longer match reality — shrink BASELINE_VIOLATIONS to match:\n')
      for (const s of stale) console.error('  ' + s)
    }
    process.exit(1)
  }
  const total = [...BASELINE_VIOLATIONS.values()].reduce((sum, n) => sum + n, 0)
  console.log(
    `No unexpected scratch/user-path literals (${total} baseline hit${total === 1 ? '' : 's'} across ` +
      `${BASELINE_VIOLATIONS.size} file${BASELINE_VIOLATIONS.size === 1 ? '' : 's'} grandfathered, tracked by M2-0225).`
  )
}
