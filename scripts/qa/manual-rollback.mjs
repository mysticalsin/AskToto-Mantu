#!/usr/bin/env node
// Hosted, disposable Windows exercise of the documented manual recovery path: install the exact
// 1.9.6 baseline, save one synthetic encrypted meeting, install the exact 1.9.7 candidate over the
// same app root, then reinstall the pinned 1.9.6 Setup and verify the same profile. The macOS row is
// deliberately BLOCKED/NEVER_RUN until unsigned-build Keychain identity continuity is proven.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  attachOwnedCdp,
  freeLoopbackPort,
  launchPackagedCdp,
  ownedCensus,
  killOwned,
  strictLaunchEnvironment
} from './lib/app-driver.mjs'
import { listProcesses, survivors } from './owned-processes.mjs'
import { stopOwnedChild } from './lib/st-1-termination.mjs'
import { directoryProblems, provenanceProblems, sha256File } from './provenance.mjs'

export const BASELINE_RELEASE = 'v1.9.6-unsigned'
export const BASELINE_REPOSITORY = 'mysticalsin/Metis-Releases'
export const BASELINE_WINDOWS_INSTALLER = 'Metis-Setup-1.9.6.exe'
export const BASELINE_WINDOWS_SHA256 = '77a532f3c33a0be6f9315e7e0df02c2420c25a297e90c5fa6baff18f84193df8'
export const BASELINE_MACOS_INSTALLER = 'Metis-1.9.6.dmg'
export const BASELINE_MACOS_SHA256 = '1687e2ca89e8db14840ded63c20e0812ceadb544e0169e1efa92bef77eddb0e4'
export const TARGET_VERSION = '1.9.7'
export const RECOVERY_ROWS = Object.freeze([
  'candidate-run-provenance',
  'baseline-release-installer',
  'baseline-encrypted-profile',
  'candidate-upgrade-readback',
  'manual-baseline-reinstall',
  'rollback-encrypted-profile-readback',
  'cleanup'
])

const REPOSITORY = 'mysticalsin/AskToto-Mantu'
const REPOSITORY_ID = 1282463398
const WORKFLOW_PATH = '.github/workflows/qa-candidate.yml'
const RUN_ID = /^[1-9]\d*$/
const HASH40 = /^[a-f0-9]{40}$/
const HASH64 = /^[a-f0-9]{64}$/
const ENCRYPTED_MEETING_MARKER = Buffer.from('ATKENC2\n', 'utf8')
const ENCRYPTED_SETTINGS_MARKER = Buffer.from('ATKENC1\n', 'utf8')
const SYNTHETIC_TITLE = 'Synthetic rollback meeting'
const SYNTHETIC_RECAP =
  '## Overview\nSynthetic QA note for manual rollback validation.\n\n' +
  '## Decisions\n- Preserve this disposable encrypted profile.\n\n' +
  '## Action items\n- Verify the manual recovery path.'
