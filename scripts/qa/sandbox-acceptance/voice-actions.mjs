// V08 sandbox acceptance, opt-in scenario `--scenario voice-actions`: voice actions of the installed QA-identity build, driven
// end to end with NO real keyboard, microphone or desktop. Design: VOICE-ACTIONS-DESIGN.md section 13.
//
//   keyboard   a FIFO inside the profile replaces the chord helper's stdout (METIS_QA_CHORD_FIFO, src/main/qa-voice-hooks.ts);
//              the harness writes the same `m <mask> <seq>` lines, so the recognizer, session, lease and capture are real.
//   microphone Chromium's fake capture device reads a per-utterance WAV (macOS `say` + `afconvert`, generated at run time).
//   desktop    a recording sink (METIS_QA_DESKTOP_SINK=1) stands in for Notes, the browser and the camera.
//   brain      the custom provider points at scripts/qa/mock-llm-server.mjs (a local TLS server with a throwaway certificate).
//
// Every step PASSES only on something it observed; a surface the build under test lacks reports NOT_SUPPORTED with the
// reason. Reports carry counts, states, timings and hashes, never what was said (voice-actions-lib.mjs reportLeaksMarkers).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sleep, waitFor } from '../lib/app-driver.mjs'
import { createMockLlmServer } from '../mock-llm-server.mjs'
import { runTool } from './exec.mjs'
import { isDraftMeetingFile, listMeetingFiles, runStep } from './lib.mjs'
import { observeTranscriptDraft, startSyntheticMeeting, stopAndSave } from './scenario.mjs'
import { readAudit } from './session.mjs'
import { sampleTree } from './sampler.mjs'
import {
  cleanQuit,
  dispatchKeyEvents,
  escapeKeyEvents,
  openSettingsTab,
  settingsShortcutEvents,
  shapeObservation
} from './settings-hig.mjs'
import {
  CHORD_UP_LINE,
  DEFAULT_HOLD_MS,
  EARLY_RETURN_MS,
  LATE_RETURN_MS,
  PRIVACY_MARKERS,
  SHORT_HOLD_MS,
  UTTERANCES,
  VOICE_ACTIONS_STEPS,
  WARM_RELEASE_TO_DONE_BUDGET_MS,
  auditCountOf,
  auditOperatorQueue,
  chordLine,
  classifyPillCopy,
  foldPillStates,
  generateUtteranceWav,
  installCaptureWav,
  isLeaseOrTurnAudit,
  judgeCardOnMount,
  judgeConfirmEscape,
  judgeConfirmUncertain,
  judgeDefaultOn,
  judgeIdleCost,
  judgeIdleNoMic,
  judgeMeetingArbitration,
  judgeNoUtteranceAtRest,
  judgeQuestion,
  judgeReadOnly,
  judgeReducedMotion,
  judgeRendererReset,
  judgeReturnGuard,
  judgeShortHold,
  judgeToggleOff,
  maskForChord,
  median,
  scanTreesForMarkers
} from './voice-actions-lib.mjs'

export { VOICE_ACTIONS_STEPS }

const SWITCH_LABEL = 'Use voice actions'
const MOCK_ANSWER_TEXT = 'Backup answer from mock'
const TERMINAL_STATES = Object.freeze(['done', 'failed', 'uncertain'])
const POLL_MS = 100

// ---------------------------------------------------------------------------------------------------------------
// Layout, seed and environment

/** Where the voice hooks keep their files, all inside the profile (the FIFO hook refuses anything outside it). */
export function voiceLayout(layout) {
  const dir = join(layout.userData, 'qa-voice')
  return {
    dir,
    fifo: join(dir, 'chord.fifo'),
    utterancesDir: join(dir, 'utterances'),
    meetingWav: join(dir, 'meeting.wav')
  }
}

/** Settings seeded for this scenario: the custom provider pointed at the local mock LLM, nothing about voice actions. */
export function voiceSeedSettings(port) {
  return {
    provider: 'custom',
    customBaseUrl: `https://127.0.0.1:${port}/ok/v1`,
    providerModels: { custom: 'mock-model' }
  }
}

/** The QA hooks for one launch. `fifo: false` leaves the REAL helper as the watcher source (the idle-cost soak). */
export function voiceExtraEnv(layout, { fifo = true, tls = true } = {}) {
  return {
    ...(fifo ? { METIS_QA_CHORD_FIFO: voiceLayout(layout).fifo } : {}),
    METIS_QA_DESKTOP_SINK: '1',
    ...(tls ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {})
  }
}

/** A throwaway self-signed certificate for the local mock, minted in `dir` (macOS ships /usr/bin/openssl). */
export function mintSelfSignedCert(dir, run = runTool) {
  mkdirSync(dir, { recursive: true })
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  const result = run(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=127.0.0.1'
    ],
    { timeoutMs: 60_000 }
  )
  if (result.status !== 0)
    throw new Error(
      `openssl could not mint a throwaway certificate (exit ${result.status}${result.error ? `: ${result.error}` : ''})`
    )
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

/**
 * Everything the run needs before the app starts: the FIFO, the per-utterance WAVs, the meeting feed and the mock LLM. The
 * mock is optional (the question step reports NOT_SUPPORTED without it); the rest is required and throws when it cannot be made.
 * @param {{ layout: any, audio: { speech: boolean }, run?: typeof runTool, log?: (line: string) => void, listen?: (server: any) => Promise<number> }} args
 */
