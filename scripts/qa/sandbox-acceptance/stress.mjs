// WP14 sandbox acceptance, opt-in scenario `--scenario stress` (C31): eight stress cases against the installed QA-identity build,
// each a real observation (audit records, files on disk with sha256, process liveness, renderer round-trip latency over CDP).
//
//   S1 start/stop spam   S2 kill -9 mid-meeting   S3 kill -9 during save   S4 relaunch loop
//   S5 many meetings     S6 settings churn        S7 long meeting memory   S8 overlay click spam
//
// Everything runs through the same guarded launch as the other scenarios (session.mjs: direct spawn, strict child env, sandbox
// profile, loopback CDP). The app is installed into its own `<sandbox>/stress/<run-id>/Applications`, and each case gets its own
// throwaway profile `<sandbox>/acceptance/<run-id>-<case>` (S8 reuses S5's, which already holds meetings). A case that finds a
// product defect reports FAIL with the exact evidence; nothing here fixes or masks one. Only processes this harness spawned are
// ever signalled, by pid and process group, never by name. Synthetic audio only (the QA build's file-fed microphone).
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { killOwned, sleep, waitFor, waitForChildExit, withTimeout } from '../lib/app-driver.mjs'
import { assertWritableInSandbox } from './guard.mjs'
import { installZip } from './install.mjs'
import { isDraftMeetingFile, listMeetingFiles, runStep, sandboxLayout, sha256File } from './lib.mjs'
import { assertSyntheticCaptureActive, startSyntheticMeeting, stopAndSave } from './scenario.mjs'
import { countByKind, sampleTree, totalRss } from './sampler.mjs'
import { launchApp, prepareProfile } from './session.mjs'
import { dispatchKeyEvents, escapeKeyEvents, settingsShortcutEvents } from './settings-hig.mjs'
import { isRunning, settingsFileFacts, snapshotMeetings } from './upgrade.mjs'
import {
  CASE_STEPS,
  MIB,
  MINUTE_MS,
  OVERLAY_ACTIONS,
  bootMsFromAudit,
  caseTable,
  churnSequence,
  classifyAudit,
  classifyFolder,
  directoryBytes,
  expectedAfterClicks,
  fatalProblems,
  judgeKillRecovery,
  judgeOverlaySpam,
  judgeRelaunchLoop,
  judgeSettingsChurn,
  judgeSizes,
  judgeSpam,
  latencyProblems,
  profileCensus,
  rssGrowth,
  spamGaps,
  startupStats,
  summarizeLatency
} from './stress-lib.mjs'

const SETTINGS = Object.freeze([
  { key: 'privateView', label: 'Private View' },
  { key: 'screenAsk', label: 'Let Métis see your screen on request' },
  { key: 'askFollowUpMemory', label: 'Carry context into follow-up questions' },
  { key: 'recordingConsent', label: 'I will inform participants before recording' },
  { key: 'redactSensitive', label: 'Redact secrets before sending to AI' }
])
const PROCESS_ALLOWANCE = 4 // ASR, speaker and audio helpers may appear while a meeting runs (SOAK-ACCEPT-1's meeting allowance)

// ---------------------------------------------------------------------------------------------------------------
// Generic helpers

/** Evidence with problems: a FAIL carries the evidence it was judged on, so triage never needs a re-run. */
const outcome = (problems, evidence) =>
  problems.length ? { status: 'FAIL', reason: problems.join('; '), evidence } : { evidence }

const profileFilesOf = (layout) => {
  const census = profileCensus(layout.userData)
  return {
    topLevel: census.topLevel,
    files: census.files,
    bytes: census.bytes,
    auditBytes: census.auditBytes,
    crashFiles: census.crashFiles
  }
}

/** A short-lived observer: one CDP Runtime.evaluate round trip every `intervalMs`, each with its own 2 s deadline. */
async function startLatencyMonitor(page, { intervalMs = 150, timeoutMs = 2000 } = {}) {
  const cdp = await page.context().newCDPSession(page)
  const samples = []
  let stopped = false
  let consecutiveErrors = 0
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now()
      try {
        await withTimeout(
          cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }),
          timeoutMs,
          'probe-timeout'
        )
        samples.push({ ms: Date.now() - started })
        consecutiveErrors = 0
      } catch (error) {
        const timedOut = String(error?.message).includes('probe-timeout')
        samples.push({
          ms: null,
          timedOut,
          error: timedOut ? 'timeout' : String(error?.message ?? error).slice(0, 120)
        })
        consecutiveErrors = timedOut ? 0 : consecutiveErrors + 1
        if (consecutiveErrors >= 3) break
      }
      await sleep(intervalMs)
    }
  })()
  return {
    samples,
    async stop() {
      stopped = true
      await loop
      await cdp.detach().catch(() => {})
      return summarizeLatency(samples, timeoutMs)
    }
  }
}

/** One evaluate round trip; ms is null when it did not answer within `timeoutMs`. */
async function probeOnce(page, timeoutMs = 2000) {
  const started = Date.now()
  try {
    await withTimeout(
      page.evaluate(() => 1),
      timeoutMs,
      'probe-timeout'
    )
    return { ms: Date.now() - started }
  } catch {
    return { ms: null, timedOut: true }
  }
}

/** Center of the first visible element matching a spec, scrolled into view; null when none. */
const locate = (page, spec) =>
  page.evaluate((s) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled
    }
    let nodes = []
    if (s.firstHistoryRow) {
      const rename = document.querySelector('button[aria-label="Rename meeting"]')
      const main = rename?.parentElement?.querySelector('button')
      nodes = main ? [main] : []
    } else {
      nodes = [...document.querySelectorAll(s.selector)].filter((el) =>
        s.textIncludes ? (el.textContent ?? '').includes(s.textIncludes) : true
      )
    }
    const el = nodes.find(visible)
    if (!el) return null
    if (s.scroll) el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, spec)

/** A real (trusted) mouse click at the element's current position; false when it is not on screen. */
async function clickSpec(page, spec) {
  const at = await locate(page, spec)
  if (!at) return false
  await page.mouse.click(at.x, at.y)
  return true
}

/** What the overlay offers right now: the live Stop control, the Start control, and any modal on top. */
const controlFacts = (page) =>
  page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled
    }
    const first = (selector) => [...document.querySelectorAll(selector)].find(visible)
    const center = (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    const stop = first('button[aria-label="Stop and end meeting"]')
    const start = first('button[aria-label="Start listening"]')
    return {
      kind: stop ? 'stop' : start ? 'start' : null,
      at: stop ? center(stop) : start ? center(start) : null,
      live: Boolean(stop),
      canStart: Boolean(start),
      modals: [...document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true]')].filter(visible)
        .length,
      askInput: Boolean(first('[aria-label="Ask Métis anything"]')),
      expandOrb: Boolean(first('button[aria-label="Expand Métis"]'))
    }
  })

/** Wrap navigator.mediaDevices.getUserMedia once so "no orphan capture" is the page's own count of live audio tracks. */
const installTrackProbe = (page) =>
  page.evaluate(() => {
    const devices = navigator.mediaDevices
    if (!devices || devices.__stressTracks) return Boolean(devices?.__stressTracks)
    window.__stressStreams = []
    window.__stressCalls = 0
    const original = devices.getUserMedia.bind(devices)
    devices.getUserMedia = async (...args) => {
      window.__stressCalls += 1
      const stream = await original(...args)
      window.__stressStreams.push(stream)
      return stream
    }
    devices.__stressTracks = true
    return true
  })

