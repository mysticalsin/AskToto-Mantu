#!/usr/bin/env node
/**
 * ST-1: measures whether the packaged app keeps two libuv pool threads free while the meetings root is
 * unreadable, the way the storage gateway (M2-0030/M2-0031) is meant to guarantee. Runs on the QA macOS
 * account or the managed Windows laptop — never on an owner account — against a candidate whose bytes
 * are bound to a CI run by sha256 (M2-0002).
 *
 * It measures INSIDE the packaged main process through Node's inspector (--inspect), not through any
 * product hook: an async userData write, a dns.lookup and the main event loop's own delay. Both fixture
 * kinds stand in for a cloud-only meetings-root file that blocks the thread reading it:
 *   - `fifo`: real FIFOs (POSIX only) placed as meeting and `.brain` files.
 *   - `dataless`: real evicted (dataless) files, read from `--cloud-dir`.
 * `none` places no fixture: the control row, which tells a boot-time block apart from a fixture reader.
 *
 * Attribution evidence, reported and never judged: every sample's time since spawn, the loop's max since
 * the previous sample and the active libuv resources; a CPU profile of the first 90 s; the profile's
 * audit logs, stall bundles and this launch's main.log; which FIFOs had a reader; and, from +20 s,
 * History's own IPC round trip (recallList + brainStatus) measured in the main window. All of it lands in
 * the report directory (`--report-dir`, else the `--out` file's directory, else out/st-1).
 *
 * Usage:
 *   node scripts/qa/st-1.mjs --installer <Metis-QA-<v>.zip | Metis-Setup-<v>.exe> --provenance <provenance.json>
 *       --fixtures fifo|dataless|none [--count 6] [--cloud-dir <folder of evicted files>] [--main-log <main.log>]
 *       [--exe <installed executable>] [--profile-template <userData dir>] [--minutes 5] [--out <report.json>]
 *       [--report-dir <dir>]
 *
 * Every in-app wait is bounded and every failure to answer is recorded in the report's `errors` (step, tMs,
 * message) while the run continues: only the criteria decide PASS or FAIL. The report is rewritten every
 * 30 s while the run lasts and once more however it ends, so the report directory always holds one; a run
 * that stopped early says INCOMPLETE.
 *
 * Exit codes: 0 PASS, 1 FAIL, NOT_EXERCISED or INCOMPLETE, 2 usage.
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { sha256File } from './provenance.mjs'
import { createFifo, releaseFifo } from './fixtures/fifo.mjs'
import {
  buildLaunchFailureReport,
  buildReport,
  emptyRun,
  failureRecord,
  historyEntry,
  pinnedExpression,
  recordSample,
  releaseExpression,
  withTimeout
} from './lib/st-1-core.mjs'

const MIN_FIFO_COUNT = 3
const DEFAULT_FIFO_COUNT = 6
const DEFAULT_MINUTES = 5
const LOOP_RESOLUTION_MS = 10
const INSPECTOR_WAIT_MS = 60_000
const SAMPLE_INTERVAL_MS = 1_000
/** A sample answered later than this is late (the no-late-samples criterion). */
const EVALUATE_TIMEOUT_MS = 1_000
/** In-app bounds: an evaluation that has not settled by then is recorded as timed out. */
const SETUP_TIMEOUT_MS = 10_000
const SAMPLE_TIMEOUT_MS = 5_000
/** The harness's own wait beyond an in-app bound, for a main loop too blocked to fire the in-app timer. */
const EVALUATE_MARGIN_MS = 2_000
const PARTIAL_REPORT_EVERY_MS = 30_000
/** The CPU profile covers boot: it starts at SETUP and stops this long after spawn. */
const PROFILE_UNTIL_MS = 90_000
const PROFILE_SAMPLING_US = 1_000
const PROFILE_STOP_TIMEOUT_MS = 30_000
/** History's IPC round trip is measured from this long after spawn, this often. */
const HISTORY_FROM_MS = 20_000
const HISTORY_EVERY_MS = 5_000
const HISTORY_TIMEOUT_MS = 10_000
const MAIN_LOG_QUERY_TIMEOUT_MS = 10_000

