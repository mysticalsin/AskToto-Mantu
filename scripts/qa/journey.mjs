#!/usr/bin/env node
/**
 * The end-to-end journey on the installed candidate (M2-0524), run by the candidate-scenarios lane
 * (scripts/qa/candidate-scenarios.mjs SCENARIOS.journey, which also holds every budget this script uses).
 *
 * On a fresh, isolated ASKTOTO_USERDATA profile it drives the app the way a person does, in order:
 *   onboarding  the first-run tour through Get started, choosing the top-center Bar, until the speech engine
 *               reports ready (a download is recorded as such when one is observed; otherwise it is bundled)
 *   meeting     Listen on the Bar with the QA-identity file source (M2-0494) as the microphone, for the
 *               registry's fixed duration, then Stop
 *   transcript  the meeting is saved with at least the registry's minimum line count
 *   write-up    the saved meeting's write-up is complete within the registry's budget
 * Every step runs on every platform; none is skipped or excused. A step that fails stops the journey; the steps
 * after it are NOT_RUN. The installed app must be the QA identity on every platform (the file source exists only
 * in QA-identity bytes), and the host must make the capture WAV, before the app is driven.
 *
 * Exit 0 PASS · 1 FAIL · 2 PRECONDITION (not run: wrong host, bytes or identity), as fault-fatal-relaunch.
 *
 * Content-free by construction: the app's transcript, write-up and meeting titles are read only inside the
 * app's own page and come back as counts and status names. The report holds step ids, outcomes, milliseconds,
 * numbers, booleans and driver-authored reason codes; it is scanned before it is written, and a report that
 * fails the scan is replaced by its step outcomes alone.
 *
 * Usage: node scripts/qa/journey.mjs --app <installed app> --installer <installer> --sha256 <hex> --out <report.json>
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SCENARIOS, contentProblems } from './candidate-scenarios.mjs'
import { isOverlayUrl } from './golden-flows/smoke-support.mjs'
import { attach, findPage, freeLoopbackPort, killOwned, sleep, waitForChildExit, withTimeout } from './lib/app-driver.mjs'
import { LOCAL_LLM_SETTINGS } from './lib/local-llm-settings.mjs'
import { englishSentences, writeCaptureWav } from './meeting/capture-wav.mjs'
import {
  LINE_COUNT,
  LISTEN_CLICK,
  LISTEN_PRESENT,
  STOP_CLICK,
  STOP_PRESENT,
  TRANSCRIPT_CLICK,
  TRANSCRIPT_PRESENT,
  auditHasEvent
} from './meeting/file-capture.mjs'
import { listProcesses, ownedProcesses } from './owned-processes.mjs'
import { sha256File } from './provenance.mjs'

export const REPORT_SCHEMA = 1
export const SCENARIO = 'journey'
export const JOURNEY = SCENARIOS[SCENARIO]
export const BUDGETS = JOURNEY.budgets
/** The journey's steps, in the order they run. */
export const JOURNEY_STEPS = Object.freeze(['onboarding', 'meeting', 'transcript', 'write-up'])
/** The exit code of each verdict: the inverse of the registry's exits, which match fault-fatal-relaunch. */
export const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, PRECONDITION: 2 })
export const QA_BUNDLE_ID = 'com.mantu.asktoto.qa'
/** The QA identity's Windows executable: build/qa-identity.electron-builder.yml's productName, Metis QA. */
export const QA_WIN_EXECUTABLE = 'Metis QA.exe'

const READY_TIMEOUT_MS = 60_000
const EVALUATE_TIMEOUT_MS = 5_000
const QUIT_TIMEOUT_MS = 15_000
const ASR_ENGINES = Object.freeze(['whisper', 'parakeet', 'apple'])
const RECAP_STATUSES = Object.freeze(['complete', 'incomplete'])

/** Thrown before the app is driven when the host, the bytes or the identity are not what the journey needs. */
export class JourneyPrecondition extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

/** Thrown by a step that ran and did not meet its acceptance. `facts` are content-free numbers and names. */
export class StepFailure extends Error {
  constructor(code, facts = {}) {
    super(code)
    this.code = code
    this.facts = facts
  }
}

/** The registry key of the platform this process runs on, or null. */
export function platformKey(platform = process.platform) {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : null
}

