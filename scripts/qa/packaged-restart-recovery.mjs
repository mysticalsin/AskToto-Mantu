#!/usr/bin/env node
// CI-only, synthetic same-package restart recovery probe for the exact installed candidate.
// It creates its own isolated userData/home, saves a synthetic transcript and note through the app IPC,
// quits cleanly, relaunches the same installed bytes, and verifies settings plus file bytes/content.
// This does not claim cross-version upgrade, updater-feed, rollback or customer-profile acceptance.

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, win32, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  attachOwnedCdp,
  boundedCall,
  disposeFreshOnboardingTransports,
  findPage,
  freeLoopbackPort,
  launchPackagedCdp,
  packagedLaunchFailed,
  strictLaunchEnvironment,
  waitForChildExit
} from './lib/app-driver.mjs'
import { listProcesses, ownedProcesses, survivors as findSurvivors } from './owned-processes.mjs'
import { stopOwnedChild } from './lib/st-1-termination.mjs'

export const RECOVERY_REPORT_SCHEMA = 'metis.packaged-restart-recovery.v1'
export const RECOVERY_ASSERTIONS = Object.freeze([
  'isolated-profile',
  'meeting-saved-and-readable',
  'note-saved',
  'settings-written',
  'first-shutdown-clean',
  'meeting-survives-restart',
  'note-survives-restart',
  'settings-survive-restart',
  'second-shutdown-clean',
  'isolated-profile-removed'
])

const ASSERTION_STATUSES = new Set(['PASS', 'FAIL', 'NOT_RUN'])
const FAILURES = new Set([
  'none',
  'platform-mismatch',
  'app-path-rejected',
  'profile-rejected',
  'launch-failed',
  'cdp-attach-failed',
  'cdp-endpoint-deadline',
  'cdp-transport-timeout',
  'cdp-session-or-process-info-invalid',
  'cdp-browser-pid-mismatch',
  'storage-api-failed',
  'restart-data-missing',
  'shutdown-not-clean',
  'shutdown-unacknowledged',
  'profile-cleanup-failed',
  'harness-error'
])

const exactKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

export function packagedRecoveryReportProblems(report) {
  if (!exactKeys(report, ['schema', 'scenario', 'platform', 'outcome', 'assertions', 'failure', 'teardown'])) {
    return ['report-schema-invalid']
  }
  if (
    report.schema !== RECOVERY_REPORT_SCHEMA ||
    report.scenario !== 'packaged-restart-recovery' ||
    !['darwin', 'win32'].includes(report.platform) ||
    !['PASS', 'FAIL'].includes(report.outcome) ||
    !FAILURES.has(report.failure) ||
    !['ACKNOWLEDGED', 'UNACKNOWLEDGED', 'NOT_ATTEMPTED'].includes(report.teardown) ||
    !Array.isArray(report.assertions) ||
    report.assertions.length !== RECOVERY_ASSERTIONS.length
  ) {
    return ['report-schema-invalid']
  }
  const problems = []
  const ids = new Set()
  for (const row of report.assertions) {
    if (!exactKeys(row, ['id', 'status']) || !RECOVERY_ASSERTIONS.includes(row.id) || !ASSERTION_STATUSES.has(row.status)) {
      return ['report-schema-invalid']
    }
    if (ids.has(row.id)) return ['report-schema-invalid']
    ids.add(row.id)
    if (row.status !== 'PASS') problems.push(`${row.id} is ${row.status}, not PASS.`)
  }
  if (ids.size !== RECOVERY_ASSERTIONS.length) return ['report-assertions-incomplete']
  if (report.outcome !== 'PASS') problems.push(`packaged restart recovery outcome is ${report.outcome}.`)
  if (report.teardown !== 'ACKNOWLEDGED') problems.push('isolated app teardown was not acknowledged.')
  if (report.outcome === 'PASS' && problems.length) problems.unshift('PASS report contains incomplete assertions.')
  return problems
}