/** `--cloud-dir` etc. become `args.cloudDir`, matching every camelCase read below. */
function parseArgs(argv) {
  const args = { minutes: String(DEFAULT_MINUTES) }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith('--')) continue
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    args[key] = argv[++i]
  }
  return args
}

/** Binds the installer's bytes to the CI run that produced them (M2-0002). Throws on any mismatch. */
async function verifyCandidate(installerPath, provenancePath) {
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
  const name = basename(installerPath)
  const asset = provenance.builds.flatMap((build) => build.assets).find((candidate) => candidate.name === name)
  if (!asset) throw new Error(`no asset named ${name} in ${provenancePath}`)
  const actual = await sha256File(installerPath)
  if (actual !== asset.sha256) throw new Error(`sha256 mismatch for ${name}: provenance says ${asset.sha256}, file is ${actual}`)
  return { build_run_id: provenance.run.id, artifact_sha256: actual }
}

/** The installed executable to launch, and the directory (if any) to remove afterward. */
function resolveExecutable(installerPath, exeArg) {
  if (exeArg) return { exe: exeArg, unzipDir: null }
  if (process.platform === 'darwin' && installerPath.endsWith('.zip')) {
    const unzipDir = mkdtempSync(join(tmpdir(), 'st1-unzip-'))
    execFileSync('ditto', ['-x', '-k', installerPath, unzipDir])
    const apps = execFileSync('find', [unzipDir, '-maxdepth', '1', '-name', '*.app'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
    if (apps.length !== 1) throw usageError(`expected exactly one *.app in ${installerPath}, found ${apps.length}`)
    const app = apps[0]
    return { exe: join(app, 'Contents', 'MacOS', basename(app, '.app')), unzipDir }
  }
  throw usageError('--exe is required on this platform (Windows needs the installed Metis.exe from a verified setup)')
}

function usageError(message) {
  const error = new Error(message)
  error.usage = true
  return error
}

function prepareProfile(profileTemplate) {
  const profile = mkdtempSync(join(tmpdir(), 'metis-st1-'))
  if (profileTemplate) cpSync(profileTemplate, profile, { recursive: true })
  return profile
}

/** `count` FIFOs placed as meeting and `.brain` files under the meetings root. */
function placeFifoFixtures(root, count) {
  mkdirSync(join(root, '.brain', 'entities', 'person'), { recursive: true })
  const targets = [
    ...Array.from({ length: Math.max(0, count - 2) }, (_, i) => join(root, `2026-01-${String(i + 1).padStart(2, '0')}_090000-st1-fifo.md`)),
    join(root, '.brain', 'index.json'),
    join(root, '.brain', 'entities', 'person', 'st1-fifo.json')
  ]
  for (const target of targets) {
    rmSync(target, { force: true })
    createFifo(target)
  }
  return targets
}

/** SF_DATALESS, <sys/stat.h>. */
const SF_DATALESS = 0x4000_0000
/** FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
 *  <winnt.h>. Matches dataless.ts's WIN_PLACEHOLDER_ATTRIBUTES exactly, so ST-1 measures the same
 *  placeholder signal the gateway checks before every read. */
const WIN_PLACEHOLDER_ATTRIBUTES = 0x0000_1000 | 0x0004_0000 | 0x0040_0000
/** Pinned System32 binaries, never a bare name — win-security.ts's WINDOWS_POWERSHELL rule, restated
 *  here because this plain script cannot import a TypeScript module. */
const SYS32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
const WIN_POWERSHELL = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const WIN_TASKKILL = join(SYS32, 'taskkill.exe')

/** dataless.ts's WIN_ATTRIBUTES_SCRIPT wire protocol: NUL-separated UTF-8 paths on stdin (so the console
 *  code page can never mangle them — this profile's own root is 'Métis Meetings'), one JSON array of
 *  attribute words out, `null` where GetAttributes failed. -EncodedCommand so no PowerShell quoting rule
 *  applies either. */
const WIN_ATTRIBUTES_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$bytes = New-Object System.IO.MemoryStream',
  '[Console]::OpenStandardInput().CopyTo($bytes)',
  '$paths = [Text.Encoding]::UTF8.GetString($bytes.ToArray()).Split([char]0)',
  '$words = foreach ($path in $paths) { try { [string][int][IO.File]::GetAttributes($path) } catch { "null" } }',
  "[Console]::Out.Write('[' + ($words -join ',') + ']')"
].join('\n')

/** One `stat` exec for the whole batch, never one per file. */
function datalessFlagsMac(paths) {
  const output = execFileSync('stat', ['-f', '%Uf', ...paths], { encoding: 'utf8' }).trim()
  return output.split('\n').map((line) => {
    const flags = Number.parseInt(line, 10)
    return Number.isFinite(flags) && (flags & SF_DATALESS) !== 0
  })
}

/** One PowerShell spawn for the whole batch, never one per file (and never twice per run). A failed
 *  GetAttributes (`null`) is never dataless: it means "could not tell", which proves nothing about
 *  whether the file's bytes are local — the opposite of a proven placeholder. */
function datalessFlagsWindows(paths) {
  const output = execFileSync(
    WIN_POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_ATTRIBUTES_SCRIPT, 'utf16le').toString('base64')],
    { input: Buffer.from(paths.join('\0'), 'utf8'), encoding: 'utf8' }
  )
  const words = JSON.parse(output)
  return words.map((word) => word !== null && (word & WIN_PLACEHOLDER_ATTRIBUTES) !== 0)
}

