/**
 * Drives the packaged QA-identity app through one file-fed capture: install the QA zip into a fresh directory,
 * seed a fresh profile, launch with ASKTOTO_USERDATA and METIS_QA_CAPTURE_FILE, press the Bar's Listen control
 * over CDP, read the live transcript's line count, press Stop and wait for the saved meeting.
 *
 * Content-free by construction: the app's transcript is read only as a number (live line count, file count,
 * byte size) and, in this process, as a count of how many fixture tokens the saved file contains. Nothing the
 * app said is returned, logged or written. The shared launch, Listen and Stop helpers are reused by the
 * meeting-history driver.
 */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeRepresentativeProfile } from '../census/profile.mjs'
import { englishSentences, writeCaptureWav } from './capture-wav.mjs'

export const AUDIT_EVENT = 'qa.capture.file_source'
export const READY_TIMEOUT_MS = 40_000
export const LINES_TIMEOUT_MS = 120_000
export const LISTEN_MS = 90_000
export const SAVE_TIMEOUT_MS = 30_000
export const LIVE_LINES_NEEDED = 2
export const CDP_STEP_TIMEOUT_MS = 5_000

const STOPWORDS = new Set(['please', 'about', 'their', 'there', 'which', 'would', 'could', 'okay', "let's", 'switch', 'three', 'point'])

/** Distinctive lowercase tokens of the sentences: five letters or more, letters only, not a stopword. */
export function distinctiveTokens(sentences) {
  const tokens = sentences.flatMap((text) => text.toLowerCase().match(/[a-z]{5,}/g) ?? [])
  return [...new Set(tokens)].filter((token) => !STOPWORDS.has(token))
}

/** How many of `tokens` occur as whole words in `text`. Only this number leaves the caller. */
export function countTokenMatches(text, tokens) {
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? [])
  return tokens.filter((token) => words.has(token)).length
}

/**
 * Seeds a fresh profile with the census profile (onboarding done, local ASR), then turns off everything that
 * would reach for a permission or a model this run does not use: local LLM, screen context, speaker id.
 */