const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const hostPath = (platform) => (platform === 'win32' ? win32 : posix)

function pathIsInside(root, candidate, platform) {
  const path = hostPath(platform)
  const rel = path.relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

function pathConfinedOrMissing(root, candidate, platform) {
  const path = hostPath(platform)
  if (!pathIsInside(root, candidate, platform)) return false
  const realRoot = realpathSync.native(root)
  let existing = candidate
  for (;;) {
    try {
      const realExisting = realpathSync.native(existing)
      return realExisting === realRoot || pathIsInside(realRoot, realExisting, platform)
    } catch {
      const parent = path.dirname(existing)
      if (parent === existing) return false
      existing = parent
    }
  }
}

function confinedRegularFile(root, candidate, platform) {
  if (!pathIsInside(root, candidate, platform)) return false
  try {
    const stat = lstatSync(candidate)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false
    const realRoot = realpathSync.native(root)
    const realCandidate = realpathSync.native(candidate)
    return pathIsInside(realRoot, realCandidate, platform)
  } catch {
    return false
  }
}

function descendantProcesses(table, mainPid) {
  const main = table.find((entry) => entry.pid === mainPid)
  if (!main) return []
  const byPpid = new Map()
  for (const entry of table) {
    const children = byPpid.get(entry.ppid)
    if (children) children.push(entry)
    else byPpid.set(entry.ppid, [entry])
  }
  const descendants = new Map([[`${main.pid}:${main.startedMs}`, main]])
  const queue = [main]
  while (queue.length) {
    const parent = queue.shift()
    for (const child of byPpid.get(parent.pid) ?? []) {
      if (child.startedMs < parent.startedMs) continue
      const identity = `${child.pid}:${child.startedMs}`
      if (descendants.has(identity)) continue
      descendants.set(identity, child)
      queue.push(child)
    }
  }
  return [...descendants.values()]
}

const processIdentity = (entry) => `${entry.pid}:${entry.startedMs}`

export function mergeOwnedProcessBaselines(launchOwned = [], ownedAtQuit = []) {
  const ownershipByIdentity = new Map()
  for (const entry of [...launchOwned, ...ownedAtQuit]) ownershipByIdentity.set(processIdentity(entry), entry)
  return [...ownershipByIdentity.values()]
}

export function shutdownVerdict({
  censusValid,
  censusCaptured,
  quitAcknowledged,
  naturalExit,
  exitCode,
  signalCode,
  survivorCountAfterGrace,
  survivorCount,
  transportsReleased
}) {
  const childExited = (Number.isSafeInteger(exitCode) && exitCode >= 0) || typeof signalCode === 'string'
  const teardown = censusCaptured && childExited && survivorCount === 0 && transportsReleased
    ? 'ACKNOWLEDGED'
    : 'UNACKNOWLEDGED'
  const clean =
    censusValid &&
    censusCaptured &&
    quitAcknowledged &&
    naturalExit &&
    exitCode === 0 &&
    signalCode === null &&
    survivorCountAfterGrace === 0 &&
    survivorCount === 0 &&
    transportsReleased
  return { clean, teardown }
}

export async function requestQuitAcknowledgement(requestQuit, timeoutMs = 8_000) {
  try {
    await boundedCall(requestQuit, timeoutMs, 'shutdown-unacknowledged')
    return true
  } catch {
    return false
  }
}

export async function releaseCandidateTransports(
  attachment,
  { dispose = disposeFreshOnboardingTransports, timeoutMs = 5_000 } = {}
) {
  const lateReleases = Array.isArray(attachment?.lateReleases) ? [...attachment.lateReleases] : []
  if (typeof attachment?.lateRelease === 'function') lateReleases.push(attachment.lateRelease)
  return dispose(
    {
      browser: attachment?.browser ?? null,
      transportUncertain: attachment?.transportUncertain === true,
      lateReleases
    },
    timeoutMs
  )
}

function createProfile() {
  const root = mkdtempSync(join(tmpdir(), 'metis-packaged-recovery-'))
  const paths = {
    root,
    home: join(root, 'home'),
    userProfile: join(root, 'userprofile'),
    appData: join(root, 'appdata'),
    localAppData: join(root, 'localappdata'),
    temp: join(root, 'tmp'),
    userData: join(root, 'userdata')
  }
  try {
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 })
    if (readdirSync(paths.userData).length !== 0) throw new Error('profile-rejected')
    writeFileSync(
      join(paths.userData, 'settings.json'),
      `${JSON.stringify({ onboardingDone: true, onboardingDoneAt: Date.now(), overlayLayout: 'bar' }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' }
    )
    return paths
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function installedExecutable(appArg, platform) {
  let appPath
  let appStat
  try {
    appPath = resolve(appArg)
    appStat = lstatSync(appPath)
  } catch {
    throw new Error('app-path-rejected')
  }
  if (appStat.isSymbolicLink()) throw new Error('app-path-rejected')
  if (platform === 'darwin') {
    if (!appStat.isDirectory() || !appPath.endsWith('.app')) throw new Error('app-path-rejected')
    const executable = join(appPath, 'Contents', 'MacOS', basename(appPath, '.app'))
    const stat = lstatSync(executable)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('app-path-rejected')
    return { appPath: realpathSync.native(appPath), executable: realpathSync.native(executable) }
  }
  if (!appStat.isFile() || appStat.isSymbolicLink() || !appPath.toLowerCase().endsWith('.exe')) {
    throw new Error('app-path-rejected')
  }
  return { appPath: realpathSync.native(appPath), executable: realpathSync.native(appPath) }
}

function baseAssertions() {
  return Object.fromEntries(RECOVERY_ASSERTIONS.map((id) => [id, 'NOT_RUN']))
}

function reportFrom({ platform, assertions, failure, teardown }) {
  const allPass = RECOVERY_ASSERTIONS.every((id) => assertions[id] === 'PASS')
  return {
    schema: RECOVERY_REPORT_SCHEMA,
    scenario: 'packaged-restart-recovery',
    platform,
    outcome: allPass && failure === 'none' && teardown === 'ACKNOWLEDGED' ? 'PASS' : 'FAIL',
    assertions: RECOVERY_ASSERTIONS.map((id) => ({ id, status: assertions[id] ?? 'NOT_RUN' })),
    failure,
    teardown
  }
}

function fixedFailure(error) {
  const code = typeof error?.message === 'string' ? error.message : ''
  return FAILURES.has(code) && code !== 'none' ? code : 'harness-error'
}

async function twoDifferentPorts() {
  const cdpPort = await freeLoopbackPort()
  for (let attempt = 0; attempt < 4; attempt++) {
    const inspectPort = await freeLoopbackPort()
    if (inspectPort !== cdpPort) return { cdpPort, inspectPort }
  }
  throw new Error('launch-failed')
}

async function launchCandidate({ executable, platform, profile, installRoot }) {
  if (ownedProcesses(listProcesses(platform), { mainPid: null, installRoot, platform }).length) {
    throw new Error('profile-rejected')
  }
  const { cdpPort, inspectPort } = await twoDifferentPorts()
  const env = strictLaunchEnvironment(process.env, profile, platform)
  const launch = launchPackagedCdp({ executablePath: executable, env, cdpPort, inspectPort, platform, spawnProcess: spawn })
  const child = launch.child
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1 || packagedLaunchFailed(child, launch.latches)) {
    throw new Error('launch-failed')
  }
  let browser = null
  let transportUncertain = false
  const lateReleases = []
  try {
    const attached = await attachOwnedCdp({
      endpoint: launch.cdpEndpoint,
      childPid: child.pid,
      timeoutMs: 90_000
    })
    transportUncertain = attached.transportUncertain === true
    if (typeof attached.lateRelease === 'function') lateReleases.push(attached.lateRelease)
    if (!attached.browser) throw new Error(attached.failure ?? 'cdp-attach-failed')
    browser = attached.browser
    const page = await findPage(
      browser,
      (candidate) => candidate.evaluate(() => typeof window.toto?.getSettings === 'function'),
      'candidate-renderer-not-ready',
      90_000
    )
    if (packagedLaunchFailed(child, launch.latches)) throw new Error('launch-failed')
    const processTable = listProcesses(platform)
    const rootResidents = ownedProcesses(processTable, { mainPid: null, installRoot, platform })
    const launchOwned = descendantProcesses(processTable, child.pid)
    const launchTree = new Set(launchOwned.map(processIdentity))
    const mainProcess = rootResidents.find((entry) => entry.pid === child.pid)
    if (
      !mainProcess ||
      !launchTree.has(processIdentity(mainProcess)) ||
      rootResidents.some((entry) => !launchTree.has(processIdentity(entry)))
    ) {
      throw new Error('profile-rejected')
    }
    return { child, browser, page, installRoot, profile, launch, launchOwned, transportUncertain, lateReleases }
  } catch (error) {
    let stopped = child.exitCode != null || child.signalCode != null
    if (!stopped) {
      const receipt = await stopOwnedChild(child, { platform, timeoutMs: 5_000 }).catch(() => ({ state: 'unacknowledged' }))
      stopped = receipt.state === 'acknowledged'
    }
    if (stopped) {
      try {
        const rootResidents = ownedProcesses(listProcesses(platform), { mainPid: null, installRoot, platform })
        if (rootResidents.length) {
          for (const entry of rootResidents) {
            if (entry.pid === process.pid) continue
            try {
              process.kill(entry.pid, 'SIGKILL')
            } catch {
              /* already gone */
            }
          }
          stopped = ownedProcesses(listProcesses(platform), { mainPid: null, installRoot, platform }).length === 0
        }
      } catch {
        stopped = false
      }
    }
    const transportsReleased = await releaseCandidateTransports({ browser, transportUncertain, lateReleases }).catch(() => false)
    if (!stopped || !transportsReleased) {
      const failure = new Error('shutdown-unacknowledged')
      failure.cleanupAcknowledged = false
      throw failure
    }
    const failure = error instanceof Error ? error : new Error('harness-error')
    failure.cleanupAcknowledged = true
    throw failure
  }
}

async function stopCandidate(instance, platform) {
  if (!instance) return { clean: false, teardown: 'NOT_ATTEMPTED' }
  const { child, installRoot } = instance
  let ownedAtQuit = []
  let censusValid = false
  const censusCaptured = Array.isArray(instance.launchOwned) && instance.launchOwned.some((entry) => entry.pid === child.pid)
  let naturalExit = false
  let quitAcknowledged = false
  let survivors = []
  let survivorCountAfterGrace = null
  let processCensusComplete = false
  let transportsReleased = false
  try {
    ownedAtQuit = ownedProcesses(listProcesses(platform), { mainPid: child.pid, installRoot, platform })
    censusValid = ownedAtQuit.some((entry) => entry.pid === child.pid) && ownedAtQuit.length >= 2
    if (censusValid) {
      quitAcknowledged = await requestQuitAcknowledgement(() => instance.page.evaluate(() => window.toto.quit()))
      naturalExit = await waitForChildExit(child, 30_000)
    }
    if (!naturalExit && child.exitCode == null && child.signalCode == null) {
      await stopOwnedChild(child, { platform, timeoutMs: 5_000 })
    }
    await waitForChildExit(child, 5_000)
  } catch {
    try {
      if (child.exitCode == null && child.signalCode == null) {
        await stopOwnedChild(child, { platform, timeoutMs: 5_000 })
      }
    } catch {
      /* Final process census below decides whether teardown can be acknowledged. */
    }
  } finally {
    const ownershipBaseline = mergeOwnedProcessBaselines(instance.launchOwned ?? [], ownedAtQuit)
    try {
      const table = listProcesses(platform)
      survivors = findSurvivors(ownershipBaseline, table, { installRoot, platform })
      processCensusComplete = true
      const survivorDeadline = Date.now() + 5_000
      while (survivors.length && Date.now() < survivorDeadline) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 500))
        survivors = findSurvivors(ownershipBaseline, listProcesses(platform), { installRoot, platform })
      }
      survivorCountAfterGrace = survivors.length
      if (survivors.length) {
        // The entries are derived from this exact child or the installed app's own root; never kill by name.
        for (const entry of survivors) {
          if (entry.pid === process.pid) continue
          try {
            process.kill(entry.pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
          survivors = findSurvivors(ownershipBaseline, listProcesses(platform), { installRoot, platform })
          if (!survivors.length) break
        }
      }
    } catch {
      processCensusComplete = false
      survivors = [{}]
    }
    transportsReleased = await releaseCandidateTransports(instance).catch(() => false)
  }
  const verdict = shutdownVerdict({
    censusValid,
    censusCaptured,
    quitAcknowledged,
    naturalExit,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    survivorCountAfterGrace,
    survivorCount: processCensusComplete ? survivors.length : 1,
    transportsReleased
  })
  return verdict
}

async function writeScenarioSettings(instance) {
  return boundedCall(
    () =>
      instance.page.evaluate(async () => {
        const settings = await window.toto.setSettings({
          overlayLayout: 'bar',
          overlayPlacement: 'top-center',
          autoHideOverlay: false
        })
        return {
          ready:
            settings.overlayLayout === 'bar' &&
            settings.overlayPlacement === 'top-center' &&
            settings.autoHideOverlay === false,
          meetingsFolder: settings.resolvedMeetingsFolder ?? null
        }
      }),
    30_000,
    'storage-api-failed'
  )
}

async function runFirstLaunch(instance, marker) {
  const fixture = {
    title: `Candidate persistence ${marker}`,
    noteTitle: `Candidate note ${marker}`,
    marker
  }
  return boundedCall(
    () =>
      instance.page.evaluate(async ({ title, noteTitle, marker }) => {
        const savedMeeting = await window.toto.saveTranscript({
          title,
          mode: 'meeting',
          startedAt: Date.now() - 60_000,
          recap: `Synthetic restart fixture ${marker}`,
          lines: [
            { speaker: 'you', text: `Synthetic restart fixture ${marker}`, t: 0 },
            { speaker: 'them', text: 'Synthetic follow-up fixture only.', t: 30_000 }
          ]
        })
        const savedNote = await window.toto.saveNote({
          title: noteTitle,
          mode: 'general',
          question: `Synthetic recovery question ${marker}`,
          answer: `Synthetic recovery answer ${marker}`
        })
        const meetingName = String(savedMeeting?.path ?? '').replaceAll('\\', '/').split('/').pop()
        const meetingRead = meetingName ? await window.toto.recallRead(meetingName) : null
        const ready = Boolean(
          savedMeeting?.path &&
            meetingRead?.ok &&
            meetingRead.title === title &&
            meetingRead.lines?.some((line) => line.text.includes(marker)) &&
            savedNote?.path
        )
        return {
          ready,
          meetingPath: savedMeeting?.path ?? null,
          notePath: savedNote?.path ?? null
        }
      }, fixture),
    30_000,
    'storage-api-failed'
  )
}

async function runSecondLaunch(instance, expected, profile) {
  return boundedCall(
    () =>
      instance.page.evaluate(async ({ meetingName, title, marker, placement, layout }) => {
        const settings = await window.toto.getSettings()
        const meetingRead = await window.toto.recallRead(meetingName)
        const inHistory = (await window.toto.recallList()).some((meeting) => meeting.title === title)
        return {
          settingsReady:
            settings.onboardingDone === true &&
            settings.overlayPlacement === placement &&
            settings.overlayLayout === layout &&
            settings.autoHideOverlay === false,
          meetingReady:
            meetingRead?.ok === true &&
            meetingRead.title === title &&
            meetingRead.lines?.some((line) => line.text.includes(marker)),
          historyReady: inHistory
        }
      }, expected),
    30_000,
    'restart-data-missing'
  ).then((result) => {
    const { notePath, noteHash, meetingPath, meetingHash } = expected
    const confined =
      confinedRegularFile(profile.root, notePath, process.platform) &&
      confinedRegularFile(profile.root, meetingPath, process.platform)
    if (!confined) throw new Error('profile-rejected')
    const noteStat = lstatSync(notePath)
    const meetingStat = lstatSync(meetingPath)
    const noteExists = noteStat.isFile() && !noteStat.isSymbolicLink() && noteStat.nlink === 1 && hashFile(notePath) === noteHash
    const meetingExists = meetingStat.isFile() && !meetingStat.isSymbolicLink() && meetingStat.nlink === 1 && hashFile(meetingPath) === meetingHash
    return { ...result, noteReady: noteExists, meetingBytesReady: meetingExists }
  })
}

async function execute({ appArg, platform, out }) {
  const assertions = baseAssertions()
  let failure = 'none'
  let teardown = 'NOT_ATTEMPTED'
  let profile = null
  let instance = null
  let reportPlatform = platform === 'mac' ? 'darwin' : platform === 'win' ? 'win32' : null
  try {
    if (!reportPlatform || process.platform !== reportPlatform) throw new Error('platform-mismatch')
    const installed = installedExecutable(appArg, reportPlatform)
    const installRoot = reportPlatform === 'darwin' ? installed.appPath : dirname(installed.executable)
    profile = createProfile()
    instance = await launchCandidate({ executable: installed.executable, platform: reportPlatform, profile, installRoot })
    const settingsProbe = await writeScenarioSettings(instance)
    const meetingsFolder = typeof settingsProbe.meetingsFolder === 'string' ? resolve(settingsProbe.meetingsFolder) : ''
    if (!settingsProbe.ready || !meetingsFolder || !pathConfinedOrMissing(profile.root, meetingsFolder, reportPlatform)) {
      throw new Error('profile-rejected')
    }
    assertions['isolated-profile'] = 'PASS'
    assertions['settings-written'] = 'PASS'
    const marker = `SYN-${randomUUID()}`
    const first = await runFirstLaunch(instance, marker)
    const meetingPath = resolve(first.meetingPath ?? '')
    const notePath = resolve(first.notePath ?? '')
    if (
      !first.ready ||
      !confinedRegularFile(profile.root, meetingPath, reportPlatform) ||
      !confinedRegularFile(profile.root, notePath, reportPlatform)
    ) {
      throw new Error('storage-api-failed')
    }
    assertions['meeting-saved-and-readable'] = 'PASS'
    assertions['note-saved'] = 'PASS'
    const meetingName = reportPlatform === 'win32' ? win32.basename(meetingPath) : posix.basename(meetingPath)
    const noteHash = hashFile(notePath)
    const meetingHash = hashFile(meetingPath)
    const firstShutdown = await stopCandidate(instance, reportPlatform)
    teardown = firstShutdown.teardown
    assertions['first-shutdown-clean'] = firstShutdown.clean ? 'PASS' : 'FAIL'
    if (firstShutdown.teardown === 'ACKNOWLEDGED') instance = null
    if (!firstShutdown.clean) {
      throw new Error(firstShutdown.teardown === 'ACKNOWLEDGED' ? 'shutdown-not-clean' : 'shutdown-unacknowledged')
    }

    instance = await launchCandidate({ executable: installed.executable, platform: reportPlatform, profile, installRoot })
    const second = await runSecondLaunch(
      instance,
      {
        meetingName,
        title: `Candidate persistence ${marker}`,
        marker,
        placement: 'top-center',
        layout: 'bar',
        notePath,
        noteHash,
        meetingPath,
        meetingHash
      },
      profile
    )
    if (second.meetingReady && second.historyReady && second.meetingBytesReady) {
      assertions['meeting-survives-restart'] = 'PASS'
    }
    if (second.noteReady) assertions['note-survives-restart'] = 'PASS'
    if (second.settingsReady) assertions['settings-survive-restart'] = 'PASS'
    if (
      assertions['meeting-survives-restart'] !== 'PASS' ||
      assertions['note-survives-restart'] !== 'PASS' ||
      assertions['settings-survive-restart'] !== 'PASS'
    ) {
      throw new Error('restart-data-missing')
    }
    const secondShutdown = await stopCandidate(instance, reportPlatform)
    teardown = secondShutdown.teardown
    assertions['second-shutdown-clean'] = secondShutdown.clean ? 'PASS' : 'FAIL'
    if (secondShutdown.teardown === 'ACKNOWLEDGED') instance = null
    if (!secondShutdown.clean) {
      throw new Error(secondShutdown.teardown === 'ACKNOWLEDGED' ? 'shutdown-not-clean' : 'shutdown-unacknowledged')
    }
  } catch (error) {
    failure = fixedFailure(error)
    if (error?.cleanupAcknowledged === true) teardown = 'ACKNOWLEDGED'
    else if (failure === 'shutdown-unacknowledged') teardown = 'UNACKNOWLEDGED'
    if (failure === 'shutdown-unacknowledged') {
      if (assertions['first-shutdown-clean'] === 'NOT_RUN') assertions['first-shutdown-clean'] = 'FAIL'
      else if (assertions['second-shutdown-clean'] === 'NOT_RUN') assertions['second-shutdown-clean'] = 'FAIL'
    }
    if (failure === 'restart-data-missing') {
      for (const id of ['meeting-survives-restart', 'note-survives-restart', 'settings-survive-restart']) {
        if (assertions[id] === 'NOT_RUN') assertions[id] = 'FAIL'
      }
    }
  } finally {
    if (instance) {
      const stopped = await stopCandidate(instance, reportPlatform ?? process.platform)
      teardown = stopped.teardown
      if (stopped.teardown === 'ACKNOWLEDGED') instance = null
      if (!stopped.clean && failure === 'none') {
        failure = stopped.teardown === 'ACKNOWLEDGED' ? 'shutdown-not-clean' : 'shutdown-unacknowledged'
      }
    }
    if (profile && !instance && teardown !== 'UNACKNOWLEDGED') {
      try {
        rmSync(profile.root, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 })
        assertions['isolated-profile-removed'] = 'PASS'
      } catch {
        assertions['isolated-profile-removed'] = 'FAIL'
        failure = failure === 'none' ? 'profile-cleanup-failed' : failure
        teardown = 'UNACKNOWLEDGED'
      }
    } else if (profile) {
      assertions['isolated-profile-removed'] = 'FAIL'
      failure = failure === 'none' ? 'profile-cleanup-failed' : failure
      teardown = 'UNACKNOWLEDGED'
    }
  }
  const report = reportFrom({ platform: reportPlatform ?? 'darwin', assertions, failure, teardown })
  const reportPath = resolve(out)
  if (!pathIsInside(process.cwd(), reportPath, process.platform)) throw new Error('harness-error')
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return report
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith('--') || index + 1 >= argv.length) throw new Error('harness-error')
    values[key.slice(2)] = argv[++index]
  }
  if (!values.app || !['mac', 'win'].includes(values.platform) || !values.out) throw new Error('harness-error')
  return { appArg: values.app, platform: values.platform, out: values.out }
}

async function main(argv) {
  const options = parseArgs(argv)
  const report = await execute(options)
  process.stdout.write(`packaged-restart-recovery ${report.outcome} ${report.failure}\n`)
  process.exitCode = report.outcome === 'PASS' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stdout.write('packaged-restart-recovery FAIL harness-error\n')
    process.exitCode = 1
  })
}