/** Whether each of `paths` is dataless, in order — one spawn for the whole batch. */
function datalessFlags(paths) {
  if (paths.length === 0) return []
  return process.platform === 'darwin' ? datalessFlagsMac(paths) : datalessFlagsWindows(paths)
}

/** Every file directly under `dir`, recursively. Node builtins only: `find` does not exist on Windows,
 *  and this fixture kind is the one row ST-1 also runs there (ST-1-W). */
function listFilesRecursive(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFilesRecursive(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/** Every dataless top-level `*.md` and `.brain/*` file in `cloudDir`, made the meetings root via a link. */
function placeDatalessFixtures(root, cloudDir) {
  rmSync(root, { recursive: true, force: true })
  symlinkSync(cloudDir, root, 'junction')
  const topLevelMarkdown = readdirSync(cloudDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(cloudDir, entry.name))
  const brainDir = join(cloudDir, '.brain')
  const brainFiles = existsSync(brainDir) ? listFilesRecursive(brainDir) : []
  const candidates = [...topLevelMarkdown, ...brainFiles]
  const dataless = datalessFlags(candidates)
  const fixtures = candidates.filter((_, i) => dataless[i])
  if (fixtures.length === 0) throw usageError('no dataless files under --cloud-dir: evict files first')
  return fixtures
}

/** Spawns the candidate with an inspector on an OS-assigned port. Never throws (spawn's own failure modes
 *  surface later, as an 'error' event): the caller must take ownership of the returned child — and be
 *  ready to stop it — before calling inspectorUrl, so every way that wait can end still leaves the child
 *  killable by the caller's cleanup. */
function spawnCandidate(exe, profile) {
  return spawn(exe, ['--inspect=127.0.0.1:0'], {
    env: { ...process.env, ASKTOTO_USERDATA: profile },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32'
  })
}

/** The candidate's ws:// inspector URL, read off its stderr. Settles on whichever comes first: the URL,
 *  the child's 'error' event (a mistyped or non-executable --exe emits this with no other listener and
 *  would otherwise crash the harness), its 'exit' event, or the 60 s timeout (the
 *  EnableNodeCliInspectArguments fuse may be off). */
async function inspectorUrl(child) {
  let stderr = ''
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer)
      child.stderr.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    function onData(chunk) {
      stderr += String(chunk)
      const match = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(stderr)
      if (match) {
        cleanup()
        resolve(match[0])
      }
    }
    function onError(error) {
      cleanup()
      reject(new Error(`candidate failed to start: ${error.message}`))
    }
    function onExit(code) {
      cleanup()
      reject(new Error(`candidate exited before the inspector was ready (code ${code})`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('no main-process inspector: the EnableNodeCliInspectArguments fuse may be off'))
    }, INSPECTOR_WAIT_MS)
    child.stderr.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

/** A minimal Chrome DevTools Protocol client: any method, and Runtime.evaluate, each with an answer budget. */
function cdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const resolver = pending.get(message.id)
    if (!resolver) return
    pending.delete(message.id)
    resolver(message)
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('inspector socket failed to connect')))
  })
  // Every send awaits `ready`; this only keeps a failure before the first send from being unhandled.
  ready.catch(() => {})
  /** The method's result, or `{ late: true }` when it did not answer within `timeoutMs`. Throws on a
   *  protocol error. */
  async function send(method, params, timeoutMs) {
    await ready
    const id = nextId++
    const answer = new Promise((resolve) => pending.set(id, resolve))
    socket.send(JSON.stringify({ id, method, params }))
    const outcome = await withTimeout(answer, timeoutMs)
    if (!outcome.ok) {
      pending.delete(id)
      return { late: true }
    }
    const message = outcome.value
    if (message.error) throw new Error(`${method}: ${message.error.message}`)
    return { late: false, result: message.result }
  }
  async function evaluate(expression, timeoutMs = EVALUATE_TIMEOUT_MS) {
    const answer = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (answer.late) return answer
    if (answer.result.exceptionDetails) throw new Error(answer.result.exceptionDetails.text)
    return { late: false, value: answer.result.result?.value }
  }
  return { send, evaluate, close: () => socket.close() }
}

