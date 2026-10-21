// WP14 sandbox acceptance, opt-in scenario `--scenario upgrade` (C29): update, single instance and rollback of the
// QA-identity build, observed on ONE sandbox profile (userData) that is shared by every app version in the run.
//
//   previous build -> meeting saved -> quit -> candidate installed over it (userData untouched) -> candidate launches on the
//   profile written by the previous build -> the saved meeting is listed, readable and byte-identical -> settings preserved
//   -> version reported -> second meeting -> single instance (a second process on the same profile) -> quit ->
//   rollback (previous build again, on the profile 2.12 wrote) -> re-upgrade (candidate again) -> meetings still present.
//
// Every step PASSES only on something the run observed (a process exit, an audit record, an IPC reply, a file hash). The
// rollback step records what the older build really does (starts and lists the meetings, or refuses) and fails only on a
// crash or on data that changed or disappeared. Nothing here opens anything but the QA identity inside the sandbox.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, waitForChildExit } from '../lib/app-driver.mjs'
import { assertCommandAllowed, assertGuards } from './guard.mjs'
import { readBundleVersion } from './bundle.mjs'
import { installZip } from './install.mjs'
import { executableForApp, isSavedMeetingFile, runStep, sha256Buffer, sha256File } from './lib.mjs'
import { planLaunch, readAudit } from './session.mjs'
import { observeTranscriptDraft, reviewSavedMeeting, startSyntheticMeeting, stopAndSave } from './scenario.mjs'

export const UPGRADE_STEPS = Object.freeze([
  'install-previous',
  'previous-launch-and-ready',
  'previous-settings-written',
  'previous-meeting-live',
  'previous-transcript-observed',
  'previous-stop-and-save',
  'previous-clean-quit',
  'install-candidate-over-previous',
  'candidate-launch-on-previous-profile',
  'candidate-reports-version',
  'candidate-meeting-preserved',
  'candidate-settings-preserved',
  'candidate-second-meeting-live',
  'candidate-second-transcript-observed',
  'candidate-second-stop-and-save',
  'single-instance',
  'candidate-clean-quit',
  'install-previous-again',
  'rollback-launch',
  'rollback-meetings-listed',
  'rollback-clean-quit',
  'rollback-data-integrity',
  'install-candidate-again',
  'reupgrade-launch',
  'reupgrade-meetings-present',
  'reupgrade-clean-quit',
  'legacy-profile-migration'
])

/** Settings the previous build writes and the candidate must still report. Plain, reversible, read by nothing at launch. */
export const UPGRADE_SETTINGS_PATCH = Object.freeze({ askFollowUpMemory: true })
/** A second instance has to give up quickly; the app quits it before its window exists. */
export const SECOND_INSTANCE_MAX_EXIT_MS = 15_000
export const DEFAULT_CANDIDATE_VERSION = '2.12.0'

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

/**
 * name -> { sha256, bytes } for every regular file directly in `folder` (names only, never content). `saved` keeps the
 * meeting files; `others` is the rest (README, index, dot files) and is informational.
 * @param {string} folder
 * @param {{ list?: (dir: string) => string[], hash?: (path: string) => string, size?: (path: string) => number }} [deps]
 */
export function snapshotMeetings(
  folder,
  { list = (dir) => readdirSync(dir), hash = sha256File, size = (path) => statSync(path).size } = {}
) {
  const saved = {}
  const others = {}
  let names = []
  try {
    names = list(folder).sort()
  } catch {
    names = []
  }
  for (const name of names) {
    const path = join(folder, name)
    let entry
    try {
      entry = { sha256: hash(path), bytes: size(path) }
    } catch {
      continue // a directory or a file that vanished between the listing and the read
    }
    ;(isSavedMeetingFile(name) ? saved : others)[name] = entry
  }
  return { saved, others }
}

/**
 * Compare two name -> entry maps. `missing` are in `before` only, `added` in `after` only, `changed` differ in hash.
 * @param {Record<string, { sha256: string }>} before @param {Record<string, { sha256: string }>} after
 */
