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
 * The History navigation-guard rows (HIST-*, M2-0232) need a post-onboarding overlay, not a fresh
 * profile's exclusive onboarding tour: main stamps `?exclusiveOnboarding=1` on the very first window it
 * creates whenever `getSettings().onboardingDone` is still false (see `overlayRendererUrl` in
 * main/index.ts), and exiting that tour destroys and recreates the whole `BrowserWindow`
 * (`replaceTransparentOverlayWithExclusiveOnboarding` / `recreateOverlayWindow`) rather than merely
 * reloading it. Driving that exit live over CDP — as the reverted M2-0232 attempt (#271) did — races
 * Playwright's in-flight `page.evaluate()` against the old page's own destruction and can hang
 * indefinitely with no report on Windows. Seeding `settings.json` (plaintext-JSON is one of the three
 * formats `readUserRaw` accepts, see main/store.ts) into the profile BEFORE the app ever launches
 * sidesteps the whole class of bug: the very first window main creates already has `onboardingDone: true`,
 * exactly the cold boot of a returning user.
 *
 * That seed (`seedOnboardedProfile`) uses `overlayLayout: 'hide'`, the layout the RV-* reopen rows need for
 * `parked === true` evidence (`parkOverlayAfterHideSpring` only parks a hover layout). The HIST-* rows need
 * `bar` instead, where History/Settings stay on screen with no hover to drive. A plain settings write never
 * recreates the `BrowserWindow` — only exiting the exclusive onboarding stage does — so
 * `runPackagedNavigationGuardRows` switches the already-launched app to `NAVIGATION_GUARD_BOOTSTRAP_PATCH`
 * over the live IPC settings channel (`ensureNavigationGuardHarnessState`), reveals the window
 * (`revealNavigationSurface`), runs the HIST-* rows, then restores the hover layout
 * (`restoreHoverParkableLayout`) before the RV-* rows run. Those rows live in
 * golden-flows/navigation-guard-rows.mjs and golden-flows/reveal-rows.mjs (M2-0410).
 *
 * After the RV-* rows, the RE-HIDE-* rows (M2-0428, golden-flows/right-edge-hide-rows.mjs) switch the live
 * app to the right-edge placement and prove Hide/Island park and reveal from the screen edge
 * (`runRightEdgeHideRows`). They drive main's cursor watch by stubbing `screen.getCursorScreenPoint` in the
 * main process, reached through the Node inspector the launch opens on a loopback port
 * (`--inspect=127.0.0.1:<port>`), and capture click-through by wrapping `setIgnoreMouseEvents`. Rows that
 * need a live meeting report BLOCKED_EXTERNAL when the hosted runner cannot start one.
 *
 * Usage: node scripts/qa/packaged-smoke.mjs <installed app> <report.json>
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { attach, freeLoopbackPort, killOwned, ownedCensus, runProcess, sleep } from './lib/app-driver.mjs'
import { initialNavigationGuardRows, runPackagedNavigationGuardRows, withOverlayPage } from './golden-flows/navigation-guard-rows.mjs'
import { initialRightEdgeHideRows, runPackagedRightEdgeHideRows } from './golden-flows/right-edge-hide-rows.mjs'
import { initialRvRows, RV_BOOT_ROW_ID, runPackagedRvRows } from './golden-flows/reveal-rows.mjs'
import { AUDIT_POLL_MS, isOverlayUrl, parseAuditLog, readAuditLog } from './golden-flows/smoke-support.mjs'
import { listProcesses, ownedProcesses, roleCounts, survivors as computeSurvivors } from './owned-processes.mjs'

export { NAVIGATION_GUARD_BOOTSTRAP_PATCH, NAVIGATION_GUARD_SCENARIOS, initialNavigationGuardRows } from './golden-flows/navigation-guard-rows.mjs'
export {
  RIGHT_EDGE_HIDE_SCENARIOS,
  LATE_NATIVE_FRAME_HOLD_MS,
  framesAboveWorkArea,
  initialRightEdgeHideRows,
  rightEdgeExpectedRects,
  rightEdgeHideParkMatches,
  rightEdgeMeetingHideVerdict,
  rightEdgeStateMatches,
  rightEdgeStateMismatches,
  runRightEdgeHideRows
} from './golden-flows/right-edge-hide-rows.mjs'
export { RV_BOOT_ROW_ID, RV_SCENARIOS, auditDiagnostic, buildWindowsShortcutLauncher, initialRvRows, isPassingRevealEvidence, runRevealRow } from './golden-flows/reveal-rows.mjs'
export { isOverlayUrl, parseAuditLog, waitUntilParked } from './golden-flows/smoke-support.mjs'

const READY_TIMEOUT_MS = 150_000 // a cold first launch on a hosted runner; the same budget as check-packaged-launch
const SURVIVAL_MS = 3_000 // the window check-packaged-launch requires after app.renderer.ready
const QUIT_TIMEOUT_MS = 30_000 // before-quit defers at most 2s (live meeting only); will-quit is synchronous
const SURVIVOR_BOUND_MS = 5_000 // owned processes must be gone within 5s of main exiting (M2-0028, M2-0029)
const CENSUS_POLL_MS = 500
// How long after app.renderer.ready the boot row keeps watching before it reads the overlay: the launch's
// own activate can arrive after the renderer is up, and a reveal it wrongly honoured shows by then.
const BOOT_OBSERVE_MS = 5_000
const BOOT_QUIT_TIMEOUT_MS = 30_000
// The parked Hide window's size (OVERLAY_HIDE_PARK): a revealed overlay is always larger.
const PARKED_WINDOW = Object.freeze({ width: 8, height: 2 })

export const LIFECYCLE_EVENTS = Object.freeze([
  'app.started',
  'app.renderer.ready',
  'app.stall',
  'app.crash',
  'app.unresponsive',
  'app.shutdown.clean'
])
function hasEvent(records, event) {
  return records.some((record) => record.event === event)
}

function rowIsTerminal(row) {
  return row.status === 'PASS' || row.status === 'FAIL' || row.status === 'BLOCKED_EXTERNAL' || row.status === 'PRECONDITION'
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
      observation.rv.some((row) => !rowIsTerminal(row))
  )
  fail(
    'navigation_guard_failed',
    Array.isArray(observation.navigationGuard) && observation.navigationGuard.some((row) => row.status === 'FAIL')
  )
  fail(
    'navigation_guard_incomplete',
    observation.readyMs !== null &&
      !observation.exitedEarly &&
      Array.isArray(observation.navigationGuard) &&
      observation.navigationGuard.some((row) => !rowIsTerminal(row))
  )
  fail(
    'right_edge_hide_failed',
    Array.isArray(observation.rightEdgeHide) && observation.rightEdgeHide.some((row) => row.status === 'FAIL')
  )
  fail(
    'right_edge_hide_incomplete',
    observation.readyMs !== null &&
      !observation.exitedEarly &&
      Array.isArray(observation.rightEdgeHide) &&
      observation.rightEdgeHide.some((row) => !rowIsTerminal(row))
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
    navigationGuard: observation.navigationGuard,
    rightEdgeHide: observation.rightEdgeHide ?? null,
    processes: {
      atQuit: observation.ownedAtQuit === null ? null : roleCounts(observation.ownedAtQuit),
      survivors: observation.survivors === null ? null : roleCounts(observation.survivors)
    }
  }
}