let nextEvaluationKey = 0

/**
 * Evaluates `expression` in the candidate, bounded by `ms` there (pinnedExpression keeps the awaited
 * promise reachable) and by `ms` plus a margin here. Never throws: the outcome (lib/st-1-core.mjs) carries
 * `elapsedMs`, the harness-side round trip.
 */
async function evaluateBounded(cdp, step, expression, ms) {
  const key = `${step}-${nextEvaluationKey++}`
  const started = performance.now()
  let outcome
  try {
    const answer = await cdp.evaluate(pinnedExpression(key, expression, ms), ms + EVALUATE_MARGIN_MS)
    outcome = answer.late ? { ok: false, timedOut: true } : answer.value
  } catch (error) {
    outcome = { ok: false, error: error.message }
  }
  cdp.send('Runtime.evaluate', { expression: releaseExpression(key) }, EVALUATE_TIMEOUT_MS).catch(() => {})
  return { ...outcome, elapsedMs: performance.now() - started }
}

/** `__st1` covers the whole run for the criteria; `__st1since` is read and reset at every sample. */
const SETUP = `(() => {
  const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks')
  globalThis.__st1 = monitorEventLoopDelay({ resolution: ${LOOP_RESOLUTION_MS} })
  globalThis.__st1.enable()
  globalThis.__st1since = monitorEventLoopDelay({ resolution: ${LOOP_RESOLUTION_MS} })
  globalThis.__st1since.enable()
  return process.env.UV_THREADPOOL_SIZE ?? 'default'
})()`

const sample = (probeFile) => `(async () => {
  const loopMaxSinceLastMs = __st1since.max / 1e6
  __st1since.reset()
  const resources = {}
  if (typeof process.getActiveResourcesInfo === 'function') {
    for (const type of process.getActiveResourcesInfo()) resources[type] = (resources[type] ?? 0) + 1
  }
  const { writeFile } = process.getBuiltinModule('node:fs/promises')
  const { lookup } = process.getBuiltinModule('node:dns/promises')
  let started = performance.now()
  await writeFile(${JSON.stringify(probeFile)}, String(started))
  const writeMs = performance.now() - started
  started = performance.now()
  await lookup('localhost')
  return { writeMs, lookupMs: performance.now() - started, loopMaxSinceLastMs, resources }
})()`

const SUMMARY = '({ p99Ms: __st1.percentile(99) / 1e6, maxMs: __st1.max / 1e6 })'

