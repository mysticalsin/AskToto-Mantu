#!/usr/bin/env node
// Disposable diagnostic spike, 2026-10-09: remove within 48 hours of the hosted observation.
// This measures one pinned, already-failed Windows candidate. It is not an onboarding acceptance lane.
// Never print or persist raw app, CDP, inspector, process, path, or network content.
import { createHash } from 'node:crypto'
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPackagedAsarVersion, teardownThenDispose } from './fresh-onboarding-baseline.mjs'

export const CANDIDATE_RUN = 37771807736
export const INSTALLER_SHA256 = 'a5459e1f5137710b3f249a21ae372c13395f083a45319a0bd3f8fce7a44d6ff1'
const PRODUCER_COMMIT = '2d4ebe7b6698f78abcb74dc426867d95d96e4268'
const CANDIDATE_VERSION = '1.9.7'
const INSTALLER_NAME = `Metis-Setup-${CANDIDATE_VERSION}.exe`
const SCHEMA = 'metis.windows-cdp-diagnostic-spike.v1'
const REPORT_DIRECTORY = 'candidate-probe'
const REPORT_FILE = 'cdp-probe.json'
const REPORT_PATH = join(REPORT_DIRECTORY, REPORT_FILE)
const PROVENANCE_PATH = join('provenance', 'provenance.json')
const HASH40 = /^[0-9a-f]{40}$/
const FIRST_DEADLINE_MS = 15_000
const FINAL_DEADLINE_MS = 45_000
const MAX_REPORT_BYTES = 2_048
const CDP_STATUSES = new Set([
  'OWNED_CDP',
  'DEADLINE',
  'ATTACH_FAILED',
  'TRANSPORT_TIMEOUT',
  'PROCESS_INFO_INVALID',
  'PID_MISMATCH',
  'PROCESS_EXITED',
  'NOT_RUN'
])
const INSPECTOR_STATUSES = new Set([
  'OWNED_PROFILE_AND_VERSION',
  'OWNED_PROFILE_MISMATCH',
  'OWNED_VERSION_MISMATCH',
  'OWNED_PROFILE_AND_VERSION_MISMATCH',
  'UNAVAILABLE',
  'TRANSPORT_UNCERTAIN',
  'INVALID_OBSERVATION',
  'NOT_RUN'
])
const TEARDOWN_STATUSES = new Set(['ACKNOWLEDGED', 'UNACKNOWLEDGED', 'NOT_ATTEMPTED'])
const RELEASE_STATUSES = new Set(['RELEASED', 'UNCERTAIN', 'NOT_ATTEMPTED'])
const PROCESS_STATUSES = new Set(['RUNNING', 'EXITED', 'UNKNOWN'])
const REPORT_KEYS = [
  'schema',
  'diagnostic_only',
  'identity',
  'acceptance_15s',
  'cdp_45s',
  'inspector_45s',
  'process_at_end',
  'teardown',
  'transport_release'
]
const IDENTITY_KEYS = ['candidate_run', 'installer_sha256', 'producer_commit', 'harness_commit', 'version']

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

/** A fixed-domain classifier. Only attachOwnedCdp can produce a trusted OWNED_CDP in the hosted probe. */
export function classifyCdp(result) {
  if (result?.browser && result.failure === null) return 'OWNED_CDP'
  switch (result?.failure) {
    case 'cdp-endpoint-deadline':
      return 'DEADLINE'
    case 'cdp-transport-timeout':
      return 'TRANSPORT_TIMEOUT'
    case 'cdp-session-or-process-info-invalid':
      return 'PROCESS_INFO_INVALID'
    case 'cdp-browser-pid-mismatch':
      return 'PID_MISMATCH'
    default:
      return 'ATTACH_FAILED'
  }
}