/**
 * The steps to run on `platform`, in JOURNEY_STEPS order. Every step runs on every registry platform.
 * @param {string} platform  a registry platform key
 * @param {Record<string, () => Promise<object | void>>} runners  one per step id
 */
export function journeyPlan(platform, runners) {
  if (!JOURNEY.platforms[platform]) throw new JourneyPrecondition('platform-not-in-registry')
  return JOURNEY_STEPS.map((id) => ({ id, run: runners[id] }))
}

/**
 * Whether the installed app is the QA identity, the only bytes holding the file source: on macOS its bundle
 * id, on Windows its executable name. Promotable bytes are never driven.
 * @param {string} platform  a registry platform key
 * @param {{ executable: string, bundleId?: string | null }} installed
 */
export function isQaIdentity(platform, { executable, bundleId = null }) {
  if (platform === 'mac') return bundleId === QA_BUNDLE_ID
  if (platform === 'win') return win32.basename(String(executable ?? '')) === QA_WIN_EXECUTABLE
  return false
}

const safeErrorName = (error) => (/^[A-Za-z]{1,40}$/.test(String(error?.name ?? '')) ? error.name : 'Error')

/**
 * Runs the plan in order and returns one result per step: PASS, FAIL, PRECONDITION or, after the first step
 * that did not pass, NOT_RUN. `ms` is the step's own wall time.
 */
export async function runSteps(plan, { now = Date.now } = {}) {
  const results = []
  let halted = false
  for (const step of plan) {
    if (halted) {
      results.push({ id: step.id, outcome: 'NOT_RUN', ms: 0 })
      continue
    }
    const started = now()
    try {
      const facts = await step.run()
      results.push({ id: step.id, outcome: 'PASS', ms: now() - started, ...(facts ? { facts } : {}) })
    } catch (error) {
      halted = true
      const ms = now() - started
      if (error instanceof JourneyPrecondition) results.push({ id: step.id, outcome: 'PRECONDITION', ms, reason: error.code })
      else if (error instanceof StepFailure) results.push({ id: step.id, outcome: 'FAIL', ms, reason: error.code, facts: error.facts })
      else results.push({ id: step.id, outcome: 'FAIL', ms, reason: 'driver-error', facts: { error: safeErrorName(error) } })
    }
  }
  return results
}

/** The ids the results do not list in JOURNEY_STEPS order; empty when every step is reported once, in order. */
export function stepOrderProblems(results) {
  const ids = results.map((result) => result.id)
  return JOURNEY_STEPS.every((id, index) => ids[index] === id) && ids.length === JOURNEY_STEPS.length
    ? []
    : [`steps ${JSON.stringify(ids)} are not ${JSON.stringify(JOURNEY_STEPS)}`]
}

/**
 * The verdict of a run. PRECONDITION when the journey could not start or a step met one; PASS only when every
 * step is reported in order and each one passed, on every platform; otherwise FAIL.
 * @param {{ id: string, outcome: string }[]} results
 * @param {{ precondition?: string | null }} [options]
 */
export function judgeJourney(results, { precondition = null } = {}) {
  if (precondition || results.some((result) => result.outcome === 'PRECONDITION')) return 'PRECONDITION'
  if (stepOrderProblems(results).length) return 'FAIL'
  return results.every((result) => result.outcome === 'PASS') ? 'PASS' : 'FAIL'
}

/**
 * The report: verdict, exit code, budgets and one entry per step. Built only from step results and codes.
 * @param {{ platform: string | null, results: { id: string, outcome: string, ms: number, reason?: string, facts?: object }[], precondition?: string | null }} input
 */
export function buildReport({ platform, results, precondition = null }) {
  const verdict = judgeJourney(results, { precondition })
  return {
    schema: REPORT_SCHEMA,
    scenario: SCENARIO,
    ticket: JOURNEY.ticket,
    platform,
    verdict,
    exitCode: EXIT_CODES[verdict],
    ...(precondition ? { precondition } : {}),
    budgets: { ...BUDGETS },
    steps: results.map(({ id, outcome, ms, reason, facts }) => ({
      id,
      outcome,
      ms: Math.max(0, Math.round(Number(ms) || 0)),
      ...(reason ? { reason } : {}),
      ...(facts ? { facts } : {})
    }))
  }
}

/**
 * The content rules `text` breaks: the lane's own (user home paths, email addresses, the runner account) plus
 * any `forbidden` literal, such as the profile path or a fixture sentence. Never the matched text itself.
 * @param {string} text
 * @param {{ account: string, forbidden?: string[] }} scan
 */
