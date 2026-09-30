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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  const { settings, meetingsFolder } = writeRepresentativeProfile(profileDir)
  const seeded = {
    ...settings,
    onboardingDone: true,
    asrEngine: 'whisper',
    localLlm: { ...settings.localLlm, enabled: false },
    backgroundScreenContext: false,
    instantSuggestions: false,
    speakerId: { enabled: false, saveVoiceprints: false },
    showLiveTranscript: true,
    autoSaveTranscripts: true
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

/** Every saved meeting file under the meetings folder: Markdown, not the index and not the hidden brain. */
export function meetingFiles(folder) {
  if (!existsSync(folder)) return []
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.md') && entry.name !== 'index.md') found.push(path)
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
async function cdpPage(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  const connect = async (wsUrl) => {
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')))
    })
    const pending = new Map()
    let nextId = 1
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    })
    return {
      evaluate(expression) {
        const id = nextId++
        const answer = new Promise((resolve) => pending.set(id, resolve))
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
        return answer.then((message) => {
          if (message.error || message.result?.exceptionDetails) throw new Error('evaluate failed')
          return message.result?.result?.value
        })
      },
      close: () => socket.close()
    }
  }
  return { pages, connect }
}

const clickByLabel = (label) =>
  `(() => { const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]'); if (!b) return false; b.click(); return true })()`
export const LISTEN_CLICK = clickByLabel('Start listening')
export const STOP_CLICK = clickByLabel('End meeting & get summary')
/** The Bar's Listen control exists: the overlay has rendered and onboarding is done. */
export const LISTEN_PRESENT = `!!document.querySelector('button[aria-label="Start listening"]')`
/** The live transcript's line count; the waiting and empty placeholders are not lines. */
export const LINE_COUNT = `(() => {
  const section = [...document.querySelectorAll('section')].find((s) => s.firstElementChild?.textContent.trim() === 'Transcript')
  const rows = section?.querySelector('.scroll-thin')
  if (!rows) return 0
  return [...rows.children].filter((row) => !/^(Waiting for speech…|No audio yet\\.)$/.test(row.textContent.trim())).length
})()`
export const ASR_ENGINE = `window.toto.getSettings().then((s) => String(s.asrEngine))`

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

async function overlayPage(port, timeoutMs) {
  return waitFor(async () => {
    const { pages, connect } = await cdpPage(port)
    for (const target of pages) {
      const page = await connect(target.webSocketDebuggerUrl)
      if (await page.evaluate(LISTEN_PRESENT).catch(() => false)) return page
      page.close()
    }
    return null
  }, timeoutMs)
}

/**
 * One file-fed capture. Returns counts and booleans only (`ready: false` when the app never became usable;
 * `driverError` when a step failed after it was ready; `pageStoppedAnswering` when a live-line probe failed).
 * `timings` are milliseconds since the launch.
 */
export async function runFileCapture({ installer, workDir = mkdtempSync(join(tmpdir(), 'metis-file-capture-')), listenMs = LISTEN_MS }) {
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
  const child = spawn(spec.command, spec.args, { env: spec.env, stdio: 'ignore' })
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
    totalMs: 0
  }
  let page = null
  try {
    page = await overlayPage(port, READY_TIMEOUT_MS)
    if (!page) return observed
    observed.ready = true
    observed.asrEngine = (await page.evaluate(ASR_ENGINE).catch(() => null)) ?? null
    if (!(await page.evaluate(LISTEN_CLICK))) throw new Error('Listen control vanished before the click')
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
      if (count >= LIVE_LINES_NEEDED && observed.linesReachedMs === null) observed.linesReachedMs = Date.now() - listenStarted
      return observed.linesReachedMs !== null && Date.now() - listenStarted >= listenMs
    }, LINES_TIMEOUT_MS)
    await page.evaluate(STOP_CLICK)
    const saved = await waitFor(() => {
      const now = meetingFiles(meetingsFolder).filter((file) => !before.includes(file))
      return now.length > 0 ? now : null
    }, SAVE_TIMEOUT_MS)
    observed.meetingFilesAfter = meetingFiles(meetingsFolder).length
    if (saved) {
      observed.savedBytes = statSync(saved[0]).size
      const tokens = distinctiveTokens(englishSentences())
      observed.tokenTotal = tokens.length
      observed.tokenMatches = countTokenMatches(readFileSync(saved[0], 'utf8'), tokens)
    }
    observed.auditEvent = auditHasEvent(profileDir)
    return observed
  } catch (error) {
    // Only a failure before the app was ready is a precondition; once ready, a driver error is a failed run.
    if (!observed.ready) throw error
    observed.driverError = true
    return observed
  } finally {
    page?.close()
    observed.totalMs = since()
    child.kill('SIGTERM')
    await sleep(2000)
    child.kill('SIGKILL')
    rmSync(workDir, { recursive: true, force: true })
  }
}