/**
 * Pure verdict of the LaunchServices cold-launch row. `precondition` is a reason string when the runner
 * could not deliver the profile env or the CDP port through LaunchServices; the row is then PRECONDITION
 * and never PASS. Every observation must be positively known: an unobserved `parked` or `settingsOpened`
 * (null) fails rather than passes.
 */
export function bootLaunchActivateVerdict(observation) {
  if (observation.precondition) {
    return { status: 'PRECONDITION', failures: [], reason: observation.precondition }
  }
  if (observation.rendererReady !== true) {
    return { status: 'PRECONDITION', failures: [], reason: 'app.renderer.ready was not observed after the LaunchServices launch' }
  }
  const failures = []
  if (observation.activateReveals !== 0) failures.push('activate_reveal_during_boot')
  if (observation.parked !== true) failures.push('not_parked_after_boot')
  if (observation.settingsOpened !== false) failures.push('settings_opened_on_boot')
  return { status: failures.length === 0 ? 'PASS' : 'FAIL', failures, reason: null }
}

function completeRvRow(rows, id, patch) {
  const row = rows.find((entry) => entry.id === id)
  if (row) Object.assign(row, patch)
}

function auditRecords(auditLogPath) {
  return parseAuditLog(readAuditLog(auditLogPath))
}