const SYNTHETIC_LINES = Object.freeze([
  Object.freeze({
    speaker: 'them',
    text: 'Synthetic transcript marker for recovery validation.',
    t: 1_800_000_000_000
  }),
  Object.freeze({
    speaker: 'you',
    text: 'The disposable profile remains available after reinstall.',
    t: 1_800_000_001_000
  })
])

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) =>
  plain(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isPositive = (value) => Number.isSafeInteger(value) && value > 0
const inside = (root, path) => {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

const MACOS_BLOCK_REASON = 'unsigned-keychain-identity'
const MACOS_UNBLOCK =
  'Resolve and independently verify safeStorage/Keychain identity continuity for exact unsigned ' +
  '1.9.7-to-1.9.6 DMG reinstall on a disposable hosted Mac; confirm existing encrypted data remains ' +
  'readable or provide an explicit recovery path.'

/**
 * @typedef {{
 *   run_id: number,
 *   attempt: number,
 *   commit: string,
 *   version: string,
 *   windows_installer_sha256: string,
 *   macos_dmg_sha256: string
 * }} ManualRollbackIdentity
 */
/** @typedef {{ id: string, status: string, code: string | null }} ManualRollbackRow */

/** Return stable, content-free failure codes for candidate run + provenance binding. */
export function candidateBindingProblems(run, provenance, input) {
  const problems = []
  const runId = Number(input?.runId)
  const attempt = Number(input?.attempt)
  const requestedSha = String(input?.sha256 ?? '').toLowerCase()
  const workflowPath = String(run?.path ?? '').replace(/@.*$/, '')
  if (!isPositive(runId) || run?.id !== runId) problems.push('run-id-mismatch')
  if (!isPositive(attempt) || run?.run_attempt !== attempt) problems.push('run-attempt-mismatch')
  if (workflowPath !== WORKFLOW_PATH || run?.name !== 'QA candidate') problems.push('run-workflow-mismatch')
  if (run?.event !== 'workflow_dispatch' || run?.head_branch !== 'main') problems.push('run-ref-mismatch')
  if (run?.status !== 'completed' || run?.conclusion !== 'success') problems.push('run-not-successful')
  if (!HASH40.test(run?.head_sha ?? '')) problems.push('run-commit-invalid')
  if (
    run?.repository?.id !== REPOSITORY_ID ||
    run.repository.full_name !== REPOSITORY ||
    run?.head_repository?.id !== REPOSITORY_ID ||
    run.head_repository.full_name !== REPOSITORY
  ) {
    problems.push('run-repository-mismatch')
  }
  if (!HASH64.test(requestedSha)) problems.push('candidate-sha-invalid')
  if (provenanceProblems(provenance).length > 0) problems.push('candidate-provenance-invalid')
  if (
    provenance?.schema !== 2 ||
    provenance?.repository !== REPOSITORY ||
    provenance?.run?.id !== runId ||
    provenance?.run?.attempt !== attempt ||
    provenance?.commit !== run?.head_sha ||
    provenance?.version !== TARGET_VERSION
  ) {
    problems.push('candidate-provenance-mismatch')
  }

  const winBuilds = Array.isArray(provenance?.builds)
    ? provenance.builds.filter((build) => build?.variant === 'win')
    : []
  const winAsset = winBuilds[0]?.assets?.length === 1 ? winBuilds[0].assets[0] : null
  if (
    winBuilds.length !== 1 ||
    winBuilds[0]?.artifact !== 'candidate-win' ||
    winBuilds[0]?.platform !== 'win' ||
    winAsset?.name !== `Metis-Setup-${TARGET_VERSION}.exe` ||
    winAsset?.sha256 !== requestedSha ||
    !isPositive(winAsset?.size)
  ) {
    problems.push('candidate-windows-asset-mismatch')
  }

  const macBuilds = Array.isArray(provenance?.builds)
    ? provenance.builds.filter((build) => build?.variant === 'mac')
    : []
  const macAssets = macBuilds[0]?.assets
  if (
    macBuilds.length !== 1 ||
    macBuilds[0]?.artifact !== 'candidate-mac' ||
    macBuilds[0]?.platform !== 'mac' ||
    !Array.isArray(macAssets) ||
    macAssets.length !== 2 ||
    macAssets.filter((asset) => asset?.name === `Metis-${TARGET_VERSION}.dmg`).length !== 1 ||
    macAssets.filter((asset) => asset?.name === `Metis-${TARGET_VERSION}.zip`).length !== 1 ||
    macAssets.some((asset) => !HASH64.test(asset?.sha256 ?? '') || !isPositive(asset?.size))
  ) {
    problems.push('candidate-macos-provenance-mismatch')
  }
  return problems
}

function candidateIdentity(run, provenance, sha256Value) {
  const macBuild = provenance.builds.find((build) => build.variant === 'mac')
  const macAsset = macBuild.assets.find((asset) => asset.name === `Metis-${TARGET_VERSION}.dmg`)
  return {
    run_id: run.id,
    attempt: run.run_attempt,
    commit: run.head_sha,
    version: provenance.version,
    windows_installer_sha256: sha256Value,
    macos_dmg_sha256: macAsset.sha256
  }
}

/** Pin both the public checksum manifest entry and the downloaded bytes to the observed release digest. */
export function baselineReleaseProblems(installerBytes, sumsText) {
  const problems = []
  if (!Buffer.isBuffer(installerBytes) || sha256(installerBytes) !== BASELINE_WINDOWS_SHA256) {
    problems.push('baseline-installer-digest-mismatch')
  }
  problems.push(...baselineChecksumProblems(sumsText))
  return problems
}

export function baselineChecksumProblems(sumsText) {
  const problems = []
  const lines = String(sumsText ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
  const entries = lines.flatMap((line) => {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    return match ? [{ sha256: match[1], name: match[2] }] : []
  })
  const pinned = entries.filter((entry) => entry.name === BASELINE_WINDOWS_INSTALLER)
  if (pinned.length !== 1 || pinned[0].sha256 !== BASELINE_WINDOWS_SHA256) {
    problems.push('baseline-checksum-manifest-mismatch')
  }
  return problems
}

/** @param {ManualRollbackIdentity | null} identity */
export function createManualRollbackReport(identity = null) {
  /** @type {ManualRollbackRow[]} */
  const rows = RECOVERY_ROWS.map((id) => ({ id, status: 'NOT_RUN', code: 'not-run' }))
  return {
    schema: 'metis.manual-rollback.v1',
    outcome: 'FAIL',
    identity,
    rows,
    windows: {
      status: 'NOT_RUN',
      baseline_installer: BASELINE_WINDOWS_INSTALLER,
      candidate_installer: `Metis-Setup-${TARGET_VERSION}.exe`,
      baseline_installer_sha256: BASELINE_WINDOWS_SHA256,
      candidate_installer_sha256: identity?.windows_installer_sha256 ?? null,
      phases: {
        baseline: {
          version: null,
          settings_encrypted: false,
          settings_verified: false,
          meeting_encrypted: false,
          meeting_verified: false,
          notes_verified: false,
          history_verified: false
        },
        candidate: {
          version: null,
          settings_encrypted: false,
          settings_verified: false,
          meeting_encrypted: false,
          meeting_verified: false,
          notes_verified: false,
          history_verified: false
        },
        rollback: {
          version: null,
          settings_encrypted: false,
          settings_verified: false,
          meeting_encrypted: false,
          meeting_verified: false,
          notes_verified: false,
          history_verified: false
        }
      },
      meeting_count: 0,
      exact_meeting_bytes_preserved: false
    },
    macos: {
      status: 'BLOCKED',
      execution: 'NEVER_RUN',
      attempted: false,
      candidate_dmg: `Metis-${TARGET_VERSION}.dmg`,
      baseline_dmg: BASELINE_MACOS_INSTALLER,
      candidate_dmg_sha256: identity?.macos_dmg_sha256 ?? null,
      baseline_dmg_sha256: BASELINE_MACOS_SHA256,
      candidate_bytes_verified: false,
      baseline_bytes_verified: false,
      reason: MACOS_BLOCK_REASON,
      unblock: MACOS_UNBLOCK
    },
    cleanup: {
      status: 'NOT_ACKNOWLEDGED',
      isolated_profile_removed: false,
      install_root_removed: false,
      input_staging_removed: false,
      attachment_released: false,
      owned_processes_gone: false
    }
  }
}

const PHASE_KEYS = [
  'version',
  'settings_encrypted',
  'settings_verified',
  'meeting_encrypted',
  'meeting_verified',
  'notes_verified',
  'history_verified'
]

/** Strict report validator used after the runner (including when its exit code was zero). */
export function manualRollbackReportProblems(report, expected = {}) {
  const problems = []
  if (!exact(report, ['schema', 'outcome', 'identity', 'rows', 'windows', 'macos', 'cleanup'])) {
    return ['report-shape-invalid']
  }
  if (report.schema !== 'metis.manual-rollback.v1') problems.push('report-schema-invalid')
  if (
    !exact(report.identity, ['run_id', 'attempt', 'commit', 'version', 'windows_installer_sha256', 'macos_dmg_sha256'])
  ) {
    problems.push('identity-shape-invalid')
  } else {
    if (!isPositive(report.identity.run_id) || report.identity.run_id !== Number(expected.runId)) {
      problems.push('identity-run-mismatch')
    }
    if (!isPositive(report.identity.attempt) || report.identity.attempt !== Number(expected.attempt)) {
      problems.push('identity-attempt-mismatch')
    }
    if (!HASH40.test(report.identity.commit)) problems.push('identity-commit-invalid')
    if (report.identity.version !== TARGET_VERSION) problems.push('identity-version-mismatch')
    if (report.identity.windows_installer_sha256 !== String(expected.sha256 ?? '').toLowerCase()) {
      problems.push('identity-windows-sha-mismatch')
    }
    if (!HASH64.test(report.identity.macos_dmg_sha256)) problems.push('identity-macos-sha-invalid')
  }
  if (!Array.isArray(report.rows) || report.rows.length !== RECOVERY_ROWS.length) {
    problems.push('rows-incomplete')
  } else {
    const ids = report.rows.map((row) => row?.id)
    if (JSON.stringify(ids) !== JSON.stringify(RECOVERY_ROWS)) problems.push('rows-order-or-identity-invalid')
    for (const row of report.rows) {
      if (!exact(row, ['id', 'status', 'code'])) {
        problems.push('row-shape-invalid')
        continue
      }
      if (row.status !== 'PASS' || row.code !== null) problems.push(`row-not-passing:${row.id}`)
    }
  }
  if (
    !exact(report.windows, [
      'status',
      'baseline_installer',
      'candidate_installer',
      'baseline_installer_sha256',
      'candidate_installer_sha256',
      'phases',
      'meeting_count',
      'exact_meeting_bytes_preserved'
    ])
  ) {
    problems.push('windows-shape-invalid')
  } else {
    if (report.windows.status !== 'PASS') problems.push('windows-not-passing')
    if (report.windows.baseline_installer !== BASELINE_WINDOWS_INSTALLER) {
      problems.push('windows-baseline-name-mismatch')
    }
    if (report.windows.candidate_installer !== `Metis-Setup-${TARGET_VERSION}.exe`) {
      problems.push('windows-candidate-name-mismatch')
    }
    if (report.windows.baseline_installer_sha256 !== BASELINE_WINDOWS_SHA256) {
      problems.push('windows-baseline-sha-mismatch')
    }
    if (report.windows.candidate_installer_sha256 !== String(expected.sha256 ?? '').toLowerCase()) {
      problems.push('windows-candidate-sha-mismatch')
    }
    if (report.windows.meeting_count !== 1 || report.windows.exact_meeting_bytes_preserved !== true) {
      problems.push('windows-data-preservation-failed')
    }
    if (!exact(report.windows.phases, ['baseline', 'candidate', 'rollback'])) {
      problems.push('phase-set-invalid')
    } else {
      for (const [name, phase] of Object.entries(report.windows.phases)) {
        if (!exact(phase, PHASE_KEYS)) {
          problems.push(`phase-shape-invalid:${name}`)
          continue
        }
        const expectedVersion = name === 'candidate' ? TARGET_VERSION : '1.9.6'
        if (
          phase.version !== expectedVersion ||
          phase.settings_encrypted !== true ||
          phase.settings_verified !== true ||
          phase.meeting_encrypted !== true ||
          phase.meeting_verified !== true ||
          phase.notes_verified !== true ||
          phase.history_verified !== true
        ) {
          problems.push(`phase-not-verified:${name}`)
        }
      }
    }
  }
  if (
    !exact(report.macos, [
      'status',
      'execution',
      'attempted',
      'candidate_dmg',
      'baseline_dmg',
      'candidate_dmg_sha256',
      'baseline_dmg_sha256',
      'candidate_bytes_verified',
      'baseline_bytes_verified',
      'reason',
      'unblock'
    ])
  ) {
    problems.push('macos-shape-invalid')
  } else if (
    report.macos.status !== 'BLOCKED' ||
    report.macos.execution !== 'NEVER_RUN' ||
    report.macos.attempted !== false ||
    report.macos.candidate_dmg !== `Metis-${TARGET_VERSION}.dmg` ||
    report.macos.baseline_dmg !== BASELINE_MACOS_INSTALLER ||
    report.macos.candidate_dmg_sha256 !== report.identity?.macos_dmg_sha256 ||
    report.macos.baseline_dmg_sha256 !== BASELINE_MACOS_SHA256 ||
    report.macos.candidate_bytes_verified !== false ||
    report.macos.baseline_bytes_verified !== false ||
    report.macos.reason !== MACOS_BLOCK_REASON ||
    report.macos.unblock !== MACOS_UNBLOCK
  ) {
    problems.push('macos-blocker-not-explicit')
  }
  if (
    !exact(report.cleanup, [
      'status',
      'isolated_profile_removed',
      'install_root_removed',
      'input_staging_removed',
      'attachment_released',
      'owned_processes_gone'
    ])
  ) {
    problems.push('cleanup-shape-invalid')
  } else if (
    report.cleanup.status !== 'ACKNOWLEDGED' ||
    report.cleanup.isolated_profile_removed !== true ||
    report.cleanup.install_root_removed !== true ||
    report.cleanup.input_staging_removed !== true ||
    report.cleanup.attachment_released !== true ||
    report.cleanup.owned_processes_gone !== true
  ) {
    problems.push('cleanup-unacknowledged')
  }
  if (report.outcome !== 'PARTIAL_BLOCKED') problems.push('outcome-not-explicit-partial')
  return problems
}

function recordRow(report, id, status, code = null) {
  const row = report.rows.find((item) => item.id === id)
  if (row) Object.assign(row, { status, code })
}

export function markExecutionFailure(report, id, code) {
  recordRow(report, id, 'FAIL', code)
}

export function cleanShutdownAcknowledged({
  quitRequested,
  transportClosed,
  attachmentReleased,
  exitCode,
  signal,
  forcedTermination,
  survivors
}) {
  return (
    quitRequested === true &&
    transportClosed === true &&
    attachmentReleased === true &&
    exitCode === 0 &&
    signal === null &&
    forcedTermination !== true &&
    survivors === 0
  )
}

export function finalizeManualRollbackResult(report, executionFailed) {
  report.windows.status =
    !executionFailed && report.rows.every((row) => row.status === 'PASS') && report.cleanup.status === 'ACKNOWLEDGED'
      ? 'PASS'
      : 'FAIL'
  report.outcome = report.windows.status === 'PASS' ? 'PARTIAL_BLOCKED' : 'FAIL'
  return report.windows.status
}

function failureCode(error) {
  const code = error?.code
  return typeof code === 'string' && /^[a-z0-9-]{1,64}$/.test(code) ? code : 'runner-failed'
}

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail('input-json-invalid')
  }
}

function requireStagedPath(inputRoot, path, kind) {
  const stagedPath = resolve(path)
  if (!inside(inputRoot, stagedPath) || stagedPath === inputRoot) fail('input-outside-staging')
  let stat
  try {
    stat = lstatSync(stagedPath)
  } catch {
    fail('input-missing')
  }
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) fail('input-kind-invalid')
  return stagedPath
}