/** Where the candidate's electron-log main.log lives: app.getPath('logs'), which ASKTOTO_USERDATA does
 *  not relocate on macOS. */
const MAIN_LOG_PATH = `(() => {
  const load = process.mainModule?.require
  if (typeof load !== 'function') return { error: 'process.mainModule.require is unavailable in the compiled main' }
  try {
    return { path: load('node:path').join(load('electron').app.getPath('logs'), 'main.log') }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
})()`

/** One History round trip through the real preload bridge, timed inside the main process. The results
 *  stay in the renderer: only whether they settled comes back. */
const HISTORY_PROBE = `(async () => {
  const load = process.mainModule?.require
  if (typeof load !== 'function') return { skipped: 'process.mainModule.require is unavailable in the compiled main' }
  const { BrowserWindow } = load('electron')
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const bridged = await win.webContents.executeJavaScript(
      "typeof window.toto?.recallList === 'function' && typeof window.toto?.brainStatus === 'function'"
    )
    if (!bridged) continue
    const started = performance.now()
    try {
      await win.webContents.executeJavaScript('Promise.all([window.toto.recallList(), window.toto.brainStatus()]).then(() => true)')
      return { ms: performance.now() - started }
    } catch (error) {
      return { ms: performance.now() - started, error: String(error?.message ?? error) }
    }
  }
  return { skipped: 'no window exposes window.toto.recallList and brainStatus' }
})()`

/** Starts the sampling CPU profiler; reports why when it cannot. */
async function startProfiler(cdp) {
  try {
    await cdp.send('Profiler.enable', {}, EVALUATE_TIMEOUT_MS)
    await cdp.send('Profiler.setSamplingInterval', { interval: PROFILE_SAMPLING_US }, EVALUATE_TIMEOUT_MS)
    const started = await cdp.send('Profiler.start', {}, EVALUATE_TIMEOUT_MS)
    return started.late ? { running: false, error: 'Profiler.start did not answer' } : { running: true }
  } catch (error) {
    return { running: false, error: error.message }
  }
}

/** Stops the profiler and writes its .cpuprofile. */
async function stopProfiler(cdp, profiler, path, tMs) {
  profiler.running = false
  profiler.stoppedAtMs = tMs
  try {
    const stopped = await cdp.send('Profiler.stop', {}, PROFILE_STOP_TIMEOUT_MS)
    if (stopped.late) {
      profiler.error = 'Profiler.stop did not answer'
      return
    }
    writeFileSync(path, JSON.stringify(stopped.result.profile))
    profiler.file = basename(path)
  } catch (error) {
    profiler.error = error.message
  }
}

/** One History probe; never throws. */
async function probeHistory(cdp, tMs) {
  return historyEntry(tMs, await evaluateBounded(cdp, 'history', HISTORY_PROBE, HISTORY_TIMEOUT_MS))
}

/** Fills `run` (lib/st-1-core.mjs emptyRun) in place, so a partial report can be written at any moment.
 *  Never throws on a probe that fails or hangs: each is recorded in `run.errors` and the run goes on. */