/** A fixed-domain classifier. The inspector helper proves main-PID ownership before returning an observation. */
export function classifyInspector(result) {
  if (!result?.inspector || !result.observation) {
    return result?.transportUncertain ? 'TRANSPORT_UNCERTAIN' : 'UNAVAILABLE'
  }
  const observation = result.observation
  if (
    typeof observation.profileMatches !== 'boolean' ||
    !Number.isSafeInteger(observation.profileMask) ||
    observation.profileMask < 0 ||
    observation.profileMask > 15 ||
    observation.profileMatches !== (observation.profileMask === 0) ||
    typeof observation.versionMatches !== 'boolean' ||
    typeof observation.nativeFullDisplay !== 'boolean'
  ) {
    return 'INVALID_OBSERVATION'
  }
  if (!observation.profileMatches && !observation.versionMatches) return 'OWNED_PROFILE_AND_VERSION_MISMATCH'
  if (!observation.profileMatches) return 'OWNED_PROFILE_MISMATCH'
  if (!observation.versionMatches) return 'OWNED_VERSION_MISMATCH'
  return 'OWNED_PROFILE_AND_VERSION'
}

/** Reject arbitrary fields and any semantically impossible promotion of a late CDP observation. */
export function probeReportProblems(report) {
  if (!exactRecord(report, REPORT_KEYS)) return ['REPORT_SHAPE']
  const problems = []
  if (report.schema !== SCHEMA || report.diagnostic_only !== true) problems.push('REPORT_SCHEMA')
  if (!exactRecord(report.identity, IDENTITY_KEYS)) {
    problems.push('IDENTITY_SHAPE')
  } else if (
    report.identity.candidate_run !== CANDIDATE_RUN ||
    report.identity.installer_sha256 !== INSTALLER_SHA256 ||
    report.identity.producer_commit !== PRODUCER_COMMIT ||
    typeof report.identity.harness_commit !== 'string' ||
    !HASH40.test(report.identity.harness_commit) ||
    report.identity.version !== CANDIDATE_VERSION
  ) {
    problems.push('IDENTITY_INVALID')
  }
  if (!CDP_STATUSES.has(report.acceptance_15s) || !CDP_STATUSES.has(report.cdp_45s)) problems.push('CDP_STATUS')
  if (!INSPECTOR_STATUSES.has(report.inspector_45s)) problems.push('INSPECTOR_STATUS')
  if (!PROCESS_STATUSES.has(report.process_at_end) || report.process_at_end === 'UNKNOWN') {
    problems.push('PROCESS_STATUS')
  }
  if (!TEARDOWN_STATUSES.has(report.teardown) || !RELEASE_STATUSES.has(report.transport_release)) {
    problems.push('TEARDOWN_STATUS')
  }
  if (report.acceptance_15s === 'NOT_RUN' || report.inspector_45s === 'NOT_RUN') {
    problems.push('OBSERVATION_NOT_RUN')
  }
  if (report.cdp_45s !== 'NOT_RUN' && report.acceptance_15s !== 'DEADLINE') {
    problems.push('LATE_OBSERVATION_SEMANTICS')
  }
  if (report.teardown === 'NOT_ATTEMPTED' || report.transport_release === 'NOT_ATTEMPTED') {
    problems.push('TEARDOWN_NOT_ATTEMPTED')
  }
  if (report.teardown !== 'ACKNOWLEDGED' && report.transport_release === 'RELEASED') {
    problems.push('RELEASE_ORDER')
  }
  return problems
}

/**
 * Run two strictly separated observations on one captured child: an unchanged 15-second acceptance boundary,
 * then at most 30 seconds of late diagnostics. The inspector runs independently against that child's PID.
 * Every transport is released only after stopping the exact captured child.
 */