export async function prepareVoiceActions({ layout, audio, run = runTool, log = () => {}, listen = listenOnFreePort }) {
  const vl = voiceLayout(layout)
  mkdirSync(vl.utterancesDir, { recursive: true })
  rmSync(vl.fifo, { force: true })
  const mkfifo = run('/usr/bin/mkfifo', [vl.fifo], { timeoutMs: 10_000 })
  if (mkfifo.status !== 0)
    throw new Error(`mkfifo failed (exit ${mkfifo.status}${mkfifo.error ? `: ${mkfifo.error}` : ''})`)
  /** @type {Record<string, ReturnType<typeof generateUtteranceWav>>} */
  const utterances = {}
  for (const [id, phrase] of Object.entries(UTTERANCES)) {
    utterances[id] = generateUtteranceWav({ id, phrase, dir: vl.utterancesDir, tmp: layout.tmp, run })
    log(`utterance ${id}: ${utterances[id].durationSeconds}s, sha256 ${utterances[id].sha256.slice(0, 12)}`)
  }
  let meeting = null
  if (audio.speech && existsSync(layout.captureWav)) {
    meeting = { path: vl.meetingWav, sha256: installCaptureWav(layout.captureWav, vl.meetingWav) }
  }
  let mock = null
  let mockReason = null
  let certDir = null
  try {
    certDir = join(layout.tmp, 'va-cert')
    const tls = mintSelfSignedCert(certDir, run)
    const { server, log: requestLog } = createMockLlmServer({ tls })
    const port = await listen(server)
    mock = { server, log: requestLog, port }
  } catch (error) {
    mockReason = `the local mock LLM could not start: ${String(error?.message ?? error).slice(0, 200)}`
  } finally {
    if (certDir) rmSync(certDir, { recursive: true, force: true })
  }
  return {
    vl,
    utterances,
    meeting,
    mock,
    mockReason,
    seed: mock ? voiceSeedSettings(mock.port) : {},
    envFor: ({ fifo = true } = {}) => voiceExtraEnv(layout, { fifo, tls: Boolean(mock) }),
    stop: async () => {
      if (mock) await new Promise((resolve) => mock.server.close(() => resolve())).catch(() => {})
    }
  }
}

