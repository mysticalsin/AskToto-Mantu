#!/usr/bin/env node
// Disposable hosted diagnostic. Remove within 48 hours of its first hosted observation.
// This never promotes the original failed 15-second onboarding assertion or reads meeting content.
import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readPackagedAsarVersion, teardownThenDispose } from './fresh-onboarding-baseline.mjs'
import { createAuditMonitor } from './hosted-candidate-tls.mjs'
import {
  attachOwnedCdp,
  attachOwnedMainInspector,
  boundedCall,
  disposeFreshOnboardingTransports,
  freeLoopbackPort,
  launchPackagedCdp,
  packagedLaunchFailed,
  strictLaunchEnvironment
} from './lib/app-driver.mjs'
import { observeLoopbackProtocols } from './lib/endpoint-observation.mjs'
import { normalizeTeardown, stopOwnedChild } from './lib/st-1-termination.mjs'
import { sha256File } from './provenance.mjs'

export const PIN = Object.freeze({
  candidateRun: 37771807736,
  installerSha256: 'a5459e1f5137710b3f249a21ae372c13395f083a45319a0bd3f8fce7a44d6ff1',
  producerCommit: '2d4ebe7b6698f78abcb74dc426867d95d96e4268',
  version: '1.9.7',
  installerName: 'Metis-Setup-1.9.7.exe'
})
export const SCHEMA = 'metis.windows-cdp-env-matrix.v2'
const HASH40 = /^[0-9a-f]{40}$/
const FIRST_MS = 15_000
const FINAL_MS = 45_000
const MAX_OUTPUT_BYTES = 4_096
const SNAPSHOT_KEYS = [
  'process',
  'window_post_deadline',
  'audit',
  'protocol_shape',
  'cdp_http_interval',
  'inspector_attach_stage',
  'host_loop_lag'
]
const VARIANT_KEYS = [
  'environment',
  'cdp_15s',
  'cdp_45s',
  'inspector_15s',
  'inspector_45s',
  'at_15s',
  'at_45s',
  'teardown',
  'transport_release'
]
const REPORT_KEYS = ['schema', 'diagnostic_only', 'original_acceptance', 'identity', 'variants']
const IDENTITY_KEYS = ['candidate_run', 'installer_sha256', 'producer_commit', 'harness_commit', 'version']
const CDP = new Set([
  'OWNED',
  'DEADLINE',
  'ATTACH_FAILED',
  'TRANSPORT_TIMEOUT',
  'PROCESS_INFO_INVALID',
  'PID_MISMATCH',
  'PROCESS_EXITED'
])
const INSPECTOR = new Set([
  'OWNED_MATCH',
  'OWNED_PROFILE_MISMATCH',
  'OWNED_VERSION_MISMATCH',
  'OWNED_BOTH_MISMATCH',
  'UNAVAILABLE',
  'TRANSPORT_UNCERTAIN',
  'PROCESS_EXITED'
])
const PROCESS = new Set(['RUNNING', 'EXITED'])
const WINDOW_QUERY_RESULT = new Set([
  'NORMAL_TITLE',
  'ERROR_TITLE',
  'OTHER_TITLE',
  'NO_MAIN_WINDOW',
  'QUERY_PROCESS_LOOKUP_FAILED',
  'QUERY_SHELL_PATH_INVALID',
  'QUERY_SHELL_MISSING',
  'QUERY_TIMEOUT',
  'QUERY_SHELL_FAILED',
  'QUERY_OUTPUT_INVALID'
])
const WINDOW = new Set([
  ...[...WINDOW_QUERY_RESULT].map((status) => `POST_DEADLINE_${status}`),
  'EXITED_BEFORE_QUERY',
  'EXITED_DURING_QUERY'
])
const AUDIT = new Set(['READY', 'NOT_OBSERVED', 'INVALID'])
const ENDPOINT = new Set([
  'BOTH_PROTOCOL_SHAPES_OBSERVED',
  'CDP_PROTOCOL_SHAPE_OBSERVED',
  'INSPECTOR_PROTOCOL_SHAPE_OBSERVED',
  'NOT_OBSERVED'
])
const CDP_HTTP = new Set([
  'NO_RESULT',
  'REFUSED_OBSERVED',
  'NETWORK_ERROR_OBSERVED',
  'TIMEOUT_OBSERVED',
  'NON_200_OBSERVED',
  'INVALID_200_SHAPE_OBSERVED',
  'VALID_200_SHAPE_OBSERVED'
])
const INSPECTOR_STAGE_RANK = Object.freeze({
  NO_STAGE: 0,
  DEADLINE: 1,
  DISCOVERY_WAITING: 2,
  INPUT_REJECTED: 3,
  DISCOVERY_INVALID: 4,
  DISCOVERY_READY: 5,
  SOCKET_FAILED: 6,
  SOCKET_UNCERTAIN: 6,
  SOCKET_OPEN: 7,
  OBSERVATION_RETRY: 8,
  OBSERVATION_FAILED: 9,
  OBSERVATION_OWNED: 10,
  UNEXPECTED_STAGE: 11
})
const INSPECTOR_STAGE = new Set(Object.keys(INSPECTOR_STAGE_RANK))
const LAG = new Set(['LT_250_MS', '250_TO_999_MS', 'GE_1000_MS', 'UNKNOWN'])
const TEARDOWN = new Set(['ACKNOWLEDGED', 'UNACKNOWLEDGED'])
const RELEASE = new Set(['RELEASED', 'UNCERTAIN'])
const execFileAsync = promisify(execFile)