export function seedProfile(profileDir) {
  const { settings } = writeRepresentativeProfile(profileDir)
  const meetingsFolder = join(profileDir, 'capture-meetings')
  mkdirSync(join(meetingsFolder, '.brain'), { recursive: true })
  const baseline = [
    '2026-09-30_090000-capture-baseline-1.md',
    '2026-09-30_091500-capture-baseline-2.md'
  ]
  for (const file of baseline) {
    writeFileSync(join(meetingsFolder, file), '---\ntype: meeting-transcript\n---\n\n# Synthetic capture baseline\n', { mode: 0o600 })
  }
  writeFileSync(join(meetingsFolder, 'index.md'), baseline.map((file) => `- [[${file}]]`).join('\n') + '\n', { mode: 0o600 })
  const seeded = {
    ...settings,
    meetingsFolder,
    onboardingDone: true,
    asrEngine: 'whisper',
    asrQuality: 'fast',
    asrLanguage: 'English',
    overlayPlacement: 'top-center',
    overlayLayout: 'bar',
    localLlm: { ...settings.localLlm, enabled: false },
    backgroundScreenContext: false,
    instantSuggestions: false,
    speakerId: { enabled: false, saveVoiceprints: false },
    audioSource: 'mic',
    showLiveTranscript: true,
    autoSaveTranscripts: true,
    encryptTranscripts: false
  }
  writeFileSync(join(profileDir, 'settings.json'), `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 })
  return { settings: seeded, meetingsFolder }
}

/** The environment and arguments of the launch; the profile is the only place the hook reads the WAV from. */
export function launchSpec({ executable, profileDir, wavPath, port, baseEnv = process.env }) {
  return {
    command: executable,
    args: [`--remote-debugging-port=${port}`],
    env: { ...baseEnv, ASKTOTO_USERDATA: profileDir, METIS_QA_CAPTURE_FILE: wavPath }
  }
}

/**
 * Spawn options for the packaged app. stderrFd is opened synchronously so Node receives a real fd.
 * @param {ReturnType<typeof launchSpec>} spec
 * @param {number | null | undefined} stderrFd
 */
export function appSpawnOptions(spec, stderrFd = null) {
  return {
    env: { ...spec.env, ELECTRON_ENABLE_LOGGING: '1', ASKTOTO_DEBUG_RENDERER: '1' },
    stdio: ['ignore', 'ignore', stderrFd ?? 'ignore']
  }
}

const BOOKKEEPING_MARKDOWN = new Set(['index.md', 'README.md'])

/** Every saved meeting file under the meetings folder: Markdown, not bookkeeping and not the hidden brain. */
export function meetingFiles(folder) {
  if (!existsSync(folder)) return []
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.md') && !BOOKKEEPING_MARKDOWN.has(entry.name)) found.push(path)
    }
  }
  walk(folder)
  return found.sort()
}

/** True when the profile's audit log holds the event; the log is read here and never returned. */
export function auditHasEvent(profileDir, event = AUDIT_EVENT) {
  const dir = join(profileDir, 'logs')
  if (!existsSync(dir)) return false
  return readdirSync(dir)
    .filter((name) => /^audit(-\d+)?\.log$/.test(name))
    .some((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .some((line) => {
          try {
            return JSON.parse(line).event === event
          } catch {
            return false
          }
        })
    )
}

/** Harvests content-free end-state observations after Stop or after a post-ready driver failure. */
export function harvestCaptureArtifacts(observed, { profileDir, meetingsFolder, before, saved = null, sentences = englishSentences() }) {
  const after = meetingFiles(meetingsFolder)
  observed.meetingFilesAfter = after.length
  const newFiles = saved ?? after.filter((file) => !before.includes(file))
  if (newFiles.length > 0) {
    observed.savedBytes = statSync(newFiles[0]).size
    const tokens = distinctiveTokens(sentences)
    observed.tokenTotal = tokens.length
    observed.tokenMatches = countTokenMatches(readFileSync(newFiles[0], 'utf8'), tokens)
  }
  observed.auditEvent = auditHasEvent(profileDir)
  return observed
}

/** Extracts the QA zip into `dir` and returns the app's executable. */
export function installQaZip(zipPath, dir) {
  execFileSync('ditto', ['-x', '-k', zipPath, dir])
  const app = readdirSync(dir).find((name) => name.endsWith('.app'))
  if (!app) throw new Error(`no .app in ${basename(zipPath)}`)
  return join(dir, app, 'Contents', 'MacOS', basename(app, '.app'))
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** A minimal CDP client over Node's global WebSocket. */
function timeoutError(label) {
  const error = new Error(`${label} timed out`)
  error.name = 'TimeoutError'
  return error
}

export async function withTimeout(task, timeoutMs = CDP_STEP_TIMEOUT_MS, label = 'operation') {
  let timer
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function reduceCdpTarget(target) {
  const rawUrl = typeof target?.url === 'string' ? target.url : ''
  let reducedUrl = 'unknown'
  try {
    const url = new URL(rawUrl)
    const file = basename(url.pathname) || url.hostname || 'unknown'
    reducedUrl = `${url.protocol.replace(/:$/, '')}:${file}${url.hash || ''}`
  } catch {
    reducedUrl = rawUrl ? `unknown:${basename(rawUrl)}` : 'unknown'
  }
  return { type: String(target?.type ?? 'unknown'), url: reducedUrl }
}

export function describeOverlayPoll(targets, targetResults = []) {
  const parts = targets.map((target, index) => {
    const reduced = reduceCdpTarget(target)
    const result = targetResults[index] ?? { status: 'not-checked' }
    const listen = result.status === 'present'
      ? 'listen=true'
      : result.status === 'absent'
        ? 'listen=false'
        : result.status === 'timeout'
          ? 'listen=timed-out'
          : result.status === 'threw'
            ? `listen=threw:${result.errorName ?? 'Error'}`
            : `listen=${result.status}`
    const buttons = Array.isArray(result.buttons) ? result.buttons.join('|') : ''
    return `${reduced.type} ${reduced.url} ${listen} buttons=${buttons}`
  })
  return `no overlay page; targets=${targets.length}${parts.length ? `; ${parts.join('; ')}` : ''}`
}

async function cdpPage(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const connect = async (wsUrl) => {
    const socket = new WebSocket(wsUrl)
    try {
      await withTimeout(new Promise((resolve, reject) => {
        socket.addEventListener('open', () => resolve())
        socket.addEventListener('error', () => reject(new Error('CDP socket failed')))
      }), CDP_STEP_TIMEOUT_MS, 'CDP connect')
    } catch (error) {
      socket.close()
      throw error
    }
    const pending = new Map()
    const diagnostics = {
      whisperEngineMessages: 0,
      asrLoadFailedMessages: 0,
      microphoneCaptureFailedMessages: 0,
      backpressureMessages: 0
    }
    const countDiagnosticText = (text) => {
      if (text.includes('[whisper] engine:')) diagnostics.whisperEngineMessages += 1
      if (text.includes('ASR load failed')) diagnostics.asrLoadFailedMessages += 1
      if (text.includes('[listen] microphone capture failed')) diagnostics.microphoneCaptureFailedMessages += 1
      if (/backpressure/i.test(text)) diagnostics.backpressureMessages += 1
    }
    let nextId = 1
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.consoleAPICalled') {
        for (const arg of message.params?.args ?? []) {
          if (typeof arg.value === 'string') countDiagnosticText(arg.value)
        }
      } else if (message.method === 'Log.entryAdded') {
        const text = message.params?.entry?.text
        if (typeof text === 'string') countDiagnosticText(text)
      }
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    })
    const send = (method, params = {}) => {
      const id = nextId++
      const answer = new Promise((resolve) => pending.set(id, resolve))
      socket.send(JSON.stringify({ id, method, params }))
      return answer.then((message) => {
        if (message.error) throw new Error(message.error.message ?? `${method} failed`)
        return message.result
      })
    }
    return {
      send,
      diagnostics,
      async enableDiagnostics() {
        await Promise.allSettled([send('Runtime.enable'), send('Log.enable')])
      },
      evaluate(expression) {
        const id = nextId++
        const answer = new Promise((resolve) => pending.set(id, resolve))
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
        return withTimeout(answer.then((message) => {
          if (message.error || message.result?.exceptionDetails) throw new Error('evaluate failed')
          return message.result?.result?.value
        }), CDP_STEP_TIMEOUT_MS, 'CDP evaluate')
      },
      close: () => socket.close()
    }
  }
  return { targets, connect }
}

export const BUTTON_LABELS = `(() => [...document.querySelectorAll('button')]
  .map((button) => button.getAttribute('aria-label') || (button.textContent || '').trim())
  .filter(Boolean)
  .slice(0, 20))()`

const clickByLabels = (labels) =>
  `(() => {
    const labels = ${JSON.stringify(labels)}
    const buttons = [...document.querySelectorAll('button')]
    const b = buttons.find((button) => labels.includes(button.getAttribute('aria-label') || ''))
    if (!b) return false
    b.click()
    return true
  })()`
const clickTranscriptControl = () =>
  `(() => {
    const visible = !!document.querySelector('[data-qa-live-transcript]')
      || [...document.querySelectorAll('section')]
        .some((section) => section.firstElementChild?.textContent.trim() === 'Transcript')
    if (visible) return true
    const direct = document.querySelector('[data-bar-transcript]')
    if (direct) { direct.click(); return true }
    const buttons = [...document.querySelectorAll('button')]
    const b = buttons.find((button) => {
      const label = button.getAttribute('aria-label') || ''
      const text = (button.textContent || '').trim()
      return label === 'Show transcript' || text === 'View Transcript' || text === 'Transcript'
    })
    if (!b) return false
    b.click()
    return true
  })()`
export const LISTEN_CLICK = clickByLabels(['Start listening'])
export const EXPAND_CLICK = clickByLabels(['Expand Métis'])
export const STOP_CLICK = clickByLabels(['Stop and end meeting', 'Stop meeting', 'End meeting'])
export const TRANSCRIPT_CLICK = clickTranscriptControl()
/** The Bar's Listen control exists: the overlay has rendered and onboarding is done. */
export const LISTEN_PRESENT = `!!document.querySelector('button[aria-label="Start listening"]')`
/** A Stop control exists only after the app has accepted the Listen click as an active capture. */
export const STOP_PRESENT = `!!document.querySelector('button[aria-label="Stop and end meeting"], button[aria-label="Stop meeting"], button[aria-label="End meeting"]')`
/** The transcript panel is visible and can be counted without toggling the Bar control again. */
export const TRANSCRIPT_PRESENT = `!!document.querySelector('[data-qa-live-transcript]')
  || [...document.querySelectorAll('section')].some((s) => s.firstElementChild?.textContent.trim() === 'Transcript')`
/** The live transcript's line count; the waiting and empty placeholders are not lines. */
export const LINE_COUNT = `(() => {
  const section = document.querySelector('[data-qa-live-transcript]')
    || [...document.querySelectorAll('section')].find((s) => s.firstElementChild?.textContent.trim() === 'Transcript')
  const rows = section?.querySelector('.scroll-thin')
  if (!rows) return 0
  return [...rows.children].filter((row) => !/^(Waiting for speech…|No audio yet\\.)$/.test(row.textContent.trim())).length
})()`
export const ASR_ENGINE = `window.toto.getSettings().then((s) => String(s.asrEngine))`
export const MAIN_LOG_PATH = `(() => {
  const load = process.mainModule?.require
  if (typeof load !== 'function') return { error: 'process.mainModule.require unavailable' }
  try {
    return { path: load('node:path').join(load('electron').app.getPath('logs'), 'main.log') }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
})()`
export const CAPTURE_DIAGNOSTIC_PROBE = `(async () => {
  const result = {
    fakeDevice: false,
    getUserMediaFailed: false,
    nonSilentFrames: 0,
    peakRms: 0,
    loadingModel: false
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    result.fakeDevice = devices.some((device) => /^Fake/i.test(device.label || ''))
  } catch {
    result.getUserMediaFailed = true
  }
  try {
    result.loadingModel = document.body.innerText.includes('Loading transcription model')
      || document.body.innerText.includes('Loading model')
  } catch {}
  let stream = null
  let ctx = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const value of samples) sum += value * value
      const rms = Math.sqrt(sum / samples.length)
      result.peakRms = Math.max(result.peakRms, rms)
      if (rms > 0.001) result.nonSilentFrames += 1
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } catch {
    result.getUserMediaFailed = true
  } finally {
    if (stream) for (const track of stream.getTracks()) track.stop()
    if (ctx) await ctx.close().catch(() => {})
  }
  return result
})()`

/** Polls `probe` until it returns a truthy value or `timeoutMs` passes; returns the value or null. */
export async function waitFor(probe, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value = null
    try {
      value = await probe()
    } catch {
      /* not answering yet */
    }
    if (value) return value
    if (Date.now() >= deadline) return null
    await sleep(intervalMs)
  }
}

export async function revealCollapsedOverlay(page) {
  const expanded = await page.evaluate(EXPAND_CLICK).catch(() => false)
  if (!expanded) return false
  return (await waitFor(() => page.evaluate(LISTEN_PRESENT).catch(() => false), CDP_STEP_TIMEOUT_MS, 250)) === true
}

async function overlayPage(port, timeoutMs) {
  let lastTargets = []
  let lastResults = []
  const page = await waitFor(async () => {
    const { targets, connect } = await withTimeout(cdpPage(port), CDP_STEP_TIMEOUT_MS, 'CDP target list')
    lastTargets = targets
    lastResults = []
    for (const target of targets) {
      if (target.type !== 'page' || !target.webSocketDebuggerUrl) {
        lastResults.push({ status: 'not-checked', buttons: [] })
        continue
      }
      let page = null
      try {
        page = await connect(target.webSocketDebuggerUrl)
        const buttons = await page.evaluate(BUTTON_LABELS).catch(() => [])
        const present = await page.evaluate(LISTEN_PRESENT)
        if (!present && buttons.includes('Expand Métis') && await revealCollapsedOverlay(page)) {
          lastResults.push({ status: 'present', buttons })
          return page
        }
        lastResults.push({ status: present ? 'present' : 'absent', buttons })
        if (present) return page
      } catch (error) {
        lastResults.push({ status: error?.name === 'TimeoutError' ? 'timeout' : 'threw', errorName: error?.name ?? 'Error', buttons: [] })
      }
      page?.close()
    }
    return null
  }, timeoutMs)
  return { page, reason: page ? null : describeOverlayPoll(lastTargets, lastResults) }
}

async function locateMainLog(page) {
  try {
    const answer = await page.evaluate(MAIN_LOG_PATH)
    if (answer?.path) return { path: answer.path, fromByte: 0 }
  } catch {
    /* optional diagnostic only */
  }
  return null
}

function copyCaptureLogs({ profileDir, reportDir, mainLog }) {
  if (!reportDir) return
  mkdirSync(reportDir, { recursive: true })
  const logs = join(profileDir, 'logs')
  if (existsSync(logs)) {
    mkdirSync(join(reportDir, 'logs'), { recursive: true })
    for (const name of readdirSync(logs).filter((entry) => /^audit.*\.log$/.test(entry))) {
      cpSync(join(logs, name), join(reportDir, 'logs', name))
    }
  }
  if (mainLog?.path && existsSync(mainLog.path)) {
    writeFileSync(join(reportDir, 'main.log'), readFileSync(mainLog.path).subarray(mainLog.fromByte ?? 0))
  }
}

function diagnosticSource(observed) {
  if ((observed.diagnostics?.fakeDevice || observed.diagnostics?.stderrFakeDeviceInput) && observed.diagnostics?.framesFed === 0) {
    return 'fake-unreadable'
  }
  if (observed.diagnostics?.stderrFakeDeviceInput) return 'fake-file'
  if (observed.auditEvent || observed.diagnostics?.fakeDevice) return 'fake-file'
  if (observed.diagnostics?.getUserMediaFailed) return 'none'
  return 'real'
}

/**
 * One file-fed capture. Returns counts and booleans only (`ready: false` when the app never became usable;
 * `driverError` when a step failed after it was ready; `pageStoppedAnswering` when a live-line probe failed).
 * `timings` are milliseconds since the launch.
 */
export async function runFileCapture({ installer, workDir = mkdtempSync(join(tmpdir(), 'metis-file-capture-')), listenMs = LISTEN_MS, reportDir = null }) {
  const installDir = join(workDir, 'app')
  const profileDir = join(workDir, 'profile')
  mkdirSync(installDir, { recursive: true })
  mkdirSync(profileDir, { recursive: true })
  const executable = installQaZip(installer, installDir)
  const { meetingsFolder } = seedProfile(profileDir)
  const { path: wavPath } = writeCaptureWav(profileDir)
  const before = meetingFiles(meetingsFolder)
  const port = await freePort()
  const spec = launchSpec({ executable, profileDir, wavPath, port })
  const launched = Date.now()
  const since = () => Date.now() - launched
  const stderrPath = reportDir ? join(reportDir, 'app-stderr.log') : null
  if (reportDir) mkdirSync(reportDir, { recursive: true })
  let stderrFd = stderrPath ? openSync(stderrPath, 'w') : null
  let child
  try {
    child = spawn(spec.command, spec.args, appSpawnOptions(spec, stderrFd))
  } catch (error) {
    if (stderrFd !== null) {
      closeSync(stderrFd)
      stderrFd = null
    }
    throw error
  }
  const childExited = new Promise((resolve) => child.once('exit', resolve))
  const observed = {
    ready: false,
    asrEngine: null,
    linesReachedMs: null,
    maxLines: 0,
    meetingFilesBefore: before.length,
    meetingFilesAfter: before.length,
    savedBytes: 0,
    tokenMatches: 0,
    tokenTotal: 0,
    auditEvent: false,
    driverError: false,
    pageStoppedAnswering: false,
    diagnostics: {
      engine: 'loading',
      source: 'none',
      fakeDevice: false,
      getUserMediaFailed: false,
      framesFed: 0,
      peakRms: 0,
      firstLineMs: null,
      stderrFakeDeviceInput: false,
      whisperEngineMessages: 0,
      asrLoadFailedMessages: 0,
      microphoneCaptureFailedMessages: 0,
      backpressureMessages: 0,
      loadingModel: false
    },
    totalMs: 0
  }
  let page = null
  let mainLog = null
  try {
    const overlay = await overlayPage(port, READY_TIMEOUT_MS)
    page = overlay.page
    if (!page) {
      observed.reason = overlay.reason
      return observed
    }
    await page.enableDiagnostics()
    mainLog = await locateMainLog(page)
    observed.ready = true
    observed.asrEngine = (await page.evaluate(ASR_ENGINE).catch(() => null)) ?? null
    if (!(await page.evaluate(LISTEN_CLICK))) throw new Error('Listen control vanished before the click')
    if (!(await waitFor(() => page.evaluate(STOP_PRESENT), 10_000, 250))) throw new Error('Listen did not enter active capture')
    const probe = await page.evaluate(CAPTURE_DIAGNOSTIC_PROBE).catch(() => null)
    if (probe) {
      observed.diagnostics.fakeDevice = probe.fakeDevice === true
      observed.diagnostics.getUserMediaFailed = probe.getUserMediaFailed === true
      observed.diagnostics.framesFed = Number(probe.nonSilentFrames ?? 0)
      observed.diagnostics.peakRms = Number(probe.peakRms ?? 0)
      observed.diagnostics.loadingModel = probe.loadingModel === true
    }
    const transcriptVisible = await waitFor(async () => {
      if (await page.evaluate(TRANSCRIPT_PRESENT).catch(() => false)) return true
      await page.evaluate(TRANSCRIPT_CLICK).catch(() => false)
      return page.evaluate(TRANSCRIPT_PRESENT).catch(() => false)
    }, 10_000, 250)
    if (!transcriptVisible) throw new Error('Transcript panel did not open')
    const listenStarted = Date.now()
    await waitFor(async () => {
      let count
      try {
        count = Number(await page.evaluate(LINE_COUNT))
      } catch (error) {
        observed.pageStoppedAnswering = true
        throw error
      }
      observed.maxLines = Math.max(observed.maxLines, count)
      if (count >= LIVE_LINES_NEEDED && observed.linesReachedMs === null) {
        observed.linesReachedMs = Date.now() - listenStarted
        observed.diagnostics.firstLineMs = observed.linesReachedMs
      }
      return observed.linesReachedMs !== null && Date.now() - listenStarted >= listenMs
    }, LINES_TIMEOUT_MS)
    if (!(await page.evaluate(STOP_CLICK))) throw new Error('Stop control vanished before the click')
    const saved = await waitFor(() => {
      const now = meetingFiles(meetingsFolder).filter((file) => !before.includes(file))
      return now.length > 0 ? now : null
    }, SAVE_TIMEOUT_MS)
    return harvestCaptureArtifacts(observed, { profileDir, meetingsFolder, before, saved })
  } catch (error) {
    // Only a failure before the app was ready is a precondition; once ready, a driver error is a failed run.
    if (!observed.ready) throw error
    observed.driverError = true
    harvestCaptureArtifacts(observed, { profileDir, meetingsFolder, before })
    return observed
  } finally {
    Object.assign(observed.diagnostics, page?.diagnostics ?? {})
    page?.close()
    observed.totalMs = since()
    child.kill('SIGTERM')
    await Promise.race([childExited, sleep(2000)])
    child.kill('SIGKILL')
    await Promise.race([childExited, sleep(1000)])
    if (stderrFd !== null) {
      closeSync(stderrFd)
      stderrFd = null
    }
    observed.diagnostics.engine = observed.diagnostics.asrLoadFailedMessages > 0
      ? 'load-failed'
      : observed.diagnostics.whisperEngineMessages > 0
        ? 'ready'
        : observed.diagnostics.loadingModel
          ? 'loading'
          : 'no-signal'
    if (stderrPath && existsSync(stderrPath)) {
      observed.diagnostics.stderrFakeDeviceInput = /as input to the fake device/.test(readFileSync(stderrPath, 'utf8'))
    }
    observed.diagnostics.source = diagnosticSource(observed)
    copyCaptureLogs({ profileDir, reportDir, mainLog })
    rmSync(workDir, { recursive: true, force: true })
  }
}
