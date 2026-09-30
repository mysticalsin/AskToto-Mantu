#!/usr/bin/env node
/**
 * Release-gate proof that the PACKAGED app can decode real audio through its real on-device ASR
 * engines — Whisper/transformers and Parakeet/sherpa, each with its bundled model. Other ASR checks
 * (check-sherpa-platform, check-local-model) inspects FILES — the right binary is present for the
 * right arch, the right model files exist on disk — but none of them actually decode audio through
 * the native addon inside a packaged Electron process. That gap is exactly the shape of the 1.2.0 DOA
 * class of failure: everything present, nothing proven to run together.
 *
 * Method: launch the packaged exe with Playwright's Electron driver (the full `playwright` package,
 * already a devDependency — scripts/smoke-import.mjs uses the same driver for the same "drive an
 * import through the real picker" shape) and drive the real IPC surface the renderer uses
 * (window.toto.importAudioPick / importAudioStart / importJobsList / recallRead), exactly what a user
 * does via File > Import audio. MQA-306: settings alone do not prove the actual engine. Observe the
 * production utility-process requests/results without replacing their data, then require successful
 * PCM results from the requested packaged child and model. A Whisper-to-Parakeet fallback fails.
 * Whisper runs first; import-idle releases its Parakeet language-probe helper before the separate
 * Parakeet job. This also proves both native stacks can decode in one application session (MQA-234).
 *
 * MQA-233 — deviation from a pure playwright-core-over-CDP design, recorded honestly: CDP alone cannot reach
 * Electron's OS-level dialog.showOpenDialog (it runs in the main process, not any Chromium page CDP
 * exposes), so driving the REAL Windows Open-File dialog needs something outside CDP. A raw-Win32
 * approach (GetDlgItem + WM_SETTEXT/BM_CLICK against the dialog's standard control ids, spawning the
 * exe directly and shelling out to PowerShell) was built and DOES work in isolation — verified live,
 * multiple times, against a manually-triggered picker. But end-to-end, on this machine, the real
 * dialog's first appearance after a scripted launch was measured to take anywhere from ~25s to over
 * 240s with no reliable ceiling (evidence: 5 timed runs, deadlines of 20s/45s/90s/240s/60s, dialog
 * absent from a full Win32 EnumWindows scan of the process's own windows every time except the one
 * lucky low-latency run) — unpredictable enough to make a hard-coded gate deadline either flaky or
 * absurdly slow. Playwright's Electron driver sidesteps the OS dialog by running inside the main
 * process (electronApp.evaluate) to substitute the picker's return value directly — the same technique
 * smoke-import.mjs already relies on. This keeps the gate fast and deterministic while still exercising
 * every layer that actually matters for THIS gate's purpose: the real IPC handlers
 * (importAudioPick/importAudioStart), the real bundled ffmpeg decode, and both real ASR native
 * addon + model. What it does NOT cover: whether Explorer's Open-File dialog itself still wires up to
 * pickAudioFile() correctly (control ids, filters) — that native-dialog latency/reliability question is
 * reported to the orchestrator separately as its own finding, not silently dropped.
 *
 * The fixture is synthesized at gate-runtime via Windows SAPI (System.Speech), never bundled as repo
 * bytes: PowerShell speaks a fixed sentence to a WAV file in a temp dir. The app's own bundled ffmpeg
 * sidecar resamples whatever SAPI produces to 16kHz mono during import (see ffmpeg-decoder.ts's
 * FFMPEG_SAMPLE_RATE), so the fixture format does not need to match Parakeet's input format up front.
 *
 * Usage: node scripts/check-packaged-asr.mjs [path-to-exe] [--timeout-seconds 180]
 * Default target: release/win-unpacked/Metis.exe
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertPackagedAsrEvidence, installAsrObserver } from './lib/packaged-asr-evidence.mjs'

const root = resolve(process.cwd())
const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const target = resolve(positional[0] || join(root, 'release/win-unpacked/Metis.exe'))
const timeoutIndex = argv.indexOf('--timeout-seconds')
const timeoutSeconds = timeoutIndex === -1 ? 180 : Number(argv[timeoutIndex + 1])
const PHRASE = 'The quarterly revenue target is seven million dollars'
const ENGINES = ['whisper', 'parakeet']

if (process.platform !== 'win32') {
  console.error(`[check:packaged-asr] FAIL — this gate synthesizes its fixture via Windows SAPI; host is ${process.platform}.`)
  process.exit(2)
}
if (!existsSync(target)) {
  console.error(`[check:packaged-asr] FAIL — no such executable: ${target}`)
  process.exit(1)
}

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. Synthesize the fixture. No repo bytes — SAPI speaks it fresh every run. ─────────────────────
const workDir = mkdtempSync(join(tmpdir(), 'metis-asr-gate-'))
const wavPath = join(workDir, 'asr-fixture.wav')
console.log('[check:packaged-asr] synthesizing fixture via Windows SAPI…')
try {
  execFileSync(
    POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.Speech; ` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}'); ` +
        `$s.Speak('${PHRASE}'); ` +
        `$s.Dispose()`
    ],
    { encoding: 'utf8', timeout: 60000 }
  )
} catch (error) {
  console.error(`[check:packaged-asr] FAIL — could not synthesize the SAPI fixture: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
if (!existsSync(wavPath)) {
  console.error('[check:packaged-asr] FAIL — SAPI reported success but the fixture WAV does not exist.')
  process.exit(1)
}
console.log(`[check:packaged-asr]   fixture: ${wavPath}`)

// ── 2. Launch the packaged app under Playwright's Electron driver, isolated profile. ───────────────
const userData = mkdtempSync(join(tmpdir(), 'metis-asr-userdata-'))
const meetingsFolder = join(userData, 'meetings')
const env = { ...process.env, ASKTOTO_USERDATA: userData, ASKTOTO_LOCAL_KEYSTORE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]

console.log(`[check:packaged-asr] launching ${target}`)
console.log(`[check:packaged-asr]   isolated profile: ${userData}`)

let app
function killApp() {
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', "Get-Process -Name 'Metis*' -ErrorAction SilentlyContinue | Stop-Process -Force"], { timeout: 15000 })
  } catch {
    /* best-effort */
  }
}
function safeRmSync(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    console.error(`[check:packaged-asr]   (cleanup) could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
async function fail(reason) {
  console.error(`[check:packaged-asr] FAIL — ${reason}`)
  try {
    await app?.close()
  } catch {
    /* best-effort */
  }
  killApp()
  await sleep(500)
  safeRmSync(userData)
  safeRmSync(workDir)
  process.exit(1)
}

async function main() {
try {
  app = await electron.launch({ executablePath: target, env })
  await app.evaluate(installAsrObserver)
} catch (error) {
  return fail(`the packaged app failed to launch under Playwright: ${error instanceof Error ? error.message : String(error)}`)
}

let page
try {
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.toto, undefined, { timeout: 60_000 })
} catch (error) {
  await fail(`no renderer window exposing window.toto appeared within 60s: ${error instanceof Error ? error.message : String(error)}`)
}
console.log('[check:packaged-asr] attached to the main window.')
const resourcesPath = await app.evaluate(() => process.resourcesPath)
const mainLogPath = join(await app.evaluate(({ app: electronApp }) => electronApp.getPath('logs')), 'main.log')

// ── 3. Substitute only the native picker's RETURN VALUE inside the real main process. ───────────────
// Runs in Electron's main process (not a Chromium page — this is Playwright's Electron bridge), so this
// is the actual `dialog` module the real ipcMain.handle(IPC.importAudioPick) handler calls into. Nothing
// about pickAudioFile()/consumePickedAudio()'s own logic is bypassed — only the OS's native file-picker
// UI, which this gate cannot drive fast enough to be usable (see the file header). importAudioPick() and
// importAudioStart() below are the real, unmodified IPC round trip.
await app.evaluate(async ({ dialog }, pickedFile) => {
  Object.defineProperty(dialog, 'showOpenDialog', {
    configurable: true,
    value: async () => ({ canceled: false, filePaths: [pickedFile] })
  })
}, wavPath)

// ── 4. Separate real IPC jobs, each scoped to fresh request evidence and the existing deadline. ──────
const jobIds = new Set()
for (const engine of ENGINES) {
  await page.evaluate(
    (args) => window.toto.setSettings({ asrEngine: args.engine, meetingsFolder: args.folder, encryptTranscripts: false }),
    { engine, folder: meetingsFolder }
  )
  const confirmedEngine = await page.evaluate(async () => (await window.toto.getSettings()).asrEngine)
  if (confirmedEngine !== engine) return fail(`asrEngine did not stick — getSettings() reported "${confirmedEngine}", expected "${engine}".`)
  const afterSequence = await app.evaluate(() => globalThis.__metisPackagedAsrGate.sequence)
  const logOffset = existsSync(mainLogPath) ? readFileSync(mainLogPath, 'utf8').length : 0
  const picked = await page.evaluate(() => window.toto.importAudioPick())
  if (picked?.error) return fail(`importAudioPick() returned an error: ${picked.error}`)
  if (!picked?.token) return fail(`importAudioPick() did not return a usable capability token: ${JSON.stringify(picked)}`)
  const started = await page.evaluate((token) => window.toto.importAudioStart(token), picked.token)
  if (!started?.jobId || jobIds.has(started.jobId)) return fail(`${engine}: importAudioStart() did not create a separate job.`)
  jobIds.add(started.jobId)
  console.log(`[check:packaged-asr] ${engine} import started: ${started.jobId}`)

  const jobDeadline = Date.now() + timeoutSeconds * 1000
  let job = started
  while (Date.now() < jobDeadline) {
    await sleep(1000)
    job = await page.evaluate(
      async (jobId) => (await window.toto.importJobsList()).find((j) => j.jobId === jobId),
      started.jobId
    )
    if (job?.state === 'done' || job?.state === 'failed') break
  }
  if (!job) return fail(`${engine}: the import job disappeared from importJobsList().`)
  if (job.state === 'failed') return fail(`${engine}: the import job failed: ${job.error || '(no error message)'}`)
  if (job.state !== 'done') return fail(`${engine}: the import job did not finish within ${timeoutSeconds}s (last state: ${job.state}).`)
  if (!job.file) return fail(`${engine}: the import job reported done but has no saved meeting file.`)

  // A ready message is emitted before lazy model loading, so it cannot satisfy this gate on its own.
  // Match a real PCM request/result from the exact bundled host/model AND the saved transcript.
  const meeting = await page.evaluate((file) => window.toto.recallRead(file), job.file)
  if (!meeting?.ok || !meeting.lines?.length) return fail(`${engine}: the saved meeting has no transcript lines.`)
  const transcript = meeting.lines.map((line) => line.text).join(' ')
  const observed = await app.evaluate(() => globalThis.__metisPackagedAsrGate)
  const verified = assertPackagedAsrEvidence(engine, {
    ...observed, resourcesPath, afterSequence, transcript,
    mainLog: readFileSync(mainLogPath, 'utf8').slice(logOffset)
  })
  console.log(`[check:packaged-asr] ${engine} decoded transcript: "${transcript}"`)
  console.log(`[check:packaged-asr] VERIFIED ${JSON.stringify(verified)}`)
}

console.log('[check:packaged-asr] OK — separate real Whisper and Parakeet imports verified; no engine fallback.')

try {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0))
} catch {
  /* best-effort */
}
await app.close().catch(() => {})
killApp()
await sleep(500)
safeRmSync(userData)
safeRmSync(workDir)
process.exit(0)
}

await main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
