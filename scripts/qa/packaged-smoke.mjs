#!/usr/bin/env node
/**
 * Smoke-test a packaged Métis installer end to end (M2-0007), on a hosted `macos-latest` or
 * `windows-latest` runner only (D-9, D-28): installs and launches on a clean host by construction, so
 * this never runs against the owner's account.
 *
 * Proves, in order: the process starts; the renderer bridge/root reports `app.renderer.ready`, then
 * survives `SURVIVAL_MS` with no `app.crash` or `app.unresponsive`; it quits cleanly through its own
 * Quit path (`window.toto.quit()`, the same IPC the tray "Quit Métis" item calls) with exit 0,
 * `app.shutdown.clean` audited and `run-state.json` `clean: true`; and zero owned processes — main's
 * descendants plus residents of the install root (owned-processes.mjs) — are alive `SURVIVOR_BOUND_MS`
 * after main exits.
 *
 * The app is spawned directly, exactly as `check-packaged-launch.mjs` does, with one extra argument:
 * `--remote-debugging-port=<port>`, which only starts Chromium's DevTools HTTP server. Playwright's
 * `_electron.launch` is never used here: its loader rewrites `app.whenReady`/`app.isReady`, swallows the
 * `ready` event, and appends `--disable-breakpad` and `--disable-hang-monitor` — removing the very crash
 * handler and hang monitor this smoke has to observe. A hard kill (SIGKILL, `taskkill /F`,
 * `Stop-Process`) is never a quit, and neither is closing the window: the app stays in the tray by
 * design, so only the product's own Quit IPC counts.
 *
 * Usage: node scripts/qa/packaged-smoke.mjs <installed app> <report.json>
 */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listProcesses, ownedProcesses, roleCounts, survivors as computeSurvivors } from './owned-processes.mjs'

const READY_TIMEOUT_MS = 150_000 // a cold first launch on a hosted runner; the same budget as check-packaged-launch
const SURVIVAL_MS = 3_000 // the window check-packaged-launch requires after app.renderer.ready
const QUIT_TIMEOUT_MS = 30_000 // before-quit defers at most 2s (live meeting only); will-quit is synchronous
const SURVIVOR_BOUND_MS = 5_000 // owned processes must be gone within 5s of main exiting (M2-0028, M2-0029)
const AUDIT_POLL_MS = 250
const CENSUS_POLL_MS = 500
const RV_TIMEOUT_MS = 15_000

export const LIFECYCLE_EVENTS = Object.freeze([
  'app.started',
  'app.renderer.ready',
  'app.stall',
  'app.crash',
  'app.unresponsive',
  'app.shutdown.clean'
])

export const RV_SCENARIOS = Object.freeze([
  { id: 'RV-1-macos-open-activate', platform: 'darwin', reason: 'activate', automation: 'open-app-path' },
  { id: 'RV-2-macos-open-new-instance', platform: 'darwin', reason: 'second-instance', automation: 'open-new-instance' },
  { id: 'RV-3-windows-exe-relaunch', platform: 'win32', reason: 'second-instance', automation: 'exe-relaunch' },
  { id: 'RV-4-tray-show', platform: 'all', reason: 'tray', automation: 'tray-menu' },
  { id: 'RV-4-global-hotkey', platform: 'all', reason: 'hotkey', automation: 'global-hotkey' },
  { id: 'RV-1-macos-finder-spotlight-launchpad', platform: 'darwin', reason: 'activate', automation: 'finder-open-app-file' },
  { id: 'RV-3-windows-shortcut-relaunch', platform: 'win32', reason: 'second-instance', automation: 'windows-shortcut' }
])

/** JSON-lines audit transport ('{text}', logger.ts): blank and malformed lines are skipped, never guessed. */
export function parseAuditLog(text) {
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      continue
    }
  }
  return records
}

/** True iff `url` is the trusted overlay's own `file:` document (overlayRendererUrl). */
export function isOverlayUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'file:' && parsed.pathname.endsWith('/renderer/index.html')
}

function hasEvent(records, event) {
  return records.some((record) => record.event === event)
}

