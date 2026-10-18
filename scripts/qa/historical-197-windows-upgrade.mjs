#!/usr/bin/env node
// Installed healthy native-profile evidence only. No build, download, signing, auth bypass or publication.
import { randomBytes, createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HISTORICAL_197, hashHistorical197File } from './historical-197-inputs.mjs'
import {
  attachOwnedCdp, boundedCall, disposeFreshOnboardingTransports, freeLoopbackPort,
  killOwned, launchPackagedCdp, ownedCensus, packagedLaunchFailed, strictLaunchEnvironment,
  waitFor, waitForChildExit
} from './lib/app-driver.mjs'
import { listProcesses } from './owned-processes.mjs'

export const BASELINE = Object.freeze({
  repository: 'mysticalsin/Metis-Releases', releaseId: 395306225, tag: 'v1.9.6-unsigned', assetId: 585098577,
  name: 'Metis-Setup-1.9.6.exe', size: 1532977165,
  sha256: '77a532f3c33a0be6f9315e7e0df02c2420c25a297e90c5fa6baff18f84193df8',
  producerReportedSource: '2bf21f1ceefe117838325342574b57852e5cadcb', buildRun: 35872259580,
  sourceBinding: 'UNSIGNED_PRODUCER_ATTRIBUTION_NOT_SIGNED_PROVENANCE'
})
export const REQUIRED_CHECKS = Object.freeze([
  'inputs', 'prepared', 'baseline_install', 'baseline_seed', 'baseline_read', 'baseline_stop', 'baseline_native',
  'upgrade_install', 'upgrade_read', 'upgrade_stop', 'upgrade_native', 'fresh_read', 'fresh_stop', 'fresh_native', 'cleanup'
])
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HEX = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
function requireValue(value) { if (!value) throw new Error('historical-upgrade-refused') }
function pathEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase()
}
function insideWindows(parent, child) {
  if (typeof child !== 'string' || !win32.isAbsolute(child)) return false
  const rel = win32.relative(win32.resolve(parent), win32.resolve(child))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${win32.sep}`) && !win32.isAbsolute(rel)
}
function insideHost(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}
const nativeBase64 = (value, size) => typeof value === 'string' && value.length > 0 &&
  Buffer.from(value, 'base64').toString('base64') === value && (size === undefined || Buffer.from(value, 'base64').length === size)

/** Parses real storage formats; synthetic parser fixtures never establish live DPAPI acceptance. */
export function assessNativeFiles(files, canaries) {
  for (const field of ['settings', 'provider', 'meeting']) {
    requireValue(Buffer.isBuffer(files[field]) && files[field].length > 0 && files[field].length <= 32 * 1024 * 1024)
    for (const canary of canaries) requireValue(typeof canary === 'string' && canary.length > 0 && !files[field].includes(Buffer.from(canary)))
  }
  requireValue(files.settings.subarray(0, 8).equals(Buffer.from('ATKENC1\n')) && files.settings.length > 8)
  requireValue(!files.provider.subarray(0, 8).equals(Buffer.from('ATKAES1\n')))
  requireValue(files.meeting.subarray(0, 8).equals(Buffer.from('ATKENC2\n')))
  const envelope = JSON.parse(files.meeting.subarray(8).toString('utf8'))
  requireValue(envelope.v === 2 && nativeBase64(envelope.iv, 12) && nativeBase64(envelope.tag, 16) &&
    nativeBase64(envelope.ct) && typeof envelope.kLocal === 'string' && envelope.kLocal.startsWith('S:') &&
    nativeBase64(envelope.kLocal.slice(2)))
  return { native: true, settingsSha256: sha256(files.settings), providerSha256: sha256(files.provider), meetingSha256: sha256(files.meeting) }
}

async function call(page, fn, arg = undefined) {
  return await boundedCall(() => page.evaluate(fn, arg), 15_000, 'historical-ipc-deadline')
}
async function observeAdmission(page, expected, requireBoundRoot) {
  const auth = await call(page, () => window.toto.authStatus())
  requireValue(auth?.configured === false && auth.signedIn === false && auth.enforced === false)
  const settings = await call(page, () => window.toto.getSettings())
  requireValue(settings && Array.isArray(settings.allowedProviders) && settings.allowedProviders.length === 0 &&
    settings.localLlm?.enabled === false && Array.isArray(settings.envKeys) && settings.envKeys.length === 0 &&
    insideWindows(expected.profileRoot ?? win32.dirname(expected.meetingsRoot), settings.resolvedMeetingsFolder))
  if (requireBoundRoot) requireValue(pathEqual(settings.meetingsFolder, expected.meetingsRoot) && pathEqual(settings.resolvedMeetingsFolder, expected.meetingsRoot))
  return settings
}
function seededSettings(settings) {
  requireValue(settings.onboardingDone === true && settings.encryptTranscripts === true && settings.temperature === 0.42)
}

/** Uses only ordinary shipped preload APIs shared by the two historical app versions. */
export async function configureAndSeed(page, expected, admitStorage) {
  const initial = await observeAdmission(page, expected, false)
  requireValue(initial.version === '1.9.6')
  const patch = {
    meetingsFolder: expected.meetingsRoot, onboardingDone: true, encryptTranscripts: true, temperature: 0.42,
    graphifyEnabled: false, graphifyAutoRebuild: false,
    localLlm: { ...initial.localLlm, enabled: false, useFor: { suggest: false, summary: false, vision: false } },
    brainConsolidation: { enabled: true, maxPassesPerDay: 2, preferLocal: true }
  }
  const saved = await call(page, (value) => window.toto.setSettings(value), patch)
  requireValue(pathEqual(saved?.meetingsFolder, expected.meetingsRoot) && pathEqual(saved?.resolvedMeetingsFolder, expected.meetingsRoot) &&
    Array.isArray(saved.allowedProviders) && saved.allowedProviders.length === 0 && saved.localLlm?.enabled === false)
  seededSettings(saved)
  const effective = await observeAdmission(page, expected, true)
  seededSettings(effective)
  requireValue(typeof admitStorage === 'function')
  await admitStorage(effective.resolvedMeetingsFolder)
  const keyResult = await call(page, (value) => window.toto.setApiKey('openai', value), expected.key)
  requireValue(keyResult?.hasKeys?.openai === true)
  await admitStorage((await observeAdmission(page, expected, true)).resolvedMeetingsFolder)
  const meeting = await call(page, (value) => window.toto.saveTranscript(value), {
    title: expected.title, mode: 'general', startedAt: expected.startedAt, durationMs: 64000,
    lines: [{ speaker: 'you', text: expected.line, t: expected.startedAt + 2000 }], recap: ''
  })
  requireValue(insideWindows(expected.meetingsRoot, meeting?.path))
  return meeting.path
}

export async function readInstalledProfile(page, expected) {
  const settings = await observeAdmission(page, expected, true)
  requireValue(settings.version === expected.version && settings.hasKeys?.openai === true)
  seededSettings(settings)
  const history = await call(page, () => window.toto.recallList())
  requireValue(Array.isArray(history) && history.length === 1 && history[0].file === expected.file &&
    history[0].title === expected.title && history[0].locked !== true && history[0].notDownloaded !== true && history[0].unavailable !== true)
  const read = await call(page, (file) => window.toto.recallRead(file), expected.file)
  requireValue(read?.ok === true && read.title === expected.title && read.recap === '' &&
    Array.isArray(read.lines) && read.lines.length === 1 && read.lines[0].text === expected.line)
  return true
}

export function assessHistoricalUpgradeReport(report) {
  if (report?.schema !== 1 || report.platform !== 'win32' || report.error !== null || !COMMIT.test(report.harnessCommit ?? '') ||
    report.appSource !== HISTORICAL_197.artifactSource || JSON.stringify(report.baseline) !== JSON.stringify(BASELINE) ||
    JSON.stringify(report.candidate) !== JSON.stringify(HISTORICAL_197.assets[2]) || !Array.isArray(report.checks) || report.checks.length !== REQUIRED_CHECKS.length ||
    !Array.isArray(report.installers) || report.installers.length !== 2 ||
    !report.installers.every((item, index) => item?.version === ['1.9.6', '1.9.7'][index] && item.closed === true &&
      item.censusConfirmed === true && item.exitCode === 0 && Number.isSafeInteger(item.pid) && item.pid > 1) ||
    !Array.isArray(report.processes) || report.processes.length !== 3 || new Set(report.processes).size !== 3 ||
    report.processes.some((pid) => !Number.isSafeInteger(pid) || pid <= 1) || !Array.isArray(report.nativeSnapshots) || report.nativeSnapshots.length !== 3 ||
    !report.checks.every((row) => row && REQUIRED_CHECKS.includes(row.id) && ['PASS', 'FAIL', 'NOT_RUN'].includes(row.status))) return false
  return REQUIRED_CHECKS.every((id) => report.checks.filter((row) => row.id === id).length === 1 && report.checks.find((row) => row.id === id).status === 'PASS') &&
    report.nativeSnapshots.every((row) => row?.native === true && typeof row.fileKeyPresent === 'boolean' && HEX.test(row.settingsSha256 ?? '') && HEX.test(row.meetingSha256 ?? '') && HEX.test(row.providerSha256 ?? '') &&
      row.meetingSha256 === report.nativeSnapshots[0].meetingSha256 && row.providerSha256 === report.nativeSnapshots[0].providerSha256)
}

/**
 * The orchestrator consumes this public driver contract, rather than the default driver's private
 * launch-attempt registry. A successful launch has already validated its positive process identity.
 * @typedef {{ profileRoot: string, meetingsRoot: string, title: string, line: string, key: string, startedAt: number, file?: string }} HistoricalUpgradePlan
 * @typedef {{ pid: number, version: string }} HistoricalUpgradeSession
 * @typedef {{ pid: number, exitCode: number, censusConfirmed: boolean, closed: boolean }} HistoricalInstallerReceipt
 * @typedef {{ native: boolean, settingsSha256: string, providerSha256: string, meetingSha256: string, fileKeyPresent: boolean }} HistoricalNativeSnapshot
 * @typedef {object} HistoricalUpgradeDriver
 * @property {() => Promise<boolean>} verifyInputs
 * @property {() => Promise<HistoricalUpgradePlan>} prepare
 * @property {(version: string) => Promise<HistoricalInstallerReceipt>} install
 * @property {(version: string) => Promise<HistoricalUpgradeSession>} launch
 * @property {(session: HistoricalUpgradeSession, plan: HistoricalUpgradePlan) => Promise<string>} seed
 * @property {(session: HistoricalUpgradeSession, plan: HistoricalUpgradePlan, version: string) => Promise<unknown>} read
 * @property {(path: string, plan: HistoricalUpgradePlan) => Promise<HistoricalNativeSnapshot>} inspect
 * @property {(session: HistoricalUpgradeSession) => Promise<boolean>} stop
 * @property {() => Promise<boolean>} cleanup
 */

/**
 * The default CLI supplies real system boundaries below; injected drivers exist solely for harness contract tests.
 * @param {HistoricalUpgradeDriver} [driver]
 */
export async function runHistoricalUpgrade(options, driver = createWindowsDriver(options)) {
  const report = {
    schema: 1, scope: 'HEALTHY_NATIVE_196_TO_PUBLISHED_197_ONLY', platform: 'win32', harnessCommit: COMMIT.test(options.harnessCommit ?? '') ? options.harnessCommit : null,
    appSource: HISTORICAL_197.artifactSource, baseline: { ...BASELINE }, candidate: { ...HISTORICAL_197.assets[2] },
    processes: [], installers: [], nativeSnapshots: [], checks: REQUIRED_CHECKS.map((id) => ({ id, status: 'NOT_RUN' })), error: null, accepted: false,
    limitations: ['Baseline source attribution is not signed provenance.', 'No rollback, recovery, authenticated-enterprise, ACL, foreign-account, notes, recap-generation or full-release security qualification.']
  }
  let current = 'inputs'
  const step = async (id, fn) => {
    current = id
    const value = await fn()
    requireValue(value !== false)
    report.checks.find((row) => row.id === id).status = 'PASS'
    return value
  }
  try {
    await step('inputs', () => driver.verifyInputs())
    const plan = await step('prepared', () => driver.prepare())
    const install = async (id, version) => await step(id, async () => {
      const receipt = await driver.install(version)
      requireValue(receipt?.closed === true && receipt.censusConfirmed === true && receipt.exitCode === 0 &&
        Number.isSafeInteger(receipt.pid) && receipt.pid > 1)
      report.installers.push({ version, ...receipt })
      return true
    })
    await install('baseline_install', '1.9.6')
    let app
    const launch = async (version) => {
      const launched = await driver.launch(version)
      requireValue(Number.isSafeInteger(launched.pid) && launched.pid > 1 && !report.processes.includes(launched.pid))
      report.processes.push(launched.pid)
      return launched
    }
    const path = await step('baseline_seed', async () => { app = await launch('1.9.6'); return await driver.seed(app, plan) })
    plan.file = win32.basename(path)
    await step('baseline_read', () => driver.read(app, plan, '1.9.6'))
    await step('baseline_stop', () => driver.stop(app))
    const inspect = async (id) => await step(id, async () => {
      const observed = await driver.inspect(path, plan)
      requireValue(observed?.native === true && HEX.test(observed.meetingSha256 ?? '') && HEX.test(observed.providerSha256 ?? ''))
      if (report.nativeSnapshots.length) requireValue(observed.meetingSha256 === report.nativeSnapshots[0].meetingSha256 && observed.providerSha256 === report.nativeSnapshots[0].providerSha256)
      report.nativeSnapshots.push(observed)
      return true
    })
    await inspect('baseline_native')
    await install('upgrade_install', '1.9.7')
    await step('upgrade_read', async () => { app = await launch('1.9.7'); return await driver.read(app, plan, '1.9.7') })
    await step('upgrade_stop', () => driver.stop(app))
    await inspect('upgrade_native')
    await step('fresh_read', async () => { app = await launch('1.9.7'); return await driver.read(app, plan, '1.9.7') })
    await step('fresh_stop', () => driver.stop(app))
    await inspect('fresh_native')
  } catch {
    report.error = current
    report.checks.find((row) => row.id === current).status = 'FAIL'
  } finally {
    try { await step('cleanup', () => driver.cleanup()) } catch {
      report.checks.find((row) => row.id === 'cleanup').status = 'FAIL'
      report.error ??= 'cleanup'
    }
  }
  report.accepted = assessHistoricalUpgradeReport(report)
  return report
}

async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
export async function validateOwnedStoragePath(root, path, file = false) {
  requireValue(insideHost(root, path))
  const actualRoot = await realpath(root)
  const actual = await realpath(path)
  requireValue(insideHost(actualRoot, actual) && pathEqual(actual, resolve(path)))
  let cursor = resolve(path)
  while (!pathEqual(cursor, resolve(root))) {
    const stat = await lstat(cursor)
    requireValue(!stat.isSymbolicLink() && (cursor !== resolve(path) || (file ? stat.isFile() : stat.isDirectory())))
    cursor = dirname(cursor)
  }
  return actual
}
async function boundedOwnedFile(root, path) {
  await validateOwnedStoragePath(root, path, true)
  const before = await lstat(path)
  requireValue(before.size > 0 && before.size <= 32 * 1024 * 1024)
  const bytes = await readFile(path)
  const after = await lstat(path)
  requireValue(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && bytes.length === before.size)
  return bytes
}
function remember(session) {
  try {
    const census = ownedCensus({ platform: 'win32', mainPid: session.child.pid, installRoot: session.installRoot })
    const root = census.owned.find((entry) => entry.pid === session.child.pid)
    requireValue(root && Number.isFinite(root.startedMs) && typeof root.exe === 'string' && pathEqual(root.exe, session.executablePath))
    if (session.rootIdentity) requireValue(sameProcess(root, session.rootIdentity))
    else session.rootIdentity = Object.freeze({ ...root })
    for (const entry of census.owned) {
      requireValue(Number.isFinite(entry.startedMs) && typeof entry.exe === 'string' && entry.exe.length > 0)
      session.owned.set(`${entry.pid}:${entry.startedMs}`, Object.freeze({ ...entry }))
    }
    session.censusConfirmed = true
  } catch (error) { session.uncertain = true; throw error }
}

function sameProcess(actual, captured) {
  return actual.pid === captured.pid && actual.startedMs === captured.startedMs &&
    typeof actual.exe === 'string' && typeof captured.exe === 'string' && pathEqual(actual.exe, captured.exe)
}

function refreshOwnership(record) {
  try {
    const current = listProcesses('win32')
    const captured = [...record.owned.values()]
    const safe = new Map()
    const conflict = new Set()
    for (const entry of current) {
      const key = `${entry.pid}:${entry.startedMs}`
      const original = record.owned.get(key)
      if (original && !sameProcess(entry, original)) { record.uncertain = true; conflict.add(key); continue }
      // Install-root residence is an independent existing ownership rule, not authority from a recycled PID.
      if (original || (typeof entry.exe === 'string' && insideWindows(record.installRoot, entry.exe))) safe.set(key, entry)
    }
    let expanded = true
    while (expanded) {
      expanded = false
      for (const entry of current) {
        const key = `${entry.pid}:${entry.startedMs}`
        if (safe.has(key) || conflict.has(key)) continue
        const parent = [...safe.values()].find((known) => known.pid === entry.ppid)
        if (!parent || entry.startedMs < parent.startedMs) continue
        if (!Number.isFinite(entry.startedMs) || typeof entry.exe !== 'string' || entry.exe.length === 0) {
          record.uncertain = true
          continue
        }
        safe.set(key, entry)
        expanded = true
      }
    }
    for (const entry of current) {
      if (safe.has(`${entry.pid}:${entry.startedMs}`)) continue
      const oldParent = captured.find((known) => known.pid === entry.ppid && entry.startedMs >= known.startedMs)
      const liveParent = current.find((parent) => parent.pid === entry.ppid)
      // Do not adopt a possible orphan using an absent numeric parent. Retain the namespace instead.
      if (oldParent && (!liveParent || entry.startedMs < liveParent.startedMs)) record.uncertain = true
    }
    for (const [key, entry] of safe) {
      record.owned.set(key, Object.freeze({ ...entry }))
    }
    return [...safe.values()]
  } catch (error) { record.uncertain = true; throw error }
}

async function stopWindowsRecord(record) {
  if (record.stopped) return record.clean
  if (!record.child || !Number.isSafeInteger(record.child.pid) || record.child.pid <= 1) {
    record.uncertain = true
    return false
  }
  let quit = record.kind === 'installer'
  if (record.child.exitCode === null && record.child.signalCode === null) {
    try { remember(record) } catch { /* uncertainty is sticky */ }
  }
  if (record.page) {
    try { await call(record.page, () => window.toto.quit()); quit = true } catch { /* exit can close IPC before reply */ }
  }
  await waitForChildExit(record.child, 10_000)
  let forced = false
  let exited = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const remaining = refreshOwnership(record)
      const rootExited = record.child.exitCode !== null || record.child.signalCode !== null
      if (rootExited && remaining.length === 0) { exited = record.censusConfirmed === true; break }
      forced = true
      if (remaining.length) killOwned(remaining)
      else if (!rootExited) record.uncertain = true // no numeric-PID fallback without current identity proof
    } catch { /* uncertainty prevents deletion even if a later census succeeds */ }
    await new Promise((done) => setTimeout(done, 250))
  }
  const released = await disposeFreshOnboardingTransports({ browser: record.browser ?? null,
    transportUncertain: record.transportUncertain === true, lateReleases: record.lateReleases ?? [] })
  record.stopped = true
  record.safeToRemove = exited && released && !record.uncertain
  record.clean = quit && record.safeToRemove && !forced && record.child.exitCode === 0 && record.child.signalCode === null
  return record.clean
}

/** Consumed only after driver's unchanged real installer hash admission; no identity success is inferred here. */
export async function runOwnedInstaller(installer, installRoot, paths, records) {
  const record = { kind: 'installer', child: null, executablePath: installer, installRoot, owned: new Map(), censusConfirmed: false,
    uncertain: true, spawnError: false, stopped: false, clean: false, safeToRemove: false }
  const env = strictLaunchEnvironment(process.env, paths, 'win32')
  records.push(record)
  let polling
  try {
    record.child = spawn(installer, ['/S', `/D=${installRoot}`], { env: { ...env }, windowsHide: true, stdio: 'ignore' })
    record.child.once('error', () => { record.uncertain = true; record.spawnError = true })
    requireValue(Number.isSafeInteger(record.child.pid) && record.child.pid > 1)
    record.uncertain = record.spawnError
    remember(record)
    polling = setInterval(() => { try { refreshOwnership(record) } catch { /* sticky uncertainty */ } }, 250)
    const exited = await waitForChildExit(record.child, 180_000)
    if (!exited) record.uncertain = true
    requireValue(exited && record.child.exitCode === 0 && record.child.signalCode === null && !record.uncertain)
    requireValue(await stopWindowsRecord(record))
    return { pid: record.child.pid, exitCode: record.child.exitCode, censusConfirmed: record.censusConfirmed, closed: record.safeToRemove }
  } catch (error) {
    if (!record.child || !record.censusConfirmed) record.uncertain = true
    throw error
  } finally { if (polling) clearInterval(polling) }
}

/** Same registry is used by the real driver for installers and application launches. */
export async function cleanupWindowsOwnership(records, rootStamp) {
  let clean = true
  for (const record of records) {
    try { clean = (await stopWindowsRecord(record)) && clean } catch { record.uncertain = true; clean = false }
  }
  if (!rootStamp) return clean
  try {
    const current = listProcesses('win32')
    requireValue(!current.some((entry) => typeof entry.exe === 'string' && insideWindows(rootStamp.path, entry.exe)))
    for (const record of records) for (const captured of record.owned.values()) {
      requireValue(!current.some((entry) => entry.pid === captured.pid && entry.startedMs === captured.startedMs))
    }
  } catch { return false }
  if (records.some((record) => record.uncertain || !record.safeToRemove)) return false
  try {
    const stat = await lstat(rootStamp.path)
    requireValue(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === rootStamp.dev && stat.ino === rootStamp.ino &&
      pathEqual(await realpath(rootStamp.path), resolve(rootStamp.path)))
    await rm(rootStamp.path, { recursive: true, force: false })
    return clean && !(await exists(rootStamp.path))
  } catch { return false }
}

/** Creates real installed-system operations. No installer, IPC or native crypto implementation is mocked here. */
export function createWindowsDriver(options) {
  const sessions = []
  let prepared = false
  let rootStamp = null
  const profile = join(options.root, 'profile')
  const installRoot = join(options.root, 'install')
  const meetingsRoot = join(profile, 'meetings')
  const exe = join(installRoot, 'Metis.exe')
  const stop = stopWindowsRecord
  const home = join(options.root, 'home')
  const paths = { home, userProfile: home, appData: join(home, 'roaming'), localAppData: join(home, 'local'), temp: join(home, 'temp'), userData: profile }
  return {
    async verifyInputs() {
      requireValue(process.platform === 'win32' && COMMIT.test(options.harnessCommit ?? ''))
      const checkout = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
      requireValue(checkout.status === 0 && checkout.stdout.trim() === options.harnessCommit)
      const verification = spawnSync(process.execPath, [join(ROOT, 'scripts/qa/historical-197-inputs.mjs'),
        '--metadata', options.metadata, '--assets', options.assets, '--harness-commit', options.harnessCommit],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 15 * 60_000, maxBuffer: 32_768 })
      requireValue(verification.status === 0 && !verification.error)
      const identity = JSON.parse(verification.stdout)
      requireValue(identity.scope === 'IDENTITY_ONLY' && identity.outcome === 'VERIFIED' && identity.verification === 'local-bytes' &&
        identity.harness_commit === options.harnessCommit && identity.artifact_source === HISTORICAL_197.artifactSource &&
        identity.candidate_run === HISTORICAL_197.candidateRun && identity.candidate_attempt === 1 &&
        JSON.stringify(identity.assets) === JSON.stringify(HISTORICAL_197.assets))
      await hashHistorical197File(options.baseline, BASELINE)
      return true
    },
    async prepare() {
      requireValue(typeof process.env.RUNNER_TEMP === 'string' && process.env.RUNNER_TEMP.length > 0)
      const temp = await realpath(process.env.RUNNER_TEMP)
      requireValue(isAbsolute(options.root) && insideHost(temp, options.root) && insideHost(temp, options.report) &&
        !insideHost(options.root, options.report) && resolve(options.root) !== resolve(options.report) && !(await exists(options.root)) && !(await exists(options.report)))
      requireValue(pathEqual(await realpath(dirname(options.root)), dirname(options.root)) && pathEqual(await realpath(dirname(options.report)), dirname(options.report)))
      requireValue(!pathEqual(options.report, options.metadata) && !pathEqual(options.report, options.baseline) && !insideHost(options.assets, options.report))
      await mkdir(options.root)
      prepared = true
      rootStamp = { path: options.root, dev: null, ino: null }
      const stamp = await lstat(options.root)
      rootStamp = { path: options.root, dev: stamp.dev, ino: stamp.ino }
      for (const path of [profile, installRoot, meetingsRoot, ...Object.values(paths)]) await mkdir(path, { recursive: true })
      await validateOwnedStoragePath(options.root, meetingsRoot)
      requireValue(!(await exists(join(profile, 'AskToto Meetings'))))
      await writeFile(join(profile, 'managed-config.json'), '{"allowedProviders":[]}\n', { flag: 'wx', mode: 0o600 })
      const token = randomBytes(16).toString('hex')
      return { profileRoot: profile, meetingsRoot, title: `Historical synthetic ${token}`, line: `Historical transcript ${token}`,
        key: `sk-synthetic-${randomBytes(24).toString('hex')}`, startedAt: Date.now() }
    },
    async install(version) {
      requireValue(prepared && sessions.every((session) => session.stopped && session.clean))
      const installer = version === '1.9.6' ? options.baseline : join(options.assets, HISTORICAL_197.assets[2].name)
      await hashHistorical197File(installer, version === '1.9.6' ? BASELINE : HISTORICAL_197.assets[2])
      const receipt = await runOwnedInstaller(installer, installRoot, paths, sessions)
      await validateOwnedStoragePath(options.root, exe, true)
      return receipt
    },
    /**
     * The success path below requires a safe integer PID greater than one before returning.
     * @param {string} version
     * @returns {Promise<HistoricalUpgradeSession>}
     */
    async launch(version) {
      requireValue(sessions.every((session) => session.stopped && session.clean))
      await validateOwnedStoragePath(options.root, exe, true)
      requireValue(await readFile(join(profile, 'managed-config.json'), 'utf8') === '{"allowedProviders":[]}\n')
      for (const path of Object.values(paths)) await mkdir(path, { recursive: true })
      const env = strictLaunchEnvironment(process.env, paths, 'win32')
      requireValue(!env.ASKTOTO_LOCAL_KEYSTORE && !env.AZURE_CLIENT_ID && !env.ASKTOTO_REQUIRE_AUTH)
      const cdpPort = await freeLoopbackPort()
      let inspectPort = await freeLoopbackPort()
      while (inspectPort === cdpPort) inspectPort = await freeLoopbackPort()
      const session = { kind: 'app', executablePath: exe, child: null, latches: null, censusConfirmed: false, uncertain: true, pid: null, version, installRoot, owned: new Map(), browser: null, page: null,
        transportUncertain: false, lateReleases: [], stopped: false, clean: false, safeToRemove: false }
      sessions.push(session)
      try {
        const launched = launchPackagedCdp({ executablePath: exe, env, cdpPort, inspectPort, platform: 'win32' })
        requireValue(launched?.child && typeof launched.child.once === 'function')
        session.child = launched.child
        session.pid = launched.child.pid
        session.latches = launched.latches
        requireValue(Number.isSafeInteger(session.pid) && session.pid > 1 && session.latches)
        session.uncertain = false
        session.child.once('error', () => { session.uncertain = true })
        remember(session)
        const attached = await attachOwnedCdp({ endpoint: launched.cdpEndpoint, childPid: launched.child.pid, timeoutMs: 30_000 })
        session.browser = attached.browser
        session.transportUncertain = attached.transportUncertain
        if (attached.lateRelease) session.lateReleases.push(attached.lateRelease)
        requireValue(attached.browser && !attached.failure && !packagedLaunchFailed(session.child, session.latches))
        session.page = await waitFor(async () => {
          if (packagedLaunchFailed(session.child, session.latches)) throw new Error('historical-launch-exited')
          remember(session)
          for (const context of session.browser.contexts()) for (const page of context.pages()) {
            if (await call(page, () => Boolean(window.toto?.authStatus && window.toto?.getSettings))) return page
          }
          return null
        }, 'historical-preload-unavailable', 30_000, 150)
        const settings = await call(session.page, () => window.toto.getSettings())
        requireValue(settings.version === version && insideWindows(profile, settings.resolvedMeetingsFolder))
        return session
      } catch (error) { session.uncertain = true; throw error }
    },
    async seed(session, plan) {
      const path = await configureAndSeed(session.page, plan, async (effectiveRoot) => {
        requireValue(pathEqual(effectiveRoot, meetingsRoot) && pathEqual(plan.profileRoot, profile))
        const stamp = await lstat(options.root)
        requireValue(rootStamp && stamp.dev === rootStamp.dev && stamp.ino === rootStamp.ino)
        await validateOwnedStoragePath(options.root, profile)
        await validateOwnedStoragePath(options.root, effectiveRoot)
        requireValue(!(await exists(join(profile, 'AskToto Meetings'))))
      })
      await validateOwnedStoragePath(meetingsRoot, path, true)
      return path
    },
    async read(session, plan, version) {
      await validateOwnedStoragePath(meetingsRoot, join(meetingsRoot, plan.file), true)
      return await readInstalledProfile(session.page, { ...plan, version })
    },
    async inspect(path, plan) {
      requireValue(sessions.every((session) => session.stopped && session.clean))
      const files = {
        settings: await boundedOwnedFile(profile, join(profile, 'settings.json')),
        provider: await boundedOwnedFile(profile, join(profile, 'key-openai.bin')),
        meeting: await boundedOwnedFile(meetingsRoot, path)
      }
      const native = assessNativeFiles(files, [plan.title, plan.line, plan.key])
      return { ...native, fileKeyPresent: await exists(join(profile, 'secret-key.bin')) }
    },
    stop,
    async cleanup() { return await cleanupWindowsOwnership(sessions, rootStamp) }
  }
}

async function main(argv) {
  const names = ['--baseline', '--historical-metadata', '--historical-assets', '--harness-commit', '--root', '--report']
  requireValue(argv.length === names.length * 2)
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    requireValue(names.includes(argv[index]) && !flags.has(argv[index]) && typeof argv[index + 1] === 'string' && argv[index + 1].length > 0)
    flags.set(argv[index], argv[index + 1])
  }
  const options = { baseline: flags.get('--baseline'), metadata: flags.get('--historical-metadata'), assets: flags.get('--historical-assets'),
    harnessCommit: flags.get('--harness-commit'), root: flags.get('--root'), report: flags.get('--report') }
  requireValue(process.platform === 'win32' && typeof process.env.RUNNER_TEMP === 'string' && process.env.RUNNER_TEMP.length > 0)
  const temp = await realpath(process.env.RUNNER_TEMP)
  requireValue(isAbsolute(options.report) && insideHost(temp, options.report) && !insideHost(options.root, options.report) &&
    resolve(options.report) !== resolve(options.root) && !(await exists(options.report)) &&
    pathEqual(await realpath(dirname(options.report)), dirname(options.report)) &&
    !pathEqual(options.report, options.metadata) && !pathEqual(options.report, options.baseline) && !insideHost(options.assets, options.report))
  const report = await runHistoricalUpgrade(options)
  // prepare enforces a new separate RUNNER_TEMP output. Never emit raw errors or installed-profile content.
  requireValue(insideHost(temp, options.report) && !insideHost(options.root, options.report) && !(await exists(options.report)))
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`historical-windows-native-upgrade:${report.accepted ? 'PASS' : 'FAIL'}\n`)
  process.exitCode = report.accepted ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('historical-windows-native-upgrade:REFUSED\n'); process.exitCode = 1 })
}