const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

// Only machine-wide OS paths absent from strictLaunchEnvironment are eligible; no credential, user-profile,
// Electron/debug or GitHub variable can reach the app. Both variants retain identical fresh profile overrides.
export const WINDOWS_OS_EXTRA = Object.freeze([
  'ALLUSERSPROFILE',
  'PUBLIC',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ProgramW6432',
  'SystemDrive'
])

export function osSupersetLaunchEnvironment(base, paths) {
  const strict = strictLaunchEnvironment(base, paths, 'win32')
  if (!win32.isAbsolute(paths.userProfile) || !/^[A-Za-z]:[\\/]/.test(paths.userProfile)) {
    throw new Error('invalid-fresh-user-profile')
  }
  const extra = {}
  for (const name of WINDOWS_OS_EXTRA) {
    const matches = Object.keys(base ?? {}).filter((key) => key.toLowerCase() === name.toLowerCase())
    if (matches.length > 1) throw new Error('ambiguous-os-environment')
    if (matches.length === 0) continue
    const value = base[matches[0]]
    if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new Error('invalid-os-environment')
    if (name === 'SystemDrive' ? !/^[A-Za-z]:$/.test(value) : !win32.isAbsolute(value)) {
      throw new Error('invalid-os-environment')
    }
    extra[name] = value
  }
  return {
    ...strict,
    ...extra,
    HOMEDRIVE: paths.userProfile.slice(0, 2),
    HOMEPATH: paths.userProfile.slice(2)
  }
}

