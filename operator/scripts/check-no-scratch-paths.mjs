#!/usr/bin/env node
/**
 * check-no-scratch-paths.mjs — CI gate. Fails when a tracked source file contains an absolute
 * per-user path or a past agent-session scratch path: both are local-machine specifics that must
 * never be committed (finding P5-F4).
 *
 * Scans every tracked .ts/.tsx/.js/.mjs/.cjs/.json/.yml file, except *.test.ts/*.test.tsx, whose
 * fixtures deliberately use such literals to exercise this exact check.
 *
 * BASELINE_VIOLATIONS grandfathers hits that predate this gate (tracked by a follow-up ticket).
 * The gate fails on any violation NOT in that set; it never fails on one that is, but
 * check-no-scratch-paths.contract.test.ts asserts every baseline entry still matches a real
 * violation, so a fixed file's entry cannot linger unnoticed — shrink the set as each one lands.
 *
 * Run: `npm run check:scratch-paths`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TRACKED_GLOBS = ['*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.json', '*.yml']

const FORBIDDEN = [
  /\/private\/tmp\/claude-/,
  /\/Users\/[A-Za-z]/
]

/** Pre-existing hits outside finding P5-F4's six operator/scripts files. Each entry is
 *  "<path>:<line>"; remove an entry the moment its file is fixed. */
export const BASELINE_VIOLATIONS = new Set([
  'operator/scripts/build-css.mjs:28',
  'intelligence/scripts/build-data.mjs:14',
  '.scratch/render-preview.mjs:68',
  'scripts/prove-local-ttft.mjs:13',
  'scripts/prove-local-ttft.mjs:20',
  'src/main/cli.ts:149',
  'package.json:64'
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

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '--', ...TRACKED_GLOBS], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
}

/** findViolations() over every tracked file in the repo at `root`. */
export function findRepoViolations(root = REPO_ROOT) {
  const files = trackedFiles(root).map((path) => ({ path, content: readFileSync(join(root, path), 'utf8') }))
  return findViolations(files)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const unexpected = findRepoViolations().filter((v) => !BASELINE_VIOLATIONS.has(v))
  if (unexpected.length) {
    console.error('Absolute per-user path or agent scratch-path literal(s) found outside the baseline:\n')
    for (const v of unexpected) console.error('  ' + v)
    console.error('\nUse an os.tmpdir()-based default (see operator/scripts/qa-dirs.mjs) instead.')
    process.exit(1)
  }
  console.log(`No unexpected scratch/user-path literals (${BASELINE_VIOLATIONS.size} baseline entr${BASELINE_VIOLATIONS.size === 1 ? 'y' : 'ies'} grandfathered).`)
}