export function reportContentProblems(text, { account, forbidden = [] }) {
  const problems = contentProblems(text, { account })
  if (forbidden.some((literal) => typeof literal === 'string' && literal.length > 0 && text.includes(literal))) {
    problems.push('forbidden literal')
  }
  return problems
}

/** The report as written: unchanged when it is content-free, else a FAIL that keeps only each step's id,
 *  outcome and milliseconds plus the names of the rules it broke.
 * @param {ReturnType<typeof buildReport>} report
 * @param {{ account: string, forbidden?: string[] }} scan
 */
export function contentFreeReport(report, scan) {
  const problems = reportContentProblems(JSON.stringify(report), scan)
  if (!problems.length) return report
  return {
    schema: REPORT_SCHEMA,
    scenario: SCENARIO,
    ticket: JOURNEY.ticket,
    platform: report.platform,
    verdict: 'FAIL',
    exitCode: EXIT_CODES.FAIL,
    contentProblems: problems,
    steps: report.steps.map(({ id, outcome, ms }) => ({ id, outcome, ms }))
  }
}

/**
 * The fresh profile's settings: not onboarded, so the tour runs. The bundled local model may serve the
 * write-up (summary first, no live suggestions), and the speech engine is Whisper fast, the configuration
 * M2-0495 proved with the file source. Plain JSON is a supported settings read path.
 */
export const JOURNEY_PROFILE_SETTINGS = Object.freeze({
  onboardingDone: false,
  asrEngine: 'whisper',
  asrQuality: 'fast',
  asrLanguage: 'English',
  localLlm: Object.freeze({
    ...LOCAL_LLM_SETTINGS.localLlm,
    useFor: Object.freeze({ suggest: false, summary: true, vision: false })
  })
})

/** Writes the fresh profile's settings.json into a new, empty profile directory. */
export function seedJourneyProfile(profile) {
  writeFileSync(join(profile, 'settings.json'), `${JSON.stringify(JOURNEY_PROFILE_SETTINGS, null, 2)}\n`, { mode: 0o600 })
}

/**
 * The launch environment: the isolated profile, the file source when given, no provider keys, no Apple
 * Foundation Models, and the QA host-floor override the bundled model needs on a hosted runner (honoured
 * only on an isolated profile).
 * @param {Record<string, string | undefined>} baseEnv
 * @param {{ profile: string, captureFile?: string | null }} options
 */
export function journeyLaunchEnv(baseEnv, { profile, captureFile = null }) {
  const env = { ...baseEnv, ASKTOTO_USERDATA: profile, METIS_DISABLE_APPLE_FM: '1', METIS_QA_HOST_FLOOR_OVERRIDE: '1' }
  for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]
  delete env.METIS_QA_CAPTURE_FILE
  if (captureFile) env.METIS_QA_CAPTURE_FILE = captureFile
  return env
}

export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!['--app', '--installer', '--sha256', '--out'].includes(flag)) throw new JourneyPrecondition('usage')
    args[flag.slice(2)] = argv[++i] ?? ''
  }
  if (!args.app || !args.installer || !args.sha256 || !args.out) throw new JourneyPrecondition('usage')
  return args
}

const oneOf = (value, allowed) => (allowed.includes(value) ? value : value == null ? null : 'other')
const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0)

// --- Page expressions: each returns numbers, booleans or status names, never app text. -----------------

const SETTINGS_STATE = `window.toto.getSettings().then((s) => ({
  done: s.onboardingDone === true,
  placement: String(s.overlayPlacement),
  layout: String(s.overlayLayout),
  asrEngine: String(s.asrEngine),
  summarizer: s.providerReady ? 'provider' : (s.localSummaryReady || s.localFallbackReady) ? 'local' : null
}))`
const ASR_STATE = `window.toto.asrAssetsStatus().then((s) => ({
  ready: s.ready === true || s.status === 'ready',
  downloading: s.status === 'downloading' && Number(s.progress) > 0 && Number(s.progress) < 1
}))`
const ONBOARDING_DONE = `window.toto.getSettings().then((s) => s.onboardingDone === true)`
/** The first saved meeting, read through the app's own History path: counts and the write-up status only. */
export const SAVED_MEETING = `(async () => {
  const list = await window.toto.recallList()
  if (!list.length) return { meetings: 0, lines: 0, recapStatus: null, recapNonEmpty: false }
  const read = await window.toto.recallRead(list[0].file)
  return {
    meetings: list.length,
    lines: read.ok && Array.isArray(read.lines) ? read.lines.length : 0,
    recapStatus: read.ok && read.recapStatus ? String(read.recapStatus) : null,
    recapNonEmpty: read.ok && typeof read.recap === 'string' && read.recap.trim().length > 0
  }
})()`