export function classifyCdp(result, settledAt, deadline, processExited = false) {
  if (processExited) return 'PROCESS_EXITED'
  if (result?.browser && result.failure === null) return settledAt < deadline ? 'OWNED' : 'DEADLINE'
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

export function classifyInspector(result, settledAt, deadline, processExited = false) {
  if (processExited) return 'PROCESS_EXITED'
  if (!result?.inspector || !result.observation) {
    return result?.transportUncertain ? 'TRANSPORT_UNCERTAIN' : 'UNAVAILABLE'
  }
  if (settledAt >= deadline) return 'UNAVAILABLE'
  const observation = result.observation
  if (
    typeof observation.profileMatches !== 'boolean' ||
    !Number.isSafeInteger(observation.profileMask) ||
    observation.profileMask < 0 ||
    observation.profileMask > 15 ||
    observation.profileMatches !== (observation.profileMask === 0) ||
    typeof observation.versionMatches !== 'boolean'
  )
    return 'UNAVAILABLE'
  if (!observation.profileMatches && !observation.versionMatches) return 'OWNED_BOTH_MISMATCH'
  if (!observation.profileMatches) return 'OWNED_PROFILE_MISMATCH'
  if (!observation.versionMatches) return 'OWNED_VERSION_MISMATCH'
  return 'OWNED_MATCH'
}

/** Latch the child state when an owned attach settles, not after its peer's independent deadline. */
export async function captureSettledAttachment(attachment, isExited, now = () => performance.now()) {
  return Promise.resolve(attachment).then(
    (value) => ({ value, settledAt: now(), exitedAtSettle: isExited() === true }),
    () => ({ value: null, settledAt: now(), exitedAtSettle: isExited() === true })
  )
}

/** Historical ownership by the deadline is distinct from whether the child is still alive at that deadline. */
export function cdpByDeadline(first, late, processAtDeadline, deadline) {
  for (const receipt of [first, late]) {
    if (receipt && classifyCdp(receipt.value, receipt.settledAt, deadline, receipt.exitedAtSettle) === 'OWNED') {
      return 'OWNED'
    }
  }
  if (processAtDeadline === 'EXITED') return 'PROCESS_EXITED'
  const last = late ?? first
  if (last?.settledAt >= deadline) return 'DEADLINE'
  return classifyCdp(last?.value, last?.settledAt ?? deadline, deadline)
}

export function inspectorByDeadline(first, late, processAtDeadline, deadline) {
  for (const receipt of [first, late]) {
    if (!receipt) continue
    const status = classifyInspector(receipt.value, receipt.settledAt, deadline, receipt.exitedAtSettle)
    if (status.startsWith('OWNED_')) return status
  }
  if (processAtDeadline === 'EXITED') return 'PROCESS_EXITED'
  const last = late ?? first
  if (last?.settledAt >= deadline) return 'UNAVAILABLE'
  return classifyInspector(last?.value, last?.settledAt ?? deadline, deadline)
}

export function reportProblems(report) {
  if (!exact(report, REPORT_KEYS)) return ['REPORT_SHAPE']
  const problems = []
  if (
    report.schema !== SCHEMA ||
    report.diagnostic_only !== true ||
    report.original_acceptance !== 'FAIL_CDP_DEADLINE_8_NOT_RUN'
  )
    problems.push('REPORT_IDENTITY')
  if (
    !exact(report.identity, IDENTITY_KEYS) ||
    report.identity.candidate_run !== PIN.candidateRun ||
    report.identity.installer_sha256 !== PIN.installerSha256 ||
    report.identity.producer_commit !== PIN.producerCommit ||
    report.identity.version !== PIN.version ||
    !HASH40.test(report.identity.harness_commit)
  )
    problems.push('CANDIDATE_IDENTITY')
  if (
    !Array.isArray(report.variants) ||
    report.variants.length !== 2 ||
    report.variants[0]?.environment !== 'STRICT' ||
    report.variants[1]?.environment !== 'OS_SUPERSET'
  ) {
    problems.push('VARIANT_ORDER')
  }
  for (const variant of Array.isArray(report.variants) ? report.variants : []) {
    if (!exact(variant, VARIANT_KEYS)) {
      problems.push('VARIANT_SHAPE')
      continue
    }
    if (
      ![variant.cdp_15s, variant.cdp_45s].every((value) => CDP.has(value)) ||
      ![variant.inspector_15s, variant.inspector_45s].every((value) => INSPECTOR.has(value))
    )
      problems.push('ATTACH_STATUS')
    if (
      !TEARDOWN.has(variant.teardown) ||
      !RELEASE.has(variant.transport_release) ||
      (variant.teardown !== 'ACKNOWLEDGED' && variant.transport_release === 'RELEASED')
    )
      problems.push('RELEASE_ORDER')
    for (const snap of [variant.at_15s, variant.at_45s]) {
      if (!exact(snap, SNAPSHOT_KEYS)) {
        problems.push('SNAPSHOT_SHAPE')
        continue
      }
      if (
        !PROCESS.has(snap.process) ||
        !WINDOW.has(snap.window_post_deadline) ||
        !AUDIT.has(snap.audit) ||
        !ENDPOINT.has(snap.protocol_shape) ||
        !CDP_HTTP.has(snap.cdp_http_interval) ||
        !INSPECTOR_STAGE.has(snap.inspector_attach_stage) ||
        !LAG.has(snap.host_loop_lag)
      )
        problems.push('SNAPSHOT_STATUS')
    }
  }
  return problems
}

function createProfile() {
  const root = mkdtempSync(join(tmpdir(), 'metis-cdp-env-matrix-'))
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

function childExited(launch) {
  return packagedLaunchFailed(launch.child, launch.latches)
}

function lagMonitor() {
  let expected = performance.now() + 100
  let max = 0
  const timer = setInterval(() => {
    max = Math.max(max, performance.now() - expected)
    expected = performance.now() + 100
  }, 100)
  return {
    read() {
      const delay = Math.max(max, performance.now() - expected)
      if (!Number.isFinite(delay)) return 'UNKNOWN'
      if (delay >= 1_000) return 'GE_1000_MS'
      return delay >= 250 ? '250_TO_999_MS' : 'LT_250_MS'
    },
    close() {
      clearInterval(timer)
    }
  }
}

const WINDOW_QUERY = String.raw`
  $ErrorActionPreference = 'Stop'
  try { $p = Get-Process -Id ([int]$env:METIS_MATRIX_PID) -ErrorAction Stop }
  catch { 'QUERY_PROCESS_LOOKUP_FAILED'; return }
  if ($p.HasExited) { 'PROCESS_EXITED' }
  elseif ($p.MainWindowHandle -eq 0) { 'NO_MAIN_WINDOW' }
  elseif ($p.MainWindowTitle -eq 'Métis') { 'NORMAL_TITLE' }
  elseif ($p.MainWindowTitle -match '^(?:A JavaScript error occurred in the main process|Error)$') { 'ERROR_TITLE' }
  else { 'OTHER_TITLE' }
`

export async function queryWindowStatus(childPid, runShell = execFileAsync, systemRoot = process.env.SystemRoot) {
  if (typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot) || /[\r\n\0]/.test(systemRoot)) {
    return 'QUERY_SHELL_PATH_INVALID'
  }
  try {
    const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await runShell(powershell, ['-NoProfile', '-NonInteractive', '-Command', WINDOW_QUERY], {
      env: { SystemRoot: systemRoot, METIS_MATRIX_PID: String(childPid) },
      timeout: 2_500,
      maxBuffer: 1_024,
      windowsHide: true
    })
    const status = stdout.trim()
    return WINDOW_QUERY_RESULT.has(status) || status === 'PROCESS_EXITED' ? status : 'QUERY_OUTPUT_INVALID'
  } catch (error) {
    if (error?.killed === true || error?.code === 'ETIMEDOUT') return 'QUERY_TIMEOUT'
    if (error?.code === 'ENOENT') return 'QUERY_SHELL_MISSING'
    return 'QUERY_SHELL_FAILED'
  }
}

/** A title/handle query starts after the timed snapshot and can never become an on-time assertion. */
export async function sampleWindowAfterDeadline(launch, query = queryWindowStatus) {
  if (childExited(launch)) return 'EXITED_BEFORE_QUERY'
  const status = await query(launch.child.pid)
  if (childExited(launch) || status === 'PROCESS_EXITED') return 'EXITED_DURING_QUERY'
  return WINDOW_QUERY_RESULT.has(status) ? `POST_DEADLINE_${status}` : 'POST_DEADLINE_QUERY_OUTPUT_INVALID'
}

async function waitUntil(deadline) {
  const remaining = deadline - performance.now()
  if (remaining > 0) await new Promise((resolveSleep) => setTimeout(resolveSleep, remaining))
}

function auditStatus(audit) {
  try {
    return audit.read() ? 'READY' : 'NOT_OBSERVED'
  } catch {
    return 'INVALID'
  }
}

function retain(state, result) {
  state.transportUncertain ||= result?.transportUncertain === true
  if (typeof result?.lateRelease === 'function') state.lateReleases.push(result.lateRelease)
  if (result?.browser) state.browser = result.browser
  if (result?.inspector) state.inspector = result.inspector
}

async function runVariant(target, provenance, environment) {
  const paths = createProfile()
  const audit = createAuditMonitor(paths.userData)
  let lag = null
  const state = { browser: null, inspector: null, transportUncertain: false, lateReleases: [] }
  let launch = null
  let firstObserver = null
  let lateObserver = null
  let sample15 = null
  let sample45 = null
  let result = null
  let failure = false
  let inspectorStage = 'NO_STAGE'
  const markInspector = (stage) => {
    const next = INSPECTOR_STAGE.has(stage) ? stage : 'UNEXPECTED_STAGE'
    if (INSPECTOR_STAGE_RANK[next] > INSPECTOR_STAGE_RANK[inspectorStage]) inspectorStage = next
  }
  try {
    const env =
      environment === 'STRICT'
        ? strictLaunchEnvironment(process.env, paths, 'win32')
        : osSupersetLaunchEnvironment(process.env, paths)
    const cdpPort = await boundedCall(() => freeLoopbackPort(), FIRST_MS, 'port-budget')
    const inspectPort = await boundedCall(() => freeLoopbackPort(), FIRST_MS, 'port-budget')
    if (cdpPort === inspectPort) throw new Error('port-collision')
    launch = launchPackagedCdp({ executablePath: target.executable, env, cdpPort, inspectPort, platform: 'win32' })
    const pid = launch.child?.pid
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || childExited(launch)) {
      throw new Error('child-receipt-invalid')
    }
    lag = lagMonitor()
    const started = performance.now()
    const firstDeadline = started + FIRST_MS
    const finalDeadline = started + FINAL_MS
    firstObserver = observeLoopbackProtocols({ cdpPort, inspectPort, deadline: firstDeadline })
    sample15 = waitUntil(firstDeadline).then(async () => {
      const shape = firstObserver.cancel()
      const cdpHttp = firstObserver.cdpHttpStage()
      lateObserver = observeLoopbackProtocols({ cdpPort, inspectPort, deadline: finalDeadline })
      const processStatus = childExited(launch) ? 'EXITED' : 'RUNNING'
      const readyStatus = auditStatus(audit)
      const lagStatus = lag.read()
      const inspectorStatus = inspectorStage
      return {
        process: processStatus,
        window_post_deadline: await sampleWindowAfterDeadline(launch),
        audit: readyStatus,
        protocol_shape: shape,
        cdp_http_interval: cdpHttp,
        inspector_attach_stage: inspectorStatus,
        host_loop_lag: lagStatus
      }
    })
    sample45 = waitUntil(finalDeadline).then(async () => {
      const processStatus = childExited(launch) ? 'EXITED' : 'RUNNING'
      const readyStatus = auditStatus(audit)
      const shape = lateObserver?.cancel() ?? 'NOT_OBSERVED'
      const cdpHttp = lateObserver?.cdpHttpStage() ?? 'NO_RESULT'
      const lagStatus = lag.read()
      const inspectorStatus = inspectorStage
      return {
        process: processStatus,
        window_post_deadline: await sampleWindowAfterDeadline(launch),
        audit: readyStatus,
        protocol_shape: shape,
        cdp_http_interval: cdpHttp,
        inspector_attach_stage: inspectorStatus,
        host_loop_lag: lagStatus
      }
    })
    const firstCdp = captureSettledAttachment(
      attachOwnedCdp({
        endpoint: launch.cdpEndpoint,
        childPid: pid,
        timeoutMs: FIRST_MS,
        deadlineMs: firstDeadline
      }),
      () => childExited(launch)
    )
    const firstInspector = captureSettledAttachment(
      attachOwnedMainInspector({
        inspectPort,
        childPid: pid,
        expectedPaths: paths,
        expectedVersion: provenance.version,
        timeoutMs: FIRST_MS,
        onStage: markInspector
      }),
      () => childExited(launch)
    )
    const [cdp15, inspector15] = await Promise.all([firstCdp, firstInspector])
    retain(state, cdp15.value)
    retain(state, inspector15.value)
    let lateCdp = null
    let lateInspector = null
    const remaining = Math.max(0, finalDeadline - performance.now())
    if (remaining > 0 && !childExited(launch)) {
      const tasks = []
      if (!state.browser && !cdp15.value?.transportUncertain) {
        tasks.push(
          captureSettledAttachment(
            attachOwnedCdp({
              endpoint: launch.cdpEndpoint,
              childPid: pid,
              timeoutMs: remaining,
              deadlineMs: finalDeadline
            }),
            () => childExited(launch)
          ).then((receipt) => {
            lateCdp = receipt
            retain(state, receipt.value)
          })
        )
      }
      if (!state.inspector && !inspector15.value?.transportUncertain) {
        tasks.push(
          captureSettledAttachment(
            attachOwnedMainInspector({
              inspectPort,
              childPid: pid,
              expectedPaths: paths,
              expectedVersion: provenance.version,
              timeoutMs: remaining,
              onStage: markInspector
            }),
            () => childExited(launch)
          ).then((receipt) => {
            lateInspector = receipt
            retain(state, receipt.value)
          })
        )
      }
      await Promise.all(tasks)
    }
    const [at15, at45] = await Promise.all([sample15, sample45])
    const cdp15Status = cdpByDeadline(cdp15, null, at15.process, firstDeadline)
    const inspector15Status = inspectorByDeadline(inspector15, null, at15.process, firstDeadline)
    const cdp45Status = cdpByDeadline(cdp15, lateCdp, at45.process, finalDeadline)
    const inspector45Status = inspectorByDeadline(inspector15, lateInspector, at45.process, finalDeadline)
    result = {
      environment,
      cdp_15s: cdp15Status,
      cdp_45s: cdp45Status,
      inspector_15s: inspector15Status,
      inspector_45s: inspector45Status,
      at_15s: at15,
      at_45s: at45,
      teardown: 'UNACKNOWLEDGED',
      transport_release: 'UNCERTAIN'
    }
  } catch {
    failure = true
  } finally {
    if (sample15 || sample45) await Promise.allSettled([sample15, sample45].filter(Boolean))
    firstObserver?.cancel()
    lateObserver?.cancel()
    lag?.close()
    audit.close()
    if (launch?.child) {
      if (childExited(launch)) {
        console.error('::error::windows-cdp-env-matrix: OWNED_CHILD_EXITED_BEFORE_TEARDOWN; no acceptance claim')
      }
      const teardown = await teardownThenDispose({
        child: launch.child,
        stop: stopOwnedChild,
        normalize: normalizeTeardown,
        dispose: () => disposeFreshOnboardingTransports(state, 5_000)
      })
      if (result) {
        result.teardown = teardown.teardown
        result.transport_release = teardown.transportReleased ? 'RELEASED' : 'UNCERTAIN'
      }
      if (teardown.teardown !== 'ACKNOWLEDGED' || !teardown.transportReleased) failure = true
    }
    if (!failure) rmSync(paths.root, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 })
  }
  if (failure || !result) throw new Error('variant-failed')
  return result
}

