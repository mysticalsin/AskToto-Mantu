#!/usr/bin/env node
// Candidate scenarios lane (M2-0467, .github/workflows/candidate-scenarios.yml). Installs the exact bytes of
// a qa-candidate.yml run, selected by sha256, on a fresh hosted profile and runs one packaged scenario on
// them. SCENARIOS below is the single source of truth: the workflow's scenario choices equal its keys, and
// the lane reads the platforms, variant, artifact, command and report of a scenario only from here.
//
// Legacy lanes use contentProblems and evidence-record field names. The support-only fresh-onboarding
// lane uses a separate closed JSON schema and exact upload whitelist; it is not ticket acceptance.
//
//   node scripts/qa/candidate-scenarios.mjs resolve --scenario <s> [--mac-sha256 <hex>] [--win-sha256 <hex>]
//   node scripts/qa/candidate-scenarios.mjs guard <run.json> <candidate_run>
//   node scripts/qa/candidate-scenarios.mjs profile --scenario <s> --platform <p>
//   node scripts/qa/candidate-scenarios.mjs grant-gui --scenario <s> --platform <p>
//   node scripts/qa/candidate-scenarios.mjs installer-kind --scenario <s> --platform <p>
//   node scripts/qa/candidate-scenarios.mjs run --scenario <s> --platform <p> --installer <relative path>
//       --sha256 <hex> --provenance <provenance.json> --candidate-run <id> --out <relative dir> [--app <installed app>]
//   node scripts/qa/candidate-scenarios.mjs scan <dir> --account <runner account>
// Node builtins only, so the guard job needs no npm ci.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeRepresentativeProfile } from './census/profile.mjs'
import {
  NOT_COVERED,
  assessFreshOnboardingReport,
  isStrictSemver,
  reportProblems
} from './fresh-onboarding-baseline.mjs'
import { LOCAL_LLM_SETTINGS } from './lib/local-llm-settings.mjs'
import { TLS_REPORT, TLS_SCENARIO, assessHostedTlsReport, bindHostedTlsCandidate } from './hosted-candidate-tls.mjs'
import { VARIANTS } from './provenance.mjs'

export const LANE_SCHEMA = 1
export const QA_CANDIDATE_WORKFLOW = '.github/workflows/qa-candidate.yml'
export const PLATFORMS = Object.freeze(['mac', 'win'])
/** The GitHub-hosted image each platform runs on; it is also the evidence environment host. */
export const RUNNER_LABELS = Object.freeze({ mac: 'macos-latest', win: 'windows-latest' })

/** userData directory name per installed variant: Electron takes it from the packaged package.json name,
 *  which build/qa-identity.electron-builder.yml sets to asktoto-qa for the QA identity. */
export const PROFILE_DIRS = Object.freeze({ mac: 'asktoto', 'mac-qa-identity': 'asktoto-qa' })

export const FRESH_ONBOARDING_SCENARIO = 'fresh-onboarding-baseline'
const FRESH_LANE_SCHEMA = 'metis.fresh-onboarding-lane.v1'
const FRESH_REPORT = 'fresh-onboarding-baseline.json'
const FRESH_DETAILS = new Set(['none', 'invalid-context', 'report-missing', 'report-rejected', 'scenario-failed'])

/** The runner cannot write GitHub command files or inherit provider credentials and debug overrides. */
export function freshOnboardingChildEnv(env) {
  const allowed = new Set([
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_ARCHITEW6432',
    'OS',
    'TMPDIR',
    'TMP',
    'TEMP'
  ])
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => allowed.has(key.toUpperCase()) && typeof value === 'string')
  )
}

const positiveRunId = (value) => {
  const number = Number(value)
  return /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(number) ? number : null
}
const canonical = (value, pattern) =>
  typeof value === 'string' && value.length <= 64 && pattern.test(value) ? value : null

function freshIdentity({ provenance, candidateRun, sha256, env, platform }) {
  return {
    candidate_run: positiveRunId(candidateRun),
    producer_commit: canonical(provenance?.commit, /^[0-9a-f]{40}$/),
    installer_sha256: canonical(sha256, /^[0-9a-f]{64}$/),
    version: isStrictSemver(provenance?.version) && provenance.version.length <= 64 ? provenance.version : null,
    harness_commit: canonical(env?.GITHUB_SHA, /^[0-9a-f]{40}$/),
    platform: platform === 'mac' ? 'darwin' : platform === 'win' ? 'win32' : null
  }
}

const expectedFreshIdentity = (identity) => ({
  candidateRun: identity.candidate_run,
  commit: identity.producer_commit,
  sha256: identity.installer_sha256,
  version: identity.version,
  harnessCommit: identity.harness_commit,
  platform: identity.platform
})

/** Build independent scan context only from provenance for the candidate run selected by the workflow. */
export function freshOnboardingScanContext({ platform, provenance, candidateRun, sha256, env, laneWritten }) {
  const run = positiveRunId(candidateRun)
  if (!run || positiveRunId(provenance?.run?.id) !== run) return undefined
  return {
    identity: freshIdentity({ platform, provenance, candidateRun, sha256, env }),
    ciRun: positiveRunId(env?.GITHUB_RUN_ID),
    laneWritten: laneWritten === true
  }
}

/** Support-only lane: deliberately does not copy arbitrary commands, runner metadata or child output. */
export function freshOnboardingLane({
  platform,
  env,
  provenance,
  candidateRun,
  sha256,
  exitCode,
  reportWritten,
  reportData
}) {
  const identity = freshIdentity({ platform, env, provenance, candidateRun, sha256 })
  const ciRun = positiveRunId(env?.GITHUB_RUN_ID)
  const invalidContext =
    !ciRun ||
    Object.values(identity).some((value) => value === null) ||
    String(provenance?.run?.id) !== String(candidateRun)
  const schemaValid = reportWritten && reportProblems(reportData).length === 0
  const boundReport =
    schemaValid &&
    assessFreshOnboardingReport(reportData, expectedFreshIdentity(identity), {
      requirePass: false
    }).problems.length === 0
  const outcome =
    !invalidContext && exitCode === 0 && boundReport && reportData.outcome === 'PASS'
      ? 'PASS'
      : !invalidContext && exitCode === 2 && boundReport && reportData.outcome === 'PRECONDITION'
        ? 'PRECONDITION'
        : 'FAIL'
  return {
    schema: FRESH_LANE_SCHEMA,
    scenario: FRESH_ONBOARDING_SCENARIO,
    support_only: true,
    identity,
    ci_run_id: ciRun,
    exit_code: [0, 1, 2].includes(exitCode) ? exitCode : null,
    outcome,
    report: schemaValid ? FRESH_REPORT : null,
    detail:
      outcome === 'PASS'
        ? 'none'
        : invalidContext
          ? 'invalid-context'
          : !reportWritten
            ? 'report-missing'
            : !boundReport
              ? 'report-rejected'
              : 'scenario-failed',
    not_covered: NOT_COVERED
  }
}

const exactKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