async function measure(cdp, run, { profile, minutes, spawnedAt, cpuProfilePath }) {
  const sinceSpawn = () => Math.round(performance.now() - spawnedAt)
  run.setupAtMs = sinceSpawn()
  const setup = await evaluateBounded(cdp, 'setup', SETUP, SETUP_TIMEOUT_MS)
  if (setup.ok) run.poolSize = setup.value
  else run.errors.push(failureRecord('setup', run.setupAtMs, setup, SETUP_TIMEOUT_MS))
  run.profiler = { startedAtMs: sinceSpawn(), ...(await startProfiler(cdp)) }
  const probeFile = join(profile, 'st1-probe.txt')
  let historyRunning = null
  let historyLastMs = -Infinity
  const deadline = Date.now() + minutes * 60_000
  while (Date.now() < deadline) {
    const tMs = sinceSpawn()
    if (run.profiler.running && tMs >= PROFILE_UNTIL_MS) await stopProfiler(cdp, run.profiler, cpuProfilePath, tMs)
    if (!historyRunning && tMs >= HISTORY_FROM_MS && tMs - historyLastMs >= HISTORY_EVERY_MS) {
      historyLastMs = tMs
      historyRunning = probeHistory(cdp, tMs).then((probe) => {
        run.history.push(probe)
        historyRunning = null
      })
    }
    const outcome = await evaluateBounded(cdp, 'sample', sample(probeFile), SAMPLE_TIMEOUT_MS)
    recordSample(run, tMs, outcome, { lateAfterMs: EVALUATE_TIMEOUT_MS, boundMs: SAMPLE_TIMEOUT_MS })
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS))
  }
  if (run.profiler.running) await stopProfiler(cdp, run.profiler, cpuProfilePath, sinceSpawn())
  await historyRunning
  const summaryAtMs = sinceSpawn()
  const summary = await evaluateBounded(cdp, 'summary', SUMMARY, SETUP_TIMEOUT_MS)
  if (!summary.ok) run.errors.push(failureRecord('summary', summaryAtMs, summary, SETUP_TIMEOUT_MS))
  run.loop = summary.ok ? summary.value : { p99Ms: Infinity, maxMs: Infinity }
}

/** Where this launch's main.log is, and the byte it starts at. The file's own birth time tells whether
 *  this launch created it (then the whole file is this launch); otherwise its size when the path became
 *  known is the best offset, and boot lines before SETUP may be missing. */
async function locateMainLog(cdp, spawnedWallMs) {
  try {
    const answer = await cdp.evaluate(MAIN_LOG_PATH, MAIN_LOG_QUERY_TIMEOUT_MS)
    if (answer.late) return { error: 'the main.log path query did not answer' }
    if (answer.value.error) return { error: answer.value.error }
    const path = answer.value.path
    if (!existsSync(path)) return { path, fromByte: 0, exactLaunchOffset: true }
    const stats = statSync(path)
    const createdByLaunch = stats.birthtimeMs >= spawnedWallMs
    return { path, fromByte: createdByLaunch ? 0 : stats.size, exactLaunchOffset: createdByLaunch }
  } catch (error) {
    return { error: error.message }
  }
}

/** Copies the profile's audit logs, stall bundles and this launch's main.log into `dir`. Never throws:
 *  missing evidence is reported, never allowed to hide the measurement. */
function copyAppEvidence(profile, mainLog, dir) {
  const copied = []
  const errors = []
  const attempt = (label, copy) => {
    try {
      if (copy()) copied.push(label)
    } catch (error) {
      errors.push(`${label}: ${error.message}`)
    }
  }
  attempt('logs/audit*.log', () => {
    const logs = join(profile, 'logs')
    const audits = existsSync(logs) ? readdirSync(logs).filter((entry) => /^audit.*\.log$/.test(entry)) : []
    for (const name of audits) cpSync(join(logs, name), join(dir, 'logs', name))
    return audits.length > 0
  })
  attempt('diagnostics/stalls', () => {
    const stalls = join(profile, 'diagnostics', 'stalls')
    if (!existsSync(stalls)) return false
    cpSync(stalls, join(dir, 'diagnostics', 'stalls'), { recursive: true })
    return true
  })
  if (mainLog?.path) {
    attempt('main.log', () => {
      if (!existsSync(mainLog.path)) return false
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'main.log'), readFileSync(mainLog.path).subarray(mainLog.fromByte))
      return true
    })
  }
  return { dir: basename(dir), copied, errors }
}

/** Whether the run actually reached the fixtures, and (dataless only) whether they stayed unread. */
function collectExercisedEvidence(kind, fixtures, mainLogPath, mainLogOffset, root) {
  if (kind === 'none') return { exercised: null }
  if (kind === 'fifo') {
    const opened = fixtures.filter((fifo) => releaseFifo(fifo))
    return { exercised: opened.length >= 1, fixturesOpened: opened.map((fifo) => relative(root, fifo)) }
  }
  const stillDataless = datalessFlags(fixtures).every(Boolean)
  const mainLogTail = mainLogPath && existsSync(mainLogPath) ? readFileSync(mainLogPath, 'utf8').slice(mainLogOffset) : ''
  return { exercised: mainLogTail.includes('[dataless] probed'), stillDataless }
}

