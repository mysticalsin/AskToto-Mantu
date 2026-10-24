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
 * The skips themselves are legitimate — they drive real platform helpers, real signed binaries, and a
 * real llama-server. They cannot run on Windows and faking them would test the fake. So the fix is not to
 * unskip them; it is to make them impossible to forget:
 *
 *   - the count may not exceed the declared baseline for this platform, so a newly-skipped test fails
 *     the build instead of quietly joining the pile;
 *   - every skipped test must be covered by a REASON below, so "why is this skipped?" always has an
 *     answer that was written down by whoever skipped it;
 *   - a skip that no longer happens fails too, so the baseline cannot rot upward-of-reality.
 *
 * Run: `npm run check:skips [root-report.json]`. With no report argument it produces its own report;
 * a supplied report is evidence from a completed root run and must be complete and successful.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    match: 'screen-ocr/engine.win32.test.ts',
    why: 'Checks the typed Windows OCR "unavailable" state on a real Windows host (G89). The case is gated to win32; the platform-independent engine selection and copy are unit-tested on every platform, and the hosted windows-qa scenarios suite runs this file.'
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
    match:
      'llm/local-runtime.concurrency.test.ts :: uses one real supervisor wrapper and waits for forwarded health and registry receipt',
    exact: true,
    why: 'Drives the macOS supervisor wrapper (macSupervisorHelperPath, resolveBinaryPath for mac) with its exact spawn argv and registry receipt ordering. The wrapper is a macOS-only helper and this describe is gated to darwin; the cross-platform start(), generation-guard and Windows-fallback cancellation cases in the same file run on every platform.'
  },
  {
    match:
      'llm/local-runtime.concurrency.test.ts :: does not launch a direct fallback when stop precedes a supervised helper setup failure',
    exact: true,
    why: 'Exercises the macOS supervised-helper setup-failure path, which only exists where the macOS supervisor wrapper does. The Windows candidate-fallback cancellation cases in the same file run on every platform.'
  },
  {
    match:
      'llm/local-runtime.concurrency.test.ts :: keeps a healthy successor when the old supervised generation emits delayed output and exit',
    exact: true,
    why: 'Exercises generation ownership of delayed output and exit from a macOS supervised wrapper. The same generation guard is covered cross-platform for unsupervised sidecars by the G1 and detached-start cases in the same file.'
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
    why: "Needs the packaged ffmpeg sidecar binary for this OS. CI linux images without the sidecar skip the live decode; contract tests cover window sizing without spawning ffmpeg. The cancel test's SIGTERM-immune stand-in and (Q12, D9-9) the canned-stderr ffmpeg stand-in are POSIX shell scripts with no Windows shebang equivalent, so they run on linux and darwin only; the stderr-to-plain-copy mapping itself is unit-tested on every platform."
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
    match: 'gateway-fifo-posix.test.ts',
    why: 'Pins libuv pool threads with real FIFOs, the kernel-blocking stand-in for a cloud-only read. Windows has no FIFOs; the admission, deadline, sharing and dataless rules run on every platform through an in-memory fs whose calls can be held open.'
  },
  {
    match: 'transcripts.test.ts',
    why: 'Plants a real file symlink with a draft-shaped name to prove recovery never follows it. File symlinks need elevation or Developer Mode on Windows; the gateway isSymlink classification itself runs on every platform in gateway.test.ts.'
  },
  {
    match: 'meetings-storage.test.ts',
    why: 'Pins libuv pool threads with real FIFOs under several root spellings to prove every storageAt gateway shares one admission. Windows has no FIFOs; the per-root gateway keying runs on every platform in the same file, and the admission cap itself in gateway.test.ts through an in-memory fs.'
  },
  {
    match: 'history-actions.test.ts',
    why: 'Opens and exports a meeting file that is a real FIFO, the kernel-blocking stand-in for a cloud-only read, to prove History settles within the read deadline with the event loop free; and (Q06) asserts the decrypted Open copy is mode 0o444, a POSIX permission bit Windows does not have. Windows has no FIFOs or POSIX modes; the Open and Export copy decoding, missing-file and cloud-only paths run on every platform in the same file.'
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
    match: 'windows/baseline.contract.test.ts',
    why: 'Drives the real PowerShell 7 `pwsh` against scripts/qa/windows/baseline.ps1. Hosted CI runners all ship pwsh and always run these four cases (a missing pwsh fails them there); only an off-CI host without PowerShell skips them, and the baseline below is raised by exactly four for that host so the allowance cannot hide a skip on CI. The workflow-lane cases in the same file run everywhere.'
  },
  {
    match: 'sandbox-acceptance/session.test.ts',
    why: 'Direct-spawns a fake macOS bundle executable (an extension-less bash script at Contents/MacOS/<name>) to exercise the sandbox launch path. Windows cannot execute that script and the harness launches only the macOS QA bundle; the guard, layout, environment and dry-run logic in the same directory run on every platform.'
  },
  {
    match: 'install-proxy.test.ts',
    why: 'Proves a lowercase https_proxy is refused separately from HTTPS_PROXY. process.env keys are case-insensitive on Windows, so the two names collapse into one variable there and the distinct-case scenario this test sets up cannot occur.'
  },
  {
    match: 'cli-resolve-bin.test.ts',
    why: "Drives the real POSIX login shell ($SHELL -lc) that resolveBin's mac/Linux branch shells out through (M2-0147). Windows has no equivalent shell-resolution path; that side is covered by cli-win.test.ts."
  },
  {
    match:
      'qa/retained-profile-analysis.test.ts :: verifies selected bytes, CRC failure and policy rejection without extracting files',
    exact: true,
    why: 'Runs the real Linux system unzip against owned synthetic ZIPs only on hosted GitHub CI. Windows/macOS and off-hosted Linux cannot qualify this native route; the same file runs pure identity, schema, transport and child-lifecycle tests cross-platform.'
  },
  {
    match: 'qa/candidate-report-readback.test.ts :: reads only the two regular JSON members from an exact digest',
    exact: true,
    why: 'Runs the real Linux system unzip against owned synthetic ZIPs only on hosted GitHub CI. The metadata and report-validation cases in the same file run cross-platform.'
  },
  {
    match:
      'qa/candidate-report-readback.test.ts :: rejects extra, traversal, case-collision, link, oversized, corrupt CRC and malformed members',
    exact: true,
    why: 'Runs the real Linux system unzip against owned synthetic ZIPs only on hosted GitHub CI. The metadata and report-validation cases in the same file run cross-platform.'
  },
  {
    match:
      'qa/candidate-report-readback.test.ts :: rejects a swapped producer or CI identity inside otherwise valid members',
    exact: true,
    why: 'Runs the real Linux system unzip against owned synthetic ZIPs only on hosted GitHub CI. The metadata and report-validation cases in the same file run cross-platform.'
  },
  {
    match: 'main/qa-voice-hooks.test.ts',
    why: 'V08 QA chord source on a real named pipe (mkfifo): Windows has no POSIX FIFOs, so the three real-FIFO cases (open/close/kill, symlink-out-of-profile and regular-file refusals) run on macOS and Linux only. The FIFO path decision, the desktop sink and the QA-identity gating run on every platform.'
  }
]