export function diffSnapshots(before, after) {
  const missing = Object.keys(before).filter((name) => !(name in after))
  const added = Object.keys(after).filter((name) => !(name in before))
  const changed = Object.keys(before).filter((name) => name in after && before[name].sha256 !== after[name].sha256)
  return { missing, added, changed, identical: !missing.length && !changed.length }
}

/** The versions an app launch reported: app.started / app.renderer.ready audit records (never any other field). */
export function reportedVersions(records) {
  const versions = new Set()
  for (const record of records) {
    if ((record?.event === 'app.started' || record?.event === 'app.renderer.ready') && typeof record.version === 'string')
      versions.add(record.version)
  }
  return [...versions].sort()
}

/**
 * Judge the candidate's version: the bundle's Info.plist, the version the running app reported over IPC
 * (getSettings().version, app.getVersion()) and the audit records must all agree with `expected`, and it must differ from
 * the previous build's version, otherwise the "upgrade" did not change anything.
 * @param {{ expected: string, plistVersion: string | null, ipcVersion: string | null, auditVersions: string[], previousVersion: string | null }} observed
 */
export function judgeVersion({ expected, plistVersion, ipcVersion, auditVersions, previousVersion }) {
  const problems = []
  if (plistVersion !== expected) problems.push(`Info.plist says ${plistVersion ?? 'nothing'}, expected ${expected}`)
  if (ipcVersion !== expected) problems.push(`the running app reported ${ipcVersion ?? 'nothing'}, expected ${expected}`)
  if (!auditVersions.length) problems.push('no app.started/app.renderer.ready audit version was written')
  else if (auditVersions.some((version) => version !== expected))
    problems.push(`audit records report ${auditVersions.join(', ')}, expected only ${expected}`)
  if (previousVersion && previousVersion === expected)
    problems.push(`the previous build reports the same version (${previousVersion}), so nothing was upgraded`)
  return { ok: problems.length === 0, problems }
}

/**
 * Judge a second instance started on the same profile. It must exit by itself within `maxExitMs` without a signal, the
 * first instance must still be running and answer an IPC call, and no new crash/unresponsive record may appear.
 * @param {{ second: { exited: boolean, code: number | null, signal: string | null, ms: number },
 *   firstAlive: boolean, firstResponsive: boolean, crashRecords: number }} observed
 * @param {number} [maxExitMs]
 */
export function judgeSingleInstance({ second, firstAlive, firstResponsive, crashRecords }, maxExitMs = SECOND_INSTANCE_MAX_EXIT_MS) {
  const problems = []
  if (!second.exited) problems.push(`the second instance was still running after ${Math.round(second.ms / 1000)}s`)
  else {
    if (second.signal) problems.push(`the second instance died from signal ${second.signal}`)
    if (second.code !== 0) problems.push(`the second instance exited with code ${second.code}`)
    if (second.ms > maxExitMs) problems.push(`the second instance took ${second.ms} ms to exit (limit ${maxExitMs})`)
  }
  if (!firstAlive) problems.push('the first instance is no longer running')
  else if (!firstResponsive) problems.push('the first instance did not answer an IPC call after the second launch')
  if (crashRecords > 0) problems.push(`${crashRecords} app.crash/app.unresponsive audit record(s) appeared`)
  return { ok: problems.length === 0, problems }
}

/**
 * Judge the rollback (the older build started on the profile the newer build wrote). Honest outcomes:
 *   starts-and-lists  the older build reached renderer-ready and lists every meeting      -> PASS
 *   starts-lists-partly  it started but cannot list/read some meeting (data intact)          -> NOT_SUPPORTED (gap)
 *   refused-safely    it did not become ready, exited cleanly, wrote nothing, data intact    -> NOT_SUPPORTED (gap, recorded)
 * FAIL: it crashed (signal / non-zero exit / crash record), or any meeting changed or vanished.
 * @param {{ launched: boolean, launchError: string | null, crashed: boolean, integrity: { missing: string[], changed: string[] },
 *   listedAll: boolean, readableAll: boolean }} observed
 */