const readTracks = (page) =>
  page.evaluate(() => {
    const streams = window.__stressStreams ?? []
    const tracks = streams.flatMap((stream) => stream.getAudioTracks())
    return {
      calls: window.__stressCalls ?? 0,
      tracks: tracks.length,
      live: tracks.filter((track) => track.readyState === 'live').length
    }
  })

/** SIGKILL the main process group the harness spawned, then record what survived (and clear it, so nothing is orphaned). */
async function hardKill(session) {
  const killedAt = Date.now()
  await session.disconnect()
  let signalled = true
  try {
    process.kill(-session.child.pid, 'SIGKILL')
  } catch {
    signalled = false
  }
  const exited = await waitForChildExit(session.child, 8_000)
  await sleep(1_500)
  const survivors = session.leftovers()
  killOwned(survivors)
  await sleep(500)
  return { signalled, mainExited: exited, survivorsAfterSigkill: survivors.length, killMs: Date.now() - killedAt }
}

/** Clean quit through the app's own IPC; returns the evidence and the problems with it. */
async function quitClean(session, label = 'quit') {
  const quit = await session.quit()
  const problems = []
  if (!quit.cleanShutdown)
    problems.push(`${label}: the app did not exit cleanly (request ${quit.request}, exit ${quit.exit})`)
  else if (!quit.cleanShutdownRecord) problems.push(`${label}: the app exited but wrote no app.shutdown.clean record`)
  if (quit.leftovers.length) problems.push(`${label}: ${quit.leftovers.length} owned process(es) survived the quit`)
  return {
    problems,
    evidence: { exit: quit.exit, cleanRecord: quit.cleanShutdownRecord, leftovers: quit.leftovers.length }
  }
}

/** Meetings folder as the scenario reasons about it: names, sizes, hashes, drafts, partial writes, duplicates. */
function folderOf(layout) {
  const snapshot = snapshotMeetings(layout.meetingsFolder)
  return { snapshot, ...classifyFolder(snapshot) }
}

const folderEvidence = (folder) => ({
  saved: folder.saved.map((name) => ({
    name,
    bytes: folder.snapshot.saved[name].bytes,
    sha256: folder.snapshot.saved[name].sha256
  })),
  drafts: folder.drafts.map((name) => ({ name, bytes: folder.snapshot.others[name].bytes })),
  stragglers: folder.stragglers,
  duplicates: folder.duplicates
})

/** Every meeting History lists, each opened with recallRead (what Review uses); `words` only when a case needs them. */
const readMeetings = (session, { words = false } = {}) =>
  session.withPage((page) =>
    page.evaluate(async (withWords) => {
      const list = await window.toto.recallList()
      const items = []
      for (const meeting of list) {
        const read = await window.toto.recallRead(meeting.file)
        const lines = Array.isArray(read?.lines) ? read.lines : []
        const set = new Set()
        if (withWords)
          for (const line of lines)
            for (const word of String(line.text ?? '')
              .toLowerCase()
              .match(/[a-z]{6,}/g) ?? [])
              set.add(word)
        items.push({
          file: meeting.file,
          ok: read?.ok === true,
          locked: Boolean(meeting.locked),
          recovered: Boolean(meeting.recovered || read?.recovered),
          lines: lines.length,
          startedAt: typeof read?.startedAt === 'number' ? read.startedAt : null,
          ...(withWords ? { words: [...set] } : {})
        })
      }
      return { count: list.length, items }
    }, words)
  )

const unreadableOf = (read) => read.items.filter((item) => !item.ok || item.locked).map((item) => item.file)

/** Wait for the first autosave draft the renderer writes (every 60 s once it holds lines). */
async function waitForDraft(layout, waitSeconds = 150) {
  const started = Date.now()
  const name = await waitFor(
    () => listMeetingFiles(layout.meetingsFolder, isDraftMeetingFile).at(-1) ?? null,
    `no autosave draft appeared within ${waitSeconds}s of synthetic speech`,
    waitSeconds * 1000,
    1_000
  )
  const path = join(layout.meetingsFolder, name)
  return {
    name,
    bytes: statSync(path).size,
    sha256: sha256File(path),
    secondsToDraft: Math.round((Date.now() - started) / 1000)
  }
}

/** Poll until `predicate` holds for `stableMs` in a row, or `maxMs` passes; returns the last observation. */
async function settleOn(observe, predicate, { maxMs = 60_000, stableMs = 4_000, intervalMs = 1_000 } = {}) {
  const started = Date.now()
  let stableSince = null
  let last
  while (Date.now() - started < maxMs) {
    last = await observe()
    if (predicate(last)) {
      stableSince ??= Date.now()
      if (Date.now() - stableSince >= stableMs) return { settled: true, last, ms: Date.now() - started }
    } else stableSince = null
    await sleep(intervalMs)
  }
  return { settled: false, last, ms: Date.now() - started }
}

const journalFacts = (userData) => {
  const root = join(userData, 'meeting-journal')
  if (!existsSync(root)) return { present: false, journals: 0, bytes: 0 }
  return { present: true, journals: readdirSync(root).length, bytes: directoryBytes(root) }
}

// ---------------------------------------------------------------------------------------------------------------
// Case context

