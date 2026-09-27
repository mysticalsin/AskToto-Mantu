#!/usr/bin/env node
/**
 * Every skipped test must be declared, justified, and counted (MQA-252).
 *
 * WHY THIS EXISTS
 *
 * "3,305 passed, 0 failed" reads as "everything ran". It does not mean that. Twelve tests skip on a
 * Windows host, and the number appears in vitest's summary as a word nobody reads. That gap is not
 * hypothetical: `-c undefined` reached a tagged release partly BECAUSE the test that would have caught it
 * was `it.skip`ped off-platform, and every report of that run said zero failures and was telling the
 * truth. A skip is an untested path wearing a green tick.
 *
 * The skips themselves are legitimate — they drive the real macOS keychain, real signed binaries, and a
 * real llama-server. They cannot run on Windows and faking them would test the fake. So the fix is not to
 * unskip them; it is to make them impossible to forget:
 *
 *   - the count may not exceed the declared baseline for this platform, so a newly-skipped test fails
 *     the build instead of quietly joining the pile;
 *   - every skipped test must be covered by a REASON below, so "why is this skipped?" always has an
 *     answer that was written down by whoever skipped it;
 *   - a skip that no longer happens fails too, so the baseline cannot rot upward-of-reality.
 *
 * Run: `npm run check:skips` (needs a vitest JSON report; it produces one if absent).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { BASELINE, extractSkippedTests, reasonFor } from './skip-reasons.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const platform = process.platform
const allowed = BASELINE[platform]
if (allowed === undefined) {
  console.error(`[check:skips] FAIL — no declared skip baseline for platform ${platform}.`)
  process.exit(1)
}

let reportPath = process.argv[2]
let tmp
if (!reportPath || !existsSync(reportPath)) {
  tmp = mkdtempSync(join(tmpdir(), 'metis-skips-'))
  reportPath = join(tmp, 'report.json')
  try {
    execFileSync(process.execPath, [join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=json', `--outputFile=${reportPath}`], {
      cwd: repoRoot,
      stdio: 'ignore'
    })
  } catch {
    /* a failing suite still writes the report; the suite's own gate reports that */
  }
}

if (!existsSync(reportPath)) {
  console.error('[check:skips] FAIL — no vitest JSON report was produced, so nothing was measured.')
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const skipped = extractSkippedTests(report)
if (tmp) rmSync(tmp, { recursive: true, force: true })

const problems = []

if (skipped.length > allowed) {
  problems.push(
    `${skipped.length} skipped tests on ${platform}, above the declared baseline of ${allowed}. ` +
      'A newly-skipped test is an untested path that reports as green — declare it or unskip it.'
  )
}
if (skipped.length < allowed) {
  problems.push(
    `${skipped.length} skipped on ${platform}, BELOW the baseline of ${allowed}. Good — but lower ` +
      `BASELINE.${platform} to ${skipped.length} in scripts/check-skipped-tests.mjs so the slack cannot ` +
      'silently absorb a future skip.'
  )
}

const unexplained = skipped.filter((s) => !reasonFor(s.id))
for (const s of unexplained) {
  problems.push(`no declared reason for: ${s.id}`)
}

if (problems.length) {
  console.error(`[check:skips] FAIL — ${problems.length} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  console.error('  Skipped tests on this run:')
  for (const s of skipped) console.error(`    ${s.id}`)
  process.exit(1)
}

console.log(`[check:skips] OK — ${skipped.length} skipped on ${platform}, all declared:`)
const byFile = new Map()
for (const s of skipped) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1)
for (const [file, n] of byFile) {
  const reason = reasonFor(file)
  console.log(`    ${String(n).padStart(2)}  ${file} — ${reason.split('.')[0]}.`)
}