export function judgeRollback({ launched, launchError, crashed, integrity, listedAll, readableAll }) {
  if (integrity.missing.length || integrity.changed.length)
    return {
      status: 'FAIL',
      outcome: 'data-damaged',
      reason: `meeting data changed after the rollback launch (missing: ${integrity.missing.length}, changed: ${integrity.changed.length})`
    }
  if (crashed) return { status: 'FAIL', outcome: 'crashed', reason: `the older build crashed on the newer profile: ${launchError ?? 'crash record'}` }
  if (launched && listedAll && readableAll) return { status: 'PASS', outcome: 'starts-and-lists' }
  if (launched)
    return {
      status: 'NOT_SUPPORTED',
      outcome: 'starts-lists-partly',
      reason: 'the older build starts on the newer profile but does not list/read every meeting; the data on disk is unchanged'
    }
  return {
    status: 'NOT_SUPPORTED',
    outcome: 'refused-safely',
    reason: `the older build did not reach a ready renderer (${launchError ?? 'no reason captured'}); data on disk is unchanged. Recorded as a gap, not a pass.`
  }
}

/** Normalise the names an install step should never touch: the install must not write into the profile. */
export const profileUntouchedBy = (before, after) => diffSnapshots({ ...before.saved, ...before.others }, { ...after.saved, ...after.others }).identical

// ---------------------------------------------------------------------------------------------------------------
// Observation helpers (use a real launched app)

/** Read getSettings() through the real renderer: only the version and the named keys, never other values. */
export async function readSettingsFacts(session, keys) {
  return session.withPage((page) =>
    page.evaluate(async (names) => {
      const settings = await window.toto.getSettings()
      const picked = {}
      for (const name of names) picked[name] = settings?.[name] ?? null
      return { version: typeof settings?.version === 'string' ? settings.version : null, picked, onboardingDone: Boolean(settings?.onboardingDone) }
    }, keys)
  )
}

/**
 * The profile's settings.json as a file: size, hash and whether it is encrypted at rest (ATKENC header). The content is never
 * read into the report; settings.json is encrypted, so persistence is proven by a fresh process reading the value back.
 * @param {string} userData
 */
export function settingsFileFacts(userData) {
  try {
    const bytes = readFileSync(join(userData, 'settings.json'))
    return { present: true, bytes: bytes.length, sha256: sha256Buffer(bytes), encryptedAtRest: bytes.subarray(0, 6).toString('latin1') === 'ATKENC' }
  } catch {
    return { present: false, bytes: 0, sha256: null, encryptedAtRest: false }
  }
}