function newCase(env, suffix, { fresh = true } = {}) {
  const layout = sandboxLayout({ sandboxRoot: env.sandboxRoot, runId: `${env.runId}-${suffix}` })
  if (fresh && existsSync(layout.runRoot)) throw new Error(`${layout.runRoot} already exists: use a new --run-id`)
  prepareProfile(layout)
  mkdirSync(layout.captureDir, { recursive: true })
  copyFileSync(env.audioWav, layout.captureWav)
  const sessions = []
  const log = (line) => env.log(`[${suffix}] ${line}`)
  return {
    layout,
    log,
    sessions,
    async launch() {
      const started = Date.now()
      const session = await launchApp({
        layout,
        appPath: env.appPath,
        parentEnv: env.parentEnv,
        captureFile: layout.captureWav,
        readyTimeoutMs: env.readyTimeoutMs,
        log
      })
      session.launchMs = Date.now() - started
      sessions.push(session)
      env.onSession(session)
      return session
    },
    async cleanup() {
      for (const session of sessions) await session.kill().catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// S1 start/stop spam

async function caseS1(env) {
  const c = newCase(env, 's1')
  try {
    const session = await c.launch()
    const page = await session.connect()
    assertSyntheticCaptureActive(session)
    const probeInstalled = await installTrackProbe(page)
    const baseline = sampleTree({ mainPid: session.pid, installRoot: env.appPath })
    const monitor = await startLatencyMonitor(page)
    const planned = 20
    const gaps = spamGaps({ count: planned, minMs: 120, maxMs: 300, seed: 31 })
    const clicks = { planned, start: 0, stop: 0, none: 0, gapsMs: gaps, sequence: [] }
    const spamStarted = Date.now()
    for (let i = 0; i < planned; i += 1) {
      const facts = await controlFacts(page)
      if (facts.kind) {
        await page.mouse.click(facts.at.x, facts.at.y)
        clicks[facts.kind] += 1
      } else clicks.none += 1
      clicks.sequence.push(facts.kind ?? 'none')
      await sleep(gaps[i])
    }
    const spamMs = Date.now() - spamStarted
    // Settle: a live meeting is stopped (the spam can end on an odd number of effective toggles), then the app must be idle.
    const settleStarted = Date.now()
    let forcedStops = 0
    let idleSince = null
    let liveSince = null
    let settledIdle = false
    let lastFacts = null
    while (Date.now() - settleStarted < 90_000) {
      lastFacts = await controlFacts(page)
      if (lastFacts.live) {
        idleSince = null
        liveSince ??= Date.now()
        if (Date.now() - liveSince > 4_000 && forcedStops < 3) {
          await page.mouse.click(lastFacts.at.x, lastFacts.at.y)
          forcedStops += 1
          liveSince = null
        }
      } else if (lastFacts.canStart) {
        liveSince = null
        idleSince ??= Date.now()
        if (Date.now() - idleSince >= 4_000) {
          settledIdle = true
          break
        }
      } else idleSince = null
      await sleep(400)
    }
    const stuck = !settledIdle && !lastFacts?.live && !lastFacts?.canStart
    await sleep(2_000)
    const latency = await monitor.stop()
    const tracks = probeInstalled
      ? await readTracks(page).catch(() => ({ calls: 0, tracks: 0, live: 0 }))
      : { calls: 0, tracks: 0, live: 0 }
    const after = sampleTree({ mainPid: session.pid, installRoot: env.appPath })
    const folder = folderOf(c.layout)
    const read = await readMeetings(session).catch((error) => ({
      count: -1,
      items: [],
      error: String(error?.message ?? error)
    }))
    const audit = classifyAudit(session.audit())
    const excess = Math.max(0, after.processes.length - baseline.processes.length - PROCESS_ALLOWANCE)
    const problems = judgeSpam({
      clicks,
      mainAlive: isRunning(session.child) && after.mainAlive,
      fatal: audit.fatal,
      latency,
      settledIdle,
      stuck,
      liveTracks: tracks.live,
      trackProbeEffective: probeInstalled && tracks.calls > 0,
      folder,
      unreadable: unreadableOf(read),
      leftoverProcesses: excess
    })
    if (read.count !== folder.saved.length)
      problems.push(`History lists ${read.count} meeting(s) but ${folder.saved.length} saved file(s) are on disk`)
    const quit = await quitClean(session, 'final quit')
    problems.push(...quit.problems)
    return outcome(problems, {
      clicks: {
        planned,
        start: clicks.start,
        stop: clicks.stop,
        none: clicks.none,
        sequence: clicks.sequence.join(' '),
        gapsMs: gaps,
        spamMs
      },
      forcedStopsAfterSpam: forcedStops,
      settledIdle,
      stuck,
      renderer: latency,
      audioTracks: { probeEffective: probeInstalled && tracks.calls > 0, ...tracks },
      processes: {
        before: baseline.processes.length,
        after: after.processes.length,
        kindsBefore: countByKind(baseline),
        kindsAfter: countByKind(after),
        allowance: PROCESS_ALLOWANCE
      },
      meetings: {
        ...folderEvidence(folder),
        listed: read.count,
        opened: read.items.map((item) => ({ file: item.file, ok: item.ok, lines: item.lines }))
      },
      audit: { fatal: audit.fatal, notable: audit.notable },
      quit: quit.evidence
    })
  } finally {
    await c.cleanup()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// S2 kill -9 mid-meeting

async function caseS2(env, ctx) {
  const c = newCase(env, 's2')
  try {
    const first = await c.launch()
    await startSyntheticMeeting(first)
    const draft = await waitForDraft(c.layout)
    await sleep(2_000) // let the autosave that wrote this draft finish, so the kill lands between autosaves
    const draftNow = (() => {
      const path = join(c.layout.meetingsFolder, draft.name)
      return { name: draft.name, bytes: statSync(path).size, sha256: sha256File(path) }
    })()
    const journal = journalFacts(c.layout.userData)
    const beforeKill = classifyAudit(first.audit())
    const killed = await hardKill(first)
    ctx.s2 = { draft: draftNow, journal, firstAudit: beforeKill }

    const second = await c.launch()
    const started = second.audit().find((record) => record.event === 'app.started')
    const settle = await settleOn(
      async () => ({ folder: folderOf(c.layout), listed: (await readMeetings(second)).count }),
      (state) => state.listed >= 1 && state.folder.drafts.length === 0,
      { maxMs: 60_000, stableMs: 6_000 }
    )
    const read = await readMeetings(second)
    const folder = folderOf(c.layout)
    const audit = classifyAudit(second.audit())
    const recovered = read.items.find((item) => item.recovered) ?? null
    const savedBytes = folder.saved.length ? folder.snapshot.saved[folder.saved[0]].bytes : 0
    const problems = judgeKillRecovery({
      expectedMeetings: 1,
      folder,
      listed: read.count,
      unreadable: unreadableOf(read),
      minLines: 1,
      lines: recovered?.lines ?? read.items[0]?.lines ?? null,
      fatal: audit.fatal,
      mainAlive: isRunning(second.child)
    })
    if (!recovered) problems.push('the meeting is listed but not flagged as recovered (status: recovered)')
    if (savedBytes < draftNow.bytes * 0.9)
      problems.push(
        `the recovered file (${savedBytes} bytes) is smaller than the draft at kill time (${draftNow.bytes} bytes): lines were lost`
      )
    if (!audit.counts['transcript.recovered']) problems.push('no transcript.recovered audit record on the relaunch')
    const recoveredAudit = second.audit().find((record) => record.event === 'transcript.recovered')
    const quit = await quitClean(second, 'quit after recovery')
    problems.push(...quit.problems)

    // A third launch must not recover it again: exactly one meeting, byte-identical.
    const third = await c.launch()
    await sleep(8_000)
    const readThird = await readMeetings(third)
    const folderThird = folderOf(c.layout)
    const sameBytes =
      folder.saved[0] &&
      folderThird.saved[0] === folder.saved[0] &&
      folderThird.snapshot.saved[folderThird.saved[0]].sha256 === folder.snapshot.saved[folder.saved[0]].sha256
    if (readThird.count !== 1 || folderThird.saved.length !== 1)
      problems.push(
        `after a further relaunch History lists ${readThird.count} and ${folderThird.saved.length} file(s) are on disk, expected 1`
      )
    if (!sameBytes) problems.push('the recovered meeting changed or was duplicated on a further relaunch')
    problems.push(...fatalProblems(classifyAudit(third.audit())))
    const quitThird = await quitClean(third, 'final quit')
    problems.push(...quitThird.problems)
    return outcome(problems, {
      draftAtKill: { bytes: draftNow.bytes, sha256: draftNow.sha256, secondsToFirstDraft: draft.secondsToDraft },
      kill: killed,
      prevShutdownAfterKill: typeof started?.prevShutdown === 'string' ? started.prevShutdown : null,
      recoverySettled: settle.settled,
      msToSettle: settle.ms,
      recovered: {
        listed: read.count,
        flaggedRecovered: Boolean(recovered),
        lines: recovered?.lines ?? null,
        bytes: savedBytes,
        draftsLeft: folder.drafts.length
      },
      transcriptRecoveredAudit: recoveredAudit ? { recovered: recoveredAudit.recovered ?? null } : null,
      meetings: folderEvidence(folder),
      furtherRelaunch: { listed: readThird.count, onDisk: folderThird.saved.length, byteIdentical: Boolean(sameBytes) },
      audit: { fatal: audit.fatal, notable: audit.notable },
      quit: quit.evidence
    })
  } finally {
    await c.cleanup()
  }
}

/** The live journal is behind a switch the build may not ship; report what the profile shows instead of assuming. */
async function caseS2Journal(env, ctx) {
  const facts = ctx.s2
  if (!facts) return { status: 'SKIPPED', reason: 's2-kill9-mid-meeting did not run', evidence: {} }
  if (!facts.journal.present)
    return {
      status: 'NOT_SUPPORTED',
      reason:
        'no <userData>/meeting-journal directory exists after more than 60 s of a live meeting, so the journal tail cannot be observed in this build (the journal records committed cloud finals behind the liveMeetingJournal switch; the QA profile uses the local recogniser). Recovery above is from the autosave draft only.',
      evidence: { journalDirectoryPresent: false, secondsOfMeetingBeforeKill: facts.draft ? 60 : 0 }
    }
  return {
    evidence: {
      journalDirectoryPresent: true,
      journals: facts.journal.journals,
      journalBytes: facts.journal.bytes,
      note: 'the journal exists; recovery of its tail is reported by meeting.journal.recovery audit records in s2-kill9-mid-meeting'
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// S3 kill -9 during save

const S3_KILLS = Object.freeze([
  { id: 'a', mode: 'delay', ms: 100 },
  { id: 'b', mode: 'delay', ms: 400 },
  { id: 'c', mode: 'first-write' }
])

async function s3Iteration(env, spec) {
  const c = newCase(env, `s3${spec.id}`)
  try {
    const first = await c.launch()
    const page = await first.connect()
    await startSyntheticMeeting(first)
    const draft = await waitForDraft(c.layout)
    await sleep(2_000)
    const before = new Set(readdirSync(c.layout.meetingsFolder))
    const facts = await controlFacts(page)
    if (facts.kind !== 'stop') throw new Error(`the Stop control was not reachable (${JSON.stringify(facts)})`)
    const clickedAt = Date.now()
    await page.mouse.click(facts.at.x, facts.at.y)
    let caught = null
    if (spec.mode === 'delay') await sleep(spec.ms)
    else {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        const fresh = readdirSync(c.layout.meetingsFolder).filter((name) => !before.has(name))
        if (fresh.length) {
          caught = fresh.map((name) =>
            /\.tmp$/i.test(name) ? 'temp-file' : name.endsWith('.md') ? 'final-file' : 'other'
          )
          break
        }
        await sleep(2)
      }
    }
    const killMsAfterClick = Date.now() - clickedAt
    const namesAtKill = readdirSync(c.layout.meetingsFolder)
      .filter((name) => !before.has(name))
      .map((name) => (/\.tmp$/i.test(name) ? 'temp-file' : name.endsWith('.md') ? 'final-file' : 'other'))
    const killed = await hardKill(first)

    const second = await c.launch()
    const settle = await settleOn(
      async () => ({ folder: folderOf(c.layout), listed: (await readMeetings(second)).count }),
      (state) => state.listed >= 1 && state.folder.drafts.length === 0 && state.folder.stragglers.length === 0,
      { maxMs: 60_000, stableMs: 6_000 }
    )
    const read = await readMeetings(second)
    const folder = folderOf(c.layout)
    const audit = classifyAudit(second.audit())
    const problems = judgeKillRecovery({
      expectedMeetings: 1,
      folder,
      listed: read.count,
      unreadable: unreadableOf(read),
      minLines: 1,
      lines: read.items[0]?.lines ?? null,
      fatal: audit.fatal,
      mainAlive: isRunning(second.child)
    })
    const quit = await quitClean(second, 'quit after relaunch')
    problems.push(...quit.problems)
    return {
      problems,
      evidence: {
        iteration: spec.id,
        mode:
          spec.mode === 'delay'
            ? `kill ${spec.ms} ms after the Stop click`
            : 'kill at the first new entry in the meetings folder',
        killMsAfterClick,
        newEntriesWhenKilled: namesAtKill,
        caughtFirstWrite: caught,
        draftBeforeStop: { bytes: draft.bytes, secondsToDraft: draft.secondsToDraft },
        kill: killed,
        settled: settle.settled,
        savedByApp: read.items.filter((item) => !item.recovered).length,
        recoveredFromDraft: read.items.filter((item) => item.recovered).length,
        lines: read.items.map((item) => item.lines),
        meetings: folderEvidence(folder),
        audit: {
          fatal: audit.fatal,
          notable: audit.notable,
          saved: audit.counts['transcript.saved'] ?? 0,
          recovered: audit.counts['transcript.recovered'] ?? 0
        },
        quit: quit.evidence
      }
    }
  } finally {
    await c.cleanup()
  }
}

async function caseS3(env) {
  const iterations = []
  const problems = []
  for (const spec of S3_KILLS) {
    try {
      const result = await s3Iteration(env, spec)
      iterations.push(result.evidence)
      problems.push(...result.problems.map((problem) => `iteration ${spec.id}: ${problem}`))
    } catch (error) {
      problems.push(`iteration ${spec.id}: ${String(error?.message ?? error)}`)
      iterations.push({ iteration: spec.id, error: String(error?.message ?? error) })
    }
  }
  return outcome(problems, { iterations })
}

// ---------------------------------------------------------------------------------------------------------------
// S4 relaunch loop

async function caseS4(env, { cycles: planned = 10 } = {}) {
  const c = newCase(env, 's4')
  const cycles = []
  try {
    for (let cycle = 1; cycle <= planned; cycle += 1) {
      const wallStarted = Date.now()
      const session = await c.launch()
      const startupMs = Date.now() - wallStarted
      const records = session.audit()
      const started = records.find((record) => record.event === 'app.started')
      const sample = sampleTree({ mainPid: session.pid, installRoot: env.appPath })
      const probe = await probeOnce(session.page)
      const quitStarted = Date.now()
      const quit = await session.quit()
      const quitMs = Date.now() - quitStarted
      const after = profileFilesOf(c.layout)
      const audit = classifyAudit(session.audit())
      cycles.push({
        cycle,
        startupMs,
        bootMs: bootMsFromAudit(records),
        rendererProbeMs: probe.ms,
        quitMs,
        clean: quit.cleanShutdown,
        cleanRecord: quit.cleanShutdownRecord,
        leftovers: quit.leftovers.length,
        prevShutdown: typeof started?.prevShutdown === 'string' ? started.prevShutdown : null,
        files: after.files,
        topLevel: after.topLevel,
        bytes: after.bytes,
        auditBytes: after.auditBytes,
        crashFiles: after.crashFiles.length,
        meetingEntries: existsSync(c.layout.meetingsFolder) ? readdirSync(c.layout.meetingsFolder).length : 0,
        ownedProcesses: sample.processes.length,
        fatal: audit.fatal
      })
      c.log(
        `cycle ${cycle}/${planned}: ready in ${startupMs} ms (boot ${cycles.at(-1).bootMs} ms), quit ${quit.cleanShutdown ? 'clean' : 'NOT clean'}`
      )
    }
    const problems = judgeRelaunchLoop(cycles)
    return outcome(problems, { cycles, startup: startupStats(cycles) })
  } catch (error) {
    return outcome([String(error?.message ?? error)], { cyclesCompleted: cycles.length, cycles })
  } finally {
    await c.cleanup()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// S5 many meetings

/**
 * Start a synthetic meeting and, when the first Start click does not take, say exactly what the page and the audit log looked like
 * before one retry. A Start that needs a second click is itself a finding: the evidence goes into the report either way.
 */
async function startWithDiagnosis(session) {
  try {
    return { live: await startSyntheticMeeting(session, { timeoutMs: 15_000 }), swallowed: null }
  } catch (error) {
    const first = String(error?.message ?? error)
      .split('\n')[0]
      .slice(0, 200)
    const page = await session.connect()
    const page_ = await page
      .evaluate(() => ({ visibility: document.visibilityState, hasFocus: document.hasFocus() }))
      .catch(() => ({ visibility: null, hasFocus: null }))
    const facts = await controlFacts(page).catch(() => null)
    const recentAudit = session
      .audit()
      .slice(-8)
      .map((record) => record.event)
    // Q14: the app's own Start diagnostics (stage, outcome, reason code: never content) and whether it told the user why.
    const startAudit = session
      .audit()
      .filter((record) => record.event === 'meeting.start')
      .slice(-6)
      .map((record) => `${record.stage}:${record.outcome}${record.reason ? `:${record.reason}` : ''}`)
    const notices = await page
      .evaluate(() => {
        const text = document.body?.innerText ?? ''
        return {
          couldntStart: text.includes("couldn't start listening"),
          stillFinishing: text.includes('Still finishing your last meeting')
        }
      })
      .catch(() => null)
    let retry
    try {
      const live = await startSyntheticMeeting(session, { timeoutMs: 20_000 })
      retry = { worked: true, msToLive: live.evidence.msToLive }
    } catch (retryError) {
      retry = {
        worked: false,
        error: String(retryError?.message ?? retryError)
          .split('\n')[0]
          .slice(0, 200)
      }
    }
    return {
      live: retry.worked ? { evidence: { msToLive: retry.msToLive } } : null,
      swallowed: {
        firstAttempt: first,
        page: page_,
        controls: facts && { live: facts.live, canStart: facts.canStart, modals: facts.modals },
        recentAudit,
        startAudit,
        notices,
        retry
      }
    }
  }
}

async function caseS5Create(env, ctx, { count = 15, holdMs = 14_000 } = {}) {
  const c = newCase(env, 's5')
  ctx.s5 = { c, files: [], count }
  const session = await c.launch()
  ctx.s5.session = session
  const meetings = []
  const problems = []
  const swallowedStarts = []
  ctx.s5.startsAttempted = 0
  ctx.s5.swallowedStarts = swallowedStarts
  for (let i = 1; i <= count; i += 1) {
    ctx.s5.startsAttempted += 1
    try {
      const started = await startWithDiagnosis(session)
      if (started.swallowed) {
        swallowedStarts.push({ n: i, ...started.swallowed })
        if (!started.live) {
          problems.push(`meeting ${i}: the Start click did not start a meeting, and neither did a retry`)
          break
        }
      }
      const live = started.live
      await sleep(holdMs)
      const savedBefore = session.audit().filter((record) => record.event === 'transcript.saved').length
      const saved = await stopAndSave(session, { waitSeconds: 60 })
      // The file appears a moment before the transcript.saved audit record does; wait for the record rather than race it.
      const savedRecords = await waitFor(
        () => {
          const records = session.audit().filter((record) => record.event === 'transcript.saved')
          return records.length > savedBefore ? records : null
        },
        `meeting ${i}: no transcript.saved audit record after the file appeared`,
        10_000,
        250
      ).catch(() => [])
      const lines = savedRecords.length > savedBefore ? (savedRecords.at(-1).lines ?? null) : null
      ctx.s5.files.push(saved.file)
      meetings.push({
        n: i,
        file: saved.file,
        bytes: saved.evidence.bytes,
        secondsToSave: saved.evidence.secondsToSave,
        msToLive: live.evidence.msToLive,
        lines
      })
      if (!lines) problems.push(`meeting ${i} saved with ${lines} transcript line(s)`)
    } catch (error) {
      problems.push(`meeting ${i}: ${String(error?.message ?? error)}`)
      break
    }
  }
  const folder = folderOf(c.layout)
  const audit = classifyAudit(session.audit())
  if (folder.saved.length !== meetings.length)
    problems.push(`${folder.saved.length} saved file(s) on disk for ${meetings.length} meeting(s) created`)
  if (folder.duplicates.sameStamp.length || folder.duplicates.sameBytes.length)
    problems.push(`duplicate meeting files: ${JSON.stringify(folder.duplicates)}`)
  if (folder.stragglers.length) problems.push(`partial files left: ${folder.stragglers.join(', ')}`)
  problems.push(...fatalProblems(audit))
  ctx.s5.hashes = Object.fromEntries(folder.saved.map((name) => [name, folder.snapshot.saved[name].sha256]))
  const lineCounts = meetings.map((meeting) => meeting.lines).filter((value) => value !== null)
  return outcome(problems, {
    requested: count,
    holdSecondsEach: holdMs / 1000,
    created: meetings.length,
    lines: lineCounts.length ? { min: Math.min(...lineCounts), max: Math.max(...lineCounts) } : null,
    swallowedStarts,
    meetings,
    folder: folderEvidence(folder),
    audit: { fatal: audit.fatal, notable: audit.notable }
  })
}

/** Every meeting after the first needs only one Start click; the diagnosis of any that needed a second is in the evidence. */
function caseS5StartReliable(ctx) {
  const swallowed = ctx.s5?.swallowedStarts ?? []
  const attempted = ctx.s5?.startsAttempted ?? 0
  const problems = swallowed.map(
    (entry) =>
      `meeting ${entry.n}: the first Start click did not start a meeting within 15 s (${entry.retry.worked ? 'a second click did' : 'a retry did not either'})`
  )
  return outcome(problems, { startsAttempted: attempted, startClicksSwallowed: swallowed.length, swallowed })
}

/** History through the real UI: open it, count the rendered rows, optionally search; always closes it again. */
async function historyUi(page, { query = null } = {}) {
  const rows = () => page.locator('button[aria-label="Delete meeting"]').count()
  const opened = await clickSpec(page, { selector: 'button[data-bar-history]' })
  if (!opened) return { opened: false }
  await waitFor(
    async () => (await rows()) > 0 || (await page.getByLabel('Search past meetings').count()) > 0,
    'History did not render',
    10_000,
    250
  )
  await sleep(800)
  const result = { opened: true, rows: await rows() }
  if (query) {
    await page.getByLabel('Search past meetings').fill(query)
    await sleep(1_800) // the search is debounced 250 ms
    result.rowsAfterSearch = await rows()
    await page.getByLabel('Search past meetings').fill('')
    await sleep(600)
  }
  await sleep(500)
  await clickSpec(page, { selector: 'button[data-bar-history]' })
  await sleep(500)
  return result
}

async function caseS5History(env, ctx) {
  const { c, session, files, count } = ctx.s5
  const read = await readMeetings(session, { words: true })
  const page = await session.connect()
  const ui = await historyUi(page).catch((error) => ({ opened: false, error: String(error?.message ?? error) }))
  const listedFiles = read.items.map((item) => item.file).sort()
  const problems = []
  const missing = files.filter((file) => !listedFiles.includes(file))
  const extra = listedFiles.filter((file) => !files.includes(file))
  if (read.count !== count) problems.push(`History lists ${read.count} meeting(s), expected ${count}`)
  if (missing.length) problems.push(`${missing.length} created meeting(s) missing from History`)
  if (extra.length) problems.push(`${extra.length} History entr(ies) that were never created`)
  const unreadable = unreadableOf(read)
  if (unreadable.length) problems.push(`meeting(s) that do not open: ${unreadable.join(', ')}`)
  if (ui.opened && ui.rows === 0 && read.count > 0)
    problems.push('the History view rendered no rows although meetings exist')
  ctx.s5.words = read.items.map((item) => ({ file: item.file, words: item.words ?? [] }))
  return outcome(problems, {
    listedByIpc: read.count,
    created: count,
    missingFromList: missing,
    unexpectedInList: extra,
    allOpen: unreadable.length === 0,
    historyUi: ui,
    uiRowsMatchList: ui.opened ? ui.rows === read.count : null
  })
}

/** A word present in as many meetings as possible, so a search for it has a known set of expected hits. */
function pickSearchWord(wordSets) {
  const counts = new Map()
  for (const { words } of wordSets) for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return best ? { word: best[0], inMeetings: best[1] } : null
}

async function caseS5Search(env, ctx) {
  const { session, words, count } = ctx.s5
  const pick = pickSearchWord(words)
  if (!pick) return { status: 'NOT_SUPPORTED', reason: 'no transcript word of 6+ letters to search for', evidence: {} }
  const expected = words.filter((entry) => entry.words.includes(pick.word)).map((entry) => entry.file)
  const search = (q) =>
    session.withPage((page) =>
      page.evaluate(async (query) => {
        const hits = await window.toto.recallSearch(query)
        return hits.map((hit) => hit.file)
      }, q)
    )
  let hits = []
  const settled = await settleOn(
    async () => (hits = await search(pick.word)),
    (found) => expected.every((file) => found.includes(file)),
    { maxMs: 40_000, stableMs: 1_000, intervalMs: 2_000 }
  )
  const negative = await search('zqxjkvwy')
  const page = await session.connect()
  const ui = await historyUi(page, { query: pick.word }).catch((error) => ({
    opened: false,
    error: String(error?.message ?? error)
  }))
  const problems = []
  const missed = expected.filter((file) => !hits.includes(file))
  const stray = hits.filter((file) => !words.some((entry) => entry.file === file))
  if (missed.length)
    problems.push(
      `search missed ${missed.length} of ${expected.length} meeting(s) that contain the word (after ${Math.round(settled.ms / 1000)}s)`
    )
  if (stray.length) problems.push(`search returned ${stray.length} file(s) that are not in History`)
  if (ui.opened && ui.rowsAfterSearch === 0 && expected.length > 0)
    problems.push('the History search box showed no rows for a word that is in the meetings')
  return outcome(problems, {
    wordChars: pick.word.length,
    meetingsContainingWord: expected.length,
    hits: hits.length,
    expectedAllFound: missed.length === 0,
    msUntilIndexed: settled.ms,
    nonsenseQueryHits: negative.length,
    historySearchUi: ui,
    meetingsCreated: count
  })
}

function caseS5Delete() {
  return {
    status: 'NOT_SUPPORTED',
    reason:
      'Delete asks through a main-process native dialog (dialog.showMessageBox in src/main/ipc/recall-ipc.ts, "Delete meeting"). The harness drives the renderer over CDP and may not use osascript/System Events, so the confirmation sheet cannot be answered. The next step covers list consistency after a meeting disappears, by removing one file inside the sandbox while the app is quit.',
    evidence: { dialog: 'native NSAlert sheet', drivableOverCdp: false, osAutomationAllowed: false }
  }
}

async function caseS5External(env, ctx) {
  const { c, session, files, hashes, count } = ctx.s5
  const words = ctx.s5.words ?? []
  const problems = []
  const quit = await quitClean(session, 'quit before removal')
  problems.push(...quit.problems)
  const target = files[Math.floor(files.length / 2)]
  const targetPath = join(c.layout.meetingsFolder, target)
  assertWritableInSandbox(targetPath, env.sandboxRoot)
  unlinkSync(targetPath)
  const second = await c.launch()
  const pick = pickSearchWord(words)
  const expectedHashes = Object.fromEntries(Object.entries(hashes).filter(([name]) => name !== target))
  const settle = await settleOn(
    async () => (await readMeetings(second)).count,
    (listed) => listed === count - 1,
    { maxMs: 45_000, stableMs: 5_000 }
  )
  const read = await readMeetings(second)
  const folder = folderOf(c.layout)
  const hits = pick
    ? await second.withPage((page) =>
        page.evaluate((q) => window.toto.recallSearch(q).then((found) => found.map((hit) => hit.file)), pick.word)
      )
    : []
  const page = await second.connect()
  const ui = await historyUi(page).catch((error) => ({ opened: false, error: String(error?.message ?? error) }))
  const changed = Object.entries(expectedHashes)
    .filter(([name, sha]) => folder.snapshot.saved[name]?.sha256 !== sha)
    .map(([name]) => name)
  if (read.count !== count - 1)
    problems.push(`History lists ${read.count} meeting(s) after one was removed, expected ${count - 1}`)
  if (read.items.some((item) => item.file === target)) problems.push('the removed meeting is still listed')
  if (hits.includes(target)) problems.push('search still returns the removed meeting')
  if (changed.length) problems.push(`${changed.length} remaining meeting file(s) changed bytes across the relaunch`)
  if (unreadableOf(read).length) problems.push(`meeting(s) that do not open: ${unreadableOf(read).join(', ')}`)
  if (ui.opened && ui.rows !== undefined && ui.rows !== 0 && ui.rows !== count - 1)
    problems.push(`the History view shows ${ui.rows} row(s), expected ${count - 1}`)
  problems.push(...fatalProblems(classifyAudit(second.audit())))
  const quitSecond = await quitClean(second, 'final quit')
  problems.push(...quitSecond.problems)
  return outcome(problems, {
    substitution: 'the file was removed with the app quit (not through the in-app confirm), then the app relaunched',
    removedOne: true,
    listedAfterRelaunch: read.count,
    expected: count - 1,
    settledMs: settle.ms,
    searchStillReturnsRemoved: hits.includes(target),
    historyUi: ui,
    remainingFilesByteIdentical: changed.length === 0,
    meetingsOnDisk: folder.saved.length,
    quits: [quit.evidence, quitSecond.evidence]
  })
}

// ---------------------------------------------------------------------------------------------------------------
// S6 settings churn

const readSwitches = (page) =>
  page.evaluate(
    (labels) => {
      const read = (label) => {
        const el = [...document.querySelectorAll('button[role=switch]')].find(
          (node) => node.getAttribute('aria-label') === label
        )
        return el
          ? { present: true, on: el.getAttribute('aria-checked') === 'true', disabled: el.disabled }
          : { present: false, on: null, disabled: null }
      }
      return labels.map(read)
    },
    SETTINGS.map((setting) => setting.label)
  )

const readMainSettings = (page) =>
  page.evaluate(
    async (keys) => {
      const settings = await window.toto.getSettings()
      return keys.map((key) => Boolean(settings?.[key]))
    },
    SETTINGS.map((setting) => setting.key)
  )

async function openPrivacyPane(page) {
  await dispatchKeyEvents(page, settingsShortcutEvents())
  await page.getByRole('tablist', { name: 'Settings sections' }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('#settings-tab-privacy').click({ timeout: 10_000 })
  await waitFor(
    async () => (await page.locator('#settings-tab-privacy').getAttribute('aria-selected')) === 'true',
    'the Privacy tab did not select',
    8_000
  )
  await sleep(500)
}

async function caseS6(env) {
  const c = newCase(env, 's6')
  try {
    const first = await c.launch()
    const page = await first.connect()
    await openPrivacyPane(page)
    const initialSwitches = await readSwitches(page)
    const missing = SETTINGS.filter((_, index) => !initialSwitches[index].present).map((setting) => setting.key)
    if (missing.length)
      return {
        status: 'NOT_SUPPORTED',
        reason: `Settings > Privacy has no switch for ${missing.join(', ')} in this build`,
        evidence: { missing }
      }
    const disabled = SETTINGS.filter((_, index) => initialSwitches[index].disabled).map((setting) => setting.key)
    if (disabled.length)
      return {
        status: 'NOT_SUPPORTED',
        reason: `${disabled.join(', ')} is managed by policy in this profile`,
        evidence: { disabled }
      }
    const initial = initialSwitches.map((state) => state.on)
    const mainInitial = await readMainSettings(page)
    const monitor = await startLatencyMonitor(page)
    const sequence = churnSequence({ count: SETTINGS.length, rounds: 50, extra: [0, 2, 4] })
    const expected = expectedAfterClicks(initial, sequence)
    const clickedAt = Date.now()
    let missed = 0
    for (let n = 0; n < sequence.length; n += 1) {
      const ok = await clickSpec(page, {
        selector: `button[role=switch][aria-label="${SETTINGS[sequence[n]].label.replaceAll('"', '\\"')}"]`,
        scroll: true
      })
      if (!ok) missed += 1
      await sleep(25)
    }
    const clickMs = Date.now() - clickedAt
    await sleep(500) // deliberately short: the quit that follows must flush whatever the last clicks wrote
    const latency = await monitor.stop()
    const uiFinal = (await readSwitches(page)).map((state) => state.on)
    const mainFinal = await readMainSettings(page)
    const changedEvents = first.audit().filter((record) => record.event === 'settings.changed').length
    const quit = await quitClean(first, 'quit after churn')
    const fileAfter = settingsFileFacts(c.layout.userData)

    const second = await c.launch()
    const page2 = await second.connect()
    const afterRelaunch = await readMainSettings(page2)
    await openPrivacyPane(page2)
    const paneAfterRelaunch = (await readSwitches(page2)).map((state) => state.on)
    const audit2 = classifyAudit(second.audit())
    const auditAll = classifyAudit(first.audit())
    const verdict = judgeSettingsChurn({
      keys: SETTINGS.map((setting) => setting.key),
      uiFinal,
      mainFinal,
      afterRelaunch,
      paneAfterRelaunch,
      expected,
      settingsFile: fileAfter,
      fatal: { ...auditAll.fatal, ...audit2.fatal },
      profileRecovered:
        (auditAll.counts['settings.profile_recovered'] ?? 0) + (audit2.counts['settings.profile_recovered'] ?? 0)
    })
    const problems = [...verdict.problems, ...latencyProblems(latency), ...quit.problems]
    if (missed) problems.push(`${missed} click(s) found no switch on screen`)
    const quitSecond = await quitClean(second, 'final quit')
    problems.push(...quitSecond.problems)
    const keys = SETTINGS.map((setting) => setting.key)
    const asMap = (values) => Object.fromEntries(keys.map((key, index) => [key, values[index]]))
    return outcome(problems, {
      clicks: sequence.length,
      clicksPerSwitch: SETTINGS.map((_, index) => sequence.filter((value) => value === index).length),
      gapMs: 25,
      clickMs,
      initial: asMap(initial),
      mainInitial: asMap(mainInitial),
      uiFinal: asMap(uiFinal),
      mainFinal: asMap(mainFinal),
      afterRelaunch: asMap(afterRelaunch),
      paneAfterRelaunch: asMap(paneAfterRelaunch),
      predictedIfEveryClickLanded: asMap(expected),
      switchesWhereAClickWasCoalesced: verdict.lostClicks,
      settingsFile: fileAfter,
      settingsChangedAuditRecords: changedEvents,
      renderer: latency,
      audit: { fatal: { ...auditAll.fatal, ...audit2.fatal }, notable: { ...auditAll.notable, ...audit2.notable } },
      quits: [quit.evidence, quitSecond.evidence]
    })
  } finally {
    await c.cleanup()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// S7 long meeting memory

async function caseS7(env, { minutes = 10, intervalMs = 15_000 } = {}) {
  const c = newCase(env, 's7')
  try {
    const session = await c.launch()
    const page = await session.connect()
    await startSyntheticMeeting(session)
    const meetingStarted = Date.now()
    const samples = []
    const probes = []
    const drafts = []
    const timeline = []
    const endAt = meetingStarted + minutes * MINUTE_MS
    let mainDeadAt = null
    while (Date.now() < endAt) {
      const tMs = Date.now() - meetingStarted
      const sample = sampleTree({ mainPid: session.pid, installRoot: env.appPath })
      const rss = totalRss(sample)
      if (!sample.mainAlive && mainDeadAt === null) mainDeadAt = tMs
      if (sample.mainAlive && rss !== null) samples.push({ tMs, rssBytes: rss })
      probes.push(await probeOnce(page))
      const draftNames = listMeetingFiles(c.layout.meetingsFolder, isDraftMeetingFile)
      const draftBytes = draftNames.length ? statSync(join(c.layout.meetingsFolder, draftNames.at(-1))).size : 0
      if (draftNames.length) drafts.push({ tMs, bytes: draftBytes })
      timeline.push({
        tMin: Math.round((tMs / MINUTE_MS) * 100) / 100,
        rssMiB: rss === null ? null : Math.round((rss / MIB) * 10) / 10,
        procs: sample.processes.length,
        draftBytes
      })
      await sleep(Math.min(intervalMs, Math.max(0, endAt - Date.now())))
    }
    const lastSample = sampleTree({ mainPid: session.pid, installRoot: env.appPath })
    const journalBytes = journalFacts(c.layout.userData)
    const growth = rssGrowth(samples, { settleMs: Math.min(2 * MINUTE_MS, 0.25 * minutes * MINUTE_MS) })
    const saved = await stopAndSave(session, { waitSeconds: 120 })
    const savedLines = await waitFor(
      () =>
        session
          .audit()
          .filter((record) => record.event === 'transcript.saved')
          .at(-1) ?? null,
      'no transcript.saved audit record after the file appeared',
      10_000,
      250
    )
      .then((record) => record.lines ?? null)
      .catch(() => null)
    const folder = folderOf(c.layout)
    const audit = classifyAudit(session.audit())
    const latency = summarizeLatency(probes)
    const problems = []
    if (mainDeadAt !== null)
      problems.push(`the main process disappeared ${Math.round(mainDeadAt / 1000)} s into the meeting`)
    if (!growth.valid) problems.push(`memory growth cannot be judged: ${growth.reason}`)
    else if (!growth.pass)
      problems.push(
        `RSS growth beyond the bound: projected ${growth.projectedMiBPerHour} MiB/h, last-third minus reference ${growth.lastThirdMinusReferenceMiB} MiB, bound ${growth.boundMiB} MiB`
      )
    problems.push(
      ...judgeSizes({
        drafts,
        saved: folder.saved.map((name) => ({ bytes: folder.snapshot.saved[name].bytes })),
        journalBytes: journalBytes.bytes
      })
    )
    if (savedLines === null || savedLines < minutes * 2)
      problems.push(
        `the ${minutes}-minute meeting saved ${savedLines} transcript line(s); continuous speech should give at least ${minutes * 2}`
      )
    problems.push(...fatalProblems(audit))
    problems.push(...latencyProblems(latency))
    if (folder.saved.length !== 1) problems.push(`${folder.saved.length} saved meeting file(s), expected exactly 1`)
    const quit = await quitClean(session, 'final quit')
    problems.push(...quit.problems)
    return outcome(problems, {
      meetingMinutes: minutes,
      sampleIntervalSeconds: intervalMs / 1000,
      samples: samples.length,
      growth,
      processes: { atEnd: lastSample.processes.length, kinds: countByKind(lastSample) },
      renderer: latency,
      lines: savedLines,
      saved: { file: saved.file, bytes: saved.evidence.bytes, secondsToSave: saved.evidence.secondsToSave },
      drafts: {
        observations: drafts.length,
        firstBytes: drafts[0]?.bytes ?? null,
        lastBytes: drafts.at(-1)?.bytes ?? null,
        maxBytes: drafts.length ? Math.max(...drafts.map((d) => d.bytes)) : null
      },
      journal: journalBytes,
      timeline,
      audit: { fatal: audit.fatal, notable: audit.notable },
      quit: quit.evidence
    })
  } finally {
    await c.cleanup()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// S8 overlay click spam

const OVERLAY_SPECS = Object.freeze({
  minimize: { selector: 'button[aria-label="Minimize to the orb"]' },
  restore: { selector: 'button[aria-label="Expand Métis"]' },
  settings: { selector: 'button[data-bar-mark]' },
  history: { selector: 'button[data-bar-history]' },
  reviewOpen: { firstHistoryRow: true },
  reviewClose: { selector: 'button', textIncludes: 'Back to history' }
})
const OVERLAY_CYCLE = Object.freeze([
  'minimize',
  'restore',
  'settings',
  'settings',
  'history',
  'reviewOpen',
  'reviewClose',
  'history'
])

async function caseS8(env, ctx, { loops = 30 } = {}) {
  const shared = ctx.s5?.c
  const c = shared ?? newCase(env, 's8')
  const profileOrigin = shared
    ? 'the s5 profile (holds meetings, so Review can open)'
    : 'a fresh profile (no meetings: Review cannot open)'
  try {
    const before = folderOf(c.layout)
    const session = await c.launch()
    const page = await session.connect()
    await sleep(2_000)
    const monitor = await startLatencyMonitor(page)
    const counts = Object.fromEntries(Object.keys(OVERLAY_SPECS).map((name) => [name, { clicked: 0, missed: 0 }]))
    const gaps = spamGaps({ count: loops * OVERLAY_CYCLE.length, minMs: 60, maxMs: 220, seed: 8 })
    const startedAt = Date.now()
    let gapIndex = 0
    for (let loop = 0; loop < loops; loop += 1) {
      for (const action of OVERLAY_CYCLE) {
        const ok = await clickSpec(page, OVERLAY_SPECS[action]).catch(() => false)
        counts[action][ok ? 'clicked' : 'missed'] += 1
        await sleep(gaps[gapIndex++])
      }
    }
    const spamMs = Date.now() - startedAt
    await sleep(1_500)
    const latency = await monitor.stop()
    // Recovery: Escape (the app's own back-out), then undo whatever toggle the spam left on, until the bar is plain.
    let facts = await controlFacts(page)
    const recoverySteps = []
    for (
      let attempt = 0;
      attempt < 6 && (facts.modals > 0 || !(facts.canStart || facts.askInput) || facts.expandOrb);
      attempt += 1
    ) {
      if (facts.expandOrb) {
        await clickSpec(page, OVERLAY_SPECS.restore)
        recoverySteps.push('expand')
      } else {
        await dispatchKeyEvents(page, escapeKeyEvents())
        recoverySteps.push('escape')
      }
      await sleep(900)
      facts = await controlFacts(page)
    }
    const tablistOpen = (await page.getByRole('tablist', { name: 'Settings sections' }).count()) > 0
    const barReachable = facts.canStart || facts.askInput
    const audit = classifyAudit(session.audit())
    const after = folderOf(c.layout)
    const changed = Object.keys(before.snapshot.saved).filter(
      (name) => after.snapshot.saved[name]?.sha256 !== before.snapshot.saved[name].sha256
    )
    const performed = Object.values(counts).reduce((sum, entry) => sum + entry.clicked, 0)
    const problems = judgeOverlaySpam({
      mainAlive: isRunning(session.child),
      fatal: audit.fatal,
      latency,
      stuckModals: facts.modals,
      barReachable,
      performed
    })
    if (changed.length) problems.push(`${changed.length} saved meeting file(s) changed bytes while only being browsed`)
    if (shared && counts.reviewOpen.clicked === 0)
      problems.push('no History row could be clicked, so Review was never opened')
    const quit = await quitClean(session, 'final quit')
    problems.push(...quit.problems)
    return outcome(problems, {
      profile: profileOrigin,
      loops,
      cycle: OVERLAY_CYCLE.join(' > '),
      actions: OVERLAY_ACTIONS,
      clicks: counts,
      clickedTotal: performed,
      gapRangeMs: [60, 220],
      spamMs,
      recoverySteps,
      endState: {
        modalsOpen: facts.modals,
        settingsOpen: tablistOpen,
        startControl: facts.canStart,
        askInput: facts.askInput,
        minimized: facts.expandOrb
      },
      renderer: latency,
      meetingsUnchanged: changed.length === 0,
      audit: { fatal: audit.fatal, notable: audit.notable },
      quit: quit.evidence
    })
  } finally {
    await c.cleanup()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The scenario

/**
 * @param {{ report: any, base: ReturnType<typeof sandboxLayout>, zip: string, audioWav: string, cases: string[], longMinutes: number,
 *   parentEnv: Record<string, string | undefined>, readyTimeoutMs: number, onSession: (session: any) => void, log: (line: string) => void }} args
 */
export async function runStressScenario({
  report,
  base,
  zip,
  audioWav,
  cases,
  longMinutes,
  parentEnv,
  readyTimeoutMs,
  onSession,
  log
}) {
  const appsDir = join(base.sandboxRoot, 'stress', base.runId, 'Applications')
  const env = {
    sandboxRoot: base.sandboxRoot,
    runId: base.runId,
    appPath: join(appsDir, 'Metis QA.app'),
    audioWav,
    parentEnv,
    readyTimeoutMs,
    onSession,
    log
  }
  const ctx = {}
  await runStep(report, 'install', async () => {
    const receipt = installZip({ zip, sandboxRoot: base.sandboxRoot, appsDir, replace: true, log })
    return {
      evidence: {
        zip: receipt.zip,
        bundleId: receipt.app.bundleId,
        version: receipt.app.version,
        mainExecutableSha256: receipt.app.mainExecutableSha256,
        installedInto: 'sandbox stress Applications dir (never /Applications, never the shared sandbox install)'
      }
    }
  })
  const ready = { requires: ['install'] }
  const want = (id) => cases.includes(id)
  if (want('s1')) await runStep(report, 's1-start-stop-spam', () => caseS1(env), ready)
  if (want('s2')) {
    await runStep(report, 's2-kill9-mid-meeting', () => caseS2(env, ctx), ready)
    await runStep(report, 's2-journal-tail', () => caseS2Journal(env, ctx), ready)
  }
  if (want('s3')) await runStep(report, 's3-kill9-during-save', () => caseS3(env), ready)
  if (want('s4')) await runStep(report, 's4-relaunch-loop', () => caseS4(env), ready)
  if (want('s5')) {
    await runStep(report, 's5-create-meetings', () => caseS5Create(env, ctx), ready)
    const created = { requires: ['install', 's5-create-meetings'] }
    await runStep(report, 's5-start-click-reliable', async () => caseS5StartReliable(ctx), created)
    await runStep(report, 's5-history-lists-all', () => caseS5History(env, ctx), created)
    await runStep(report, 's5-search-works', () => caseS5Search(env, ctx), {
      requires: [...created.requires, 's5-history-lists-all']
    })
    await runStep(report, 's5-delete-confirm', async () => caseS5Delete(), created)
    await runStep(report, 's5-external-delete-consistent', () => caseS5External(env, ctx), created)
    // One app instance at a time on the shared S5 profile: whatever S5 left running ends before S8 launches on it.
    for (const session of ctx.s5?.c?.sessions ?? []) if (isRunning(session.child)) await session.kill().catch(() => {})
  }
  if (want('s6')) await runStep(report, 's6-settings-churn', () => caseS6(env), ready)
  if (want('s7')) await runStep(report, 's7-long-meeting-memory', () => caseS7(env, { minutes: longMinutes }), ready)
  if (want('s8')) await runStep(report, 's8-overlay-click-spam', () => caseS8(env, ctx), ready)
  for (const session of ctx.s5?.c?.sessions ?? []) await session.kill().catch(() => {})
  report.meta.caseTable = caseTable(report.steps, cases)
  return ctx
}

export { CASE_STEPS }