// --- Everything below drives the installed app; it runs only when this script is executed directly. -----

function evaluate(page, expression, timeoutMs = EVALUATE_TIMEOUT_MS) {
  return withTimeout(page.evaluate(expression), timeoutMs, 'page evaluate timed out')
}

/** The overlay page for which `expression` evaluates truthy, within `timeoutMs`; null when there is none. */
async function overlayPage(browser, expression, timeoutMs) {
  try {
    return await findPage(browser, async (page) => isOverlayUrl(page.url()) && (await evaluate(page, expression)), 'no overlay page', timeoutMs, 250)
  } catch {
    return null
  }
}

async function visible(locator) {
  return withTimeout(locator.isVisible(), EVALUATE_TIMEOUT_MS, 'visibility timed out').catch(() => false)
}

function createRunners(ctx) {
  const { browser, profile } = ctx
  const asr = { downloadingSeen: false, ready: false }
  const sampleAsr = async (page) => {
    const state = await evaluate(page, ASR_STATE).catch(() => null)
    if (state?.downloading) asr.downloadingSeen = true
    if (state?.ready) asr.ready = true
  }

  async function onboarding() {
    const deadline = Date.now() + BUDGETS.onboardingMs
    let page = await overlayPage(browser, 'typeof window.toto !== "undefined"', Math.min(READY_TIMEOUT_MS, BUDGETS.onboardingMs))
    if (!page) throw new StepFailure('app-not-ready')
    let actions = 0
    let done = false
    while (!done && Date.now() < deadline) {
      await sampleAsr(page)
      const settings = await evaluate(page, SETTINGS_STATE).catch(() => null)
      if (settings?.done) {
        done = true
        break
      }
      // The Bar keeps Listen on screen with no hover to drive; the tour offers it as Top center + Bar.
      const topCenter = page.getByRole('radio', { name: /^Top center\b/i }).filter({ visible: true }).first()
      const bar = page.getByRole('radio', { name: /^Bar\b/i }).filter({ visible: true }).first()
      const consent = page.locator('input[type="checkbox"]:not(:checked)').filter({ visible: true }).first()
      // The visible scene's real CTA; the no-JS shell's hidden Next never wins (as golden-flows onboarding).
      const primary = page.locator('button.onboard-cta:visible:not([disabled])').last()
      let label = ''
      if (settings && settings.placement !== 'top-center' && (await visible(topCenter))) {
        await topCenter.click({ timeout: EVALUATE_TIMEOUT_MS })
      } else if (settings && settings.layout !== 'bar' && (await visible(bar))) {
        await bar.click({ timeout: EVALUATE_TIMEOUT_MS })
      } else if (await visible(consent)) {
        await consent.check({ timeout: EVALUATE_TIMEOUT_MS })
      } else if (await visible(primary)) {
        label = String(await withTimeout(primary.innerText(), EVALUATE_TIMEOUT_MS, 'label timed out').catch(() => '')).trim()
        await primary.click({ timeout: EVALUATE_TIMEOUT_MS })
      } else {
        await sleep(500)
        continue
      }
      actions++
      if (/^Get started\b/i.test(label)) {
        // Finishing the tour replaces the onboarding window: the onboarded overlay is found afresh.
        const next = await overlayPage(browser, ONBOARDING_DONE, Math.max(1_000, deadline - Date.now()))
        if (next) {
          page = next
          done = true
        }
        break
      }
      await sleep(600)
    }
    if (!done) throw new StepFailure('onboarding-not-finished', { actions })
    while (!asr.ready && Date.now() < deadline) {
      await sampleAsr(page)
      if (!asr.ready) await sleep(1_000)
    }
    const settings = await evaluate(page, SETTINGS_STATE).catch(() => null)
    const facts = {
      actions,
      asrEngine: oneOf(settings?.asrEngine ?? null, ASR_ENGINES),
      speechEngine: asr.downloadingSeen ? 'downloaded' : 'bundled',
      speechEngineReady: asr.ready
    }
    if (!asr.ready) throw new StepFailure('speech-engine-not-ready', facts)
    ctx.page = page
    return facts
  }

  async function meeting() {
    const page = await overlayPage(browser, LISTEN_PRESENT, READY_TIMEOUT_MS)
    if (!page) throw new StepFailure('listen-control-missing')
    ctx.page = page
    const settings = await evaluate(page, SETTINGS_STATE).catch(() => null)
    ctx.summarizer = settings?.summarizer ?? null
    if (!(await evaluate(page, LISTEN_CLICK))) throw new StepFailure('listen-control-missing')
    const active = await waitUntil(() => evaluate(page, STOP_PRESENT), 10_000, 250)
    if (!active) throw new StepFailure('listen-not-active')
    const listenStarted = Date.now()
    const panel = await waitUntil(async () => {
      if (await evaluate(page, TRANSCRIPT_PRESENT)) return true
      await evaluate(page, TRANSCRIPT_CLICK)
      return evaluate(page, TRANSCRIPT_PRESENT)
    }, 10_000, 250)
    if (!panel) throw new StepFailure('live-transcript-panel-missing')
    let maxLiveLines = 0
    while (Date.now() - listenStarted < BUDGETS.meetingMs) {
      maxLiveLines = Math.max(maxLiveLines, count(await evaluate(page, LINE_COUNT).catch(() => 0)))
      await sleep(1_000)
    }
    const listenMs = Date.now() - listenStarted
    if (!(await evaluate(page, STOP_CLICK))) throw new StepFailure('stop-control-missing', { listenMs, maxLiveLines })
    ctx.stoppedAt = Date.now()
    const stopped = await waitUntil(async () => !(await evaluate(page, STOP_PRESENT)), BUDGETS.stopMs, 250)
    const facts = { listenMs, maxLiveLines, stopped: Boolean(stopped), fileSource: auditHasEvent(profile), summarizer: ctx.summarizer }
    if (!facts.stopped) throw new StepFailure('meeting-did-not-stop', facts)
    if (!facts.fileSource) throw new StepFailure('file-source-inactive', facts)
    return facts
  }

  async function transcript() {
    let last = null
    const saved = await waitUntil(async () => {
      last = await evaluate(ctx.page, SAVED_MEETING, 15_000)
      return last.meetings > 0 && last.lines >= BUDGETS.minTranscriptLines
    }, BUDGETS.transcriptSaveMs, 1_000)
    const facts = { savedMeetings: count(last?.meetings), savedLines: count(last?.lines), minLines: BUDGETS.minTranscriptLines }
    if (!saved) throw new StepFailure(facts.savedMeetings ? 'transcript-too-short' : 'transcript-not-saved', facts)
    return facts
  }

  async function writeUp() {
    let last = null
    const deadline = (ctx.stoppedAt ?? Date.now()) + BUDGETS.writeUpMs
    const complete = await waitUntil(async () => {
      last = await evaluate(ctx.page, SAVED_MEETING, 15_000)
      return last.recapStatus === 'complete' && last.recapNonEmpty === true
    }, Math.max(1_000, deadline - Date.now()), 2_000)
    const facts = {
      recapStatus: oneOf(last?.recapStatus ?? null, RECAP_STATUSES),
      recapNonEmpty: last?.recapNonEmpty === true,
      sinceStopMs: Date.now() - (ctx.stoppedAt ?? Date.now()),
      summarizer: ctx.summarizer ?? null
    }
    if (!complete) throw new StepFailure(ctx.summarizer ? 'write-up-missing' : 'no-summarizer-ready', facts)
    return facts
  }

  return { onboarding, meeting, transcript, 'write-up': writeUp }
}

