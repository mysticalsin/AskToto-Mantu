#!/usr/bin/env node
/**
 * Typecheck the TEST files, and ratchet the count down (MQA-248).
 *
 * WHY THIS EXISTS
 *
 * `npm run typecheck` runs tsconfig.node.json and tsconfig.web.json, and BOTH set
 * `"exclude": ["**\/*.test.ts", "**\/*.spec.ts"]`. So no test file has ever been typechecked. That is not
 * a cosmetic gap — it is how `-c undefined` reached a tagged release:
 *
 *   local-runtime.test.ts called `start({ gguf, mmproj })` after ModelPaths gained ctxSize/parallel/
 *   gpuLayers. TypeScript would have caught it instantly. Instead it was invisible twice over: excluded
 *   from typecheck, and gated behind `ready ? it : it.skip` requiring a mac binary, so it skipped silently
 *   on every Windows run. "3257 tests, 0 failures" was true and told nobody anything.
 *
 * The identical omission was still sitting in local-runtime.concurrency.test.ts, 20 times, when this gate
 * was written — a mocked spawn meant no runtime ever read the bad value, so only a typecheck could see it.
 *
 * WHY A RATCHET RATHER THAN ZERO
 *
 * 139 errors remain, and the overwhelming majority are vitest mock-typing noise (`MockInstance`,
 * `Procedure`, `delete` on a non-optional field) — churn with no defect behind it. Blocking the build on
 * all of them would mean either a very large mechanical change landing in one go, or the gate being
 * switched off, and a gate that gets switched off protects nothing.
 *
 * So: the count may fall and may not rise. New test code is typechecked from today; the existing noise is
 * paid down whenever someone is in the area. Lower the baseline whenever you fix some — the gate tells you
 * the new number, and REFUSES to pass while the baseline is stale, so it cannot drift upward unnoticed.
 *
 * Run: `npm run typecheck:tests`.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The number of errors accepted today. Only ever revise this DOWNWARD.
 * 2026-08-24: 159 → 139 after fixing the two real shape defects (MQA-248).
 */
const BASELINE = 139

let output = ''
try {
  output = execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', join(repoRoot, 'tsconfig.tests.json')],
    { encoding: 'utf8', cwd: repoRoot }
  )
} catch (e) {
  output = `${e.stdout ?? ''}${e.stderr ?? ''}`
}

const lines = output.split(/\r?\n/).filter((l) => / error TS\d+: /.test(l))
const count = lines.length

if (count > BASELINE) {
  const byFile = new Map()
  for (const line of lines) {
    const file = line.split('(')[0]
    byFile.set(file, (byFile.get(file) ?? 0) + 1)
  }
  console.error(`[check:test-types] FAIL — ${count} type errors in test files, up from the ${BASELINE} baseline.`)
  console.error('')
  console.error('  Test files are excluded from `npm run typecheck`, so an error here is one nothing else')
  console.error('  can see. This is the class that shipped `-c undefined` into a tagged release: a test')
  console.error('  calling production code with a shape that no longer exists.')
  console.error('')
  console.error('  Worst files:')
  for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.error(`    ${String(n).padStart(4)}  ${file}`)
  }
  console.error('')
  console.error('  Fix the new errors. Do NOT raise the baseline.')
  process.exit(1)
}

if (count < BASELINE) {
  console.error(`[check:test-types] FAIL — ${count} type errors, BELOW the ${BASELINE} baseline. Good news, but the`)
  console.error(`  baseline is now stale and would let ${BASELINE - count} new errors back in unnoticed.`)
  console.error(`  Set BASELINE = ${count} in scripts/check-test-types.mjs and commit it with your fix.`)
  process.exit(1)
}

console.log(`[check:test-types] OK — ${count} known type errors in test files, at the baseline (never rising).`)