/** Skips accepted on this platform. Each accepted skip is a platform-bound test with a REASON above.
 *  Lower it when a skip is retired; never raise it for an undeclared skip. */
const hostedCi = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
// The six Dust CLI import cases now run against a mocked process boundary on every platform.
// Hosted macos-latest (quality matrix leg since 2e1e9b08) has no provisioned native binaries (ffmpeg sidecar,
// mac-helper, llama-server, Apple speech), no Windows tooling and no candidate artifacts: 30 declared skips, all
// listed in REASONS. A provisioned local Mac keeps the stricter 6.
// Q09 (2.12) added three cases to the declared opt-in OnboardingExperience browser check (focus on scene change,
// short-window scroll, managed-lock toggle): +3 on every platform.
// Q06 added the POSIX read-only Open-copy case to history-actions.test.ts: +1 on win32 only.
// Q12 added the POSIX-only canned-stderr ffmpeg stand-in case: +1 on win32 only.
// V08 added three real-FIFO cases to qa-voice-hooks.test.ts (POSIX named pipes): +3 on win32 only.
// G89 added one real-Windows OCR "unavailable" case (screen-ocr/engine.win32.test.ts): +1 on darwin; hosted linux is unchanged.
const BASELINE = { win32: 49, darwin: hostedCi ? 35 : 10, linux: hostedCi ? 29 : 33 }
// windows/baseline.contract.test.ts skips its four pwsh-driven cases only off hosted CI on a host with no
// `pwsh`; on hosted CI they must run, so the allowance never applies there.
const PWSH_BASELINE_SKIPS = 4
const pwshMissing =
  !hostedCi && spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { timeout: 30_000 }).status !== 0