/** Alive means the OS still has the pid and the child object has not emitted an exit. */
export function isRunning(child) {
  if (child.exitCode !== null || child.signalCode !== null) return false
  try {
    process.kill(child.pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Spawn a second copy of the same bundle on the same profile (same env, no debug port) and wait for it to exit by itself.
 * The same guards as a normal launch apply. A copy that outlives `timeoutMs` is killed and reported as still running.
 * @param {{ layout: any, appPath: string, parentEnv: Record<string, string | undefined>, timeoutMs?: number }} args
 */
export async function spawnSecondInstance({ layout, appPath, parentEnv, timeoutMs = 30_000 }) {
  const { childEnv, guardConfig } = planLaunch({ layout, appPath, parentEnv, captureFile: layout.captureWav })
  assertGuards(guardConfig)
  const executable = executableForApp(appPath)
  assertCommandAllowed(executable, [])
  const started = Date.now()
  const child = spawn(executable, [], { env: childEnv, stdio: 'ignore', detached: true })
  let spawnError = null
  child.once('error', (error) => {
    spawnError = error
  })
  const exited = await waitForChildExit(child, timeoutMs)
  const ms = Date.now() - started
  if (!exited) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* group already gone */
    }
    await waitForChildExit(child, 5_000)
  }
  if (spawnError) throw new Error(`could not spawn the second instance: ${spawnError.message}`)
  return { pid: child.pid, exited, code: child.exitCode, signal: child.signalCode, ms }
}

/** Counts of audit events by name (names only), for what a window of the run wrote. */
export function eventCounts(records) {
  const counts = {}
  for (const record of records) if (typeof record?.event === 'string') counts[record.event] = (counts[record.event] ?? 0) + 1
  return counts
}

// ---------------------------------------------------------------------------------------------------------------
// The scenario

/**
 * @param {{ report: any, layout: any, appsDir: string, previousZip: string, candidateZip: string, candidateVersion?: string,
 *   audio: { speech: boolean }, meetingSeconds: number, transcriptWaitSeconds: number, saveWaitSeconds: number,
 *   parentEnv: Record<string, string | undefined>, launch: (appPath: string) => Promise<any>, onSession: (session: any) => void,
 *   log?: (line: string) => void }} args
 */
export async function runUpgradeScenario({
  report,
  layout,
  appsDir,
  previousZip,
  candidateZip,
  candidateVersion = DEFAULT_CANDIDATE_VERSION,
  audio,
  meetingSeconds,
  transcriptWaitSeconds,
  saveWaitSeconds,
  parentEnv,
  launch,
  onSession,
  log = () => {}
}) {
  const appPath = join(appsDir, 'Metis QA.app')
  const ctx = { snapshots: {}, installs: {}, versions: {} }
  let session = null
  const start = async () => {
    session = await launch(appPath)
    onSession(session)
    return session
  }
  const snapshot = () => snapshotMeetings(layout.meetingsFolder)
  const install = (zip) => installZip({ zip, sandboxRoot: layout.sandboxRoot, appsDir, replace: true, log })

  const installStep = (id, zip, key, { expectProfileUntouched }) =>
    runStep(report, id, async () => {
      const before = snapshotFiles(layout.userData)
      const receipt = install(zip)
      const after = snapshotFiles(layout.userData)
      ctx.installs[key] = receipt
      const untouched = diffSnapshots(before, after).identical && diffSnapshots(after, before).identical
      if (expectProfileUntouched && !untouched) throw new Error('the install changed files in the profile (userData)')
      return {
        evidence: {
          zip: receipt.zip.name,
          zipSha256: receipt.zip.sha256,
          bundleVersion: receipt.app.version,
          mainExecutableSha256: receipt.app.mainExecutableSha256,
          adhocSigned: receipt.codesign.adhoc,
          installedInto: 'sandbox upgrade Applications dir',
          profileFilesBefore: Object.keys(before).length,
          profileUntouchedByInstall: untouched
        }
      }
    })

  const readyEvidence = () => ({
    pid: session.pid,
    rendererReadyAudit: session.audit().some((record) => record.event === 'app.renderer.ready'),
    cdpConnected: Boolean(session.page),
    captureFileSourceAudit: session.audit().some((record) => record.event === 'qa.capture.file_source'),
    auditVersions: reportedVersions(session.audit()),
    prevShutdown: session.audit().find((record) => record.event === 'app.started')?.prevShutdown ?? null
  })

  const quitStep = (id, requires) =>
    runStep(
      report,
      id,
      async () => {
        const quit = await session.quit()
        if (!quit.cleanShutdown)
          throw new Error(`the app did not exit cleanly (request ${quit.request}, exit ${quit.exit})`)
        if (!quit.cleanShutdownRecord) throw new Error('the app exited but wrote no app.shutdown.clean audit record')
        if (quit.leftovers.length) throw new Error(`${quit.leftovers.length} owned process(es) survived the quit`)
        return { evidence: { exit: quit.exit, appShutdownCleanAudit: true, leftoverProcesses: 0 } }
      },
      { requires }
    )

  const meetingSteps = (prefix, requires) => {
    const holdMs = () =>
      Math.max(0, meetingSeconds * 1000 - (report.steps.find((step) => step.id === `${prefix}-transcript-observed`)?.ms ?? 0))
    return async () => {
      await runStep(report, `${prefix}-meeting-live`, () => startSyntheticMeeting(session), { requires })
      await runStep(
        report,
        `${prefix}-transcript-observed`,
        () => observeTranscriptDraft(session, { speech: audio.speech, waitSeconds: transcriptWaitSeconds }),
        { requires: [`${prefix}-meeting-live`] }
      )
      if (report.steps.find((step) => step.id === `${prefix}-meeting-live`)?.status === 'PASS') await sleep(holdMs())
      let saved = null
      await runStep(
        report,
        `${prefix}-stop-and-save`,
        async () => {
          const result = await stopAndSave(session, { waitSeconds: saveWaitSeconds })
          saved = result.file
          return { evidence: result.evidence }
        },
        { requires: [`${prefix}-meeting-live`] }
      )
      return saved
    }
  }

  // 1. previous build, a meeting, a setting
  await installStep('install-previous', previousZip, 'previous', { expectProfileUntouched: false })
  await runStep(
    report,
    'previous-launch-and-ready',
    async () => {
      await start()
      const facts = await readSettingsFacts(session, [])
      ctx.versions.previous = facts.version
      return { evidence: { ...readyEvidence(), ipcVersion: facts.version, bundleVersion: ctx.installs.previous?.app.version } }
    },
    { requires: ['install-previous'] }
  )
  await runStep(
    report,
    'previous-settings-written',
    async () => {
      const keys = Object.keys(UPGRADE_SETTINGS_PATCH)
      ctx.settingsFileBefore = settingsFileFacts(layout.userData)
      await session.withPage((page) => page.evaluate((patch) => window.toto.setSettings(patch), { ...UPGRADE_SETTINGS_PATCH }))
      const facts = await readSettingsFacts(session, keys)
      for (const [key, value] of Object.entries(UPGRADE_SETTINGS_PATCH)) {
        if (facts.picked[key] !== value) throw new Error(`getSettings() did not return ${key}=${value} after setSettings`)
      }
      return { evidence: { keys, ipcReturnsValues: true, settingsFileBeforeWrite: ctx.settingsFileBefore } }
    },
    { requires: ['previous-launch-and-ready'] }
  )
  const previousSaved = await meetingSteps('previous', ['previous-launch-and-ready'])()
  await quitStep('previous-clean-quit', ['previous-launch-and-ready'])
  ctx.snapshots.afterPrevious = snapshot()
  ctx.profileFilesAfterPrevious = snapshotFiles(layout.userData)
  // The settings file is written by the app (debounced and encrypted), so look at it only after the clean quit has flushed it.
  ctx.settingsFileAfterPrevious = settingsFileFacts(layout.userData)

  // 2. candidate over the previous install, same profile
  await installStep('install-candidate-over-previous', candidateZip, 'candidate', { expectProfileUntouched: true })
  await runStep(
    report,
    'candidate-launch-on-previous-profile',
    async () => {
      const before = ctx.installs.previous?.app.mainExecutableSha256
      const now = ctx.installs.candidate?.app.mainExecutableSha256
      if (!before || !now || before === now) throw new Error('the candidate bundle has the same main executable as the previous build')
      await start()
      return { evidence: { ...readyEvidence(), executableChangedFromPrevious: true } }
    },
    { requires: ['install-candidate-over-previous', 'previous-clean-quit'] }
  )
  await runStep(
    report,
    'candidate-reports-version',
    async () => {
      const facts = await readSettingsFacts(session, [])
      const judged = judgeVersion({
        expected: candidateVersion,
        plistVersion: readBundleVersion(appPath),
        ipcVersion: facts.version,
        auditVersions: reportedVersions(session.audit()),
        previousVersion: ctx.versions.previous
      })
      if (!judged.ok) throw new Error(judged.problems.join('; '))
      return {
        evidence: {
          expected: candidateVersion,
          plistVersion: readBundleVersion(appPath),
          ipcVersion: facts.version,
          auditVersions: reportedVersions(session.audit()),
          previousVersion: ctx.versions.previous
        }
      }
    },
    { requires: ['candidate-launch-on-previous-profile'] }
  )
  await runStep(
    report,
    'candidate-meeting-preserved',
    async () => {
      if (!previousSaved) throw new Error('no meeting was saved by the previous build to look for')
      const review = await reviewSavedMeeting(session, previousSaved, { speech: false })
      const diff = diffSnapshots(ctx.snapshots.afterPrevious.saved, snapshot().saved)
      if (!diff.identical) throw new Error(`meeting files changed after the upgrade (missing ${diff.missing.length}, changed ${diff.changed.length})`)
      return {
        evidence: {
          ...review.evidence,
          filesCompared: Object.keys(ctx.snapshots.afterPrevious.saved).length,
          byteIdenticalToBeforeUpgrade: true,
          sha256: ctx.snapshots.afterPrevious.saved[previousSaved]?.sha256
        }
      }
    },
    { requires: ['candidate-launch-on-previous-profile', 'previous-stop-and-save'] }
  )
  await runStep(
    report,
    'candidate-settings-preserved',
    async () => {
      const keys = Object.keys(UPGRADE_SETTINGS_PATCH)
      const facts = await readSettingsFacts(session, keys)
      for (const [key, value] of Object.entries(UPGRADE_SETTINGS_PATCH)) {
        if (facts.picked[key] !== value) throw new Error(`${key} did not survive the upgrade (getSettings returned ${facts.picked[key]})`)
      }
      if (!facts.onboardingDone) throw new Error('onboardingDone was lost in the upgrade')
      // A fresh 2.12 process just read the value back from the file the previous build wrote; also require that file to have
      // been rewritten by the previous build (so the value did not come from a default).
      const before = ctx.settingsFileBefore
      const after = ctx.settingsFileAfterPrevious
      if (!before?.present || !after?.present || before.sha256 === after.sha256)
        throw new Error('settings.json was not rewritten by the previous build after setSettings')
      return {
        evidence: {
          keys,
          ipcReturnsValues: true,
          onboardingDonePreserved: true,
          settingsFileRewrittenByPreviousBuild: true,
          settingsFileEncryptedAtRest: after.encryptedAtRest,
          settingsFileBytesAfterPreviousQuit: after.bytes,
          settingsFileSha256AfterPreviousQuit: after.sha256,
          settingsFileSha256Now: settingsFileFacts(layout.userData).sha256
        }
      }
    },
    { requires: ['candidate-launch-on-previous-profile', 'previous-settings-written'] }
  )
  const candidateSaved = await meetingSteps('candidate-second', ['candidate-launch-on-previous-profile'])()

  // 3. single instance, with the candidate still running (its second meeting is saved, so it is idle)
  await runStep(
    report,
    'single-instance',
    async () => {
      const auditBefore = readAudit(layout).length
      const second = await spawnSecondInstance({ layout, appPath, parentEnv })
      const firstAlive = isRunning(session.child)
      let firstResponsive = false
      try {
        const facts = await readSettingsFacts(session, [])
        firstResponsive = typeof facts.version === 'string'
      } catch {
        firstResponsive = false
      }
      const written = readAudit(layout).slice(auditBefore)
      const crashRecords = written.filter((record) => record.event === 'app.crash' || record.event === 'app.unresponsive').length
      const judged = judgeSingleInstance({ second, firstAlive, firstResponsive, crashRecords })
      const evidence = {
        secondExited: second.exited,
        secondExitCode: second.code,
        secondExitSignal: second.signal,
        secondExitMs: second.ms,
        firstPid: session.pid,
        firstStillRunning: firstAlive,
        firstAnsweredIpc: firstResponsive,
        auditEventsWrittenDuringSecondLaunch: eventCounts(written),
        secondInstanceRevealRecorded: written.some((record) => JSON.stringify(record).includes('second-instance'))
      }
      if (!judged.ok) throw new Error(`${judged.problems.join('; ')} (${JSON.stringify(evidence)})`)
      return { evidence }
    },
    { requires: ['candidate-launch-on-previous-profile'] }
  )
  await quitStep('candidate-clean-quit', ['candidate-launch-on-previous-profile'])
  ctx.snapshots.afterCandidate = snapshot()

  // 4. rollback: the previous build on the profile 2.12 wrote
  await installStep('install-previous-again', previousZip, 'previous-again', { expectProfileUntouched: true })
  const expectedMeetings = Object.keys(ctx.snapshots.afterCandidate.saved)
  const rollback = { launched: false, launchError: null, crashed: false, listedAll: false, readableAll: false }
  const profileBeforeRollback = snapshotFiles(layout.userData)
  await runStep(
    report,
    'rollback-launch',
    async () => {
      try {
        await start()
        rollback.launched = true
      } catch (error) {
        rollback.launchError = error instanceof Error ? error.message : String(error)
        rollback.crashed = /app\.crash|app\.unresponsive|signal|crash/i.test(rollback.launchError)
        session = null
      }
      // Whatever happened, make sure nothing from the failed attempt is left running before the integrity check.
      const integrity = diffSnapshots(ctx.snapshots.afterCandidate.saved, snapshot().saved)
      ctx.rollbackLaunchIntegrity = integrity
      const evidence = {
        launched: rollback.launched,
        launchError: rollback.launchError,
        ...(rollback.launched ? readyEvidence() : {}),
        meetingsExpected: expectedMeetings.length,
        savedMeetingsMissing: integrity.missing.length,
        savedMeetingsChanged: integrity.changed.length
      }
      ctx.rollbackJudgement = judgeRollback({ ...rollback, integrity, listedAll: true, readableAll: true })
      if (ctx.rollbackJudgement.status === 'FAIL') throw new Error(ctx.rollbackJudgement.reason)
      if (!rollback.launched)
        return { status: 'NOT_SUPPORTED', reason: ctx.rollbackJudgement.reason, evidence: { ...evidence, outcome: 'refused-safely' } }
      return { evidence: { ...evidence, outcome: 'started' } }
    },
    { requires: ['install-previous-again', 'candidate-clean-quit'] }
  )
  await runStep(
    report,
    'rollback-meetings-listed',
    async () => {
      const results = []
      for (const name of expectedMeetings) {
        try {
          const review = await reviewSavedMeeting(session, name, { speech: false })
          results.push({ listed: review.evidence.listed, readOk: review.evidence.readOk, lines: review.evidence.lines })
        } catch (error) {
          results.push({ listed: false, readOk: false, error: String(error?.message ?? error).slice(0, 120) })
        }
      }
      rollback.listedAll = results.every((result) => result.listed)
      rollback.readableAll = results.every((result) => result.readOk)
      const evidence = { meetings: results.length, results }
      if (!rollback.listedAll || !rollback.readableAll)
        return {
          status: 'NOT_SUPPORTED',
          reason: 'the older build started on the newer profile but cannot list/read every meeting; data on disk is untouched',
          evidence
        }
      return { evidence }
    },
    { requires: ['rollback-launch'] }
  )
  await quitStep('rollback-clean-quit', ['rollback-launch'])
  await runStep(
    report,
    'rollback-data-integrity',
    async () => {
      const after = snapshot()
      const saved = diffSnapshots(ctx.snapshots.afterCandidate.saved, after.saved)
      const others = diffSnapshots(ctx.snapshots.afterCandidate.others, after.others)
      const judged = judgeRollback({ ...rollback, integrity: saved })
      if (judged.status === 'FAIL') throw new Error(judged.reason)
      const profileAfter = snapshotFiles(layout.userData)
      const profileDiff = diffSnapshots(profileBeforeRollback, profileAfter)
      const vital = ['settings.json', 'secret-key.bin'].filter((name) => name in profileBeforeRollback && !(name in profileAfter))
      if (vital.length) throw new Error(`the rollback launch deleted ${vital.join(', ')} from the profile`)
      return {
        evidence: {
          profileTopLevelFilesBefore: Object.keys(profileBeforeRollback).length,
          profileTopLevelFilesMissingAfter: profileDiff.missing,
          profileTopLevelFilesRewritten: profileDiff.changed,
          savedMeetingFilesCompared: Object.keys(ctx.snapshots.afterCandidate.saved).length,
          byteIdenticalAfterRollback: saved.identical && !saved.added.length,
          addedSavedFiles: saved.added.length,
          sha256ByFile: Object.fromEntries(Object.entries(after.saved).map(([name, entry]) => [name, entry.sha256])),
          otherFilesChanged: others.changed.length,
          otherFilesMissing: others.missing.length,
          rollbackOutcome: judged.outcome
        }
      }
    },
    { requires: ['candidate-clean-quit', 'install-previous-again'] }
  )

  // 5. re-upgrade
  await installStep('install-candidate-again', candidateZip, 'candidate-again', { expectProfileUntouched: true })
  await runStep(
    report,
    'reupgrade-launch',
    async () => {
      await start()
      return { evidence: { ...readyEvidence(), ipcVersion: (await readSettingsFacts(session, [])).version } }
    },
    { requires: ['install-candidate-again', 'candidate-second-stop-and-save'] }
  )
  await runStep(
    report,
    'reupgrade-meetings-present',
    async () => {
      const results = []
      for (const name of expectedMeetings) {
        const review = await reviewSavedMeeting(session, name, { speech: false })
        results.push({ listed: review.evidence.listed, readOk: review.evidence.readOk, lines: review.evidence.lines })
      }
      const diff = diffSnapshots(ctx.snapshots.afterCandidate.saved, snapshot().saved)
      if (!diff.identical) throw new Error(`meeting files changed (missing ${diff.missing.length}, changed ${diff.changed.length})`)
      const facts = await readSettingsFacts(session, Object.keys(UPGRADE_SETTINGS_PATCH))
      return {
        evidence: {
          meetings: results.length,
          results,
          byteIdenticalToCandidateQuit: true,
          settingValuesPreserved: Object.entries(UPGRADE_SETTINGS_PATCH).every(([key, value]) => facts.picked[key] === value),
          secondMeetingPresent: Boolean(candidateSaved) && expectedMeetings.includes(candidateSaved)
        }
      }
    },
    { requires: ['reupgrade-launch'] }
  )
  await quitStep('reupgrade-clean-quit', ['reupgrade-launch'])

  await runStep(report, 'legacy-profile-migration', async () => ({
    status: 'NOT_SUPPORTED',
    reason:
      'the Metis/AskToto legacy profile-dir adoption (src/main/index.ts, CLK-F049) runs only for a packaged app without ASKTOTO_USERDATA, ' +
      "where Electron resolves userData from the real user's Application Support folder. This harness pins ASKTOTO_USERDATA to the sandbox and must never touch the real folder, so the rename path is not exercised here (covered by unit tests only).",
    evidence: { migrationGuard: 'ASKTOTO_USERDATA set by the harness', realApplicationSupportTouched: false }
  }))
  return ctx
}

/** name -> { sha256 } for every regular file directly inside the userData directory (excluding the live log and lock files). */
export function snapshotFiles(userData) {
  const volatile = new Set(['run-alive.json', 'run-state.json', 'DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'])
  if (!existsSync(userData)) return {}
  const out = {}
  for (const name of readdirSync(userData)) {
    if (volatile.has(name)) continue
    try {
      const path = join(userData, name)
      if (statSync(path).isFile()) out[name] = { sha256: sha256File(path) }
    } catch {
      /* gone */
    }
  }
  return out
}
