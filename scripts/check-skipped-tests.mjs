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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Why each skip exists, keyed by a substring of `<file> :: <test title>`.
 *
 * Deliberately prose, not a boolean: the point is that a human wrote down why this path is untested on
 * this platform, so the next person can judge whether it still holds rather than inheriting a silent gap.
 */
const REASONS = [
  {
    match: 'dustcli.test.ts',
    why: 'Drives the REAL macOS login keychain through `security add-generic-password`. Faking it would test the fake — the whole point is that Metis reads the session `dust login` actually wrote. The region-mapping and partial-session LOGIC is covered cross-platform in dustcli.logic.test.ts.'
  },
  {
    match: 'mac-helper.test.ts',
    why: 'Pipes an image through the real compiled Swift helper. The binary only exists and only runs on macOS.'
  },
  {
    match: 'apple-speech.test.ts',
    why: 'Spawns the real macOS speech subcommand end to end (spawn -> temp wav -> cleanup). No Windows equivalent exists.'
  },
  {
    match: 'check-ffmpeg-sidecar.test.ts',
    why: 'Reads the LGPL/GPL banner out of a real mac ffmpeg build. The licence check is the assertion, so a stubbed banner would assert nothing.'
  },
  {
    match: 'local-runtime.test.ts',
    why: 'Spawns a real mac llama-server against real weights. Its spawn-ARGUMENT contract is covered cross-platform by buildSpawnArgs tests in the same file, which is the part that regressed as `-c undefined`.'
  },
  {
    match: 'fetch-llama-server.test.ts',
    why: 'Exercises Windows zip/bsdtar extraction of the llama-server release asset. On linux/darwin the platform-specific zip path is skipped; cross-platform unpack logic is covered by the same file’s non-skipped cases where tar is available.'
  },
  {
    match: 'cli-win.test.ts',
    why: 'Drives cmd.exe argument quoting on Windows only. Empty-arg delivery through cmd.exe has no equivalent on posix shells.'
  },
  {
    match: 'ffmpeg-decoder.test.ts',
    why: "Needs the packaged ffmpeg sidecar binary for this OS. CI linux images without the sidecar skip the live decode; contract tests cover window sizing without spawning ffmpeg. The cancel test's SIGTERM-immune stand-in is a POSIX shell script; Windows has no signals to ignore (kill is TerminateProcess), so it runs on linux and darwin only."
  },
  {
    match: 'win-security.test.ts',
    why: 'Probes Windows ACL owner SIDs and admin-managed policy files. No-op / skipped on non-Windows hosts by design.'
  },
  {
    match: 'dataless.test.ts',
    why: 'Runs the real Windows PowerShell attribute probe against an NTFS file carrying FILE_ATTRIBUTE_OFFLINE. The binary and the attribute exist only on Windows; the shared wire protocol, decoding and failure policy run on every platform through a stand-in probe.'
  },
  {
    match: 'gateway.test.ts',
    why: 'Pins libuv pool threads with real FIFOs, the kernel-blocking stand-in for a cloud-only read. Windows has no FIFOs; the admission, deadline, sharing and dataless rules run on every platform through an in-memory fs whose calls can be held open.'
  },
  {
    match: 'OnboardingExperience.browser.test.ts',
    why: 'Opt-in Playwright/Chromium browser check for the onboarding demo (ASKTOTO_BROWSER_QA=1) — mounts the real component in a real browser outside Electron. Off by default so ordinary CI does not spin up a live Chromium session on every push; the source-level navigation and media-failure regressions these tests would catch are covered cross-platform without the browser opt-in (MQA-338), and installed QA remains the place this runs for real.'
  },
  {
    match: 'mac-helper-privacy.test.ts',
    why: 'Reads the Speech Recognition usage string out of the real compiled macOS helper binary (MQA-347). The binary only exists on a mac packaging host with the helper built, so it is absent from a fresh checkout and every hosted CI runner.'
  },
  {
    match: 'verify-signing.test.ts',
    why: 'Loads a real Windows Authenticode signature through the system PowerShell with an inherited, incompatible PSModulePath (MQA-300) — needs the real windows powershell.exe and its built-in signature module, so it only runs on a Windows host.'
  },
  {
    match: 'install-proxy.test.ts',
    why: 'Proves a lowercase https_proxy is refused separately from HTTPS_PROXY. process.env keys are case-insensitive on Windows, so the two names collapse into one variable there and the distinct-case scenario this test sets up cannot occur.'
  },
  {
    match: 'cli-resolve-bin.test.ts',
    why: "Drives the real POSIX login shell ($SHELL -lc) that resolveBin's mac/Linux branch shells out through (M2-0147). Windows has no equivalent shell-resolution path; that side is covered by cli-win.test.ts."
  }
]

/** Skips accepted on this platform. Each accepted skip is a platform-bound test with a REASON above.
 *  Lower it when a skip is retired; never raise it for an undeclared skip. */
const BASELINE = { win32: 30, darwin: 2, linux: 28 }

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
const skipped = []
for (const file of report.testResults ?? []) {
  for (const t of file.assertionResults ?? []) {
    if (t.status === 'pending' || t.status === 'skipped') {
      const rel = String(file.name ?? '').split(/[\\/]/).slice(-2).join('/')
      skipped.push({ id: `${rel} :: ${t.title}`, file: rel })
    }
  }
}
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

const unexplained = skipped.filter((s) => !REASONS.some((r) => s.id.includes(r.match)))
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
  const reason = REASONS.find((r) => file.includes(r.match))
  console.log(`    ${String(n).padStart(2)}  ${file} — ${reason.why.split('.')[0]}.`)
}