async function verifySummedAsset(installerPath, sumsPath) {
  let sumsText
  try {
    const stats = lstatSync(installerPath)
    if (!stats.isFile() || stats.isSymbolicLink()) fail('baseline-installer-invalid')
    sumsText = readFileSync(sumsPath, 'utf8')
  } catch {
    fail('baseline-input-missing')
  }
  const problems = baselineChecksumProblems(sumsText)
  if (problems.length) fail(problems[0])
  if (basename(installerPath) !== BASELINE_WINDOWS_INSTALLER) fail('baseline-name-mismatch')
  const digest = await sha256File(installerPath)
  if (digest !== BASELINE_WINDOWS_SHA256) fail('baseline-installer-digest-mismatch')
  return digest
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveExit) => {
    let settled = false
    const finish = (answer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolveExit(answer)
    }
    const onExit = (code, signal) => finish({ code, signal })
    const timer = setTimeout(() => finish(null), timeoutMs)
    child.once('exit', onExit)
  })
}

function installSetup(installer, target) {
  return new Promise((resolveInstall) => {
    let settled = false
    const child = spawn(installer, ['/S', `/D=${target}`], { stdio: 'ignore', windowsHide: true })
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveInstall(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* installer is already gone */
      }
      finish({ code: null, timedOut: true })
    }, 120_000)
    child.once('error', () => finish({ code: null, timedOut: false }))
    child.once('exit', (code) => finish({ code, timedOut: false }))
  })
}