const reasonFor = (id) => REASONS.find((reason) => (reason.exact ? id === reason.match : id.includes(reason.match)))

const platform = process.platform
const allowed =
  BASELINE[platform] === undefined ? undefined : BASELINE[platform] + (pwshMissing ? PWSH_BASELINE_SKIPS : 0)
if (allowed === undefined) {
  console.error(`[check:skips] FAIL — no declared skip baseline for platform ${platform}.`)
  process.exit(1)
}

const REQUIRED_SUMMARY_COUNTS = [
  'numTotalTestSuites',
  'numPassedTestSuites',
  'numFailedTestSuites',
  'numPendingTestSuites',
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests'
]
const ASSERTION_STATUSES = new Set(['passed', 'failed', 'pending', 'skipped', 'todo'])

function failReport(label) {
  console.error(`[check:skips] FAIL ${label}`)
  process.exit(1)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readJsonReport(reportPath) {
  let text
  try {
    text = readFileSync(reportPath, 'utf8')
  } catch {
    failReport('[report:unreadable]')
  }

  let report
  try {
    report = JSON.parse(text)
  } catch {
    failReport('[report:malformed]')
  }
  if (!isRecord(report)) failReport('[report:invalid]')
  return report
}

function validateSuppliedReport(report) {
  for (const key of REQUIRED_SUMMARY_COUNTS) {
    if (!isCount(report[key])) failReport('[report:invalid]')
  }

  if (report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0) {
    failReport('[report:failed]')
  }

  if (
    !Array.isArray(report.testResults) ||
    report.testResults.length === 0 ||
    report.numTotalTestSuites === 0 ||
    report.numTotalTests === 0
  ) {
    failReport('[report:incomplete]')
  }

  const suiteTotal = report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites
  if (suiteTotal !== report.numTotalTestSuites) failReport('[report:incomplete]')

  let assertions = 0
  for (const file of report.testResults) {
    if (!isRecord(file) || !Array.isArray(file.assertionResults)) {
      failReport('[report:incomplete]')
    }
    if (file.status === 'failed') failReport('[report:failed]')
    if (file.status !== 'passed') failReport('[report:invalid]')

    for (const assertion of file.assertionResults) {
      if (!isRecord(assertion) || typeof assertion.status !== 'string' || !ASSERTION_STATUSES.has(assertion.status)) {
        failReport('[report:invalid]')
      }
      if (assertion.status === 'failed') failReport('[report:failed]')
      assertions += 1
    }
  }

  if (assertions !== report.numTotalTests) failReport('[report:incomplete]')
}

const reportArgs = process.argv.slice(2)
if (reportArgs.length > 1) failReport('[report:arguments]')

const suppliedReport = reportArgs.length === 1
let reportPath
let tmp
let report
if (suppliedReport) {
  reportPath = reportArgs[0]
  if (!reportPath) failReport('[report:missing]')
  let metadata
  try {
    metadata = lstatSync(reportPath)
  } catch {
    failReport('[report:missing]')
  }
  if (!metadata.isFile()) failReport('[report:not-file]')
  report = readJsonReport(reportPath)
  validateSuppliedReport(report)
} else {
  tmp = mkdtempSync(join(tmpdir(), 'metis-skips-'))
  reportPath = join(tmp, 'report.json')
  try {
    execFileSync(
      process.execPath,
      [join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=json', `--outputFile=${reportPath}`],
      {
        cwd: repoRoot,
        stdio: 'ignore'
      }
    )
  } catch {
    /* a failing suite still writes the report; the suite's own gate reports that */
  }
  if (!existsSync(reportPath)) {
    console.error('[check:skips] FAIL — no vitest JSON report was produced, so nothing was measured.')
    process.exit(1)
  }
  report = readJsonReport(reportPath)
}

const skipped = []
for (const file of report.testResults ?? []) {
  for (const t of file.assertionResults ?? []) {
    if (t.status === 'pending' || t.status === 'skipped') {
      const rel = String(file.name ?? '')
        .split(/[\\/]/)
        .slice(-2)
        .join('/')
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
  const reasons = new Set(skipped.filter((s) => s.file === file).map((s) => reasonFor(s.id).why.split('.')[0]))
  console.log(`    ${String(n).padStart(2)}  ${file} — ${[...reasons].join('; ')}.`)
}