export async function runDiagnosticSession({
  launch,
  expectedPaths,
  expectedVersion,
  attachCdp,
  attachInspector,
  observeProtocols,
  stop,
  normalize,
  dispose,
  now = () => performance.now()
}) {
  const childPid = launch?.child?.pid
  if (!Number.isSafeInteger(childPid) || childPid <= 1 || childPid === process.pid) {
    throw new Error('owned-child-receipt-invalid')
  }
  const started = now()
  const firstDeadline = started + FIRST_DEADLINE_MS
  const finalDeadline = started + FINAL_DEADLINE_MS
  const result = {
    acceptance_15s: 'NOT_RUN',
    cdp_45s: 'NOT_RUN',
    inspector_45s: 'NOT_RUN',
    process_at_end: 'UNKNOWN',
    teardown: 'NOT_ATTEMPTED',
    transport_release: 'NOT_ATTEMPTED'
  }
  let browser = null
  let inspector = null
  let transportUncertain = false
  const lateReleases = []
  const retain = (attachment) => {
    transportUncertain ||= attachment?.transportUncertain === true
    if (typeof attachment?.lateRelease === 'function') lateReleases.push(attachment.lateRelease)
  }
  const childExited = () =>
    Boolean(
      launch.latches?.spawnError ||
        launch.latches?.exited ||
        launch.child.exitCode != null ||
        launch.child.signalCode != null
    )
  let inspectorPromise = null
  let protocolObserver = null
  try {
    // Reproduce the failed lane's passive endpoint traffic during this exact first-CDP window.
    protocolObserver = observeProtocols?.(firstDeadline) ?? null
    const first = await attachCdp({
      endpoint: launch.cdpEndpoint,
      childPid,
      timeoutMs: FIRST_DEADLINE_MS,
      deadlineMs: firstDeadline
    }).catch(() => ({ browser: null, failure: 'cdp-attach-failed', transportUncertain: true, lateRelease: null }))
    protocolObserver?.cancel()
    protocolObserver = null
    retain(first)
    browser = first.browser ?? null
    // The baseline checks the captured child immediately after first CDP attach; preserve that gate.
    if (childExited()) {
      result.acceptance_15s = 'PROCESS_EXITED'
      result.inspector_45s = 'UNAVAILABLE'
      result.process_at_end = 'EXITED'
      return result
    }
    const firstStatus = classifyCdp(first)
    if (firstStatus === 'OWNED_CDP' && now() >= firstDeadline) {
      // A completion at/after the hard boundary is diagnostic only, even if the helper returned a browser.
      result.acceptance_15s = 'DEADLINE'
      result.cdp_45s = now() < finalDeadline ? 'OWNED_CDP' : 'DEADLINE'
    } else {
      result.acceptance_15s = firstStatus
    }
    // Match the acceptance harness exactly: no inspector attach can contend with the first CDP window.
    // Inspector and late CDP observation are diagnostic only, under the remaining overall 45-second budget.
    inspectorPromise = Promise.resolve()
      .then(() =>
        attachInspector({
          inspectPort: launch.inspectPort,
          childPid,
          expectedPaths,
          expectedVersion,
          timeoutMs: Math.max(1, finalDeadline - now())
        })
      )
      .catch(() => ({ inspector: null, observation: null, transportUncertain: true, lateRelease: null }))
    if (result.acceptance_15s === 'DEADLINE' && result.cdp_45s === 'NOT_RUN' && !transportUncertain) {
      const remaining = Math.max(0, finalDeadline - now())
      if (remaining > 0) {
        const late = await attachCdp({
          endpoint: launch.cdpEndpoint,
          childPid,
          timeoutMs: remaining,
          deadlineMs: finalDeadline
        }).catch(() => ({ browser: null, failure: 'cdp-attach-failed', transportUncertain: true, lateRelease: null }))
        retain(late)
        browser = late.browser ?? null
        result.cdp_45s = now() >= finalDeadline && late.browser ? 'DEADLINE' : classifyCdp(late)
      } else {
        result.cdp_45s = 'DEADLINE'
      }
    }
    const observedInspector = await inspectorPromise
    retain(observedInspector)
    inspector = observedInspector.inspector ?? null
    result.inspector_45s = classifyInspector(observedInspector)
    result.process_at_end = childExited() ? 'EXITED' : 'RUNNING'
  } finally {
    protocolObserver?.cancel()
    // Even when CDP throws, the inspector promise and its transport must be captured before teardown.
    const observedInspector = inspectorPromise
      ? await inspectorPromise
      : { inspector: null, observation: null, transportUncertain: true, lateRelease: null }
    if (result.inspector_45s === 'NOT_RUN') {
      retain(observedInspector)
      inspector = observedInspector.inspector ?? null
      result.inspector_45s = classifyInspector(observedInspector)
    }
    const teardown = await teardownThenDispose({
      child: launch.child,
      stop,
      normalize,
      dispose: () => dispose({ inspector, browser, transportUncertain, lateReleases })
    })
    result.teardown = teardown.teardown
    result.transport_release = teardown.transportReleased ? 'RELEASED' : 'UNCERTAIN'
  }
  return result
}