function seedUserData(userData, meetingsFolder) {
  mkdirSync(userData, { recursive: true })
  mkdirSync(meetingsFolder, { recursive: true })
  const settings = {
    onboardingDone: true,
    onboardingDoneAt: Date.now(),
    recordingConsent: true,
    meetingsFolder,
    encryptTranscripts: true,
    autoSaveTranscripts: false,
    overlayLayout: 'bar',
    localLlm: {
      enabled: false,
      modelId: 'qwen3.5-0.8b',
      useFor: { suggest: false, summary: false, vision: false },
      fallback: false
    },
    brainConsolidation: { enabled: false, maxPassesPerDay: 1 },
    speakerId: { enabled: false, saveVoiceprints: false }
  }
  writeFileSync(join(userData, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
}

function launchEnvironment(home, userData) {
  const paths = {
    root: home,
    home,
    userProfile: home,
    appData: join(home, 'appdata'),
    localAppData: join(home, 'localappdata'),
    temp: join(home, 'temp'),
    userData
  }
  for (const path of [paths.appData, paths.localAppData, paths.temp, userData]) mkdirSync(path, { recursive: true })
  return strictLaunchEnvironment(process.env, paths, 'win32')
}

function auditEvents(userData) {
  try {
    return readFileSync(join(userData, 'logs', 'audit.log'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line)
          return plain(record) ? [record] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

async function waitForBridge(browser, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages())
    for (const page of pages) {
      try {
        if (await page.evaluate(() => typeof window.toto?.getSettings === 'function')) return page
      } catch {
        /* renderer is still initializing */
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  fail('renderer-bridge-timeout')
}

async function releaseAttachment(attachment, timeoutMs = 5_000) {
  if (!attachment) return true
  if (attachment.transportUncertain === true && typeof attachment.lateRelease !== 'function') return false
  if (attachment.lateRelease == null) return attachment.transportUncertain !== true
  if (typeof attachment.lateRelease !== 'function') return false
  try {
    return (await attachment.lateRelease(timeoutMs)) === true
  } catch {
    return false
  }
}

export function createAttachmentReceipt(attachment) {
  return {
    attachment,
    transportClosed: attachment !== null && attachment?.browser == null && attachment?.transportUncertain !== true,
    released: false
  }
}

export function markAttachmentTransportClosed(receipt, closed) {
  if (!receipt || typeof receipt !== 'object') return false
  receipt.transportClosed = closed === true
  return receipt.transportClosed
}

export async function releaseAttachmentReceipt(receipt, timeoutMs = 5_000) {
  if (!receipt || typeof receipt !== 'object') return false
  if (receipt.released === true) return true
  if (receipt.transportClosed !== true) {
    if (!receipt.attachment) return false
    if (receipt.attachment?.browser != null) return false
    if (!(await releaseAttachment(receipt.attachment, timeoutMs))) return false
    receipt.transportClosed = true
    receipt.released = true
    return true
  }
  const released = await releaseAttachment(receipt.attachment, timeoutMs)
  if (released) receipt.released = true
  return released
}

async function openPackagedApp(exe, env, installRoot, userData, registry, attachmentReceipts) {
  const cdpPort = await freeLoopbackPort()
  const inspectPort = await freeLoopbackPort()
  if (cdpPort === inspectPort) fail('port-collision')
  const launched = launchPackagedCdp({ executablePath: exe, env, cdpPort, inspectPort, platform: 'win32' })
  let browser = null
  let attachment = null
  let attachmentReceipt = null
  try {
    try {
      rememberOwnedProcesses(registry, launched.child.pid, installRoot)
    } catch {
      fail('owned-process-census-unavailable')
    }
    attachmentReceipt = createAttachmentReceipt(null)
    attachmentReceipts.push(attachmentReceipt)
    attachment = await attachOwnedCdp({
      endpoint: launched.cdpEndpoint,
      childPid: launched.child.pid,
      timeoutMs: 90_000
    })
    attachmentReceipt.attachment = attachment
    attachmentReceipt.transportClosed = attachment.browser == null && attachment.transportUncertain !== true
    if (attachment.transportUncertain === true || !attachment.browser || attachment.failure) {
      fail('app-attach-failed')
    }
    browser = attachment.browser
    const page = await waitForBridge(browser)
    const events = auditEvents(userData)
    const started = events.filter((event) => event.event === 'app.started').at(-1)
    if (started?.version !== '1.9.6' && started?.version !== TARGET_VERSION) fail('app-version-unobserved')
    return {
      child: launched.child,
      browser,
      page,
      installRoot,
      userData,
      version: started.version,
      attachmentReceipt
    }
  } catch (error) {
    let transportClosed = true
    if (browser) {
      try {
        transportClosed = (await browser.close()) !== false
      } catch {
        transportClosed = false
      }
    }
    if (attachmentReceipt && attachment) {
      markAttachmentTransportClosed(attachmentReceipt, transportClosed)
    }
    const attachmentReleased = attachmentReceipt
      ? await releaseAttachmentReceipt(attachmentReceipt)
      : await releaseAttachment(attachment)
    let exit = await waitForChildExit(launched.child, 250)
    if (!exit) {
      const receipt = await stopOwnedChild(launched.child, { platform: 'win32', timeoutMs: 5_000 })
      if (receipt.state !== 'acknowledged') fail('app-teardown-unacknowledged')
      exit = await waitForChildExit(launched.child, 5_000)
    }
    if (!transportClosed || !attachmentReleased || !exit) fail('app-teardown-unacknowledged')
    throw error
  }
}

function rememberOwnedProcesses(registry, mainPid, installRoot) {
  const owned = ownedCensus({ platform: 'win32', mainPid, installRoot }).owned
  for (const entry of owned) registry.set(`${entry.pid}:${entry.startedMs}`, entry)
  return owned
}

function currentOwnedSurvivors(registry, installRoot) {
  return survivors([...registry.values()], listProcesses('win32'), { installRoot, platform: 'win32' })
}

async function stopPackagedApp(session, registry) {
  try {
    rememberOwnedProcesses(registry, session.child.pid, session.installRoot)
  } catch {
    fail('owned-process-census-unavailable')
  }
  let quitRequested = false
  let transportClosed = false
  try {
    await session.page.evaluate(() => window.toto.quit())
    quitRequested = true
  } catch {
    /* A failed renderer path is handled by the owned-process stop below. */
  }
  try {
    rememberOwnedProcesses(registry, session.child.pid, session.installRoot)
  } catch {
    fail('owned-process-census-unavailable')
  }
  try {
    transportClosed = (await session.browser.close()) !== false
  } catch {
    transportClosed = false
  }
  markAttachmentTransportClosed(session.attachmentReceipt, transportClosed)
  let exit = await waitForChildExit(session.child, 30_000)
  let forcedTermination = false
  if (!exit) {
    forcedTermination = true
    const receipt = await stopOwnedChild(session.child, { platform: 'win32', timeoutMs: 5_000 })
    if (receipt.state !== 'acknowledged') fail('app-teardown-unacknowledged')
    exit = await waitForChildExit(session.child, 5_000)
  }
  let remaining = []
  try {
    rememberOwnedProcesses(registry, session.child.pid, session.installRoot)
    remaining = currentOwnedSurvivors(registry, session.installRoot)
  } catch {
    fail('owned-process-census-unavailable')
  }
  if (remaining.length) {
    forcedTermination = true
    killOwned(remaining)
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      try {
        rememberOwnedProcesses(registry, session.child.pid, session.installRoot)
        remaining = currentOwnedSurvivors(registry, session.installRoot)
      } catch {
        fail('owned-process-census-unavailable')
      }
      if (!remaining.length) break
    }
  }
  const attachmentReleased = await releaseAttachmentReceipt(session.attachmentReceipt)
  if (
    !cleanShutdownAcknowledged({
      quitRequested,
      transportClosed,
      attachmentReleased,
      exitCode: exit?.code,
      signal: exit?.signal,
      forcedTermination,
      survivors: remaining.length
    })
  ) {
    fail('app-teardown-unacknowledged')
  }
  return true
}

function verifyEncryptedSettings(userData) {
  try {
    return readFileSync(join(userData, 'settings.json'))
      .subarray(0, ENCRYPTED_SETTINGS_MARKER.length)
      .equals(ENCRYPTED_SETTINGS_MARKER)
  } catch {
    return false
  }
}

function readMeetingBytes(meetingsFolder, file) {
  const name = basename(String(file ?? ''))
  if (!name.endsWith('.md') || name !== file) fail('meeting-name-invalid')
  const path = join(meetingsFolder, name)
  const bytes = readFileSync(path)
  if (!bytes.subarray(0, ENCRYPTED_MEETING_MARKER.length).equals(ENCRYPTED_MEETING_MARKER)) {
    fail('meeting-not-encrypted')
  }
  return { name, bytes, sha256: sha256(bytes) }
}

async function verifyApplicationState(session, { meetingsFolder, userData, file, expectedHash = null }) {
  const state = await session.page.evaluate(async (meetingFile) => {
    const settings = await window.toto.getSettings()
    const history = await window.toto.recallList()
    const meeting = await window.toto.recallRead(meetingFile)
    return {
      settings: {
        onboardingDone: settings.onboardingDone,
        recordingConsent: settings.recordingConsent,
        encryptTranscripts: settings.encryptTranscripts,
        meetingsFolder: settings.meetingsFolder,
        autoSaveTranscripts: settings.autoSaveTranscripts
      },
      history: Array.isArray(history)
        ? history.map((row) => ({ file: row.file, title: row.title, locked: row.locked === true }))
        : null,
      meeting:
        meeting && typeof meeting === 'object'
          ? {
              ok: meeting.ok === true,
              title: meeting.title,
              recap: meeting.recap,
              lines: Array.isArray(meeting.lines) ? meeting.lines.map((line) => line.text) : null
            }
          : null
    }
  }, file)
  if (
    state?.settings?.onboardingDone !== true ||
    state.settings.recordingConsent !== true ||
    state.settings.encryptTranscripts !== true ||
    state.settings.meetingsFolder !== meetingsFolder ||
    state.settings.autoSaveTranscripts !== false
  ) {
    fail('settings-readback-failed')
  }
  if (!verifyEncryptedSettings(userData)) fail('settings-not-encrypted')
  const meetingBytes = readMeetingBytes(meetingsFolder, file)
  if (expectedHash && meetingBytes.sha256 !== expectedHash) fail('meeting-bytes-changed')
  const matchingHistory = Array.isArray(state.history)
    ? state.history.filter((row) => row.file === file && row.title === SYNTHETIC_TITLE && row.locked !== true)
    : []
  if (state.history?.length !== 1 || matchingHistory.length !== 1) fail('history-readback-failed')
  const hasNotes =
    state.meeting?.ok === true &&
    state.meeting.title === SYNTHETIC_TITLE &&
    typeof state.meeting.recap === 'string' &&
    state.meeting.recap.includes('Synthetic QA note for manual rollback validation.')
  const hasTranscript =
    Array.isArray(state.meeting?.lines) &&
    state.meeting.lines.length === SYNTHETIC_LINES.length &&
    state.meeting.lines[0] === SYNTHETIC_LINES[0].text &&
    state.meeting.lines[1] === SYNTHETIC_LINES[1].text
  if (!hasNotes || !hasTranscript) fail('meeting-readback-failed')
  return { settings: true, notes: true, history: true, meeting: true, meetingHash: meetingBytes.sha256 }
}

function markPhase(report, phase, version, verification) {
  report.windows.phases[phase] = {
    version,
    settings_encrypted: true,
    settings_verified: verification.settings,
    meeting_encrypted: true,
    meeting_verified: verification.meeting,
    notes_verified: verification.notes,
    history_verified: verification.history
  }
}

function workspacePaths(root) {
  const profile = join(root, 'profile')
  const userData = join(profile, 'user-data')
  const meetingsFolder = join(profile, 'meetings')
  const home = join(profile, 'windows-home')
  const installRoot = join(root, 'install')
  return { profile, userData, meetingsFolder, home, installRoot }
}

async function runManualRollback(args) {
  const inputRoot = resolve(args.inputRoot)
  const outputPath = resolve(args.output)
  const runnerTempValue = process.env.RUNNER_TEMP
  const runnerTemp = runnerTempValue ? resolve(runnerTempValue) : ''
  if (
    process.platform !== 'win32' ||
    process.env.CI !== 'true' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_OS !== 'Windows' ||
    !runnerTemp ||
    !inside(runnerTemp, inputRoot) ||
    inside(inputRoot, outputPath)
  ) {
    fail('hosted-isolation-precondition')
  }
  const report = createManualRollbackReport()
  let isolatedRoot = null
  let appSession = null
  const ownedProcessRegistry = new Map()
  const attachmentReceipts = []
  let executionFailed = false
  let installRootRemoved = false
  let profileRemoved = false
  let inputRemoved = false
  let ownedProcessesGone = false
  let meetingFile = null
  let initialMeetingHash = null
  let inputCleanupAllowed = inside(runnerTemp, inputRoot)
  let activeRow = 'candidate-run-provenance'

  try {
    requireStagedPath(inputRoot, args.runMetadata, 'file')
    requireStagedPath(inputRoot, args.provenance, 'file')
    const run = readJson(args.runMetadata)
    const provenance = readJson(args.provenance)
    const problems = candidateBindingProblems(run, provenance, args)
    if (problems.length) fail(problems[0])
    report.identity = candidateIdentity(run, provenance, String(args.sha256).toLowerCase())
    report.windows.candidate_installer_sha256 = report.identity.windows_installer_sha256
    report.macos.candidate_dmg_sha256 = report.identity.macos_dmg_sha256

    requireStagedPath(inputRoot, args.candidateDir, 'directory')
    requireStagedPath(inputRoot, args.candidateInstaller, 'file')
    requireStagedPath(inputRoot, args.baselineInstaller, 'file')
    requireStagedPath(inputRoot, args.baselineSums, 'file')
    const candidateIssues = await directoryProblems(provenance, args.candidateDir, ['win'])
    if (candidateIssues.length) fail('candidate-artifact-mismatch')
    const winAsset = provenance.builds.find((build) => build.variant === 'win').assets[0]
    if (
      basename(args.candidateInstaller) !== winAsset.name ||
      (await sha256File(args.candidateInstaller)) !== args.sha256.toLowerCase()
    ) {
      fail('candidate-installer-digest-mismatch')
    }
    const candidateStat = lstatSync(args.candidateInstaller)
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink() || candidateStat.size !== winAsset.size) {
      fail('candidate-installer-invalid')
    }
    recordRow(report, 'candidate-run-provenance', 'PASS')

    activeRow = 'baseline-release-installer'
    await verifySummedAsset(args.baselineInstaller, args.baselineSums)
    recordRow(report, 'baseline-release-installer', 'PASS')

    mkdirSync(dirname(outputPath), { recursive: true })
    if (existsSync(outputPath)) fail('output-already-exists')
    isolatedRoot = mkdtempSync(join(runnerTemp, 'metis-manual-rollback-'))
    const paths = workspacePaths(isolatedRoot)
    for (const path of [paths.profile, paths.installRoot]) mkdirSync(path, { recursive: true })
    seedUserData(paths.userData, paths.meetingsFolder)
    const env = launchEnvironment(paths.home, paths.userData)
    const baselineInstall = await installSetup(args.baselineInstaller, paths.installRoot)
    if (baselineInstall.code !== 0 || baselineInstall.timedOut) fail('baseline-install-failed')

    activeRow = 'baseline-encrypted-profile'
    appSession = await openPackagedApp(
      join(paths.installRoot, 'Metis.exe'),
      env,
      paths.installRoot,
      paths.userData,
      ownedProcessRegistry,
      attachmentReceipts
    )
    rememberOwnedProcesses(ownedProcessRegistry, appSession.child.pid, appSession.installRoot)
    if (appSession.version !== '1.9.6') fail('baseline-app-version-mismatch')
    const settingsUpdate = await appSession.page.evaluate(async (meetingsFolder) => {
      const next = await window.toto.setSettings({
        onboardingDone: true,
        recordingConsent: true,
        meetingsFolder,
        encryptTranscripts: true,
        autoSaveTranscripts: false
      })
      return {
        onboardingDone: next.onboardingDone,
        recordingConsent: next.recordingConsent,
        encryptTranscripts: next.encryptTranscripts,
        meetingsFolder: next.meetingsFolder,
        autoSaveTranscripts: next.autoSaveTranscripts
      }
    }, paths.meetingsFolder)
    if (
      settingsUpdate?.onboardingDone !== true ||
      settingsUpdate.recordingConsent !== true ||
      settingsUpdate.encryptTranscripts !== true ||
      settingsUpdate.meetingsFolder !== paths.meetingsFolder ||
      settingsUpdate.autoSaveTranscripts !== false ||
      !verifyEncryptedSettings(paths.userData)
    ) {
      fail('baseline-settings-seed-failed')
    }
    const startedAt = SYNTHETIC_LINES[0].t - 1_000
    const saved = await appSession.page.evaluate(async (meeting) => window.toto.saveTranscript(meeting), {
      title: SYNTHETIC_TITLE,
      mode: 'meeting',
      startedAt,
      lines: SYNTHETIC_LINES,
      recap: SYNTHETIC_RECAP
    })
    if (typeof saved?.path !== 'string' || !isAbsolute(saved.path) || !inside(paths.meetingsFolder, saved.path)) {
      fail('baseline-meeting-save-failed')
    }
    meetingFile = basename(saved.path)
    const baselineRead = await verifyApplicationState(appSession, {
      meetingsFolder: paths.meetingsFolder,
      userData: paths.userData,
      file: meetingFile
    })
    initialMeetingHash = baselineRead.meetingHash
    markPhase(report, 'baseline', '1.9.6', baselineRead)
    report.windows.meeting_count = 1
    recordRow(report, 'baseline-encrypted-profile', 'PASS')
    await stopPackagedApp(appSession, ownedProcessRegistry)
    appSession = null

    activeRow = 'candidate-upgrade-readback'
    const candidateInstall = await installSetup(args.candidateInstaller, paths.installRoot)
    if (candidateInstall.code !== 0 || candidateInstall.timedOut) fail('candidate-install-failed')
    appSession = await openPackagedApp(
      join(paths.installRoot, 'Metis.exe'),
      env,
      paths.installRoot,
      paths.userData,
      ownedProcessRegistry,
      attachmentReceipts
    )
    rememberOwnedProcesses(ownedProcessRegistry, appSession.child.pid, appSession.installRoot)
    if (appSession.version !== TARGET_VERSION) fail('candidate-app-version-mismatch')
    const candidateRead = await verifyApplicationState(appSession, {
      meetingsFolder: paths.meetingsFolder,
      userData: paths.userData,
      file: meetingFile,
      expectedHash: initialMeetingHash
    })
    markPhase(report, 'candidate', TARGET_VERSION, candidateRead)
    recordRow(report, 'candidate-upgrade-readback', 'PASS')
    await stopPackagedApp(appSession, ownedProcessRegistry)
    appSession = null

    activeRow = 'manual-baseline-reinstall'
    // This is a manual install path, not an updater rollback: quit 1.9.7, run the pinned 1.9.6 Setup
    // over the same install directory, and retain the same OS userData + meetings folder.
    const rollbackInstall = await installSetup(args.baselineInstaller, paths.installRoot)
    if (rollbackInstall.code !== 0 || rollbackInstall.timedOut) fail('manual-baseline-reinstall-failed')
    recordRow(report, 'manual-baseline-reinstall', 'PASS')
    activeRow = 'rollback-encrypted-profile-readback'
    appSession = await openPackagedApp(
      join(paths.installRoot, 'Metis.exe'),
      env,
      paths.installRoot,
      paths.userData,
      ownedProcessRegistry,
      attachmentReceipts
    )
    rememberOwnedProcesses(ownedProcessRegistry, appSession.child.pid, appSession.installRoot)
    if (appSession.version !== '1.9.6') fail('rollback-app-version-mismatch')
    const rollbackRead = await verifyApplicationState(appSession, {
      meetingsFolder: paths.meetingsFolder,
      userData: paths.userData,
      file: meetingFile,
      expectedHash: initialMeetingHash
    })
    markPhase(report, 'rollback', '1.9.6', rollbackRead)
    report.windows.exact_meeting_bytes_preserved = rollbackRead.meetingHash === initialMeetingHash
    if (!report.windows.exact_meeting_bytes_preserved) fail('rollback-bytes-not-preserved')
    recordRow(report, 'rollback-encrypted-profile-readback', 'PASS')
    await stopPackagedApp(appSession, ownedProcessRegistry)
    appSession = null
    activeRow = 'cleanup'
    recordRow(report, 'cleanup', 'PASS')
  } catch (error) {
    const code = failureCode(error)
    executionFailed = true
    markExecutionFailure(report, activeRow, code)
    report.outcome = 'FAIL'
  } finally {
    if (appSession) {
      try {
        await stopPackagedApp(appSession, ownedProcessRegistry)
        appSession = null
      } catch {
        executionFailed = true
        markExecutionFailure(report, activeRow, 'app-teardown-unacknowledged')
        ownedProcessesGone = false
      }
    }
    let attachmentsReleased = true
    for (const receipt of attachmentReceipts) {
      if (!(await releaseAttachmentReceipt(receipt))) attachmentsReleased = false
    }
    if (isolatedRoot) {
      const paths = workspacePaths(isolatedRoot)
      try {
        rememberOwnedProcesses(ownedProcessRegistry, null, paths.installRoot)
        let remaining = currentOwnedSurvivors(ownedProcessRegistry, paths.installRoot)
        let forcedCleanup = remaining.length > 0
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          if (remaining.length) {
            forcedCleanup = true
            killOwned(remaining)
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
          rememberOwnedProcesses(ownedProcessRegistry, null, paths.installRoot)
          remaining = currentOwnedSurvivors(ownedProcessRegistry, paths.installRoot)
        }
        if (remaining.length) {
          forcedCleanup = true
          killOwned(remaining)
          const settleDeadline = Date.now() + 1_000
          while (remaining.length && Date.now() < settleDeadline) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
            rememberOwnedProcesses(ownedProcessRegistry, null, paths.installRoot)
            remaining = currentOwnedSurvivors(ownedProcessRegistry, paths.installRoot)
          }
        }
        ownedProcessesGone = remaining.length === 0
        if (forcedCleanup) {
          executionFailed = true
          markExecutionFailure(report, 'cleanup', 'forced-process-cleanup')
        }
      } catch {
        ownedProcessesGone = false
      }
      if (ownedProcessesGone && attachmentsReleased) {
        try {
          rmSync(isolatedRoot, { recursive: true, force: true })
          installRootRemoved = !existsSync(paths.installRoot)
          profileRemoved = !existsSync(paths.profile)
        } catch {
          installRootRemoved = false
          profileRemoved = false
        }
      }
    } else {
      installRootRemoved = true
      profileRemoved = true
      ownedProcessesGone = appSession === null
    }
    if (inputCleanupAllowed) {
      try {
        rmSync(inputRoot, { recursive: true, force: true })
        inputRemoved = !existsSync(inputRoot)
      } catch {
        inputRemoved = false
      }
    }
    report.cleanup = {
      status:
        profileRemoved && installRootRemoved && inputRemoved && attachmentsReleased && ownedProcessesGone
          ? 'ACKNOWLEDGED'
          : 'NOT_ACKNOWLEDGED',
      isolated_profile_removed: profileRemoved,
      install_root_removed: installRootRemoved,
      input_staging_removed: inputRemoved,
      attachment_released: attachmentsReleased,
      owned_processes_gone: ownedProcessesGone
    }
    if (report.cleanup.status !== 'ACKNOWLEDGED') {
      recordRow(report, 'cleanup', 'FAIL', 'cleanup-unacknowledged')
      report.outcome = 'FAIL'
    }
    finalizeManualRollbackResult(report, executionFailed)
    report.macos.candidate_dmg_sha256 = report.identity?.macos_dmg_sha256 ?? null
    try {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    } catch {
      report.outcome = 'FAIL'
    }
  }
  const validation = manualRollbackReportProblems(report, args)
  if (validation.length) return { exitCode: 1, report: null }
  return { exitCode: 0, report }
}

function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || Object.hasOwn(flags, key.slice(2))) fail('arguments-invalid')
    flags[key.slice(2)] = value
  }
  return flags
}