async function bootObservation({ port, auditLogPath }) {
  const activateReveals = auditRecords(auditLogPath).filter((r) => r.event === 'reveal' && r.reason === 'activate').length
  return withOverlayPage(port, async (page, browser) => {
    const size = await page.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }))
    const otherPages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((candidate) => !candidate.isClosed() && !isOverlayUrl(candidate.url())).length
    // Settings is a surface of the overlay window itself (its tab strip), not a separate page.
    const settingsTabs = await page.getByRole('tab', { name: 'Brain' }).count()
    return {
      activateReveals,
      parked: size.width <= PARKED_WINDOW.width && size.height <= PARKED_WINDOW.height,
      settingsOpened: settingsTabs > 0 || otherPages > 0
    }
  })
}

/**
 * Cold-launch the packaged app through LaunchServices, the way Finder, the Dock and Spotlight do, so the
 * launch's own `activate` reaches the app before boot completes. Spawning the binary never delivers it.
 * `open` does not forward this process's environment, so the isolated profile goes through `open --env`,
 * or `launchctl setenv` when that is refused; the CDP port rides `--args`. The row records which method
 * carried it. It runs before the main smoke launch, in its own profile, and quits the app it started.
 */
async function runBootLaunchActivateRow({ target, installRoot, platform, rows }) {
  const profile = mkdtempSync(join(tmpdir(), 'metis-smoke-boot-'))
  const auditLogPath = join(profile, 'logs', 'audit.log')
  const launchctlKeys = []
  let port = null
  let method = null
  const observation = { precondition: null, rendererReady: false, activateReveals: null, parked: null, settingsOpened: null }
  try {
    seedOnboardedProfile(profile)
    port = await freeLoopbackPort()
    const appArgs = ['--args', `--remote-debugging-port=${port}`]
    method = 'open-env'
    let launched = await runProcess('open', ['-a', target, '--env', `ASKTOTO_USERDATA=${profile}`, ...appArgs], 20_000)
    if (launched.error || launched.code !== 0) {
      method = 'launchctl-setenv'
      const set = await runProcess('launchctl', ['setenv', 'ASKTOTO_USERDATA', profile], 10_000)
      if (set.error || set.code !== 0) {
        observation.precondition = 'neither open --env nor launchctl setenv could pass the profile env through LaunchServices'
      } else {
        launchctlKeys.push('ASKTOTO_USERDATA')
        launched = await runProcess('open', ['-a', target, ...appArgs], 20_000)
        if (launched.error || launched.code !== 0) observation.precondition = 'open could not launch the app with the CDP port'
      }
    }

    if (!observation.precondition) {
      const deadline = Date.now() + READY_TIMEOUT_MS
      while (Date.now() < deadline && !hasEvent(parseAuditLog(readAuditLog(auditLogPath)), 'app.renderer.ready')) {
        await sleep(AUDIT_POLL_MS)
      }
      observation.rendererReady = hasEvent(parseAuditLog(readAuditLog(auditLogPath)), 'app.renderer.ready')
      if (!observation.rendererReady) {
        observation.precondition = 'the app never reported app.renderer.ready in the isolated profile, so the profile env did not reach it'
      }
    }

    if (!observation.precondition) {
      await sleep(BOOT_OBSERVE_MS)
      try {
        Object.assign(observation, await bootObservation({ port, auditLogPath }))
      } catch {
        observation.precondition = 'the CDP port did not reach the app through LaunchServices'
      }
    }
  } catch (err) {
    observation.precondition = `boot row harness error: ${err?.message ?? err}`
  } finally {
    try {
      await withOverlayPage(port, (page) => page.evaluate(() => void window.toto.quit()))
    } catch {
      /* not reachable: the owned-process sweep below ends it */
    }
    const quitDeadline = Date.now() + BOOT_QUIT_TIMEOUT_MS
    while (Date.now() < quitDeadline && ownedProcesses(listProcesses(platform), { mainPid: null, installRoot, platform }).length > 0) {
      await sleep(CENSUS_POLL_MS)
    }
    killOwned(ownedProcesses(listProcesses(platform), { mainPid: null, installRoot, platform }))
    for (const key of launchctlKeys) await runProcess('launchctl', ['unsetenv', key], 10_000)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  const verdict = bootLaunchActivateVerdict(observation)
  console.error(`[packaged-smoke] ${RV_BOOT_ROW_ID} ${verdict.status} ${JSON.stringify({ method, failures: verdict.failures, reason: verdict.reason })}`)
  completeRvRow(rows, RV_BOOT_ROW_ID, {
    status: verdict.status,
    evidence: {
      method,
      rendererReady: observation.rendererReady,
      activateReveals: observation.activateReveals,
      parked: observation.parked,
      settingsOpened: observation.settingsOpened,
      failures: verdict.failures
    },
    unblock:
      verdict.status === 'PASS'
        ? null
        : verdict.reason ?? 'Inspect the packaged-smoke artifact: the launch activate revealed the window, left it unparked or opened Settings.'
  })
}

/**
 * A brand-new profile boots with onboarding still live: parkOverlayAfterHideSpring (src/main/index.ts)
 * refuses to park the overlay while the exclusive onboarding tour owns the display, so every RV row's
 * `parked` evidence would read false forever and every reopen row would fail. Seed settings.json before
 * launch so the app starts already onboarded, exactly like a real user's second launch — the scenario
 * every RV row is actually testing. Plain JSON is a supported read path (store.ts's legacy-plaintext
 * fallback), so no encryption/IPC bootstrap is needed.
 */
export function seedOnboardedProfile(profile) {
  const settings = {
    onboardingDone: true,
    onboardingDoneAt: Date.now(),
    // Explicit, not just relying on the schema default: RV parking (parkOverlayAfterHideSpring) only
    // engages for a hover layout (overlayUsesHover), so this must stay 'hide' or 'island', never 'bar'.
    overlayLayout: 'hide'
  }
  writeFileSync(join(profile, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
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
    navigationGuard: initialNavigationGuardRows(),
    rightEdgeHide: initialRightEdgeHideRows(),
    survivors: null,
    survivorsGoneMs: null
  }

  let profile = null
  let child = null

  try {
    // The root must be clean before launch, or the root-residency rule below is unsound.
    const rootBefore = ownedCensus({ platform, mainPid: null, installRoot }).owned
    if (rootBefore.length > 0) {
      observation.installRootBusy = true
      return
    }

    if (platform === 'darwin') {
      await runBootLaunchActivateRow({ target, installRoot, platform, rows: observation.rv })
      // The boot row's app is gone before the main launch; a leftover would break the root-residency rule.
      if (ownedProcesses(listProcesses(platform), { mainPid: null, installRoot, platform }).length > 0) {
        observation.installRootBusy = true
        return
      }
    }

    profile = mkdtempSync(join(tmpdir(), 'metis-smoke-'))
    seedOnboardedProfile(profile)
    const port = await freeLoopbackPort()
    // The RE-HIDE rows evaluate in the main process through its Node inspector (loopback only).
    const inspectPort = await freeLoopbackPort()
    const auditLogPath = join(profile, 'logs', 'audit.log')

    const env = { ...process.env, ASKTOTO_USERDATA: profile, ASKTOTO_SMOKE_REOPEN_PROBE: '1' }
    for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]

    const exitInfo = { settled: false, code: null, signal: null }
    const launchStartMs = Date.now()
    child = spawn(executable, [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectPort}`], { env, stdio: 'ignore' })
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
      await runPackagedNavigationGuardRows({ port, rows: observation.navigationGuard, executable, env })
      await runPackagedRvRows({ platform, target, executable, auditLogPath, rows: observation.rv, env })
      await runPackagedRightEdgeHideRows({ port, inspectPort, rows: observation.rightEdgeHide })

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
    observation.ownedAtQuit = ownedCensus({ platform, mainPid: child.pid, installRoot }).owned
    const vacuous =
      !observation.ownedAtQuit.some((entry) => entry.pid === child.pid) || observation.ownedAtQuit.length < 2
    if (vacuous) return

    observation.quitRequested = true
    const quitRequestedAt = Date.now()
    try {
      const browser = await attach(`http://127.0.0.1:${port}`, 30_000)
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