function stopChild(child) {
  try {
    if (process.platform === 'win32') execFileSync(WIN_TASKKILL, ['/pid', String(child.pid), '/T', '/F'])
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/** Tolerates partial state from a failure before everything was created: `root` may never have become a
 *  junction (a usage error can throw right after resolving --cloud-dir but before placing it), and
 *  `profile`/`unzipDir` may still be null if resolveExecutable/prepareProfile never ran. */
function cleanup({ kind, root, profile, unzipDir }) {
  if (kind === 'dataless' && root) {
    try {
      unlinkSync(root) // ENOENT: never created, or already removed — nothing to do
    } catch (error) {
      // Any other failure to remove the junction stops here, before rmSync(profile, { recursive: true }),
      // rather than risk that recursive removal ever following the still-linked junction into the cloud
      // folder.
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (profile) rmSync(profile, { recursive: true, force: true })
  if (unzipDir) rmSync(unzipDir, { recursive: true, force: true })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.installer || !args.provenance || !args.fixtures) {
    console.error('usage: node scripts/qa/st-1.mjs --installer <path> --provenance <path> --fixtures fifo|dataless|none [options]')
    return 2
  }
  if (args.fixtures !== 'fifo' && args.fixtures !== 'dataless' && args.fixtures !== 'none') {
    console.error(`[st-1] FAIL — --fixtures must be fifo, dataless or none, got ${JSON.stringify(args.fixtures)}`)
    return 2
  }
  if (args.fixtures === 'fifo' && process.platform === 'win32') {
    console.error('[st-1] FAIL — Windows has no FIFOs; use --fixtures dataless')
    return 2
  }
  if (args.fixtures === 'dataless' && (!args.cloudDir || !args.mainLog)) {
    console.error('[st-1] FAIL — --fixtures dataless needs --cloud-dir and --main-log')
    return 2
  }
  const minutes = Number(args.minutes)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error(`[st-1] FAIL — --minutes must be a positive number, got ${JSON.stringify(args.minutes)}`)
    return 2
  }
  if (args.fixtures === 'fifo' && args.count !== undefined) {
    const count = Number(args.count)
    if (!Number.isInteger(count) || count < MIN_FIFO_COUNT) {
      console.error(`[st-1] FAIL — --count must be an integer >= ${MIN_FIFO_COUNT}, got ${JSON.stringify(args.count)}`)
      return 2
    }
  }

  const candidate = await verifyCandidate(args.installer, args.provenance)
  const reportDir = args.reportDir ?? (args.out ? dirname(args.out) : join('out', 'st-1'))
  mkdirSync(reportDir, { recursive: true })
  const reportBase = `st-1-${process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform}-${args.fixtures}`

  // Everything that creates state to clean up — the unzip dir, the profile, the fixtures/junction and the
  // child process — lives inside this one try, so a failure anywhere here (a usage error placing
  // fixtures, a launch that never produces an inspector) still reaches the shared cleanup below instead
  // of leaking a temp profile, a junction into the cloud folder, or a detached candidate.
  let unzipDir = null
  let profile = null
  let root = null
  let child = null
  let cdp = null
  let fixtures = []
  let mainLogOffset = 0
  let mainLogLocated = null
  // The report's inputs, filled in as the run goes; currentReport() turns them into the report at any time.
  const run = emptyRun()
  let launchFailure = null
  let evidence = null
  let mainLog = null
  let appEvidence = null
  let complete = false
  let harnessError = null
  let cleanupError = null
  const reportPath = args.out ?? join(reportDir, `${reportBase}.json`)
  const currentReport = () => {
    const common = { row: args.fixtures, installer: basename(args.installer), candidate, fixtures }
    if (launchFailure) return buildLaunchFailureReport({ ...common, reason: launchFailure })
    return buildReport({
      ...common,
      minutes,
      measured: run,
      evidence,
      attribution: { mainLog, appEvidence },
      complete,
      harnessError
    })
  }
  /** Never throws: a report that cannot be written must not end the measurement. */
  const writeReport = () => {
    try {
      writeFileSync(reportPath, JSON.stringify(currentReport(), null, 2))
    } catch (error) {
      console.error(`[st-1] could not write ${reportPath}: ${error.message}`)
    }
  }
  const partialReports = setInterval(writeReport, PARTIAL_REPORT_EVERY_MS)
  try {
    const resolved = resolveExecutable(args.installer, args.exe)
    unzipDir = resolved.unzipDir
    profile = prepareProfile(args.profileTemplate)
    root = join(profile, 'Métis Meetings')

    const count = args.fixtures === 'fifo' ? Number(args.count ?? DEFAULT_FIFO_COUNT) : undefined
    mainLogOffset = args.mainLog && existsSync(args.mainLog) ? statSync(args.mainLog).size : 0
    fixtures =
      args.fixtures === 'fifo' ? placeFifoFixtures(root, count) : args.fixtures === 'dataless' ? placeDatalessFixtures(root, args.cloudDir) : []

    // `child` is assigned before anything can fail waiting for it, so the shared `finally` below always
    // owns a child to stop — including when the inspector never answers (fuse off), the exe is bad
    // ('error') or the candidate dies early ('exit'): every one of those becomes a launch-failure report
    // instead of a detached, unkillable process.
    const spawnedWallMs = Date.now()
    const spawnedAt = performance.now()
    child = spawnCandidate(resolved.exe, profile)
    let wsUrl
    try {
      wsUrl = await inspectorUrl(child)
    } catch (error) {
      launchFailure = error.message
    }

    if (wsUrl) {
      cdp = cdpClient(wsUrl)
      const cpuProfilePath = join(reportDir, `${reportBase}.cpuprofile`)
      // Asked alongside SETUP, not after the run: when this launch did not create main.log, the size now
      // is the offset.
      mainLogLocated = args.mainLog
        ? Promise.resolve({ path: args.mainLog, fromByte: mainLogOffset, exactLaunchOffset: true })
        : locateMainLog(cdp, spawnedWallMs)
      await measure(cdp, run, { profile, minutes, spawnedAt, cpuProfilePath })
      mainLog = await mainLogLocated
      evidence = collectExercisedEvidence(args.fixtures, fixtures, args.mainLog, mainLogOffset, root)
      complete = true
    }
  } catch (error) {
    harnessError = error.message
    throw error
  } finally {
    clearInterval(partialReports)
    // A run the harness could not finish still reports every piece of evidence it can reach.
    if (!complete && mainLogLocated && !mainLog) {
      const located = await withTimeout(mainLogLocated, MAIN_LOG_QUERY_TIMEOUT_MS)
      mainLog = located.ok ? located.value : { error: 'the main.log path query did not answer' }
    }
    if (!complete && child && !launchFailure && !evidence) {
      try {
        evidence = collectExercisedEvidence(args.fixtures, fixtures, args.mainLog, mainLogOffset, root)
      } catch {
        /* evidence stays unknown */
      }
    }
    cdp?.close()
    if (child) stopChild(child)
    if (child && profile && !launchFailure) appEvidence = copyAppEvidence(profile, mainLog, join(reportDir, `${reportBase}-app`))
    // A cleanup failure is rethrown after this block, never from it: a throw inside `finally` would replace
    // the error that is already propagating.
    try {
      cleanup({ kind: args.fixtures, root, profile, unzipDir })
    } catch (error) {
      cleanupError = error
      harnessError ??= error.message
      console.error(`[st-1] cleanup failed: ${error.message}`)
    }
    writeReport()
  }
  if (cleanupError) throw cleanupError

  const report = currentReport()
  console.log(JSON.stringify(report, null, 2))
  return report.verdict === 'PASS' ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[st-1] FAIL — ${error.message}`)
    process.exit(error.usage ? 2 : 1)
  })