function createProfile() {
  const root = mkdtempSync(join(tmpdir(), 'metis-win-cdp-probe-'))
  const paths = {
    root,
    home: join(root, 'home'),
    userProfile: join(root, 'userprofile'),
    appData: join(root, 'appdata'),
    localAppData: join(root, 'localappdata'),
    temp: join(root, 'tmp'),
    userData: join(root, 'userdata')
  }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 })
  if (readdirSync(paths.userData).length !== 0) throw new Error('profile-not-fresh')
  return paths
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')))
      .on('error', reject)
  })
}

function pinnedProvenance(installer = null) {
  const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, 'utf8'))
  if (
    provenance?.run?.id !== CANDIDATE_RUN ||
    provenance.commit !== PRODUCER_COMMIT ||
    provenance.version !== CANDIDATE_VERSION ||
    !Array.isArray(provenance.builds)
  ) {
    throw new Error('provenance-rejected')
  }
  const matches = provenance.builds
    .filter((build) => build?.variant === 'win' && Array.isArray(build.assets))
    .flatMap((build) => build.assets)
    .filter(
      (asset) =>
        asset?.sha256 === INSTALLER_SHA256 &&
        asset?.name === INSTALLER_NAME &&
        (installer === null || asset.name === basename(installer))
    )
  if (matches.length !== 1) throw new Error('installer-not-in-provenance')
  return provenance
}