function freshLaneProblems(lane) {
  const keys = [
    'schema',
    'scenario',
    'support_only',
    'identity',
    'ci_run_id',
    'exit_code',
    'outcome',
    'report',
    'detail',
    'not_covered'
  ]
  if (!exactKeys(lane, keys)) return ['lane-schema-invalid']
  const normalized = freshIdentity({
    platform: lane.identity?.platform === 'darwin' ? 'mac' : lane.identity?.platform === 'win32' ? 'win' : null,
    provenance: { commit: lane.identity?.producer_commit, version: lane.identity?.version },
    candidateRun: lane.identity?.candidate_run,
    sha256: lane.identity?.installer_sha256,
    env: { GITHUB_SHA: lane.identity?.harness_commit }
  })
  if (
    !exactKeys(lane.identity, Object.keys(normalized)) ||
    !Object.entries(normalized).every(([key, value]) => lane.identity[key] === value) ||
    lane.schema !== FRESH_LANE_SCHEMA ||
    lane.scenario !== FRESH_ONBOARDING_SCENARIO ||
    lane.support_only !== true ||
    (lane.ci_run_id !== null && positiveRunId(lane.ci_run_id) !== lane.ci_run_id) ||
    ![0, 1, 2, null].includes(lane.exit_code) ||
    !['PASS', 'FAIL', 'PRECONDITION'].includes(lane.outcome) ||
    ![FRESH_REPORT, null].includes(lane.report) ||
    !FRESH_DETAILS.has(lane.detail) ||
    JSON.stringify(lane.not_covered) !== JSON.stringify(NOT_COVERED)
  ) {
    return ['lane-schema-invalid']
  }
  return []
}

/** Only these two bounded, regular, nonlinked JSON outputs can pass the new scenario's upload gate.
 * @param {string} dir
 * @param {{ identity: any, ciRun: number | null, laneWritten: boolean } | undefined} context */
export function scanFreshOnboardingOutput(dir, context = undefined) {
  try {
    if (
      context?.laneWritten !== true ||
      !positiveRunId(context?.ciRun) ||
      !context?.identity ||
      Object.values(context.identity).some((value) => value === null)
    ) {
      return ['output-context-invalid']
    }
    const root = lstatSync(dir)
    if (!root.isDirectory() || root.isSymbolicLink()) return ['output-directory-invalid']
    const names = readdirSync(dir)
    if (names.length !== 2 || ![FRESH_REPORT, 'lane.json'].every((name) => names.includes(name))) {
      return ['output-file-list-invalid']
    }
    const read = (name) => {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65_536) {
        throw new Error('invalid-output')
      }
      return JSON.parse(readFileSync(path, 'utf8'))
    }
    const report = read(FRESH_REPORT)
    const lane = read('lane.json')
    if (reportProblems(report).length || freshLaneProblems(lane).length) return ['output-schema-invalid']
    if (
      lane.report !== FRESH_REPORT ||
      lane.ci_run_id !== context.ciRun ||
      !exactKeys(lane.identity, Object.keys(context.identity)) ||
      !Object.entries(context.identity).every(([key, value]) => lane.identity[key] === value)
    ) {
      return ['output-binding-invalid']
    }
    const assessment = assessFreshOnboardingReport(report, expectedFreshIdentity(context.identity), {
      requirePass: lane.outcome === 'PASS'
    })
    if (assessment.problems.length) return ['output-binding-invalid']
    const expectedExit = { PASS: 0, FAIL: 1, PRECONDITION: 2 }[report.outcome]
    if (lane.outcome !== report.outcome || lane.exit_code !== expectedExit) return ['output-outcome-invalid']
    if (lane.outcome === 'PASS' && (lane.exit_code !== 0 || !lane.ci_run_id || lane.detail !== 'none')) {
      return ['output-outcome-invalid']
    }
    return []
  } catch {
    return ['output-unreadable']
  }
}

function freshOnboardingArgs(host, { app, installer, sha256, report, provenancePath, candidateRun, harnessCommit }) {
  if (
    !app ||
    !provenancePath ||
    !/^[1-9]\d*$/.test(String(candidateRun)) ||
    !/^[0-9a-f]{40}$/.test(harnessCommit ?? '')
  ) {
    throw new Error('Fresh onboarding needs an installed app, provenance, candidate run and harness commit.')
  }
  return [
    '--app',
    app,
    '--installer',
    installer,
    '--sha256',
    sha256,
    '--provenance',
    provenancePath,
    '--candidate-run',
    String(candidateRun),
    '--harness-commit',
    harnessCommit,
    '--platform',
    host,
    '--out',
    report
  ]
}

/** Support-only context uses the API producer SHA, not an assertion made by the downloaded provenance. */
export function hostedTlsScanContext({ platform, provenance, candidateRun, sha256, env, laneWritten }) {
  try {
    if (platform !== 'mac') return undefined
    const identity = bindHostedTlsCandidate(provenance, {
      candidateRun: positiveRunId(candidateRun),
      producerCommit: env?.METIS_CANDIDATE_COMMIT,
      harnessCommit: env?.GITHUB_SHA,
      sha256,
      installer: `Metis-QA-${provenance?.version}.zip`
    })
    const ciRun = positiveRunId(env?.GITHUB_RUN_ID)
    if (!ciRun) return undefined
    return { identity, ciRun, laneWritten: laneWritten === true }
  } catch {
    return undefined
  }
}

export function hostedTlsLane({ platform, env, provenance, candidateRun, sha256, exitCode, reportWritten, reportData }) {
  const context = hostedTlsScanContext({ platform, env, provenance, candidateRun, sha256, laneWritten: true })
  const bound = context && reportWritten && assessHostedTlsReport(reportData, context.identity).length === 0
  const matches = bound && exitCode === { PASS: 0, FAIL: 1, PRECONDITION: 2 }[reportData.outcome]
  return {
    schema: 'metis.hosted-startup-tls-lane.v1',
    scenario: TLS_SCENARIO,
    support_only: true,
    identity: context?.identity ?? null,
    ci_run_id: context?.ciRun ?? null,
    outcome: matches ? reportData.outcome : 'FAIL',
    exit_code: [0, 1, 2].includes(exitCode) ? exitCode : null,
    report: bound ? TLS_REPORT : null,
    detail: matches
      ? reportData.outcome === 'PASS'
        ? 'none'
        : 'scenario-failed'
      : !context
        ? 'invalid-context'
        : !reportWritten
          ? 'report-missing'
          : 'report-rejected'
  }
}

/** Exact output pair only, with fresh-write and API/provenance identity rebinding. No raw-error fallback. */
export function scanHostedTlsOutput(dir, context = undefined) {
  try {
    if (!context?.laneWritten || !positiveRunId(context.ciRun)) return ['output-context-invalid']
    const root = lstatSync(dir)
    if (!root.isDirectory() || root.isSymbolicLink()) return ['output-directory-invalid']
    const names = readdirSync(dir)
    if (names.length !== 2 || ![TLS_REPORT, 'lane.json'].every((name) => names.includes(name))) {
      return ['output-file-list-invalid']
    }
    const read = (name) => {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65_536) {
        throw new Error('closed-output-invalid')
      }
      return JSON.parse(readFileSync(path, 'utf8'))
    }
    const report = read(TLS_REPORT)
    const lane = read('lane.json')
    if (assessHostedTlsReport(report, context.identity).length) return ['output-binding-invalid']
    if (
      !exactKeys(lane, [
        'schema',
        'scenario',
        'support_only',
        'identity',
        'ci_run_id',
        'outcome',
        'exit_code',
        'report',
        'detail'
      ]) ||
      lane.schema !== 'metis.hosted-startup-tls-lane.v1' ||
      lane.scenario !== TLS_SCENARIO ||
      lane.support_only !== true ||
      !exactKeys(lane.identity, Object.keys(context.identity)) ||
      Object.entries(context.identity).some(([key, value]) => lane.identity[key] !== value) ||
      lane.ci_run_id !== context.ciRun ||
      lane.report !== TLS_REPORT ||
      lane.outcome !== report.outcome ||
      lane.exit_code !== { PASS: 0, FAIL: 1, PRECONDITION: 2 }[report.outcome] ||
      lane.detail !== (lane.outcome === 'PASS' ? 'none' : 'scenario-failed')
    ) {
      return ['output-schema-invalid']
    }
    return []
  } catch {
    return ['output-unreadable']
  }
}