async function runHosted(app, installer) {
  const runner = process.env.RUNNER_TEMP
  const expectedApp = join(runner ?? '', 'candidate-install', 'Metis.exe')
  const installerPath = resolve(installer)
  if (
    process.platform !== 'win32' ||
    !runner ||
    !isAbsolute(runner) ||
    !isAbsolute(app) ||
    resolve(app) !== resolve(expectedApp) ||
    dirname(installerPath) !== resolve('assets') ||
    basename(installerPath) !== PIN.installerName
  )
    throw new Error('invalid-hosted-input')
  const stat = lstatSync(installerPath)
  if (!stat.isFile() || stat.isSymbolicLink() || (await sha256File(installerPath)) !== PIN.installerSha256) {
    throw new Error('installer-rejected')
  }
  const provenance = JSON.parse(readFileSync(join('provenance', 'provenance.json'), 'utf8'))
  if (
    provenance?.run?.id !== PIN.candidateRun ||
    provenance.commit !== PIN.producerCommit ||
    provenance.version !== PIN.version ||
    !Array.isArray(provenance.builds)
  )
    throw new Error('provenance-rejected')
  const assets = provenance.builds
    .filter((item) => item?.variant === 'win' && Array.isArray(item.assets))
    .flatMap((item) => item.assets)
  const matched = assets.filter((asset) => asset?.name === PIN.installerName && asset.sha256 === PIN.installerSha256)
  if (matched.length !== 1) {
    throw new Error('asset-rejected')
  }
  const { resolveInstallTarget } = await import('./census/lib.mjs')
  const target = resolveInstallTarget(app, 'win32')
  if ((await readPackagedAsarVersion({ target, platform: 'win32' })) !== PIN.version) {
    throw new Error('installed-version-rejected')
  }
  const harnessCommit = process.env.GITHUB_SHA
  if (!HASH40.test(harnessCommit ?? '')) throw new Error('harness-identity-rejected')
  const variants = []
  for (const environment of ['STRICT', 'OS_SUPERSET']) {
    variants.push(await runVariant(target, provenance, environment))
  }
  const report = {
    schema: SCHEMA,
    diagnostic_only: true,
    original_acceptance: 'FAIL_CDP_DEADLINE_8_NOT_RUN',
    identity: {
      candidate_run: PIN.candidateRun,
      installer_sha256: PIN.installerSha256,
      producer_commit: PIN.producerCommit,
      harness_commit: harnessCommit,
      version: PIN.version
    },
    variants
  }
  if (reportProblems(report).length || Buffer.byteLength(JSON.stringify(report)) > MAX_OUTPUT_BYTES) {
    throw new Error('report-rejected')
  }
  // This is the only output. It contains exclusively pinned identity literals and fixed-domain classifications.
  console.log(`windows-cdp-env-matrix: ${JSON.stringify(report)}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--app' || args[2] !== '--installer') {
    console.error('::error::windows-cdp-env-matrix: invalid-command')
    process.exitCode = 1
  } else {
    runHosted(args[1], args[3]).catch(() => {
      console.error('::error::windows-cdp-env-matrix: closed diagnostic failure; original acceptance remains FAIL')
      process.exitCode = 1
    })
  }
}