/** Polls `probe` until truthy or `timeoutMs` passes; a throwing probe counts as not yet. Returns the value or null. */
async function waitUntil(probe, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
    } catch {
      /* not answering yet */
    }
    if (Date.now() >= deadline) return null
    await sleep(intervalMs)
  }
}

function resolveInstalled(app, platform) {
  if (platform === 'mac') {
    const installRoot = realpathSync.native(app)
    return { installRoot, executable: join(installRoot, 'Contents', 'MacOS', basename(installRoot, '.app')) }
  }
  const executable = realpathSync.native(app)
  return { installRoot: dirname(executable), executable }
}

function bundleId(installRoot) {
  return execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(installRoot, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
}

/** Asks the app to quit through its own Quit IPC, then removes whatever it owns that is still alive. Cleanup
 *  only: the clean-quit proof is a later step of its own. */
async function stopApp({ child, page, installRoot }) {
  if (page) await withTimeout(page.evaluate('void window.toto.quit()'), EVALUATE_TIMEOUT_MS, 'quit timed out').catch(() => {})
  await waitForChildExit(child, QUIT_TIMEOUT_MS)
  try {
    // Main is walked only while its pid is still this run's child, never once the OS may have reused it.
    const live = child.exitCode === null && child.signalCode === null ? child.pid : null
    killOwned(ownedProcesses(listProcesses(process.platform), { mainPid: live, installRoot, platform: process.platform }))
  } catch {
    /* best effort */
  }
}

async function main() {
  const platform = platformKey()
  let results = JOURNEY_STEPS.map((id) => ({ id, outcome: 'NOT_RUN', ms: 0 }))
  let precondition = null
  let args = null
  let profile = null
  const forbidden = [homedir(), tmpdir()]
  try {
    args = parseArgs(process.argv.slice(2))
    if (!platform) throw new JourneyPrecondition('unsupported-host')
    if ((await sha256File(args.installer)) !== args.sha256.trim().toLowerCase()) throw new JourneyPrecondition('installer-sha256-mismatch')
    const { installRoot, executable } = resolveInstalled(args.app, platform)
    if (!isQaIdentity(platform, { executable, bundleId: platform === 'mac' ? bundleId(installRoot) : null })) {
      throw new JourneyPrecondition('not-qa-identity')
    }
    if (ownedProcesses(listProcesses(process.platform), { mainPid: null, installRoot, platform: process.platform }).length) {
      throw new JourneyPrecondition('install-root-busy')
    }

    // A new, empty directory: the journey's profile is fresh by construction.
    profile = mkdtempSync(join(tmpdir(), 'metis-journey-'))
    forbidden.push(profile, realpathSync.native(profile))
    seedJourneyProfile(profile)
    // The file source feeds the meeting on every platform; a host that cannot make the WAV is a precondition.
    forbidden.push(...englishSentences())
    let captureFile
    try {
      captureFile = writeCaptureWav(profile).path
    } catch {
      throw new JourneyPrecondition('capture-wav-unavailable')
    }

    const port = await freeLoopbackPort()
    const child = spawn(executable, [`--remote-debugging-port=${port}`], {
      env: journeyLaunchEnv(process.env, { profile, captureFile }),
      stdio: 'ignore'
    })
    child.once('error', () => {})
    const ctx = { browser: null, page: null, profile, platform, summarizer: null, stoppedAt: null }
    try {
      ctx.browser = await withTimeout(waitUntil(() => attach(`http://127.0.0.1:${port}`, 5_000), READY_TIMEOUT_MS, 1_000), READY_TIMEOUT_MS + 5_000, 'attach timed out').catch(() => null)
      const runners = ctx.browser
        ? createRunners(ctx)
        : Object.fromEntries(JOURNEY_STEPS.map((id) => [id, async () => { throw new StepFailure('app-not-ready') }]))
      results = await runSteps(journeyPlan(platform, runners))
    } finally {
      const quitPage = ctx.page ?? (ctx.browser ? await overlayPage(ctx.browser, 'typeof window.toto !== "undefined"', 5_000) : null)
      await stopApp({ child, page: quitPage, installRoot })
      await ctx.browser?.close().catch(() => {})
    }
  } catch (error) {
    if (error instanceof JourneyPrecondition) precondition = error.code
    else {
      console.error(`[journey] driver error: ${safeErrorName(error)}`)
      results = results.map((result) => (result.outcome === 'NOT_RUN' ? { ...result, outcome: 'FAIL', reason: 'driver-error' } : result))
    }
  } finally {
    if (profile) rmSync(profile, { recursive: true, force: true })
  }

  const report = contentFreeReport(buildReport({ platform, results, precondition }), { account: userInfo().username, forbidden })
  const out = args?.out ?? join('out', 'journey', 'journey.json')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[journey] ${report.verdict} ${report.steps.map((step) => `${step.id}=${step.outcome}`).join(' ')}`)
  return report.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