function hostedTlsArgs({ app, installer, sha256, report, provenancePath, candidateRun, harnessCommit, producerCommit }) {
  if (
    !app ||
    !provenancePath ||
    !positiveRunId(candidateRun) ||
    !/^[0-9a-f]{40}$/.test(harnessCommit ?? '') ||
    !/^[0-9a-f]{40}$/.test(producerCommit ?? '')
  ) {
    throw new Error('TLS support needs a bound candidate context.')
  }
  return [
    '--app',
    app,
    '--installer',
    installer,
    '--sha256',
    sha256,
    '--provenance',
    provenancePath,
    '--candidate-run',
    String(candidateRun),
    '--producer-commit',
    producerCommit,
    '--harness-commit',
    harnessCommit,
    '--out',
    report
  ]
}

export const PACKAGED_LIFECYCLE_RV_ROWS = Object.freeze({
  mac: Object.freeze([
    'RV-1-macos-open-activate',
    'RV-1-macos-finder-spotlight-launchpad',
    'RV-2-macos-open-new-instance',
    'RV-4-tray-show',
    'RV-4-global-hotkey',
    'RV-boot-launch-activate-stays-parked'
  ]),
  win: Object.freeze([
    'RV-3-windows-exe-relaunch',
    'RV-3-windows-shortcut-relaunch',
    'RV-4-tray-show',
    'RV-4-global-hotkey'
  ])
})

/**
 * A scenario runs on each platform it declares. A platform entry names the qa-candidate variant and
 * artifact it installs, the script and arguments it runs (args receives the installer, its sha256, the
 * report path and the installed app, relative to the repository), the report file the script writes, and the
 * settings it seeds into the fresh profile. isolatedProfiles marks a script that runs the app only on its own
 * throwaway ASKTOTO_USERDATA profiles, so the default profile is never touched. notCovered lists report rows
 * the platform cannot prove, each with the reason; lane.json carries them as a residual. qaOnlyHook marks a
 * scenario that needs a hook compiled only into QA-identity bytes. The reason-bound hosted TLS companion
 * is also QA-only support, without a fault hook; other scenarios install promotable variants. installerSuffix is the only
 * installer kind the scenario accepts; installerKind, when set, is the candidate-installer.mjs selector the
 * install step uses instead of the platform. guiScripting marks a platform entry that drives the app's native UI
 * through System Events.
 */