/** One failure code per defect, evaluated in a fixed order; `result` is `'pass'` only when none fire. */
export function smokeVerdict(observation) {
  const failures = []
  const fail = (code, condition) => {
    if (condition) failures.push(code)
  }

  fail('install_root_busy', observation.installRootBusy)
  fail('launch_failed', observation.launchFailed)
  fail('smoke_error', observation.error)
  fail('app_reported_crash', hasEvent(observation.audit, 'app.crash') || hasEvent(observation.audit, 'app.unresponsive'))
  fail('exited_early', observation.exitedEarly)
  fail('renderer_not_ready', observation.mainPid !== null && observation.readyMs === null && !observation.exitedEarly)
  fail(
    'census_vacuous',
    observation.ownedAtQuit !== null &&
      (!observation.ownedAtQuit.some((entry) => entry.pid === observation.mainPid) || observation.ownedAtQuit.length < 2)
  )
  fail('quit_request_failed', observation.quitRequested && !observation.quitDelivered)
  fail('quit_timeout', observation.quitDelivered && observation.exit === null)
  fail(
    'exit_not_clean',
    observation.quitDelivered && observation.exit !== null && (observation.exit.code !== 0 || observation.exit.signal !== null)
  )
  fail(
    'shutdown_not_recorded',
    observation.quitDelivered &&
      observation.exit !== null &&
      (!hasEvent(observation.audit, 'app.shutdown.clean') || observation.marker !== true)
  )
  fail('processes_survived', observation.survivors !== null && observation.survivors.length > 0)
  fail(
    'rv_reopen_failed',
    Array.isArray(observation.rv) && observation.rv.some((row) => row.status === 'FAIL')
  )
  fail(
    'rv_reopen_incomplete',
    observation.readyMs !== null &&
      !observation.exitedEarly &&
      Array.isArray(observation.rv) &&
      observation.rv.some((row) => row.status !== 'PASS' && row.status !== 'FAIL')
  )
  fail('smoke_incomplete', failures.length === 0 && observation.survivors === null)

  return { result: failures.length === 0 ? 'pass' : 'fail', failures }
}

/** The schema-1, content-free report: no paths, command lines, env values or audit detail. */
export function smokeReport(observation) {
  const { result, failures } = smokeVerdict(observation)
  const started = observation.audit.find((record) => record.event === 'app.started')
  const events = Object.fromEntries(
    LIFECYCLE_EVENTS.map((event) => [event, observation.audit.filter((record) => record.event === event).length])
  )

  return {
    schema: 1,
    result,
    failures,
    app: started ? { version: started.version ?? null, platform: started.platform ?? null, arch: started.arch ?? null } : null,
    events,
    timingsMs: {
      ready: observation.readyMs,
      exit: observation.exitMs,
      survivorsGone: observation.survivorsGoneMs
    },
    exit: observation.exit,
    shutdown: {
      audited: hasEvent(observation.audit, 'app.shutdown.clean'),
      marker: observation.marker
    },
    rv: observation.rv,
    processes: {
      atQuit: observation.ownedAtQuit === null ? null : roleCounts(observation.ownedAtQuit),
      survivors: observation.survivors === null ? null : roleCounts(observation.survivors)
    }
  }
}

export function initialRvRows(platform) {
  return RV_SCENARIOS
    .filter((scenario) => scenario.platform === 'all' || scenario.platform === platform)
    .map((scenario) => ({
      id: scenario.id,
      reason: scenario.reason,
      automation: scenario.automation,
      status: 'PENDING',
      evidence: null,
      unblock: null
    }))
}

function completeRvRow(rows, id, patch) {
  const row = rows.find((entry) => entry.id === id)
  if (row) Object.assign(row, patch)
}

function runProcess(file, args, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(file, args, { stdio: 'ignore', detached: false, ...options })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve({ code: null, signal: 'timeout', error: false })
    }, timeoutMs)
    child.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, signal: null, error: true })
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, error: false })
    })
  })
}

async function runAppleScript(script, timeoutMs) {
  return runProcess('osascript', ['-e', script], timeoutMs)
}

async function runPowerShell(script, timeoutMs) {
  return runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeoutMs)
}

async function waitForReveal(auditLogPath, reason, seenCount) {
  const deadline = Date.now() + RV_TIMEOUT_MS
  while (Date.now() < deadline) {
    const records = parseAuditLog(readAuditLog(auditLogPath))
    const matches = records.filter((record) => record.event === 'reveal' && record.reason === reason)
    if (matches.length > seenCount) return matches[matches.length - 1]
    await sleep(AUDIT_POLL_MS)
  }
  return null
}