async function runHostedProbe(app, installer) {
  const installedApp = join(process.env.RUNNER_TEMP ?? '', 'candidate-install', 'Metis.exe')
  const installerPath = resolve(installer)
  if (
    process.platform !== 'win32' ||
    typeof process.env.RUNNER_TEMP !== 'string' ||
    !isAbsolute(process.env.RUNNER_TEMP) ||
    !isAbsolute(app) ||
    resolve(app) !== resolve(installedApp) ||
    dirname(installerPath) !== resolve('assets') ||
    !/^Metis-Setup-.*\.exe$/.test(basename(installerPath))
  ) {
    throw new Error('invalid-hosted-input')
  }
  const assetStat = lstatSync(installerPath)
  if (!assetStat.isFile() || assetStat.isSymbolicLink()) throw new Error('installer-file-rejected')
  const provenance = pinnedProvenance(installerPath)
  if ((await sha256File(installerPath)) !== INSTALLER_SHA256) throw new Error('installer-hash-rejected')
  const { resolveInstallTarget } = await import('./census/lib.mjs')
  const target = resolveInstallTarget(app, 'win32')
  if ((await readPackagedAsarVersion({ target, platform: 'win32' })) !== provenance.version) {
    throw new Error('installed-version-rejected')
  }
  const harnessCommit = process.env.GITHUB_SHA
  if (typeof harnessCommit !== 'string' || !HASH40.test(harnessCommit)) throw new Error('harness-identity-rejected')
  const profile = createProfile()
  let launch
  let session
  let sessionStarted = false
  try {
    const driver = await import('./lib/app-driver.mjs')
    const { observeLoopbackProtocols } = await import('./lib/endpoint-observation.mjs')
    const termination = await import('./lib/st-1-termination.mjs')
    const environment = driver.strictLaunchEnvironment(process.env, profile, 'win32')
    const cdpPort = await driver.boundedCall(() => driver.freeLoopbackPort(), 15_000, 'port-budget')
    const inspectPort = await driver.boundedCall(() => driver.freeLoopbackPort(), 15_000, 'port-budget')
    if (cdpPort === inspectPort) throw new Error('port-collision')
    launch = driver.launchPackagedCdp({
      executablePath: target.executable,
      env: environment,
      cdpPort,
      inspectPort,
      platform: 'win32'
    })
    if (
      !Number.isSafeInteger(launch.child?.pid) ||
      launch.child.pid <= 1 ||
      launch.child.pid === process.pid ||
      driver.packagedLaunchFailed(launch.child, launch.latches)
    ) {
      throw new Error('launch-receipt-rejected')
    }
    sessionStarted = true
    session = await runDiagnosticSession({
      launch,
      expectedPaths: profile,
      expectedVersion: provenance.version,
      attachCdp: driver.attachOwnedCdp,
      attachInspector: driver.attachOwnedMainInspector,
      observeProtocols: (deadline) => observeLoopbackProtocols({ cdpPort, inspectPort, deadline }),
      stop: termination.stopOwnedChild,
      normalize: termination.normalizeTeardown,
      dispose: (transports) => driver.disposeFreshOnboardingTransports(transports, 5_000)
    })
    const report = {
      schema: SCHEMA,
      diagnostic_only: true,
      identity: {
        candidate_run: CANDIDATE_RUN,
        installer_sha256: INSTALLER_SHA256,
        producer_commit: provenance.commit,
        harness_commit: harnessCommit,
        version: provenance.version
      },
      ...session
    }
    if (probeReportProblems(report).length) throw new Error('report-rejected')
    mkdirSync(REPORT_DIRECTORY, { mode: 0o700 })
    writeFileSync(REPORT_PATH, `${JSON.stringify(report)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    if (session.teardown !== 'ACKNOWLEDGED' || session.transport_release !== 'RELEASED') {
      throw new Error('teardown-or-transport-unconfirmed')
    }
    rmSync(profile.root, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 })
  } catch (error) {
    // runDiagnosticSession owns teardown after it accepts a valid child. If launch failed before that point,
    // stop only the exact captured child; never search or kill by executable name.
    if (launch?.child && !sessionStarted) {
      const termination = await import('./lib/st-1-termination.mjs')
      await termination.stopOwnedChild(launch.child)
    } else if (!launch) {
      rmSync(profile.root, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 })
    }
    throw error
  }
}

function scanHostedOutput() {
  const directory = lstatSync(REPORT_DIRECTORY)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('report-directory-rejected')
  if (JSON.stringify(readdirSync(REPORT_DIRECTORY)) !== JSON.stringify([REPORT_FILE])) {
    throw new Error('report-file-list-rejected')
  }
  const file = lstatSync(REPORT_PATH)
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_REPORT_BYTES || file.size < 2) {
    throw new Error('report-file-rejected')
  }
  const text = readFileSync(REPORT_PATH, 'utf8')
  const report = JSON.parse(text)
  if (text !== `${JSON.stringify(report)}\n` || probeReportProblems(report).length) {
    throw new Error('report-content-rejected')
  }
  const provenance = pinnedProvenance()
  if (
    report.identity.producer_commit !== provenance.commit ||
    report.identity.version !== provenance.version ||
    report.identity.harness_commit !== process.env.GITHUB_SHA
  ) {
    throw new Error('report-identity-rejected')
  }
  // These fixed literals are the entire CLI readback. Never echo the JSON itself.
  console.log('windows-cdp-probe: content-free report validated; diagnostic only; original FAIL unchanged')
}

async function main(argv) {
  try {
    if (argv.length === 1 && argv[0] === 'scan') {
      scanHostedOutput()
      return
    }
    if (argv.length === 5 && argv[0] === 'run' && argv[1] === '--app' && argv[3] === '--installer') {
      await runHostedProbe(argv[2], argv[4])
      console.log('windows-cdp-probe: bounded diagnostic observation written; original FAIL unchanged')
      return
    }
    throw new Error('invalid-command')
  } catch {
    console.error('::error::windows-cdp-probe failed; no product acceptance implied')
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