export const SCENARIOS = Object.freeze({
  // M2-0026: onFatal "Relaunch Métis", then a census 10 s later with no orphaned owned sidecar. The
  // SIGUSR2 fault hook exists only in QA-identity bytes, so it installs the Metis-QA zip.
  'fault-fatal-relaunch': Object.freeze({
    ticket: 'M2-0026',
    qaOnlyHook: true,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac-qa-identity',
        artifact: 'candidate-mac-qa-identity',
        script: 'scripts/qa/fault-fatal-relaunch.mjs',
        args: ({ installer, sha256, report }) => ['--zip', installer, '--sha256', sha256, '--out', report],
        report: 'fault-fatal-relaunch.json',
        settings: LOCAL_LLM_SETTINGS
      })
    })
  }),
  // M2-0033 acceptance[7] (M2-0470): seeded ingest ledgers survive repeated clean relaunches and no
  // llama-server starts in the first 120 s of a boot, on the promotable DMG. The script seeds its own isolated
  // ASKTOTO_USERDATA profile, so the lane seeds no settings.
  'ex-suite': Object.freeze({
    ticket: 'M2-0033',
    qaOnlyHook: false,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac',
        artifact: 'candidate-mac',
        installerSuffix: '.dmg',
        script: 'scripts/qa/ex-suite.mjs',
        args: ({ app, report }) => {
          if (!app) throw new Error('ex-suite needs the installed app (--app).')
          return ['--packaged', app, report, '--relaunches', '3']
        },
        report: 'ex-suite.json'
      })
    })
  }),
  // M2-0471: on promotable macOS bytes, SIGSTOP main for 15 s, then require exactly one sanitized stall
  // bundle and one app.stall.sampled audit event. The long idle plus sleep/wake row is reported as
  // BLOCKED_EXTERNAL by the scenario because hosted runners cannot provide that physical-host setup.
  'stall-sampler': Object.freeze({
    ticket: 'M2-0471',
    qaOnlyHook: false,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac',
        artifact: 'candidate-mac',
        script: 'scripts/qa/stall-sampler-hosted.mjs',
        args: ({ app, report }) => [app, report, '--stop-seconds', '15'],
        report: 'stall-sampler.json'
      })
    })
  }),
  // M2-0492: hosted macOS idle soak on promotable DMG bytes. The tool launches the installed app on the
  // representative Hide profile, streams the 5.5 h parked-idle census, and judges IDLE-GROWTH-1.
  'idle-soak': Object.freeze({
    ticket: 'M2-0492',
    qaOnlyHook: false,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL_OR_INCOMPLETE', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac',
        artifact: 'candidate-mac',
        script: 'scripts/qa/soak/idle-soak.mjs',
        args: ({ app, report }) => [
          '--app',
          app,
          '--profile',
          'candidate-scenario/profile',
          '--hours',
          '5.5',
          '--out',
          'candidate-scenario',
          ...(process.env.SOAK_DEADLINE_EPOCH_MS ? ['--deadline-epoch-ms', process.env.SOAK_DEADLINE_EPOCH_MS] : [])
        ],
        report: 'idle-soak.json',
        profileLayout: 'hide',
        timeoutMinutes: 355,
        stepTimeoutMinutes: 340,
        outcomeFromReport: true,
        laneReportFields: Object.freeze([
          'rule',
          'hoursMeasured',
          'parkedCoverage',
          'displayAwake',
          'hostFloorOverride',
          'hostMemory',
          'memory',
          'modelState'
        ])
      }),
      win: Object.freeze({
        ticket: 'M2-0493',
        variant: 'win',
        artifact: 'candidate-win',
        script: 'scripts/qa/soak/idle-soak.mjs',
        args: ({ app, report }) => [
          '--app',
          app,
          '--profile',
          'candidate-scenario/profile',
          '--hours',
          '5.5',
          '--out',
          'candidate-scenario',
          ...(process.env.SOAK_DEADLINE_EPOCH_MS ? ['--deadline-epoch-ms', process.env.SOAK_DEADLINE_EPOCH_MS] : [])
        ],
        report: 'idle-soak.json',
        profileLayout: 'hide',
        timeoutMinutes: 355,
        stepTimeoutMinutes: 340,
        outcomeFromReport: true,
        laneReportFields: Object.freeze([
          'rule',
          'hoursMeasured',
          'parkedCoverage',
          'displayAwake',
          'hostFloorOverride',
          'hostMemory',
          'memory',
          'modelState'
        ])
      })
    })
  }),
  // M2-0027 acceptance[4] via M2-0468: SIGKILL main with a live sidecar, relaunch, orphan reaped within 5 s of
  // boot. The legacy rule is off in QA-identity bytes, so both platforms install promotable bytes. macOS
  // requires the real llama-server and legacy-orphan rows (a BLOCKED_EXTERNAL there is a PRECONDITION, not a PASS).
  'sidecar-boot-reaper': Object.freeze({
    ticket: 'M2-0027',
    qaOnlyHook: false,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac',
        artifact: 'candidate-mac',
        script: 'scripts/qa/sidecar-boot-reaper.mjs',
        args: ({ app, report }) => [app, report, '--require-real-llama'],
        report: 'sidecar-boot-reaper.json',
        isolatedProfiles: true
      }),
      win: Object.freeze({
        variant: 'win',
        artifact: 'candidate-win',
        script: 'scripts/qa/sidecar-boot-reaper.mjs',
        args: ({ app, report }) => [app, report],
        report: 'sidecar-boot-reaper.json',
        isolatedProfiles: true,
        notCovered: Object.freeze([
          Object.freeze({
            row: 'realLlama',
            reason: 'The real llama-server proof runs on macOS only; the report marks it BLOCKED_EXTERNAL.'
          }),
          Object.freeze({
            row: 'legacyOrphan',
            reason: 'The legacy-orphan proof runs on macOS only; the report marks it BLOCKED_EXTERNAL.'
          })
        ])
      })
    })
  }),
  // M2-0506: the packaged lifecycle scenario runs packaged-smoke.mjs on the exact promotable candidate
  // installer bytes, selected by sha256. The report rows stay content-free and lane.json records their
  // verdicts so RV/HIST/RE-HIDE evidence is bound to the candidate DMG/Setup instead of self-built bytes.
  'packaged-lifecycle': Object.freeze({
    ticket: 'M2-0506',
    qaOnlyHook: false,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL' }),
    reportAssessment: 'packaged-smoke',
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac',
        artifact: 'candidate-mac',
        installerKind: 'mac-dmg',
        script: 'scripts/qa/packaged-smoke.mjs',
        args: ({ app, report }) => [app, report],
        report: 'packaged-smoke.json',
        isolatedProfiles: true
      }),
      win: Object.freeze({
        variant: 'win',
        artifact: 'candidate-win',
        script: 'scripts/qa/packaged-smoke.mjs',
        args: ({ app, report }) => [app, report],
        report: 'packaged-smoke.json',
        isolatedProfiles: true
      })
    })
  }),
  // M2-0469 (proves M2-0037): 4 overlay renderer SIGKILLs within 60 s give 3 reloads, then the halted
  // dialog and no 4th reload. It needs no QA-only hook, so it installs the promotable DMG; the proof seeds
  // its own onboarded settings into a throwaway ASKTOTO_USERDATA profile, so the default profile is never
  // opened and the lane seeds none.
  'renderer-kill': Object.freeze({
    ticket: 'M2-0469',
    qaOnlyHook: false,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac',
        artifact: 'candidate-mac',
        installerKind: 'mac-dmg',
        installerSuffix: '.dmg',
        script: 'scripts/qa/renderer-kill.mjs',
        args: ({ installer, sha256, report }) => [
          installer,
          report,
          '--sha256',
          sha256,
          '--times',
          '4',
          '--window',
          '60'
        ],
        report: 'renderer-kill.json',
        isolatedProfiles: true,
        // It finds the halted dialog and clicks its Quit button through System Events, so the lane
        // authorises GUI scripting (grant-gui) before it runs.
        guiScripting: true
      })
    })
  }),
  // Supporting pre-Setup assertions only: not the full visual/completion acceptance of M2-0456.
  'fresh-onboarding-baseline': Object.freeze({
    ticket: 'M2-0456',
    qaOnlyHook: false,
    reportAssessment: 'fresh-onboarding-baseline',
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac',
        artifact: 'candidate-mac',
        installerKind: 'mac-dmg',
        installerSuffix: '.dmg',
        script: 'scripts/qa/fresh-onboarding-baseline.mjs',
        args: (options) => freshOnboardingArgs('darwin', options),
        report: 'fresh-onboarding-baseline.json',
        isolatedProfiles: true,
        timeoutMinutes: 20,
        stepTimeoutMinutes: 5
      }),
      win: Object.freeze({
        variant: 'win',
        artifact: 'candidate-win',
        installerSuffix: '.exe',
        script: 'scripts/qa/fresh-onboarding-baseline.mjs',
        args: (options) => freshOnboardingArgs('win32', options),
        report: 'fresh-onboarding-baseline.json',
        isolatedProfiles: true,
        timeoutMinutes: 20,
        stepTimeoutMinutes: 5
      })
    })
  }),
  'hosted-startup-tls': Object.freeze({
    qaOnlyHook: false,
    qaIdentityReason: 'hosted-startup-tls-support-only',
    reportAssessment: TLS_SCENARIO,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac-qa-identity',
        artifact: 'candidate-mac-qa-identity',
        installerSuffix: '.zip',
        script: 'scripts/qa/hosted-candidate-tls.mjs',
        args: hostedTlsArgs,
        report: TLS_REPORT,
        isolatedProfiles: true,
        timeoutMinutes: 20,
        stepTimeoutMinutes: 5
      })
    })
  })
})

/** Where macOS keeps TCC decisions: Accessibility in the system database, Automation (Apple events) in the
 *  user's. Hosted macOS runners run with SIP disabled, so both are writable with sudo. */
export const TCC_DATABASES = Object.freeze({
  system: '/Library/Application Support/com.apple.TCC/TCC.db',
  user: join('Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
})

/** The pids from `pid` up to, not including, launchd: TCC attributes an osascript call to the responsible
 *  process at the top of this chain, which on a hosted runner is the runner's own agent. */
export function ancestorPids(psText, pid) {
  const parent = new Map()
  for (const line of psText.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) parent.set(Number(match[1]), Number(match[2]))
  }
  const chain = []
  for (let current = pid; current > 1 && !chain.includes(current); current = parent.get(current) ?? 0)
    chain.push(current)
  return chain
}

/** The executable path in `lsof -a -p <pid> -d txt -Fn` output: its first name record. */
export function executableFromLsof(text) {
  return (
    String(text ?? '')
      .split('\n')
      .find((line) => line.startsWith('n/'))
      ?.slice(1) ?? null
  )
}

/**
 * The SQL that lets each client (an absolute executable path) script the GUI through System Events:
 * Accessibility in the system database and Automation of System Events in the user's, both allowed
 * (auth_value 2). INSERT OR REPLACE on the table's primary key makes a rerun idempotent.
 * @returns {{ system: string, user: string }}
 */
export function guiScriptingGrants(clients) {
  const paths = [...new Set(clients)]
  if (!paths.length || paths.some((path) => typeof path !== 'string' || !path.startsWith('/'))) {
    throw new Error('GUI scripting grants need at least one client, each an absolute executable path.')
  }
  const quote = (text) => `'${text.replaceAll("'", "''")}'`
  const grant = (service, client, reason, target) =>
    'INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, ' +
    'indirect_object_identifier_type, indirect_object_identifier, flags, last_modified) VALUES ' +
    `(${quote(service)}, ${quote(client)}, 1, 2, ${reason}, 1, 0, ${quote(target)}, 0, CAST(strftime('%s','now') AS INTEGER));`
  return {
    system: paths.map((client) => grant('kTCCServiceAccessibility', client, 4, 'UNUSED')).join('\n'),
    user: paths.map((client) => grant('kTCCServiceAppleEvents', client, 3, 'com.apple.systemevents')).join('\n')
  }
}