async function listenOnFreePort(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

/** Report-safe description of what was prepared: ids, hashes and durations, never a phrase. */
export function describePrepared(prepared) {
  return {
    utterances: Object.values(prepared.utterances).map(({ id, sha256, bytes, durationSeconds, speechSeconds }) => ({
      id,
      sha256,
      bytes,
      durationSeconds,
      speechSeconds
    })),
    meetingFeed: prepared.meeting ? { sha256: prepared.meeting.sha256 } : null,
    mockLlm: prepared.mock ? 'listening (https, throwaway certificate)' : prepared.mockReason
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The chord FIFO writer

/**
 * Press and release the chord by writing the helper's own protocol lines. Each write opens the FIFO read-write (never
 * blocks, never leaves the app's reader at end-of-file) and closes it again.
 */
export function createChordFifo(path, mask, { open = openFile } = {}) {
  const write = async (text) => {
    const handle = await open(path, 'r+')
    try {
      await handle.write(text)
    } finally {
      await handle.close()
    }
  }
  return { path, mask, down: () => write(chordLine(mask)), up: () => write(CHORD_UP_LINE) }
}

/** Hold the chord for `ms`; returns the wall-clock moments of the press and the release. */
export async function holdChord(fifo, ms) {
  const tDown = Date.now()
  await fifo.down()
  await sleep(ms)
  const tUp = Date.now()
  await fifo.up()
  return { tDown, tUp }
}

// ---------------------------------------------------------------------------------------------------------------
// The page recorder: what the renderer showed, in order, with wall-clock times

/**
 * Installed before anything is observed, and again (through addInitScript) for every later document, so a reload keeps
 * recording. It keeps, in memory only: pill state changes with the pill's own title, card mount and removal (with the card's
 * role, title, argument and button labels), and a getUserMedia call count. The harness turns these into classes and counts
 * before anything reaches a report.
 */
export const RECORDER_SOURCE = `(() => {
  if (window.__va) return
  const va = { events: [], gum: 0, pill: null, pillTitle: '', card: false }
  window.__va = va
  const push = (event) => {
    event.wall = Date.now()
    va.events.push(event)
    if (va.events.length > 400) va.events.shift()
  }
  const text = (node) => (node && node.textContent ? node.textContent.trim() : '')
  const byId = (id) => (id ? document.getElementById(id) : null)
  va.describeCard = () => {
    const dialog = document.querySelector('[role="alertdialog"]')
    if (!dialog) return null
    const active = document.activeElement
    return {
      role: dialog.getAttribute('role'),
      title: text(byId(dialog.getAttribute('aria-labelledby'))),
      argument: text(byId(dialog.getAttribute('aria-describedby'))),
      buttons: Array.from(dialog.querySelectorAll('button')).map(text),
      focusedLabel: active && dialog.contains(active) ? text(active) : null
    }
  }
  try {
    const devices = navigator.mediaDevices
    if (devices && devices.getUserMedia && !devices.__vaWrapped) {
      const original = devices.getUserMedia.bind(devices)
      devices.getUserMedia = function () {
        va.gum += 1
        push({ k: 'gum' })
        return original.apply(null, arguments)
      }
      devices.__vaWrapped = true
    }
  } catch (error) {}
  const scan = () => {
    const pill = document.querySelector('[data-voice-state]')
    const state = pill ? pill.getAttribute('data-voice-state') : null
    const title = pill ? text(pill.querySelector('.voice-pill__title')) : ''
    if (state !== va.pill) {
      va.pill = state
      va.pillTitle = title
      push({ k: 'pill', state, title })
    } else if (state && title !== va.pillTitle) {
      va.pillTitle = title
      push({ k: 'pillText', state, title })
    }
    const dialog = document.querySelector('[role="alertdialog"]')
    if (dialog && !va.card) {
      va.card = true
      push(Object.assign({ k: 'card' }, va.describeCard()))
    } else if (!dialog && va.card) {
      va.card = false
      push({ k: 'cardGone' })
    }
  }
  new MutationObserver(scan).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  scan()
})()`

export async function installRecorder(page) {
  await page.addInitScript(RECORDER_SOURCE)
  await page.evaluate(RECORDER_SOURCE)
}

export async function readRecorder(page) {
  const snapshot = await page.evaluate(() =>
    window.__va ? { events: window.__va.events.slice(), gum: window.__va.gum, pill: window.__va.pill } : null
  )
  if (!snapshot) throw new Error('the page recorder is not installed (a reload dropped it)')
  return snapshot
}

export const resetRecorder = (page) =>
  page.evaluate(() => {
    if (window.__va) window.__va.events.length = 0
  })

export const readCard = (page) => page.evaluate(() => (window.__va ? window.__va.describeCard() : null))

/** The last pill title the page showed (pill or pillText event). Kept only to be classified, never reported. */
export function latestPillTitle(events) {
  for (let i = (events ?? []).length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if ((event.k === 'pill' || event.k === 'pillText') && event.title) return event.title
  }
  return ''
}

export const cardMountEvent = (events) => (events ?? []).find((event) => event.k === 'card') ?? null
export const cardEverMounted = (events) => Boolean(cardMountEvent(events))

/** Return as a real key press (keyDown with text, so a focused default button also sees the character). */
export function returnKeyEvents() {
  const common = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 36,
    modifiers: 0,
    commands: []
  }
  return [
    { type: 'keyDown', ...common, text: '\r', unmodifiedText: '\r' },
    { type: 'keyUp', ...common }
  ]
}

/** A CDP session kept open for key delivery, so a timed key press is not delayed by opening one each time. */
async function openKeySender(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  return {
    cdp,
    send: async (events) => {
      for (const event of events) await cdp.send('Input.dispatchKeyEvent', event)
    },
    close: () => cdp.detach().catch(() => {})
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Audit and filesystem observations

export const auditMark = (layout) => readAudit(layout).length
export const auditFrom = (layout, mark) => readAudit(layout).slice(mark)

export const sinkActionsIn = (records) =>
  records.filter((record) => record?.event === 'qa.desktop_action.dispatched').map((record) => String(record.actionId))

const BOOKKEEPING_KEYS = new Set(['ts', 'seq', 'prev'])
/** Records whose own fields (not time, sequence or chain) match `pattern`. */
export function auditMentions(records, pattern) {
  return records.filter((record) => {
    const own = Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !BOOKKEEPING_KEYS.has(key)))
    return pattern.test(JSON.stringify(own))
  }).length
}

/** Audit records that mean the meeting's capture was revoked, restarted or degraded. */
export function isMeetingCaptureDisturbance(record) {
  const event = String(record?.event ?? '')
  return /^(meeting|listen|capture)\./.test(event) && /revok|restart|degraded|lost|stalled/i.test(event)
}

export function taskStoreFingerprint(layout) {
  try {
    return createHash('sha256')
      .update(readFileSync(join(layout.userData, 'desktop-action-tasks.bin')))
      .digest('hex')
  } catch {
    return null
  }
}

export function latestDraftBytes(layout) {
  const names = listMeetingFiles(layout.meetingsFolder, isDraftMeetingFile)
  if (!names.length) return 0
  try {
    return statSync(join(layout.meetingsFolder, names.at(-1))).size
  } catch {
    return 0
  }
}

const readOperatorQueue = (layout) => {
  try {
    return readFileSync(join(layout.userData, 'operator-queue.json'), 'utf8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Settings helpers (real clicks through Playwright, real keys over CDP)

const tablistOf = (page) => page.getByRole('tablist', { name: 'Settings sections' })

async function openSpeechSwitch(page, platform) {
  if ((await tablistOf(page).count()) === 0) {
    await dispatchKeyEvents(page, settingsShortcutEvents(platform))
    await tablistOf(page).waitFor({ state: 'visible', timeout: 10_000 })
  }
  await openSettingsTab(page, 'audio')
  return page.getByRole('switch', { name: SWITCH_LABEL, exact: true })
}

/** Close Settings with its own "Close settings" button, then Escape, then the shortcut. Throws when it stays open. */
async function closeSettings(page, platform) {
  if ((await tablistOf(page).count()) === 0) return
  const close = page.getByRole('button', { name: 'Close settings', exact: true })
  if ((await close.count()) > 0) {
    await close
      .first()
      .click({ timeout: 5_000 })
      .catch(() => {})
    await sleep(700)
  }
  for (const events of [escapeKeyEvents(), settingsShortcutEvents(platform)]) {
    if ((await tablistOf(page).count()) === 0) return
    await dispatchKeyEvents(page, events)
    await sleep(700)
  }
  if ((await tablistOf(page).count()) > 0)
    throw new Error('Settings could not be closed, so a hold would not be observed on the overlay')
}

// ---------------------------------------------------------------------------------------------------------------
// Waiting on what the page recorded

async function waitForEvent(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { events } = await readRecorder(page)
    const found = events.find(predicate)
    if (found) return found
    if (Date.now() >= deadline) return null
    await sleep(POLL_MS)
  }
}

const isTerminalPill = (event) => event.k === 'pill' && TERMINAL_STATES.includes(event.state)

/** Wait until the pill has gone (state null) after having been shown, or `timeoutMs`. */
async function waitForPillGone(page, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { pill } = await readRecorder(page)
    if (pill === null) return true
    if (Date.now() >= deadline) return false
    await sleep(POLL_MS)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The scenario

/**
 * @param {{ report: any, layout: any, launch: (options: { fifo: boolean }) => Promise<any>, onSession: (session: any) => void,
 *   prepared: Awaited<ReturnType<typeof prepareVoiceActions>>, audio: { speech: boolean }, platform?: string,
 *   config?: { idleSeconds?: number, runs?: number, holdMs?: number, relaunchPerUtterance?: boolean, idleCostMinutes?: number, saveWaitSeconds?: number, transcriptWaitSeconds?: number },
 *   log?: (line: string) => void }} args
 */
export async function runVoiceActionsScenario({
  report,
  layout,
  launch,
  onSession,
  prepared,
  audio,
  platform = process.platform,
  config = {},
  log = () => {}
}) {
  const cfg = {
    idleSeconds: 60,
    runs: 3,
    holdMs: DEFAULT_HOLD_MS,
    relaunchPerUtterance: false,
    idleCostMinutes: 0,
    saveWaitSeconds: 180,
    transcriptWaitSeconds: 150,
    ...config
  }
  const ctx = { session: null, fifo: null, mask: null, gumBaseline: 0, sinkTotal: 0 }

  const start = async ({ fifo = true } = {}) => {
    ctx.session = await launch({ fifo })
    onSession(ctx.session)
    const page = await ctx.session.connect()
    await installRecorder(page)
    const stored = await page.evaluate(() =>
      window.toto.getSettings().then((settings) => settings.voiceActions?.holdChord ?? null)
    )
    const tokens = stored?.[platform === 'win32' ? 'win' : 'mac']
    ctx.mask = maskForChord(tokens ?? ['rightCommand'])
    ctx.fifo = createChordFifo(prepared.vl.fifo, ctx.mask)
    return ctx.session
  }
  const relaunch = async () => {
    const quit = await cleanQuit(ctx.session)
    void quit
    return start()
  }
  const speak = async (id) => {
    if (cfg.relaunchPerUtterance && ctx.session) await relaunch()
    const hash = installCaptureWav(prepared.utterances[id].path, layout.captureWav)
    await sleep(300)
    return hash
  }
  const page = () => ctx.session.connect()
  const fifoAudits = (state) =>
    ctx.session.audit().filter((record) => record.event === 'qa.chord_fifo' && record.state === state)

  // -- launch -------------------------------------------------------------------------------------------------
  await runStep(report, 'launch-and-renderer-ready', async () => {
    await start()
    const state = await waitFor(
      () => {
        const records = ctx.session.audit().filter((record) => record.event === 'qa.chord_fifo')
        return records.find((record) => record.state === 'refused' || record.state === 'open') ?? null
      },
      'the app never reported its chord FIFO source (no qa.chord_fifo audit): is this a QA-identity build with the voice hooks?',
      20_000,
      250
    )
    if (state.state === 'refused')
      throw new Error(`the chord FIFO source refused its request (${state.reason}); the watcher has no source`)
    const audit = ctx.session.audit()
    return {
      evidence: {
        pid: ctx.session.pid,
        rendererReadyAudit: audit.some((record) => record.event === 'app.renderer.ready'),
        cdpConnected: Boolean(ctx.session.page),
        captureFileSourceAudit: audit.some((record) => record.event === 'qa.capture.file_source'),
        chordFifoSource: state.state,
        recorderInstalled: true,
        holdChordMask: ctx.mask
      }
    }
  })
  const launched = { requires: ['launch-and-renderer-ready'] }

  // -- step 0: the synthetic audio ------------------------------------------------------------------------------
  await runStep(
    report,
    'va-audio-prepared',
    async () => {
      const described = describePrepared(prepared)
      const missing = Object.keys(UTTERANCES).filter((id) => !prepared.utterances[id])
      if (missing.length) throw new Error(`no WAV for utterance(s) ${missing.join(', ')}`)
      return {
        evidence: {
          ...described,
          feed: cfg.relaunchPerUtterance
            ? 'one launch per utterance'
            : 'file swapped in place before each hold (Chromium reads the file when the capture stream opens: ASSUMED, proven by the first spoken step)',
          leadSeconds: 1,
          trailSeconds: 3
        }
      }
    },
    launched
  )

  // -- va-default-on ----------------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-default-on',
    async () => {
      const p = await page()
      const { gum } = await readRecorder(p)
      const leaseOrTurnAudits = ctx.session.audit().filter(isLeaseOrTurnAudit).length
      const read = await p.evaluate(async () => {
        const settings = await window.toto.getSettings()
        const snapshot = await window.toto.voiceActions?.getState?.()
        return {
          storedEnabled: settings.voiceActions?.enabled ?? null,
          wakeWord: settings.voiceActions?.wakeWord ?? null,
          snapshot: snapshot ? { enabled: snapshot.enabled, state: snapshot.state, shortcut: snapshot.shortcut } : null
        }
      })
      const toggle = await openSpeechSwitch(p, platform)
      let switchChecked = null
      try {
        await toggle.waitFor({ state: 'visible', timeout: 8_000 })
        switchChecked = (await toggle.getAttribute('aria-checked')) === 'true'
      } catch {
        switchChecked = null
      }
      await closeSettings(p, platform)
      ctx.gumBaseline = (await readRecorder(p)).gum
      return shapeObservation({
        problems: judgeDefaultOn({
          storedEnabled: read.storedEnabled,
          wakeWord: read.wakeWord,
          snapshot: read.snapshot,
          switchChecked,
          getUserMediaCalls: gum,
          leaseOrTurnAudits
        }),
        evidence: {
          storedEnabled: read.storedEnabled,
          effectiveEnabled: read.snapshot?.enabled ?? null,
          shortcut: read.snapshot?.shortcut ?? null,
          wakeWord: read.wakeWord,
          speechSwitchChecked: switchChecked,
          getUserMediaCallsBeforeAnyHold: gum,
          leaseOrTurnAuditsBeforeAnyHold: leaseOrTurnAudits,
          counterNote:
            'the getUserMedia counter was installed after the renderer was ready; the audit absence covers the gap'
        }
      })
    },
    launched
  )

  // -- va-idle-no-mic ---------------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-idle-no-mic',
    async () => {
      const p = await page()
      await sleep(cfg.idleSeconds * 1000)
      const { gum } = await readRecorder(p)
      const idleGum = gum - ctx.gumBaseline
      const audit = ctx.session.audit()
      const leaseOrTurnAudits = audit.filter(isLeaseOrTurnAudit).length
      const open = audit.filter((record) => record.event === 'qa.chord_fifo' && record.state === 'open').length
      const refused = audit.filter((record) => record.event === 'qa.chord_fifo' && record.state === 'refused').length
      return shapeObservation({
        problems: judgeIdleNoMic({
          getUserMediaCalls: idleGum,
          leaseOrTurnAudits,
          fifoOpenAudits: open,
          fifoRefusedAudits: refused
        }),
        evidence: {
          idleSeconds: cfg.idleSeconds,
          getUserMediaCalls: idleGum,
          leaseOrTurnAudits,
          watcherSource: refused ? 'refused' : open ? 'qa-fifo' : 'none',
          chordFifoOpenAudits: open
        }
      })
    },
    launched
  )

  // -- va-short-hold-ignored -------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-short-hold-ignored',
    async () => {
      const p = await page()
      await resetRecorder(p)
      const mark = auditMark(layout)
      await holdChord(ctx.fifo, SHORT_HOLD_MS)
      await sleep(1_500)
      const { events } = await readRecorder(p)
      const states = foldPillStates(events)
      const leaseOrTurnAudits = auditFrom(layout, mark).filter(isLeaseOrTurnAudit).length
      return shapeObservation({
        problems: judgeShortHold({ pillStates: states, leaseOrTurnAudits, cardEverMounted: cardEverMounted(events) }),
        evidence: {
          holdMs: SHORT_HOLD_MS,
          pillStates: states,
          voiceStateElementsSeen: states.length,
          leaseOrTurnAudits
        }
      })
    },
    launched
  )

  // -- va-read-only-immediate ------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-read-only-immediate',
    async () => {
      const runs = []
      const problems = []
      for (let index = 0; index < cfg.runs; index += 1) {
        const feedHash = await speak('open-notes')
        const p = await page()
        await resetRecorder(p)
        const mark = auditMark(layout)
        const before = taskStoreFingerprint(layout)
        const { tUp } = await holdChord(ctx.fifo, cfg.holdMs)
        const terminal = await waitForEvent(p, isTerminalPill, 25_000)
        await sleep(400)
        const { events } = await readRecorder(p)
        const states = foldPillStates(events)
        const done = events.find((event) => event.k === 'pill' && event.state === 'done')
        const records = auditFrom(layout, mark)
        const sinkActions = sinkActionsIn(records)
        const runProblems = judgeReadOnly({
          pillStates: states,
          cardEverMounted: cardEverMounted(events),
          sinkActions,
          expectedAction: 'desktop.open_notes',
          taskStoreChanged: taskStoreFingerprint(layout) !== before,
          reachedDone: Boolean(terminal && done)
        })
        problems.push(...runProblems.map((problem) => `run ${index + 1}: ${problem}`))
        runs.push({
          run: index + 1,
          releaseToDoneMs: done ? done.wall - tUp : null,
          states,
          sinkDispatches: sinkActions.length,
          feedSha256: feedHash.slice(0, 12)
        })
        await waitForPillGone(p)
        await sleep(500)
      }
      const warm = runs.slice(1).map((run) => run.releaseToDoneMs)
      const p50 = median(warm.length ? warm : runs.map((run) => run.releaseToDoneMs))
      return shapeObservation({
        problems,
        evidence: {
          runs: runs.length,
          perRun: runs,
          coldReleaseToDoneMs: runs[0]?.releaseToDoneMs ?? null,
          warmReleaseToDoneP50Ms: p50,
          warmBudgetMs: WARM_RELEASE_TO_DONE_BUDGET_MS,
          withinWarmBudget: p50 !== null && p50 <= WARM_RELEASE_TO_DONE_BUDGET_MS,
          budgetNote: 'recorded (MEASURED), not a verdict: the 1.5 s warm budget is ASSUMED in the design',
          sinkDispatchesPerRun: runs.map((run) => run.sinkDispatches)
        }
      })
    },
    launched
  )

  // -- the confirmation card steps --------------------------------------------------------------------------------
  /** Say "create a note", hold, and wait for the card. Returns the card's mount event or the reason there is none. */
  const holdForCard = async () => {
    await speak('create-note')
    const p = await page()
    await resetRecorder(p)
    const mark = auditMark(layout)
    await holdChord(ctx.fifo, cfg.holdMs)
    const outcome = await waitForEvent(p, (event) => event.k === 'card' || isTerminalPill(event), 30_000)
    const { events } = await readRecorder(p)
    return { p, mark, events, mount: outcome?.k === 'card' ? outcome : null, states: foldPillStates(events) }
  }
  const noCardOutcome = (held) =>
    held.states.includes('proposing')
      ? {
          status: 'NOT_SUPPORTED',
          reason:
            'this build proposes the action (pill state proposing) but mounts no confirmation card: the card (V04) is not in the build under test',
          evidence: { pillStates: held.states }
        }
      : null
  const cancelCard = async (p) => {
    if (!(await readCard(p))) return
    const keys = await openKeySender(p)
    try {
      await keys.send(escapeKeyEvents())
    } finally {
      await keys.close()
    }
    await waitFor(async () => (await readCard(p)) === null, 'the card stayed after the cleanup Escape', 5_000, 100)
    await waitForPillGone(p, 5_000)
  }

  await runStep(
    report,
    'va-confirm-escape',
    async () => {
      const held = await holdForCard()
      if (!held.mount) {
        const unsupported = noCardOutcome(held)
        if (unsupported) return unsupported
        throw new Error(`no confirmation card and no proposal: the pill went ${held.states.join(' > ') || '(nothing)'}`)
      }
      await sleep(250)
      const card = await readCard(held.p)
      const cardProblems = judgeCardOnMount({ card })
      const keys = await openKeySender(held.p)
      try {
        await keys.send(escapeKeyEvents())
      } finally {
        await keys.close()
      }
      const cardGone = await waitFor(
        async () => (await readCard(held.p)) === null,
        'the card stayed after Escape',
        5_000,
        100
      ).then(
        () => true,
        () => false
      )
      await sleep(400)
      const { events } = await readRecorder(held.p)
      const records = auditFrom(layout, held.mark)
      const pillCopyClass = classifyPillCopy(latestPillTitle(events))
      const sinkCount = sinkActionsIn(records).length
      const revokedCancelled = auditCountOf(records, 'command.revoked', (record) => record.reason === 'cancelled')
      await waitForPillGone(held.p, 6_000)
      return shapeObservation({
        problems: judgeConfirmEscape({ cardProblems, cardGone, pillCopyClass, sinkCount, revokedCancelled }),
        evidence: {
          cardRole: card?.role ?? null,
          cardTitleIsMainGenerated: card?.title === 'Create a note in Notes',
          cardShowsArgument: Boolean(card?.argument),
          defaultButton: card?.focusedLabel ?? null,
          buttonOrder: card?.buttons ?? null,
          escapeRemovedCard: cardGone,
          pillCopyAfterEscape: pillCopyClass,
          sinkDispatches: sinkCount,
          commandRevokedCancelledAudits: revokedCancelled
        }
      })
    },
    launched
  )

  await runStep(
    report,
    'va-return-guard',
    async () => {
      const held = await holdForCard()
      if (!held.mount) {
        const unsupported = noCardOutcome(held)
        if (unsupported) return unsupported
        throw new Error(`no confirmation card and no proposal: the pill went ${held.states.join(' > ') || '(nothing)'}`)
      }
      const keys = await openKeySender(held.p)
      let delivered = null
      try {
        await sleep(Math.max(0, EARLY_RETURN_MS - (Date.now() - held.mount.wall)))
        await keys.send(returnKeyEvents())
        delivered = Date.now() - held.mount.wall
        await sleep(600)
        const stillPresent = (await readCard(held.p)) !== null
        const sinkCount = sinkActionsIn(auditFrom(layout, held.mark)).length
        const problems = judgeReturnGuard({
          returnDeliveredMsAfterMount: delivered,
          cardStillPresent: stillPresent,
          sinkCount
        })
        await cancelCard(held.p)
        return shapeObservation({
          problems,
          evidence: {
            returnDeliveredMsAfterMount: delivered,
            guardWindowMs: 300,
            cardStillPresent: stillPresent,
            sinkDispatches: sinkCount
          }
        })
      } finally {
        await keys.close()
      }
    },
    launched
  )

  await runStep(
    report,
    'va-confirm-return-uncertain',
    async () => {
      const held = await holdForCard()
      if (!held.mount) {
        const unsupported = noCardOutcome(held)
        if (unsupported) return unsupported
        throw new Error(`no confirmation card and no proposal: the pill went ${held.states.join(' > ') || '(nothing)'}`)
      }
      const keys = await openKeySender(held.p)
      let delivered
      try {
        await sleep(Math.max(0, LATE_RETURN_MS - (Date.now() - held.mount.wall)))
        await keys.send(returnKeyEvents())
        delivered = Date.now() - held.mount.wall
      } finally {
        await keys.close()
      }
      await waitForEvent(held.p, isTerminalPill, 20_000)
      await sleep(500)
      const { events } = await readRecorder(held.p)
      const records = auditFrom(layout, held.mark)
      const pillCopyClass = classifyPillCopy(latestPillTitle(events))
      const createNote = (items) => sinkActionsIn(items).filter((id) => id === 'desktop.create_note').length
      const sinkCreateNoteCount = createNote(records)
      const uncertainAudits = auditCountOf(records, 'task.effect_uncertain')
      // Relaunch: recovery must report the uncertain task and must never replay it.
      const relaunchMark = auditMark(layout)
      await relaunch()
      const recovered = await waitFor(
        () => {
          const slice = auditFrom(layout, relaunchMark)
          return slice.some((record) => record.event === 'task.recovered') ? slice : null
        },
        'no task.recovered audit after the relaunch',
        30_000,
        250
      ).catch(() => auditFrom(layout, relaunchMark))
      await sleep(4_000)
      const afterRelaunch = auditFrom(layout, relaunchMark)
      const recoveredUncertain = auditCountOf(recovered, 'task.recovered', (record) => record.status === 'uncertain')
      const sinkCountAfterRelaunch = createNote(auditFrom(layout, held.mark))
      return shapeObservation({
        problems: judgeConfirmUncertain({
          returnDeliveredMsAfterMount: delivered,
          sinkCreateNoteCount,
          uncertainAudits,
          pillCopyClass,
          recoveredUncertain,
          sinkCountAfterRelaunch
        }),
        evidence: {
          returnDeliveredMsAfterMount: delivered,
          sinkCreateNoteDispatches: sinkCreateNoteCount,
          taskEffectUncertainAudits: uncertainAudits,
          pillCopyAfterReturn: pillCopyClass,
          recoveredUncertainAfterRelaunch: recoveredUncertain,
          sinkDispatchesSinceRelaunch: sinkActionsIn(afterRelaunch).length,
          createNoteDispatchesAcrossRelaunch: sinkCountAfterRelaunch
        }
      })
    },
    launched
  )

  await runStep(
    report,
    'va-uncertain-reader-details',
    async () => ({
      status: 'NOT_SUPPORTED',
      reason:
        'the Reader details list is a right-edge surface that takes ask, capture, live and meeting errors only (App.tsx readerDetailErrors); this build does not route voice outcomes there and the QA profile uses the bar layout, so "Reader details shows one entry" stays on the owner-run checklist',
      evidence: { surface: 'right-edge Reader details', routedFromVoice: false }
    }),
    launched
  )

  // -- va-question --------------------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-question',
    async () => {
      if (!prepared.mock) return { status: 'NOT_SUPPORTED', reason: prepared.mockReason ?? 'no mock LLM', evidence: {} }
      await speak('question')
      const p = await page()
      await p.evaluate(() => window.toto.setApiKey('custom', 'synthetic-mock-key'))
      prepared.mock.log.clear()
      await resetRecorder(p)
      const mark = auditMark(layout)
      await holdChord(ctx.fifo, cfg.holdMs)
      const answerShown = await waitFor(
        async () => (await p.getByText(MOCK_ANSWER_TEXT).count()) > 0,
        `the answer view never showed the mock answer within 40 s`,
        40_000,
        250
      ).then(
        () => true,
        () => false
      )
      await sleep(500)
      const questionRequests = prepared.mock.log.count(['capital', 'france'])
      const sinkCount = sinkActionsIn(auditFrom(layout, mark)).length
      return shapeObservation({
        problems: judgeQuestion({ questionRequests, sinkCount, answerShown }),
        evidence: {
          mockRequestsCarryingTheQuestion: questionRequests,
          mockRequestsTotal: prepared.mock.log.total(),
          answerShown,
          sinkDispatches: sinkCount
        }
      })
    },
    launched
  )

  // -- va-meeting-arbitration ----------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-meeting-arbitration',
    async () => {
      if (!audio.speech || !prepared.meeting)
        return {
          status: 'NOT_SUPPORTED',
          reason: 'the meeting needs synthetic speech to keep its autosave draft growing; re-run with --audio speech',
          evidence: { audio: audio.speech ? 'speech' : 'tone' }
        }
      const p = await page()
      installCaptureWav(prepared.meeting.path, layout.captureWav)
      await startSyntheticMeeting(ctx.session)
      let meetingLive = true
      try {
        const draftStep = await observeTranscriptDraft(ctx.session, {
          speech: true,
          waitSeconds: cfg.transcriptWaitSeconds
        })
        if (draftStep.status) return draftStep
        await resetRecorder(p)
        const mark = auditMark(layout)
        const draftBefore = latestDraftBytes(layout)
        await holdChord(ctx.fifo, cfg.holdMs)
        await sleep(1_500)
        const { events } = await readRecorder(p)
        const records = auditFrom(layout, mark)
        const pillCopyClass = classifyPillCopy(latestPillTitle(events))
        const grew = await waitFor(
          () => (latestDraftBytes(layout) > draftBefore ? latestDraftBytes(layout) : null),
          'the meeting autosave draft did not grow',
          150_000,
          2_000
        ).catch(() => latestDraftBytes(layout))
        const stopped = await stopAndSave(ctx.session, { waitSeconds: cfg.saveWaitSeconds })
        meetingLive = false
        const final = auditFrom(layout, mark)
        return shapeObservation({
          problems: judgeMeetingArbitration({
            pillCopyClass,
            voiceStartedAudits: records.filter(isLeaseOrTurnAudit).length,
            meetingRevokeAudits: final.filter(isMeetingCaptureDisturbance).length,
            draftBefore,
            draftAfter: grew
          }),
          evidence: {
            pillStates: foldPillStates(events),
            pillCopyClass,
            voiceTurnOrLeaseStarts: records.filter(isLeaseOrTurnAudit).length,
            meetingCaptureDisturbanceAudits: final.filter(isMeetingCaptureDisturbance).length,
            draftBytesBeforeHold: draftBefore,
            draftBytesAfter: grew,
            meetingSavedAfterwards: Boolean(stopped.file)
          }
        })
      } finally {
        // A failed or unsupported step must not leave a live meeting behind for the steps that follow.
        if (meetingLive) await stopAndSave(ctx.session, { waitSeconds: cfg.saveWaitSeconds }).catch(() => {})
      }
    },
    launched
  )

  // -- va-renderer-reset-revokes ---------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-renderer-reset-revokes',
    async () => {
      await speak('open-notes')
      const p = await page()
      await resetRecorder(p)
      const mark = auditMark(layout)
      await ctx.fifo.down()
      let reloaded = false
      try {
        await waitForEvent(p, (event) => event.k === 'pill' && event.state === 'listening', 15_000)
        reloaded = true
        await p.reload({ waitUntil: 'domcontentloaded' })
      } finally {
        await ctx.fifo.up()
      }
      if (!reloaded) throw new Error('the pill never reached listening, so a reload mid-listening could not be tested')
      await waitFor(
        async () => (await p.evaluate(() => typeof window.toto?.getSettings === 'function')) === true,
        'the page did not come back after the reload',
        20_000,
        250
      )
      await installRecorder(p)
      await sleep(3_000)
      const { events } = await readRecorder(p)
      const records = auditFrom(layout, mark)
      return shapeObservation({
        problems: judgeRendererReset({
          revokedRendererReset: auditMentions(records, /renderer[-_]reset/),
          proposalPills:
            foldPillStates(events).filter((state) => state === 'proposing' || state === 'confirming').length +
            (cardEverMounted(events) ? 1 : 0),
          sinkCount: sinkActionsIn(records).length,
          turnCancelled: auditCountOf(records, 'voice.turn', (record) => record.phase === 'cancelled') > 0
        }),
        evidence: {
          auditRecordsNamingRendererReset: auditMentions(records, /renderer[-_]reset/),
          voiceTurnCancelledAudits: auditCountOf(records, 'voice.turn', (record) => record.phase === 'cancelled'),
          pillStatesAfterReload: foldPillStates(events),
          sinkDispatches: sinkActionsIn(records).length,
          pcmClearedNote:
            'the command capture zeroes its PCM on every stop path (command-speech-capture.ts) and writes no audit of it; asserted by that module’s own tests'
        }
      })
    },
    launched
  )

  // -- va-toggle-off-instant ---------------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-toggle-off-instant',
    async () => {
      const p = await page()
      const toggle = await openSpeechSwitch(p, platform)
      await toggle.waitFor({ state: 'visible', timeout: 8_000 })
      const mark = auditMark(layout)
      const clickedAt = Date.now()
      await toggle.click({ timeout: 10_000 })
      const closed = await waitFor(
        () =>
          auditFrom(layout, mark).find((record) => record.event === 'qa.chord_fifo' && record.state === 'closed') ??
          null,
        'the chord FIFO source never closed',
        10_000,
        50
      ).catch(() => null)
      const watcherStoppedMs = closed ? Math.max(0, Date.parse(closed.ts) - clickedAt) : Number.POSITIVE_INFINITY
      await closeSettings(p, platform)
      await resetRecorder(p)
      await holdChord(ctx.fifo, 1_200)
      await sleep(1_000)
      const offStates = foldPillStates((await readRecorder(p)).events)
      const reopenMark = auditMark(layout)
      const again = await openSpeechSwitch(p, platform)
      await again.waitFor({ state: 'visible', timeout: 8_000 })
      await again.click({ timeout: 10_000 })
      const restored = await waitFor(
        () =>
          auditFrom(layout, reopenMark).some((record) => record.event === 'qa.chord_fifo' && record.state === 'open'),
        'the chord FIFO source did not reopen after the switch went back on',
        10_000,
        100
      ).then(
        () => true,
        () => false
      )
      await closeSettings(p, platform)
      return shapeObservation({
        problems: judgeToggleOff({
          watcherStoppedMs,
          fifoClosed: Boolean(closed),
          pillAppeared: offStates.length > 0,
          restored
        }),
        evidence: {
          watcherStoppedMs: Number.isFinite(watcherStoppedMs) ? watcherStoppedMs : null,
          budgetMs: 1000,
          pillStatesWhileOff: offStates,
          reopenedAfterTurningOn: restored,
          note: 'the stop is read from the qa.chord_fifo closed audit; the watcher kills its source in the same refresh that the setting change triggers'
        }
      })
    },
    launched
  )

  // -- va-reduced-motion -------------------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-reduced-motion',
    async () => {
      await speak('open-notes')
      const p = await page()
      const keys = await openKeySender(p)
      try {
        await keys.cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
        })
        await resetRecorder(p)
        await ctx.fifo.down()
        try {
          await waitForEvent(p, (event) => event.k === 'pill' && event.state === 'listening', 15_000)
          await sleep(500)
          const measured = await p.evaluate(() => {
            const pill = document.querySelector('[data-voice-state]')
            const animations = []
            if (pill) {
              for (const element of [pill, ...pill.querySelectorAll('*')])
                for (const pseudo of [null, '::before', '::after']) {
                  const style = getComputedStyle(element, pseudo)
                  const names = style.animationName.split(',').map((name) => name.trim())
                  const durations = style.animationDuration.split(',').map((duration) => duration.trim())
                  names.forEach((name, index) => {
                    if (name && name !== 'none') animations.push({ name, duration: durations[index] ?? durations[0] })
                  })
                }
            }
            return {
              pillPresent: Boolean(pill),
              mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
              animations
            }
          })
          return shapeObservation({
            problems: judgeReducedMotion(measured),
            evidence: {
              mediaMatches: measured.mediaMatches,
              animatedElements: measured.animations.length,
              runningAfterZeroing: measured.animations
                .filter((animation) => animation.duration !== '0ms' && animation.duration !== '0s')
                .map((animation) => animation.name)
            }
          })
        } finally {
          await ctx.fifo.up()
        }
      } finally {
        await keys.cdp.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {})
        await keys.close()
        await waitForPillGone(p, 12_000).catch(() => {})
      }
    },
    launched
  )

  // -- va-idle-cost (soak) ---------------------------------------------------------------------------------------------------
  await runStep(
    report,
    'va-idle-cost',
    async () => {
      if (!(cfg.idleCostMinutes > 0))
        return {
          status: 'NOT_SUPPORTED',
          reason:
            'not requested: it relaunches without the FIFO so the REAL helper runs for the whole window; pass --va-idle-cost-minutes 10',
          evidence: { requestedMinutes: 0 }
        }
      await cleanQuit(ctx.session)
      await start({ fifo: false })
      const samples = []
      const t0 = Date.now()
      const until = t0 + cfg.idleCostMinutes * 60_000
      while (Date.now() < until) {
        const sample = sampleTree({ mainPid: ctx.session.pid, installRoot: ctx.session.installRoot })
        samples.push({ tMs: Date.now() - t0, ...sample })
        log(
          `idle-cost sample ${samples.length}: helper ${sample.processes.some((entry) => entry.kind === 'chord-helper') ? 'seen' : 'absent'}`
        )
        await sleep(Math.min(30_000, Math.max(0, until - Date.now())))
      }
      const helperSamples = samples.filter((sample) =>
        sample.processes.some((entry) => entry.kind === 'chord-helper')
      ).length
      const { problems, percent } = judgeIdleCost({ samples, helperSamples })
      return shapeObservation({
        problems,
        evidence: {
          minutes: cfg.idleCostMinutes,
          samples: samples.length,
          samplesWithHelper: helperSamples,
          helperOneCorePercent: percent === null ? null : Math.round(percent * 1000) / 1000,
          budgetPercent: 0.1,
          watcherSource: 'real helper (no FIFO)'
        }
      })
    },
    launched
  )

  // -- quit, then the at-rest scan -----------------------------------------------------------------------------------------------
  await runStep(report, 'final-quit', () => cleanQuit(ctx.session), launched)

  await runStep(report, 'va-no-utterance-at-rest', async () => {
    // The harness' own files (the WAVs, the FIFO and the capture feed) are fixtures, not the app's data at rest.
    const excluded = (path) => path.startsWith(prepared.vl.dir) || path.startsWith(join(layout.userData, 'qa-capture'))
    const scan = scanTreesForMarkers([layout.userData, layout.home, layout.tmp], PRIVACY_MARKERS, { exclude: excluded })
    const queue = auditOperatorQueue(readOperatorQueue(layout))
    return shapeObservation({
      problems: judgeNoUtteranceAtRest({ scan, queue }),
      evidence: {
        filesScanned: scan.files,
        bytesScanned: scan.bytes,
        skippedLarge: scan.skippedLarge,
        unreadable: scan.unreadable,
        hitsPerMarker: Object.values(scan.hits),
        markersChecked: PRIVACY_MARKERS.length,
        operatorQueue: {
          present: queue.present,
          entries: queue.entries,
          voiceActionEntries: queue.voiceActionEntries,
          disallowedKeys: queue.disallowedKeys
        },
        operatorEmission:
          queue.voiceActionEntries === 0
            ? 'no voice_action event was queued (the app emits none yet); the projection contract is unit-tested'
            : 'present',
        scope:
          'profile, sandbox home and TMPDIR, after the app quit; the harness’ own WAV and FIFO fixtures and the in-memory mock LLM are excluded'
      }
    })
  })
}