function readRunArgs(flags) {
  if (!RUN_ID.test(flags['candidate-run'] ?? '') || !RUN_ID.test(flags['candidate-attempt'] ?? '')) {
    fail('candidate-run-input-invalid')
  }
  if (!HASH64.test((flags['candidate-sha256'] ?? '').toLowerCase())) fail('candidate-sha-input-invalid')
  for (const key of [
    'input-root',
    'run-metadata',
    'provenance',
    'candidate-dir',
    'candidate-installer',
    'baseline-installer',
    'baseline-sums',
    'output'
  ]) {
    if (!flags[key]) fail(`argument-missing-${key}`)
  }
  return {
    runId: flags['candidate-run'],
    attempt: flags['candidate-attempt'],
    sha256: flags['candidate-sha256'].toLowerCase(),
    inputRoot: flags['input-root'],
    runMetadata: flags['run-metadata'],
    provenance: flags.provenance,
    candidateDir: flags['candidate-dir'],
    candidateInstaller: flags['candidate-installer'],
    baselineInstaller: flags['baseline-installer'],
    baselineSums: flags['baseline-sums'],
    output: flags.output
  }
}

function readVerifyArgs(flags) {
  if (!RUN_ID.test(flags['candidate-run'] ?? '') || !RUN_ID.test(flags['candidate-attempt'] ?? '')) {
    fail('candidate-run-input-invalid')
  }
  if (!HASH64.test((flags['candidate-sha256'] ?? '').toLowerCase()) || !flags.report) fail('report-input-invalid')
  return {
    runId: flags['candidate-run'],
    attempt: flags['candidate-attempt'],
    sha256: flags['candidate-sha256'].toLowerCase(),
    report: flags.report
  }
}

async function cli(argv) {
  const [mode, ...rest] = argv
  try {
    const flags = parseFlags(rest)
    if (mode === 'run') {
      const args = readRunArgs(flags)
      const result = await runManualRollback(args)
      if (result.exitCode !== 0) {
        console.error('Manual rollback evidence failed strict validation.')
        process.exitCode = 1
        return
      }
      const report = result.report
      console.log(`Windows manual rollback PASS; macOS ${report.macos.status}; outcome ${report.outcome}.`)
      return
    }
    if (mode === 'verify') {
      const expected = readVerifyArgs(flags)
      let report
      try {
        report = readJson(expected.report)
      } catch {
        console.error('Manual rollback report is missing or invalid.')
        process.exitCode = 1
        return
      }
      const problems = manualRollbackReportProblems(report, expected)
      if (problems.length) {
        console.error(`Manual rollback report rejected: ${problems.join(', ')}.`)
        process.exitCode = 1
        return
      }
      console.log(`Windows manual rollback PASS; macOS ${report.macos.status}; outcome ${report.outcome}.`)
      return
    }
    fail('mode-invalid')
  } catch (error) {
    console.error(`Manual rollback lane failed: ${failureCode(error)}.`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await cli(process.argv.slice(2))