const SHA256 = /^[0-9a-f]{64}$/

function scenarioEntry(scenario) {
  const entry = Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : undefined
  if (!entry) {
    throw new Error(
      `Unknown scenario ${JSON.stringify(scenario)}; expected one of ${Object.keys(SCENARIOS).join(', ')}.`
    )
  }
  return entry
}

function platformEntry(scenario, platform) {
  const entry = scenarioEntry(scenario).platforms[platform]
  if (!entry) throw new Error(`Scenario ${scenario} does not run on ${platform}.`)
  return entry
}

/**
 * Checks the dispatch inputs against the registry: the scenario must exist, every platform it runs on
 * needs a 64-hex sha256, and a sha256 for a platform it does not run on is refused rather than ignored.
 * Returns the normalized plan per platform; throws listing every problem.
 * @returns {Record<string, { variant: string, artifact: string, sha256: string, timeoutMinutes: number, stepTimeoutMinutes: number }>}
 */
export function resolveScenario({ scenario, sha256 }) {
  const entry = scenarioEntry(scenario)
  const problems = []
  /** @type {Record<string, { variant: string, artifact: string, sha256: string, timeoutMinutes: number, stepTimeoutMinutes: number }>} */
  const plan = {}
  for (const platform of PLATFORMS) {
    const given = String(sha256[platform] ?? '')
      .trim()
      .toLowerCase()
    const target = entry.platforms[platform]
    if (!target) {
      if (given)
        problems.push(`${platform}_sha256 is set, but ${scenario} does not run on ${platform}; leave it empty.`)
      continue
    }
    if (!SHA256.test(given)) {
      problems.push(`${platform}_sha256 is required for ${scenario} and must be 64 hexadecimal characters.`)
      continue
    }
    const item = {
      variant: target.variant,
      artifact: target.artifact,
      sha256: given
    }
    if (scenario === 'ex-suite') {
      // Preserve the legacy enumerable plan shape while still wiring workflow timeout outputs.
      Object.defineProperties(item, {
        timeoutMinutes: { value: target.timeoutMinutes ?? 60, enumerable: false },
        stepTimeoutMinutes: { value: target.stepTimeoutMinutes ?? 40, enumerable: false }
      })
    } else {
      item.timeoutMinutes = target.timeoutMinutes ?? 60
      item.stepTimeoutMinutes = target.stepTimeoutMinutes ?? 40
    }
    plan[platform] = item
  }
  if (problems.length) throw new Error(problems.join('\n'))
  return plan
}