function revealCount(auditLogPath, reason) {
  return parseAuditLog(readAuditLog(auditLogPath)).filter((r) => r.event === 'reveal' && r.reason === reason).length
}

export function isPassingRevealEvidence(reveal) {
  return reveal !== null && reveal.parked === true && (reveal.outcome === 'created' || reveal.outcome === 'shown')
}

export async function runRevealRow({
  auditLogPath,
  rows,
  id,
  reason,
  prepare,
  run,
  failure,
  countReveals = revealCount,
  waitForRevealRecord = waitForReveal
}) {
  const prepared = prepare ? await prepare() : { error: false }
  const seen = countReveals(auditLogPath, reason)
  const launched = prepared.error ? prepared : await run()
  const reveal = launched.error ? null : await waitForRevealRecord(auditLogPath, reason, seen)
  const pass = isPassingRevealEvidence(reveal)
  completeRvRow(rows, id, {
    status: pass ? 'PASS' : 'FAIL',
    evidence: reveal ? {
      event: 'reveal',
      reason,
      outcome: reveal.outcome ?? null,
      parked: reveal.parked === true,
      layout: typeof reveal.layout === 'string' ? reveal.layout : null
    } : null,
    unblock: pass ? null : failure
  })
}

async function runPackagedRvRows({ platform, target, executable, auditLogPath, rows, env }) {
  const hideBeforeReveal = () => runProcess(executable, ['--metis-smoke-reopen=park-window'], 10_000, { env })
  if (platform === 'darwin') {
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-1-macos-open-activate',
      reason: 'activate',
      prepare: hideBeforeReveal,
      run: () => runProcess('open', [target], 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing activate reveal event.'
    })

    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-2-macos-open-new-instance',
      reason: 'second-instance',
      prepare: hideBeforeReveal,
      run: () => runProcess('open', ['-n', target], 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing second-instance reveal event.'
    })

    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-1-macos-finder-spotlight-launchpad',
      reason: 'activate',
      prepare: hideBeforeReveal,
      run: () => runAppleScript(`tell application "Finder" to open POSIX file ${JSON.stringify(target)}`, 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing Finder activate reveal event.'
    })

    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-4-global-hotkey',
      reason: 'hotkey',
      prepare: hideBeforeReveal,
      run: () => runAppleScript('tell application "System Events" to keystroke return using {command down, shift down}', 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing global-hotkey reveal event.'
    })
  }

  if (platform === 'win32') {
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-3-windows-exe-relaunch',
      reason: 'second-instance',
      prepare: hideBeforeReveal,
      run: () => runProcess(executable, [], 10_000, { env }),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing second-instance reveal event.'
    })

    const shortcutPath = join(dirname(auditLogPath), 'Metis-smoke.lnk')
    const shortcutScript = [
      '$shell = New-Object -ComObject WScript.Shell',
      `$shortcut = $shell.CreateShortcut(${JSON.stringify(shortcutPath)})`,
      `$shortcut.TargetPath = ${JSON.stringify(executable)}`,
      '$shortcut.Save()',
      `Start-Process -FilePath ${JSON.stringify(shortcutPath)}`
    ].join('; ')
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-3-windows-shortcut-relaunch',
      reason: 'second-instance',
      prepare: hideBeforeReveal,
      run: () => runPowerShell(shortcutScript, 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing Windows shortcut reveal event.'
    })

    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-4-global-hotkey',
      reason: 'hotkey',
      prepare: hideBeforeReveal,
      run: () => runPowerShell("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+{ENTER}')", 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing global-hotkey reveal event.'
    })
  }

  await runRevealRow({
    auditLogPath,
    rows,
    id: 'RV-4-tray-show',
    reason: 'tray',
    run: () => runProcess(executable, ['--metis-smoke-reopen=tray-show'], 10_000, { env }),
    failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing tray reveal event.'
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readAuditLog(auditLogPath) {
  try {
    return readFileSync(auditLogPath, 'utf8')
  } catch {
    return ''
  }
}

function readCleanMarker(userData) {
  try {
    const state = JSON.parse(readFileSync(join(userData, 'run-state.json'), 'utf8'))
    return state?.clean === true
  } catch {
    return false
  }
}

/**
 * Reads back what this run's own app process recorded: the audit log and the clean-shutdown marker, from
 * `profile` (`null` when this run never created one, e.g. the install-root-busy path). Called exactly
 * once, at the top of `finally`, before any cleanup kill or the profile's removal — a kill that lands on a
 * still-live renderer, or the removed directory, must never be able to change what gets reported.
 */
export function readObservationTail(profile) {
  if (!profile) return { audit: [], marker: null }
  return {
    audit: parseAuditLog(readAuditLog(join(profile, 'logs', 'audit.log'))),
    marker: readCleanMarker(profile)
  }
}

/**
 * True while Node still holds `child`'s pid unreaped — an un-reaped zombie on POSIX, an open handle on
 * Windows. Once false, the OS is free to hand the pid to an unrelated process, so it must never again be
 * treated as this run's identity.
 */
export function childPidReserved(child) {
  return child !== null && typeof child.pid === 'number' && child.exitCode === null && child.signalCode === null
}

/**
 * Pure: the processes this run's best-effort cleanup should kill. `[]` when this run never launched a
 * child (e.g. the install-root-busy path) — cleanup must never touch processes a run that launched
 * nothing merely found resident under the root, since those are exactly what the pre-launch clean-root
 * check just refused to own. Otherwise, the survivors of whatever baseline census this run took (empty
 * when none was ever taken) unioned with this run's currently-owned processes — walked from `mainPid`
 * only while the child's pid is still reserved (`childPidReserved`), so a pid the child has already been
 * reaped from, and which may already belong to an unrelated process, is never adopted as "main".
 */
export function computeCleanupTargets({ child, ownedAtQuit, mainPid, installRoot, platform }, table) {
  if (child === null) return []
  const targets = new Map()
  for (const entry of computeSurvivors(ownedAtQuit ?? [], table, { installRoot, platform })) {
    targets.set(`${entry.pid}:${entry.startedMs}`, entry)
  }
  const livePid = childPidReserved(child) ? mainPid : null
  for (const entry of ownedProcesses(table, { mainPid: livePid, installRoot, platform })) {
    targets.set(`${entry.pid}:${entry.startedMs}`, entry)
  }
  return [...targets.values()]
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function killOwned(entries) {
  for (const entry of entries) {
    try {
      process.kill(entry.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  const [target, reportPath] = process.argv.slice(2)
  if (!target || !reportPath || (process.platform !== 'darwin' && process.platform !== 'win32')) {
    console.error('usage: node scripts/qa/packaged-smoke.mjs <installed app> <report.json>')
    process.exit(2)
  }

  const platform = process.platform
  let installRoot
  let executable
  if (platform === 'darwin') {
    installRoot = realpathSync.native(target)
    executable = join(installRoot, 'Contents', 'MacOS', basename(installRoot, '.app'))
  } else {
    executable = realpathSync.native(target)
    installRoot = dirname(executable)
  }

  const observation = {
    installRootBusy: false,
    launchFailed: false,
    error: false,
    mainPid: null,
    readyMs: null,
    exitedEarly: false,
    ownedAtQuit: null,
    quitRequested: false,
    quitDelivered: false,
    exit: null,
    exitMs: null,
    audit: [],
    marker: null,
    rv: initialRvRows(platform),
    survivors: null,
    survivorsGoneMs: null
  }

  let profile = null
  let child = null

  try {
    // The root must be clean before launch, or the root-residency rule below is unsound.
    const rootBefore = ownedProcesses(listProcesses(platform), { mainPid: null, installRoot, platform })
    if (rootBefore.length > 0) {
      observation.installRootBusy = true
      return
    }

    profile = mkdtempSync(join(tmpdir(), 'metis-smoke-'))
    const port = await freeLoopbackPort()
    const auditLogPath = join(profile, 'logs', 'audit.log')

    const env = { ...process.env, ASKTOTO_USERDATA: profile, ASKTOTO_SMOKE_REOPEN_PROBE: '1' }
    for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]

    const exitInfo = { settled: false, code: null, signal: null }
    const launchStartMs = Date.now()
    child = spawn(executable, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
    child.once('error', (err) => {
      observation.launchFailed = true
      console.error(`[packaged-smoke] spawn error: ${err?.message ?? err}`)
    })
    child.once('exit', (code, signal) => {
      exitInfo.settled = true
      exitInfo.code = code
      exitInfo.signal = signal
    })
    observation.mainPid = child.pid ?? null

    // Poll until app.renderer.ready or a stopping condition, then keep polling through SURVIVAL_MS. The
    // 'error' event above is asynchronous, so it is checked inside the loop, not right after spawn().
    const readyDeadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < readyDeadline) {
      if (observation.launchFailed) break
      const records = parseAuditLog(readAuditLog(auditLogPath))
      if (hasEvent(records, 'app.crash') || hasEvent(records, 'app.unresponsive')) break
      if (exitInfo.settled) {
        observation.exitedEarly = true
        break
      }
      if (hasEvent(records, 'app.renderer.ready')) {
        observation.readyMs = Date.now() - launchStartMs
        break
      }
      await sleep(AUDIT_POLL_MS)
    }

    if (observation.launchFailed) return

    if (observation.readyMs !== null && !observation.exitedEarly) {
      await runPackagedRvRows({ platform, target, executable, auditLogPath, rows: observation.rv, env })

      const survivalDeadline = Date.now() + SURVIVAL_MS
      while (Date.now() < survivalDeadline) {
        const records = parseAuditLog(readAuditLog(auditLogPath))
        if (hasEvent(records, 'app.crash') || hasEvent(records, 'app.unresponsive')) break
        if (exitInfo.settled) {
          observation.exitedEarly = true
          break
        }
        await sleep(AUDIT_POLL_MS)
      }
    }

    if (observation.exitedEarly || exitInfo.settled) {
      // The quit stage never ran, so exitMs (time from quit request to exit) stays null.
      observation.exitedEarly = true
      observation.exit = { code: exitInfo.code, signal: exitInfo.signal }
      return
    }

    // The census must be non-vacuous before a quit is even requested.
    observation.ownedAtQuit = ownedProcesses(listProcesses(platform), { mainPid: child.pid, installRoot, platform })
    const vacuous =
      !observation.ownedAtQuit.some((entry) => entry.pid === child.pid) || observation.ownedAtQuit.length < 2
    if (vacuous) return

    observation.quitRequested = true
    const quitRequestedAt = Date.now()
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 })
      const pages = browser.contexts().flatMap((context) => context.pages())
      const overlay = pages.find((page) => isOverlayUrl(page.url()))
      if (overlay) {
        await overlay.evaluate(() => {
          void window.toto.quit()
        })
        observation.quitDelivered = true
      }
    } catch {
      observation.quitDelivered = false
    }

    if (!observation.quitDelivered) return

    const quitDeadline = quitRequestedAt + QUIT_TIMEOUT_MS
    while (Date.now() < quitDeadline && !exitInfo.settled) {
      await sleep(AUDIT_POLL_MS)
    }
    if (!exitInfo.settled) return

    observation.exit = { code: exitInfo.code, signal: exitInfo.signal }
    observation.exitMs = Date.now() - quitRequestedAt

    const survivorDeadline = Date.now() + SURVIVOR_BOUND_MS
    const survivorsGoneStart = Date.now()
    let latestTable = listProcesses(platform)
    let latestSurvivors = computeSurvivors(observation.ownedAtQuit, latestTable, { installRoot, platform })
    while (latestSurvivors.length > 0 && Date.now() < survivorDeadline) {
      await sleep(CENSUS_POLL_MS)
      latestTable = listProcesses(platform)
      latestSurvivors = computeSurvivors(observation.ownedAtQuit, latestTable, { installRoot, platform })
    }
    observation.survivors = latestSurvivors
    observation.survivorsGoneMs = latestSurvivors.length === 0 ? Date.now() - survivorsGoneStart : null
  } catch (err) {
    observation.error = true
    console.error(err?.stack ?? String(err))
  } finally {
    // Read back what actually happened before any kill or the profile's removal can change it.
    const tail = readObservationTail(profile)
    observation.audit = tail.audit
    observation.marker = tail.marker

    try {
      const table = listProcesses(platform)
      const targets = computeCleanupTargets(
        { child, ownedAtQuit: observation.ownedAtQuit, mainPid: observation.mainPid, installRoot, platform },
        table
      )
      killOwned(targets)
    } catch {
      /* best effort — the report still reflects what was actually observed */
    }
    if (profile) {
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }

    const report = smokeReport(observation)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.result === 'pass' ? 0 : 1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