/** The GITHUB_OUTPUT lines the guard job publishes for the platform jobs. */
export function resolveOutputs(plan) {
  const lines = []
  for (const platform of PLATFORMS) {
    lines.push(`${platform}=${Boolean(plan[platform])}`)
    if (plan[platform]) {
      lines.push(`${platform}_variant=${plan[platform].variant}`)
      lines.push(`${platform}_artifact=${plan[platform].artifact}`)
      lines.push(`${platform}_sha256=${plan[platform].sha256}`)
      lines.push(`${platform}_timeout_minutes=${plan[platform].timeoutMinutes}`)
      lines.push(`${platform}_step_timeout_minutes=${plan[platform].stepTimeoutMinutes}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Decides from the Actions API run JSON (GET repos/{repo}/actions/runs/{id}) whether a run may be measured:
 * only a completed, successful workflow_dispatch run of qa-candidate.yml on main or release/1.9.x. A
 * pull-request self-test candidate is refused, since its bytes are a PR merge commit and can never be promoted.
 * Returns the problems; empty means the run is a candidate.
 */
export const CANDIDATE_RUN_BRANCHES = Object.freeze(['main', 'release/1.9.x'])

export function candidateRunProblems(run, candidateRun) {
  if (typeof run !== 'object' || run === null) return ['The run JSON is not an object.']
  const problems = []
  if (String(run.id) !== String(candidateRun)) problems.push(`The API returned run ${run.id}, not ${candidateRun}.`)
  const path = String(run.path ?? '').replace(/@.*$/, '')
  if (path !== QA_CANDIDATE_WORKFLOW)
    problems.push(`Run ${candidateRun} is ${path || 'no workflow'}, not ${QA_CANDIDATE_WORKFLOW}.`)
  if (run.event !== 'workflow_dispatch') {
    problems.push(
      `Run ${candidateRun} was triggered by ${run.event}, not workflow_dispatch; a pull-request self-test is never a candidate.`
    )
  }
  if (!CANDIDATE_RUN_BRANCHES.includes(run.head_branch)) {
    problems.push(`Run ${candidateRun} ran on ${run.head_branch}, not ${CANDIDATE_RUN_BRANCHES.join(' or ')}.`)
  }
  if (run.status !== 'completed') problems.push(`Run ${candidateRun} is ${run.status}, not completed.`)
  if (run.conclusion !== 'success') problems.push(`Run ${candidateRun} concluded ${run.conclusion}, not success.`)
  return problems
}

/**
 * Makes the fresh profile a scenario runs on: the variant's userData directory must not exist yet (any
 * earlier state would make the run measure something other than a first install), and only the settings the
 * scenario declares are written. Returns the settings path. A scenario with isolatedProfiles never opens the
 * default profile, so nothing is written and null is returned.
 */
export function prepareProfile({ scenario, platform, appDataDir }) {
  const target = platformEntry(scenario, platform)
  if (target.isolatedProfiles) return null
  if (target.profileLayout) {
    const profile = join(process.cwd(), 'candidate-scenario', 'profile')
    if (existsSync(profile)) {
      throw new Error('The idle-soak profile directory already exists; the profile is not fresh.')
    }
    writeRepresentativeProfile(profile, undefined, { layout: target.profileLayout })
    return join(profile, 'resource-census-profile.json')
  }
  if (!appDataDir) throw new Error(`No fresh-profile location is declared for ${platform}.`)
  const name = PROFILE_DIRS[target.variant]
  if (!name) throw new Error(`No userData directory is declared for variant ${target.variant}.`)
  const profile = join(appDataDir, name)
  if (existsSync(profile)) throw new Error(`The ${name} userData directory already exists; the profile is not fresh.`)
  if (!target.settings) return null
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const settingsPath = join(profile, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify(target.settings, null, 2), { mode: 0o600 })
  return settingsPath
}

/** Maps a scenario script's exit code to its outcome; a code the scenario does not declare, or a kill by
 *  signal (null), is a FAIL. */
export function outcomeForExit(scenario, exitCode) {
  const exits = scenarioEntry(scenario).exits
  return Number.isInteger(exitCode) && Object.hasOwn(exits, exitCode) ? exits[exitCode] : 'FAIL'
}

/** The candidate-installer selector kind for this scenario/platform. Defaults to the platform. */
export function installerKindForScenario(scenario, platform) {
  return platformEntry(scenario, platform).installerKind ?? platform
}

const REPORT_SECTIONS = Object.freeze([
  ['rv', 'rv'],
  ['navigationGuard', 'hist'],
  ['rightEdgeHide', 're_hide']
])

function rowVerdict(row) {
  return {
    id: String(row?.id ?? ''),
    status: String(row?.status ?? 'MISSING'),
    ...(row?.unblock ? { unblock: String(row.unblock) } : {})
  }
}

function collectRowVerdicts(report) {
  return Object.fromEntries(
    REPORT_SECTIONS.map(([source, target]) => [
      target,
      Array.isArray(report?.[source]) ? report[source].map(rowVerdict) : []
    ])
  )
}

/** Extracts content-free verdict rows from packaged-smoke's report and decides whether they prove this
 *  platform's RV acceptance rows. BLOCKED_EXTERNAL rows are residual not-covered evidence, never PASS. */
export function assessPackagedSmokeReport(report, platform) {
  const row_verdicts = collectRowVerdicts(report)
  const problems = []
  if (report?.result !== 'pass') problems.push(`packaged-smoke result is ${report?.result ?? 'missing'}, not pass.`)

  const rvById = new Map(row_verdicts.rv.map((row) => [row.id, row]))
  for (const id of PACKAGED_LIFECYCLE_RV_ROWS[platform] ?? []) {
    const row = rvById.get(id)
    if (!row) problems.push(`${id} is missing from packaged-smoke rv rows.`)
  }
  for (const row of row_verdicts.rv) {
    if (row.status !== 'PASS') problems.push(`${row.id || 'unnamed RV row'} is ${row.status}, not PASS.`)
  }

  const notCovered = []
  for (const rows of Object.values(row_verdicts)) {
    for (const row of rows) {
      if (row.status === 'BLOCKED_EXTERNAL') {
        notCovered.push({ row: row.id, reason: row.unblock || 'The packaged-smoke row reported BLOCKED_EXTERNAL.' })
      }
    }
  }
  return { problems, row_verdicts, notCovered }
}

export function assessScenarioReport({ scenario, platform, report, expected = undefined }) {
  const entry = scenarioEntry(scenario)
  if (entry.reportAssessment === 'packaged-smoke') return assessPackagedSmokeReport(report, platform)
  if (entry.reportAssessment === FRESH_ONBOARDING_SCENARIO) return assessFreshOnboardingReport(report, expected)
  if (entry.reportAssessment === TLS_SCENARIO) return { problems: assessHostedTlsReport(report, expected), notCovered: [] }
  return { problems: [], row_verdicts: undefined, notCovered: [] }
}

/** The argv (after `node`) that runs a scenario. Every argument is repository-relative, so the recorded
 *  command never names the runner's home or temp directory.
 *  @param {{ scenario: string, platform: string, installer: string, sha256: string, outDir: string, app?: string,
 *    provenancePath?: string, candidateRun?: string, harnessCommit?: string, producerCommit?: string }} options */
export function scenarioCommand({
  scenario,
  platform,
  installer,
  sha256,
  outDir,
  app,
  provenancePath,
  candidateRun,
  harnessCommit,
  producerCommit
}) {
  const target = platformEntry(scenario, platform)
  if (target.installerSuffix && !installer.toLowerCase().endsWith(target.installerSuffix)) {
    throw new Error(
      `${scenario} installs a ${target.installerSuffix} installer; the selected installer is ${basename(installer)}.`
    )
  }
  const argv = [
    target.script,
    ...target.args({
      installer,
      sha256,
      report: join(outDir, target.report).replaceAll('\\', '/'),
      app,
      provenancePath,
      candidateRun,
      harnessCommit,
      producerCommit
    })
  ]
  if (argv.some((arg) => typeof arg !== 'string' || arg === '')) {
    throw new Error(`The ${scenario} command is missing an argument; pass the installed app with --app.`)
  }
  const absolute = argv.filter((arg) => isAbsolute(arg) || /^[A-Za-z]:[\\/]/.test(arg))
  if (absolute.length) {
    throw new Error(`The scenario command must use repository-relative paths; got ${absolute.length} absolute.`)
  }
  return argv
}

/** The provenance must be the candidate run's own: build_run_id and commit are taken from it. */
export function assertCandidateProvenance(provenance, candidateRun) {
  if (String(provenance?.run?.id) !== String(candidateRun)) {
    throw new Error(`provenance run ${provenance?.run?.id} is not the candidate run ${candidateRun}.`)
  }
}

/**
 * lane.json: what ran, on which bytes and host, and how it ended. Field names match the evidence record
 * (build_run_id, commit, artifact_sha256, ci_run_id, environment, command, exit_code) so the lead copies
 * them into a LIVE_VERIFIED record as they are. A platform that cannot prove some report rows adds
 * not_covered, so a PASS there is never read as covering them.
 * @param {{
 *   scenario: string,
 *   platform: string,
 *   env: Record<string, string | undefined>,
 *   provenance: any,
 *   candidateRun: string | number,
 *   installer: string,
 *   sha256: string,
 *   argv: string[],
 *   exitCode: number | null,
 *   detail: string,
 *   reportWritten: boolean,
 *   reportAssessment?: any
 * }} input
 */
export function laneRecord({
  scenario,
  platform,
  env,
  provenance,
  candidateRun,
  installer,
  sha256,
  argv,
  exitCode,
  detail,
  reportWritten,
  reportData = null,
  reportAssessment = undefined
}) {
  const target = platformEntry(scenario, platform)
  assertCandidateProvenance(provenance, candidateRun)
  const mappedOutcome = outcomeForExit(scenario, exitCode)
  const assessmentProblems = [
    ...(scenarioEntry(scenario).reportAssessment && !reportWritten ? [`${target.report} was not written.`] : []),
    ...(reportAssessment?.problems ?? [])
  ]
  const reportOutcome =
    target.outcomeFromReport && typeof reportData?.outcome === 'string' ? reportData.outcome : mappedOutcome
  const outcome = reportOutcome === 'PASS' && assessmentProblems.length ? 'FAIL' : reportOutcome
  const host = RUNNER_LABELS[platform]
  const reportFields = target.laneReportFields
    ? Object.fromEntries(
        target.laneReportFields
          .filter((key) => reportData && Object.hasOwn(reportData, key))
          .map((key) => [key, reportData[key]])
      )
    : {}
  const notCovered = [
    ...(target.notCovered ?? []).map(({ row, reason }) => ({ row, reason })),
    ...(reportAssessment?.notCovered ?? [])
  ]
  return {
    schema: LANE_SCHEMA,
    scenario,
    ticket: target.ticket ?? scenarioEntry(scenario).ticket,
    platform,
    runner_image: { label: host, image_os: env.ImageOS ?? null, image_version: env.ImageVersion ?? null },
    build_run_id: provenance.run.id,
    commit: provenance.commit,
    variant: target.variant,
    installer: basename(installer),
    artifact_sha256: sha256,
    ci_run_id: Number(env.GITHUB_RUN_ID),
    environment: { kind: 'hosted-runner', host },
    command: ['node', ...argv].join(' '),
    exit_code: exitCode,
    outcome,
    report: reportWritten ? target.report : null,
    detail: outcome === 'PASS' ? null : assessmentProblems.join('\n') || detail || null,
    ...reportFields,
    ...(reportAssessment?.row_verdicts ? { row_verdicts: reportAssessment.row_verdicts } : {}),
    ...(notCovered.length ? { not_covered: notCovered } : {})
  }
}

/** The job-summary markdown for a lane record. */
export function laneSummary(lane) {
  const rows = [
    ['outcome', lane.outcome],
    ['scenario', lane.scenario],
    ['platform', lane.platform],
    [
      'runner',
      `${lane.runner_image.label} (${lane.runner_image.image_os ?? '?'} ${lane.runner_image.image_version ?? '?'})`
    ],
    ['build_run_id', lane.build_run_id],
    ['commit', lane.commit],
    ['variant', lane.variant],
    ['installer', lane.installer],
    ['artifact_sha256', lane.artifact_sha256],
    ['ci_run_id', lane.ci_run_id],
    ['environment', `${lane.environment.kind} ${lane.environment.host}`],
    ['command', lane.command],
    ['exit_code', lane.exit_code],
    ['report', lane.report ?? 'none']
  ]
  if (lane.detail) rows.push(['detail', lane.detail])
  for (const { row, reason } of lane.not_covered ?? []) rows.push([`not covered: ${row}`, reason])
  for (const [group, verdicts] of Object.entries(lane.row_verdicts ?? {})) {
    for (const row of verdicts) rows.push([`${group}: ${row.id}`, row.status])
  }
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('`', "'")
  return [
    `### Candidate scenario ${lane.scenario} (${lane.platform}): ${lane.outcome}`,
    '',
    '| field | value |',
    '|---|---|',
    ...rows.map(([key, value]) => `| ${key} | \`${cell(value)}\` |`),
    ''
  ].join('\n')
}

/** The workflow annotation for an outcome that is not PASS; a PRECONDITION is a warning, never a pass. */
export function laneAnnotation(lane) {
  const text = String(lane.detail ?? 'see the scenario log').replace(/[\r\n]+/g, ' ')
  if (lane.outcome === 'PASS') return null
  if (lane.outcome === 'PRECONDITION') return `::warning title=${lane.scenario} PRECONDITION (not PASS)::${text}`
  return `::error title=${lane.scenario} ${lane.outcome}::${text}`
}

const CONTENT_PATTERNS = Object.freeze([
  ['macOS user home path', /\/Users\/[^\s/\\"'`]+/],
  ['Linux user home path', /\/home\/[^\s/\\"'`]+/],
  ['Windows user home path', /[A-Za-z]:\\+Users\\+[^\s\\"'`]+/i],
  ['email address', /[^\s@<>"'`]+@[^\s@<>"'`]+\.[A-Za-z]{2,}/]
])

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The names of the content rules `text` breaks — never the matched text itself. The runner account name
 * counts where it names an identity: a path segment, a ~account, an account@host, or a string value that
 * is exactly the account. The account as an ordinary word (such as the environment kind hosted-runner)
 * does not.
 */
export function contentProblems(text, { account }) {
  const problems = CONTENT_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  const name = String(account ?? '').trim()
  if (name) {
    const token = escapeRegExp(name)
    const identity = new RegExp(
      `[/\\\\~]${token}(?![A-Za-z0-9._-])|(?<![A-Za-z0-9._-])${token}[@/\\\\]|["']${token}["']`,
      'i'
    )
    if (identity.test(text)) problems.push('runner account name')
  }
  return problems
}

/** Legacy lanes delete files breaking a content rule; the fresh lane instead validates its exact output pair.
 * @param {string} dir
 * @param {{ account: string, scenario?: string, freshContext?: any, tlsContext?: any }} options */
export function scanUploadDir(dir, { account, scenario = undefined, freshContext = undefined, tlsContext = undefined }) {
  if (scenario === FRESH_ONBOARDING_SCENARIO) return scanFreshOnboardingOutput(dir, freshContext)
  if (scenario === TLS_SCENARIO) return scanHostedTlsOutput(dir, tlsContext)
  const problems = []
  if (!existsSync(dir)) return problems
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath ?? entry.path, entry.name)
    const hits = contentProblems(readFileSync(path, 'utf8'), { account })
    if (!hits.length) continue
    rmSync(path, { force: true })
    for (const hit of hits) problems.push(`${basename(path)}: ${hit}`)
  }
  return problems
}

// --- CLI ----------------------------------------------------------------------------------------------

function flags(argv) {
  const values = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) values[argv[i].slice(2)] = argv[++i] ?? ''
    else positional.push(argv[i])
  }
  return { values, positional }
}

function required(values, name) {
  const value = values[name]
  if (value === undefined || value === '') throw new Error(`--${name} is required.`)
  return value
}

function lastLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

/** Authorises System Events GUI scripting for this job's process chain, node and osascript, when the
 *  scenario's platform entry declares guiScripting; otherwise changes nothing. */
function grantGui(values) {
  const scenario = required(values, 'scenario')
  const platform = required(values, 'platform')
  if (!platformEntry(scenario, platform).guiScripting) {
    console.log(`${scenario} (${platform}) needs no GUI scripting; nothing granted.`)
    return 0
  }
  if (process.platform !== 'darwin') throw new Error('grant-gui authorises System Events on macOS only.')
  const exec = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const clients = ancestorPids(exec('/bin/ps', ['-axo', 'pid=,ppid=']), process.pid)
    .map((pid) => executableFromLsof(exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'])))
    .filter(Boolean)
  const grants = guiScriptingGrants([...clients, process.execPath, '/usr/bin/osascript'])
  exec('/usr/bin/sudo', ['/usr/bin/sqlite3', TCC_DATABASES.system, grants.system])
  exec('/usr/bin/sudo', ['/usr/bin/sqlite3', join(homedir(), TCC_DATABASES.user), grants.user])
  // Counts only: the clients are runner paths, and this log is public.
  console.log(`Granted Accessibility and System Events automation to ${grants.user.split('\n').length} executables.`)
  return 0
}

function run(values) {
  const scenario = required(values, 'scenario')
  const platform = required(values, 'platform')
  const installer = required(values, 'installer')
  const sha256 = required(values, 'sha256').trim().toLowerCase()
  const outDir = required(values, 'out')
  const candidateRun = required(values, 'candidate-run')
  const provenance = JSON.parse(readFileSync(required(values, 'provenance'), 'utf8'))
  const target = platformEntry(scenario, platform)
  assertCandidateProvenance(provenance, candidateRun)
  // The installed app sits outside the checkout (under the runner's temp directory); it is recorded relative
  // to the working directory so the command stays free of absolute paths.
  const app = values.app ? relative(process.cwd(), values.app).replaceAll('\\', '/') : undefined

  const argv = scenarioCommand({
    scenario,
    platform,
    installer,
    sha256,
    outDir,
    app,
    provenancePath: values.provenance,
    candidateRun,
    harnessCommit: process.env.GITHUB_SHA,
    producerCommit: process.env.METIS_CANDIDATE_COMMIT
  })
  if (scenario === TLS_SCENARIO) {
    if (existsSync(outDir)) throw new Error('TLS output must be a fresh directory.')
    mkdirSync(outDir, { mode: 0o700 })
    const childEnv = freshOnboardingChildEnv(process.env)
    // Non-secret immutable runner context is validated by the companion and never inherited by Electron.
    if (/^[0-9]{8}\.[0-9]{4}\.[0-9]+$/.test(process.env.ImageVersion ?? '')) {
      childEnv.METIS_TLS_IMAGE_VERSION = process.env.ImageVersion
    }
    const child = spawnSync(process.execPath, argv, {
      stdio: 'ignore',
      timeout: 240_000,
      killSignal: 'SIGKILL',
      env: childEnv
    })
    let reportData = null
    let reportWritten = false
    try {
      const path = join(outDir, TLS_REPORT)
      const stat = lstatSync(path)
      reportWritten = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 65_536
      if (reportWritten) reportData = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      /* Only the fixed lane failure below is public. */
    }
    const lane = hostedTlsLane({
      platform,
      env: process.env,
      provenance,
      candidateRun,
      sha256,
      exitCode: child.status,
      reportWritten,
      reportData
    })
    writeFileSync(join(outDir, 'lane.json'), `${JSON.stringify(lane, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'tls_lane_written=true\n')
    console.log(`hosted-startup-tls: ${lane.outcome} (${lane.detail})`)
    return lane.outcome === 'PASS' ? 0 : 1
  }
  mkdirSync(outDir, { recursive: true })
  if (scenario === FRESH_ONBOARDING_SCENARIO) {
    // No raw child stream/error reaches public logs or the support-only lane record.
    // A forced runner timeout is FAIL, never an owned-app shutdown acknowledgement or profile-cleanup receipt.
    const child = spawnSync(process.execPath, argv, {
      stdio: 'ignore',
      timeout: 240_000,
      env: freshOnboardingChildEnv(process.env)
    })
    const reportPath = join(outDir, target.report)
    let reportData = null
    let reportWritten = false
    try {
      const stat = lstatSync(reportPath)
      reportWritten = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 65_536
      if (reportWritten) reportData = JSON.parse(readFileSync(reportPath, 'utf8'))
    } catch {
      // Missing or malformed output is a fixed failure; never forward JSON parser details.
    }
    const lane = freshOnboardingLane({
      platform,
      env: process.env,
      provenance,
      candidateRun,
      sha256,
      exitCode: child.status,
      reportWritten,
      reportData
    })
    writeFileSync(join(outDir, 'lane.json'), `${JSON.stringify(lane, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'fresh_lane_written=true\n')
    const summary =
      `### Fresh onboarding support probe: ${lane.outcome}\n\nResult: ${lane.detail}. ` +
      'Full onboarding and visual acceptance are not covered.\n'
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
    console.log(`fresh-onboarding-baseline: ${lane.outcome} (${lane.detail})`)
    return lane.outcome === 'PASS' ? 0 : 1
  }
  const child = spawnSync(process.execPath, argv, {
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  process.stderr.write(child.stderr ?? '')
  const detail = child.signal
    ? `terminated by ${child.signal}`
    : child.error
      ? child.error.message
      : lastLine(child.stderr)
  const reportPath = join(outDir, target.report)
  const reportWritten = existsSync(reportPath)
  let reportData = null
  let reportAssessment
  if (reportWritten) {
    try {
      reportData = JSON.parse(readFileSync(reportPath, 'utf8'))
      reportAssessment = assessScenarioReport({ scenario, platform, report: reportData })
    } catch (error) {
      reportAssessment = {
        problems: [`${target.report} could not be parsed: ${error.message}`],
        row_verdicts: undefined,
        notCovered: []
      }
    }
  }

  const lane = laneRecord({
    scenario,
    platform,
    env: process.env,
    provenance,
    candidateRun,
    installer,
    sha256,
    argv,
    exitCode: child.status,
    detail,
    reportWritten,
    reportData,
    reportAssessment
  })
  writeFileSync(join(outDir, 'lane.json'), `${JSON.stringify(lane, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, laneSummary(lane))
  const annotation = laneAnnotation(lane)
  if (annotation) console.log(annotation)
  console.log(`${scenario} (${platform}): ${lane.outcome}, exit ${lane.exit_code}`)
  return lane.outcome === 'PASS' ? 0 : 1
}

function main(argv) {
  const [command, ...rest] = argv
  const { values, positional } = flags(rest)
  switch (command) {
    case 'resolve': {
      const plan = resolveScenario({
        scenario: required(values, 'scenario'),
        sha256: { mac: values['mac-sha256'], win: values['win-sha256'] }
      })
      process.stdout.write(resolveOutputs(plan))
      return 0
    }
    case 'guard': {
      const [runJson, candidateRun] = positional
      if (!runJson || !candidateRun) throw new Error('usage: guard <run.json> <candidate_run>')
      const problems = candidateRunProblems(JSON.parse(readFileSync(runJson, 'utf8')), candidateRun)
      if (problems.length) throw new Error(problems.join('\n'))
      console.log(
        `Run ${candidateRun} is a successful ${QA_CANDIDATE_WORKFLOW} dispatch on ${CANDIDATE_RUN_BRANCHES.join(' or ')}.`
      )
      return 0
    }
    case 'profile': {
      const scenario = required(values, 'scenario')
      const platform = required(values, 'platform')
      const settings = prepareProfile({
        scenario,
        platform,
        appDataDir: platform === 'mac' ? join(homedir(), 'Library', 'Application Support') : null
      })
      if (platformEntry(scenario, platform).isolatedProfiles)
        console.log('The scenario runs the app only on its own isolated profiles.')
      else
        console.log(
          settings
            ? 'Fresh profile seeded with the scenario settings.'
            : 'Fresh profile; the scenario seeds no settings.'
        )
      return 0
    }
    case 'grant-gui':
      return grantGui(values)
    case 'installer-kind':
      console.log(installerKindForScenario(required(values, 'scenario'), required(values, 'platform')))
      return 0
    case 'run':
      return run(values)
    case 'scan': {
      const [dir] = positional
      if (!dir) throw new Error('usage: scan <dir> --account <runner account>')
      const freshContext =
        values.scenario === FRESH_ONBOARDING_SCENARIO
          ? freshOnboardingScanContext({
              platform: required(values, 'platform'),
              provenance: JSON.parse(readFileSync(required(values, 'provenance'), 'utf8')),
              candidateRun: required(values, 'candidate-run'),
              sha256: required(values, 'sha256'),
              env: process.env,
              laneWritten: values['lane-written'] === 'true'
            })
          : undefined
      const problems = scanUploadDir(dir, {
        account: required(values, 'account'),
        scenario: values.scenario,
        freshContext,
        tlsContext:
          values.scenario === TLS_SCENARIO
            ? hostedTlsScanContext({
                platform: required(values, 'platform'),
                provenance: JSON.parse(readFileSync(required(values, 'provenance'), 'utf8')),
                candidateRun: required(values, 'candidate-run'),
                sha256: required(values, 'sha256'),
                env: process.env,
                laneWritten: values['tls-lane-written'] === 'true'
              })
            : undefined
      })
      for (const problem of problems) {
        const action =
          [FRESH_ONBOARDING_SCENARIO, TLS_SCENARIO].includes(values.scenario)
            ? 'upload withheld'
            : 'file removed from the upload'
        console.log(`::error title=Content-free gate::${problem} (${action})`)
      }
      return problems.length ? 1 : 0
    }
    default:
      throw new Error('usage: candidate-scenarios.mjs <resolve|guard|profile|grant-gui|installer-kind|run|scan> ...')
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    const scenarioIndex = process.argv.indexOf('--scenario')
    const fresh = scenarioIndex >= 0 && process.argv[scenarioIndex + 1] === FRESH_ONBOARDING_SCENARIO
    const tls = scenarioIndex >= 0 && process.argv[scenarioIndex + 1] === TLS_SCENARIO
    console.error(
      tls
        ? '::error::hosted-startup-tls: lane-failed'
        : fresh
          ? '::error::fresh-onboarding-baseline: lane-failed'
          : `::error::${error.message.replaceAll('\n', '%0A')}`
    )
    process.exitCode = 1
  }
}
