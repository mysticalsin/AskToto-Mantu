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
 * (`restoreHoverParkableLayout`) before the RV-* rows run.
 *
 * After the RV-* rows, the RE-HIDE-* rows (M2-0428) switch the live app to the right-edge placement and
 * prove Hide/Island park and reveal from the screen edge (`runRightEdgeHideRows`). They drive main's
 * cursor watch by stubbing `screen.getCursorScreenPoint` in the main process, reached through the Node
 * inspector the launch opens on a loopback port (`--inspect=127.0.0.1:<port>`), and capture click-through
 * by wrapping `setIgnoreMouseEvents`. Rows that need a live meeting report BLOCKED_EXTERNAL when the
 * hosted runner cannot start one.
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
// How long RE-HIDE-3-meeting-hide holds a parked band before re-reading it, so a late native frame change
// (AppKit re-deriving a titled frame after the park, M2-0526) lands inside the assertion. Empirical.
const LATE_NATIVE_FRAME_HOLD_MS = 500
// The budget a direct relaunch's run() gives the relaunched instance to boot, hand off to the running app
// and exit. A detached relaunch (the Windows shortcut's `start`) resolves run() before that boot, so its
// reveal window adds this budget on top of RV_TIMEOUT_MS instead of spending the boot inside it.
const RELAUNCH_BOOT_MS = 10_000
// How long after app.renderer.ready the boot row keeps watching before it reads the overlay: the launch's
// own activate can arrive after the renderer is up, and a reveal it wrongly honoured shows by then.
const BOOT_OBSERVE_MS = 5_000
const BOOT_QUIT_TIMEOUT_MS = 30_000
// The parked Hide window's size (OVERLAY_HIDE_PARK): a revealed overlay is always larger.
const PARKED_WINDOW = Object.freeze({ width: 8, height: 2 })
// Content-free audit context a failing RV row carries: this many records before the relaunch baseline,
// and at most RV_AUDIT_AFTER after it.
const RV_AUDIT_BEFORE = 3
const RV_AUDIT_AFTER = 40

// The same patch `appearanceSettingsPatch('bar')` (onboarding-appearance.ts) writes when a real user
// picks the bar layout, plus the `persistOnboardingCompletion` fields (onboarding-completion.ts) that
// mark the tour finished — i.e. exactly the durable state of a real user who finished onboarding with
// the bar layout and left auto-hide off. Never a synthetic in-between state.
export const NAVIGATION_GUARD_BOOTSTRAP_PATCH = Object.freeze({
  onboardingDone: true,
  recordingConsent: true,
  overlayLayout: 'bar',
  autoHideOverlay: false
})

export const LIFECYCLE_EVENTS = Object.freeze([
  'app.started',
  'app.renderer.ready',
  'app.stall',
  'app.crash',
  'app.unresponsive',
  'app.shutdown.clean'
])

export const RV_BOOT_ROW_ID = 'RV-boot-launch-activate-stays-parked'

export const RV_SCENARIOS = Object.freeze([
  { id: 'RV-1-macos-open-activate', platform: 'darwin', reason: 'activate', automation: 'open-app-path' },
  { id: 'RV-2-macos-open-new-instance', platform: 'darwin', reason: 'second-instance', automation: 'open-new-instance' },
  { id: 'RV-3-windows-exe-relaunch', platform: 'win32', reason: 'second-instance', automation: 'exe-relaunch' },
  { id: 'RV-4-tray-show', platform: 'all', reason: 'tray', automation: 'tray-menu' },
  { id: 'RV-4-global-hotkey', platform: 'all', reason: 'hotkey', automation: 'global-hotkey' },
  { id: 'RV-1-macos-finder-spotlight-launchpad', platform: 'darwin', reason: 'activate', automation: 'finder-open-app-file' },
  { id: 'RV-3-windows-shortcut-relaunch', platform: 'win32', reason: 'second-instance', automation: 'windows-shortcut' },
  { id: RV_BOOT_ROW_ID, platform: 'darwin', reason: 'activate', automation: 'launchservices-cold-launch' }
])

export const NAVIGATION_GUARD_SCENARIOS = Object.freeze([
  { id: 'HIST-clean-bar-open', state: 'clean', entry: 'bar-history' },
  { id: 'HIST-clean-settings-open', state: 'clean', entry: 'settings-open-full-history' },
  { id: 'HIST-clean-row-doubleclick', state: 'clean', entry: 'history-row-doubleclick' },
  { id: 'HIST-clean-bottom-open', state: 'clean', entry: 'history-open-button' },
  { id: 'HIST-clean-back', state: 'clean', entry: 'review-back-to-history' },
  { id: 'HIST-clean-recent-meeting', state: 'clean', entry: 'review-recent-meeting' },
  { id: 'HIST-dirty-cancel-bar', state: 'dirty', entry: 'bar-history-cancel' },
  { id: 'HIST-dirty-discard-bar', state: 'dirty', entry: 'bar-history-discard' },
  { id: 'HIST-dirty-save-bar', state: 'dirty', entry: 'bar-history-save' },
  { id: 'HIST-dirty-cancel-settings-open', state: 'dirty', entry: 'settings-open-full-history-cancel' },
  { id: 'HIST-dirty-discard-settings-open', state: 'dirty', entry: 'settings-open-full-history-discard' },
  { id: 'HIST-dirty-save-settings-open', state: 'dirty', entry: 'settings-open-full-history-save' },
  { id: 'HIST-dirty-cancel-back', state: 'dirty', entry: 'review-back-to-history-cancel' },
  { id: 'HIST-dirty-discard-back', state: 'dirty', entry: 'review-back-to-history-discard' },
  { id: 'HIST-dirty-save-back', state: 'dirty', entry: 'review-back-to-history-save' },
  { id: 'HIST-dirty-cancel-recent', state: 'dirty', entry: 'review-recent-meeting-cancel' },
  { id: 'HIST-dirty-discard-recent', state: 'dirty', entry: 'review-recent-meeting-discard' },
  { id: 'HIST-dirty-save-recent', state: 'dirty', entry: 'review-recent-meeting-save' }
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

function rowIsTerminal(row) {
  return row.status === 'PASS' || row.status === 'FAIL' || row.status === 'BLOCKED_EXTERNAL'
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

export function initialNavigationGuardRows() {
  return NAVIGATION_GUARD_SCENARIOS.map((scenario) => ({
    id: scenario.id,
    state: scenario.state,
    entry: scenario.entry,
    status: 'PENDING',
    evidence: null,
    unblock: null
  }))
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

function completeNavigationRow(rows, id, patch) {
  const row = rows.find((entry) => entry.id === id)
  if (row) Object.assign(row, patch)
}

async function findOverlayPage(browser, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages())
    const overlay = pages.find((page) => !page.isClosed() && isOverlayUrl(page.url()))
    if (overlay) return overlay
    await sleep(100)
  }
  throw new Error('overlay page not found')
}

async function withOverlayPage(port, fn) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 })
  try {
    const overlay = await findOverlayPage(browser)
    return await fn(overlay, browser)
  } finally {
    await browser.close().catch(() => undefined)
  }
}

async function waitForText(page, text, timeout = 15_000) {
  await page.getByText(text, { exact: true }).first().waitFor({ timeout })
}

async function locatorVisible(locator) {
  return locator.first().isVisible({ timeout: 500 }).catch(() => false)
}

async function ensureNavigationGuardHarnessState(page, browser) {
  const state = await page.evaluate(async (patch) => {
    const before = await window.toto.getSettings()
    const after = await window.toto.setSettings({ ...patch, onboardingDoneAt: Date.now() })
    if (!before.onboardingDone) window.toto.onboardingExit('answer')
    return {
      beforeOnboardingDone: before.onboardingDone,
      afterOnboardingDone: after.onboardingDone,
      overlayLayout: after.overlayLayout,
      autoHideOverlay: after.autoHideOverlay
    }
  }, NAVIGATION_GUARD_BOOTSTRAP_PATCH)
  const activePage = state.beforeOnboardingDone ? page : await findOverlayPage(browser, 30_000)
  await activePage.getByRole('button', { name: 'History' }).first().waitFor({ timeout: 15_000 })
  return { page: activePage, state }
}

async function restoreHoverParkableLayout(page) {
  // RV rows require overlayUsesHover (hide/island) for parked===true evidence on m2.
  await page.evaluate(async () => {
    await window.toto.setSettings({ overlayLayout: 'hide', autoHideOverlay: true })
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const ok = await page.evaluate(async () => {
      const settings = await window.toto.getSettings()
      return settings.overlayLayout === 'hide' && settings.autoHideOverlay === true
    })
    if (ok) return
    await sleep(100)
  }
  throw new Error('hover parkable layout was not applied before RV rows')
}

function readSmokeParkState(userData) {
  try {
    return JSON.parse(readFileSync(join(userData, 'smoke-park-state.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Poll the park-window marker until islandResting is proved (not a blind sleep). */
export async function waitUntilParked(userData, sinceMs, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = readSmokeParkState(userData)
    if (state && typeof state.at === 'number' && state.at >= sinceMs && state.parked === true) {
      return state
    }
    await sleep(AUDIT_POLL_MS)
  }
  return null
}

async function parkAndProve({ executable, env, userData }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const since = Date.now()
    const result = await runProcess(executable, ['--metis-smoke-reopen=park-window'], 10_000, { env })
    if (result.error) return result
    const proved = await waitUntilParked(userData, since)
    if (proved) return result
    await sleep(200)
  }
  return { code: null, signal: null, error: true }
}

async function settleOverlayForRvRows({ page, executable, env, userData }) {
  await dismissNavigationGuardIfOpen(page)
  await ensureIdleBar(page)
  await restoreHoverParkableLayout(page)
  const parked = await parkAndProve({ executable, env, userData })
  if (parked.error) throw new Error('park-window after navigation guard failed to prove parked===true')
}

async function ensureHistory(page) {
  const search = page.getByLabel('Search past meetings')
  if (await locatorVisible(search)) return

  const backToHistory = page.getByRole('button', { name: /Back to history/ })
  if (await locatorVisible(backToHistory)) {
    await backToHistory.first().click({ timeout: 15_000 })
    await search.waitFor({ timeout: 15_000 })
    return
  }

  await clickHistory(page)
}

async function ensureIdleBar(page) {
  const search = page.getByLabel('Search past meetings')
  if (await locatorVisible(search)) {
    await page.getByRole('button', { name: 'History' }).first().click({ timeout: 15_000 })
    await search.waitFor({ state: 'hidden', timeout: 15_000 })
    await page.waitForTimeout(450)
    return
  }

  const backToHistory = page.getByRole('button', { name: /Back to history/ })
  if (await locatorVisible(backToHistory)) {
    await backToHistory.first().click({ timeout: 15_000 })
    await search.waitFor({ timeout: 15_000 })
    await ensureIdleBar(page)
  }
}

async function seedNavigationMeetings(page) {
  return page.evaluate(async () => {
    const startedAt = Date.now()
    const first = await window.toto.saveTranscript({
      title: 'Smoke navigation alpha',
      mode: 'meeting',
      startedAt,
      durationMs: 60_000,
      lines: [{ speaker: 'them', text: 'Synthetic alpha navigation meeting.', t: 1 }],
      recap: '## Overview\nSmoke navigation alpha recap.',
      recapStatus: 'complete'
    })
    const second = await window.toto.saveTranscript({
      title: 'Smoke navigation beta',
      mode: 'meeting',
      startedAt: startedAt + 1,
      durationMs: 60_000,
      lines: [{ speaker: 'them', text: 'Synthetic beta navigation meeting.', t: 1 }],
      recap: '## Overview\nSmoke navigation beta recap.',
      recapStatus: 'complete'
    })
    return {
      first: first.path.split(/[\\/]/).pop(),
      second: second.path.split(/[\\/]/).pop()
    }
  })
}

async function clickHistory(page) {
  await page.getByRole('button', { name: 'History' }).first().click({ timeout: 15_000 })
  await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
}

async function clickHistoryButton(page) {
  await page.getByRole('button', { name: 'History' }).first().click({ timeout: 15_000 })
}

async function clickSettingsButton(page) {
  await page.getByRole('button', { name: 'Settings' }).first().click({ timeout: 15_000 })
}

async function clickOpenFullHistoryFromSettings(page) {
  await page.getByRole('tab', { name: 'Brain' }).first().click({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Open full history' }).first().click({ timeout: 15_000 })
}

async function openHistoryFromSettings(page) {
  await clickSettingsButton(page)
  await clickOpenFullHistoryFromSettings(page)
  await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
}

async function openMeetingFromHistoryRow(page, title) {
  await ensureHistory(page)
  await page.getByRole('button', { name: new RegExp(title) }).first().dblclick({ timeout: 15_000 })
  await waitForText(page, 'Summary')
}

async function openMeetingFromHistoryButton(page, title) {
  await ensureHistory(page)
  await page.getByRole('button', { name: new RegExp(title) }).first().click({ timeout: 15_000 })
  await page.getByRole('button', { name: /^Open/ }).first().click({ timeout: 15_000 })
  await waitForText(page, 'Summary')
}

async function makeRecapDirty(page, suffix) {
  await page.getByRole('button', { name: /Edit/ }).first().click({ timeout: 15_000 })
  const editor = page.getByLabel('Edit meeting notes')
  await editor.waitFor({ timeout: 15_000 })
  await editor.fill(`## Overview\n${suffix}`)
}

async function expectGuard(page) {
  await page.getByRole('dialog', { name: 'Save recap changes?' }).waitFor({ timeout: 15_000 })
}

async function returnToHistoryFromReview(page) {
  await page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 })
  await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
}

async function cancelRecapEdit(page) {
  await page.getByRole('button', { name: 'Cancel' }).first().click({ timeout: 15_000 })
  await page.getByRole('button', { name: /Edit/ }).first().waitFor({ timeout: 15_000 })
}

async function openDirtyReview(page, title, suffix) {
  await openMeetingFromHistoryRow(page, title)
  await makeRecapDirty(page, suffix)
}

async function assertDirtyDraft(page, suffix) {
  await page.getByLabel('Edit meeting notes').waitFor({ timeout: 15_000 })
  const value = await page.getByLabel('Edit meeting notes').inputValue()
  if (!value.includes(suffix)) throw new Error('cancel did not preserve dirty recap draft')
}

async function expectSavedRecap(page, file, suffix) {
  const readBack = await page.evaluate(async (savedFile) => window.toto.recallRead(savedFile), file)
  if (!readBack.ok || !readBack.recap.includes(suffix)) {
    throw new Error('save decision did not persist the dirty recap before navigation')
  }
}

async function dismissNavigationGuardIfOpen(page) {
  const dialog = page.getByRole('dialog', { name: 'Save recap changes?' })
  if (!(await locatorVisible(dialog))) return
  await dialog.getByRole('button', { name: 'Cancel' }).first().click({ timeout: 15_000 })
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
}

async function waitForNavigationGuardClosed(page) {
  await page.getByRole('dialog', { name: 'Save recap changes?' }).waitFor({ state: 'hidden', timeout: 15_000 })
}

async function chooseDirtyHistoryNavigation(page, choice, trigger) {
  await dismissNavigationGuardIfOpen(page)
  // Bar History ignores clicks inside a 400ms toggle debounce; settle after prior History traffic.
  await page.waitForTimeout(450)
  await trigger()
  await expectGuard(page)
  const dialog = page.getByRole('dialog', { name: 'Save recap changes?' })
  await dialog.getByRole('button', { name: choice, exact: true }).click({ timeout: 15_000 })
  await waitForNavigationGuardClosed(page)
}

async function runNavigationStep(rows, id, fn) {
  try {
    const evidence = await fn()
    completeNavigationRow(rows, id, { status: 'PASS', evidence: evidence ?? { observed: true }, unblock: null })
  } catch (err) {
    completeNavigationRow(rows, id, {
      status: 'FAIL',
      evidence: null,
      unblock: `Inspect the packaged-smoke artifact; navigation guard scenario failed: ${err?.message ?? String(err)}`
    })
  }
}

async function revealNavigationSurface({ executable, env, page }) {
  const result = await runProcess(executable, ['--metis-smoke-reopen=tray-show'], 10_000, { env })
  if (result.error) throw new Error('smoke tray-show reveal probe failed before navigation')
  await page.getByRole('button', { name: 'History' }).first().waitFor({ timeout: 15_000 })
}

async function runPackagedNavigationGuardRows({ port, rows, executable, env }) {
  await withOverlayPage(port, async (initialPage, browser) => {
    const ready = await ensureNavigationGuardHarnessState(initialPage, browser)
    const page = ready.page
    await revealNavigationSurface({ executable, env, page })
    const seeded = await seedNavigationMeetings(page)

    await runNavigationStep(rows, 'HIST-clean-bar-open', async () => {
      await ensureIdleBar(page)
      await clickHistory(page)
      return { seededMeetings: 2, guardVisible: false, harnessState: ready.state }
    })

    await runNavigationStep(rows, 'HIST-clean-settings-open', async () => {
      await openHistoryFromSettings(page)
      return { returnedToHistory: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-clean-row-doubleclick', async () => {
      await openMeetingFromHistoryRow(page, 'Smoke navigation alpha')
      return { openedReview: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-clean-bottom-open', async () => {
      await returnToHistoryFromReview(page)
      await openMeetingFromHistoryButton(page, 'Smoke navigation alpha')
      return { openedReview: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-clean-back', async () => {
      await returnToHistoryFromReview(page)
      return { returnedToHistory: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-clean-recent-meeting', async () => {
      await openMeetingFromHistoryRow(page, 'Smoke navigation alpha')
      await page.getByRole('button', { name: /Smoke navigation beta/ }).first().click({ timeout: 15_000 })
      await waitForText(page, 'Smoke navigation beta')
      await returnToHistoryFromReview(page)
      return { openedRecentMeeting: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-dirty-cancel-bar', async () => {
      const suffix = 'Cancel keeps this smoke edit from Bar History.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => clickHistoryButton(page))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', entry: 'bar-history', draftPreserved: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-discard-bar', async () => {
      await openDirtyReview(page, 'Smoke navigation alpha', 'Discard by Bar History.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => clickHistoryButton(page))
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      return { decision: 'discard', entry: 'bar-history', returnedToHistory: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-save-bar', async () => {
      const suffix = 'Saved by Bar History navigation guard.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => clickHistoryButton(page))
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      await expectSavedRecap(page, seeded.first, suffix)
      return { decision: 'save', entry: 'bar-history', persistedBeforeNavigation: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-cancel-settings-open', async () => {
      const suffix = 'Cancel keeps this smoke edit from Settings Open full history.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => clickSettingsButton(page))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', entry: 'settings-open-full-history', draftPreserved: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-discard-settings-open', async () => {
      await openDirtyReview(page, 'Smoke navigation alpha', 'Discard by Settings Open full history.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => clickSettingsButton(page))
      await clickOpenFullHistoryFromSettings(page)
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      return { decision: 'discard', entry: 'settings-open-full-history', returnedToHistory: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-save-settings-open', async () => {
      const suffix = 'Saved by Settings Open full history navigation guard.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => clickSettingsButton(page))
      await clickOpenFullHistoryFromSettings(page)
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      await expectSavedRecap(page, seeded.first, suffix)
      return { decision: 'save', entry: 'settings-open-full-history', persistedBeforeNavigation: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-cancel-back', async () => {
      const suffix = 'Cancel keeps this smoke edit from Back.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 }))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', draftPreserved: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-discard-back', async () => {
      await openDirtyReview(page, 'Smoke navigation alpha', 'Discard by Back to history.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 }))
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      return { decision: 'discard', returnedToHistory: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-save-back', async () => {
      const suffix = 'Saved by Back to history navigation guard.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 }))
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      await expectSavedRecap(page, seeded.first, suffix)
      return { decision: 'save', returnedToHistory: true, persistedBeforeNavigation: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-cancel-recent', async () => {
      const suffix = 'Cancel keeps this smoke edit from Recent meetings.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => page.getByRole('button', { name: /Smoke navigation beta/ }).first().click({ timeout: 15_000 }))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', entry: 'review-recent-meeting', draftPreserved: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-discard-recent', async () => {
      await openDirtyReview(page, 'Smoke navigation alpha', 'Discard by Recent meetings.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => page.getByRole('button', { name: /Smoke navigation beta/ }).first().click({ timeout: 15_000 }))
      await waitForText(page, 'Smoke navigation beta')
      await returnToHistoryFromReview(page)
      return { decision: 'discard', entry: 'review-recent-meeting', openedTargetMeeting: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-save-recent', async () => {
      const suffix = 'Saved by Recent meetings navigation guard.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => page.getByRole('button', { name: /Smoke navigation beta/ }).first().click({ timeout: 15_000 }))
      await waitForText(page, 'Smoke navigation beta')
      await expectSavedRecap(page, seeded.first, suffix)
      await returnToHistoryFromReview(page)
      return { decision: 'save', entry: 'review-recent-meeting', persistedBeforeNavigation: true }
    })

    await settleOverlayForRvRows({ page, executable, env, userData: env.ASKTOTO_USERDATA })
  })
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

async function waitForReveal(auditLogPath, reason, seenCount, timeoutMs = RV_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
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

function auditRecords(auditLogPath) {
  return parseAuditLog(readAuditLog(auditLogPath))
}

export function isPassingRevealEvidence(reveal) {
  return reveal !== null && reveal.parked === true && (reveal.outcome === 'created' || reveal.outcome === 'shown')
}

const REVEAL_DIAGNOSTIC_FIELDS = ['reason', 'outcome', 'isVisible', 'parked', 'layout', 'ms']

/** An audit record reduced to its event name; a `reveal` keeps only its enum/boolean/number projection fields. */
export function auditDiagnostic(record) {
  const out = { event: typeof record?.event === 'string' ? record.event : null }
  if (out.event !== 'reveal') return out
  for (const field of REVEAL_DIAGNOSTIC_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') out[field] = value
  }
  return out
}

function processOutcome(result) {
  return { code: result?.code ?? null, signal: result?.signal ?? null, error: result?.error === true }
}

export async function runRevealRow({
  auditLogPath,
  rows,
  id,
  reason,
  prepare,
  run,
  failure,
  revealTimeoutMs = RV_TIMEOUT_MS,
  countReveals = revealCount,
  waitForRevealRecord = waitForReveal
}) {
  const prepared = prepare ? await prepare() : { error: false }
  const baseline = auditRecords(auditLogPath).length
  const seen = countReveals(auditLogPath, reason)
  const launchedAt = Date.now()
  const launched = prepared.error ? prepared : await run()
  const reveal = launched.error ? null : await waitForRevealRecord(auditLogPath, reason, seen, revealTimeoutMs)
  const pass = isPassingRevealEvidence(reveal)
  let diagnostics = null
  if (!pass) {
    // A rotated log restarts shorter than the baseline; every record in it is then after the relaunch.
    const records = auditRecords(auditLogPath)
    const split = records.length >= baseline ? baseline : 0
    diagnostics = {
      stage: prepared.error ? 'prepare' : launched.error ? 'launch' : reveal === null ? 'no-reveal' : 'reveal-not-passing',
      prepare: processOutcome(prepared),
      launch: prepared.error ? null : processOutcome(launched),
      waitedMs: Date.now() - launchedAt,
      auditBefore: records.slice(Math.max(0, split - RV_AUDIT_BEFORE), split).map(auditDiagnostic),
      auditAfter: records.slice(split, split + RV_AUDIT_AFTER).map(auditDiagnostic)
    }
    console.error(`[packaged-smoke] ${id} FAIL ${JSON.stringify(diagnostics)}`)
  }
  completeRvRow(rows, id, {
    status: pass ? 'PASS' : 'FAIL',
    evidence: reveal ? {
      event: 'reveal',
      reason,
      outcome: reveal.outcome ?? null,
      parked: reveal.parked === true,
      layout: typeof reveal.layout === 'string' ? reveal.layout : null
    } : null,
    unblock: pass ? null : failure,
    ...(diagnostics ? { diagnostics } : {})
  })
}

/**
 * A .lnk shortcut cannot carry process environment variables, so Windows-shortcut reopen targets a tiny
 * generated .cmd that sets ASKTOTO_USERDATA (and the smoke reopen probe) before starting Metis.exe.
 * Without that indirection, the shortcut launches the executable directly with none of this run's
 * isolated env, so the relaunch resolves the real default profile instead of colliding with this run's
 * single-instance lock: it never reveals the window under test, and it is never quit, leaving an
 * unmanaged orphan under the install root after quit.
 *
 * `shortcutScript` only creates the .lnk (a WScript.Shell COM activation, seconds on a cold hosted runner);
 * `launchScript` only opens it, the way a user's double-click does. They run as separate steps so the COM
 * activation never spends the relaunch's own budget.
 */
export function buildWindowsShortcutLauncher({ auditLogDir, executable, userData, reopenProbe = '' }) {
  if (typeof userData !== 'string' || userData.length === 0) {
    throw new Error('windows shortcut smoke requires ASKTOTO_USERDATA in the reopen env')
  }
  const shortcutPath = join(auditLogDir, 'Metis-smoke.lnk')
  const launcherPath = join(auditLogDir, 'Metis-smoke-launch.cmd')
  const launcherBody = [
    '@echo off',
    `set "ASKTOTO_USERDATA=${userData}"`,
    `set "ASKTOTO_SMOKE_REOPEN_PROBE=${reopenProbe}"`,
    `start "" ${JSON.stringify(executable)}`
  ].join('\r\n')
  const shortcutScript = [
    '$shell = New-Object -ComObject WScript.Shell',
    `$shortcut = $shell.CreateShortcut(${JSON.stringify(shortcutPath)})`,
    `$shortcut.TargetPath = ${JSON.stringify(launcherPath)}`,
    `$shortcut.WorkingDirectory = ${JSON.stringify(dirname(executable))}`,
    '$shortcut.Save()'
  ].join('; ')
  const launchScript = `Start-Process -FilePath ${JSON.stringify(shortcutPath)}`
  return { shortcutPath, launcherPath, launcherBody, shortcutScript, launchScript }
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

async function runPackagedRvRows({ platform, target, executable, auditLogPath, rows, env }) {
  const userData = env.ASKTOTO_USERDATA
  const hideBeforeReveal = async () => parkAndProve({ executable, env, userData })
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
      // `open -n` launches through LaunchServices, which does not forward the calling process's
      // environment to the app it starts — ASKTOTO_USERDATA would never reach it, so the relaunch would
      // boot against the real default profile instead of colliding with this run's isolated lock and
      // would leave an unmanaged, unquit orphan behind. A direct relaunch of the installed executable (the
      // same single-instance-lock code path `open -n` would hit) reliably carries the isolated env, exactly
      // like the RV-3 Windows exe relaunch below.
      run: () => runProcess(executable, [], 10_000, { env }),
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
    // A cold hosted runner can spend more than the 10 s row budget just starting PowerShell, which kills
    // the shortcut script before it launches anything. Warm it once, outside every row's budget.
    await runPowerShell('exit 0', 120_000)
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-3-windows-exe-relaunch',
      reason: 'second-instance',
      prepare: hideBeforeReveal,
      run: () => runProcess(executable, [], RELAUNCH_BOOT_MS, { env }),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing second-instance reveal event.'
    })

    const { launcherPath, launcherBody, shortcutScript, launchScript } = buildWindowsShortcutLauncher({
      auditLogDir: dirname(auditLogPath),
      executable,
      userData: env.ASKTOTO_USERDATA,
      reopenProbe: env.ASKTOTO_SMOKE_REOPEN_PROBE
    })
    writeFileSync(launcherPath, launcherBody, 'utf8')
    // Created once, outside the row's launch budget, like the PowerShell warm-up above.
    const shortcutCreated = await runPowerShell(shortcutScript, 120_000)
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-3-windows-shortcut-relaunch',
      reason: 'second-instance',
      prepare: async () => (shortcutCreated.code === 0 ? hideBeforeReveal() : { ...shortcutCreated, error: true }),
      // Start-Process returns once ShellExecute has started the .cmd, whose `start` detaches Metis.exe, so
      // the relaunched instance boots after run() resolves: its boot budget is part of the reveal window.
      run: () => runPowerShell(launchScript, 30_000),
      revealTimeoutMs: RELAUNCH_BOOT_MS + RV_TIMEOUT_MS,
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

// ── Right-edge Hide (M2-0428) ──────────────────────────────────────────────────────────────────────────
// The RE-HIDE rows drive main's cursor watch by stubbing `screen.getCursorScreenPoint` inside the main
// process, and read the click-through flag by wrapping `win.setIgnoreMouseEvents` (Electron has no
// getter). Hosted runners have no pointer to move, and moving the real one would not be deterministic.
// Geometry mirrors src/main/island/geometry.ts for a fresh profile (normalized sidecar Y 0.2).

export const RIGHT_EDGE_HIDE_SCENARIOS = Object.freeze([
  { id: 'RE-HIDE-1-edge-reveals', layout: 'hide' },
  { id: 'RE-HIDE-2-inset-stays-parked', layout: 'hide' },
  { id: 'RE-HIDE-3-draft-hide-and-escape', layout: 'hide' },
  { id: 'RE-HIDE-5-toggle-hide-latches', layout: 'hide' },
  { id: 'RE-HIDE-6-toggle-reveals-hide', layout: 'hide' },
  { id: 'RE-HIDE-6-toggle-reveals-island', layout: 'island' },
  { id: 'RE-HIDE-7-layout-change-chrome', layout: 'hide' },
  { id: 'RE-HIDE-3-meeting-hide', layout: 'hide' },
  { id: 'RE-HIDE-4-island-meeting-leave-parks', layout: 'island' }
])

const RIGHT_EDGE = Object.freeze({ margin: 12, tab: 52, drawerWidth: 360, drawerHeight: 560, band: 4, normalizedY: 0.2 })
/** Right-edge only (src/main/island/cursor-watch.ts RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS). */
const RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS = 3000
const MEETING_UNBLOCK =
  'Run the RE-HIDE meeting rows on the QA Mac or a Windows QA machine with a working, permitted microphone: ' +
  'the hosted runner could not start a live meeting.'

export function initialRightEdgeHideRows() {
  return RIGHT_EDGE_HIDE_SCENARIOS.map((scenario) => ({
    id: scenario.id,
    layout: scenario.layout,
    status: 'PENDING',
    evidence: null,
    unblock: null
  }))
}

function rightEdgeY(height, workArea) {
  const min = workArea.y + RIGHT_EDGE.margin
  const max = workArea.y + workArea.height - height - RIGHT_EDGE.margin
  return Math.round(min + (max - min) * RIGHT_EDGE.normalizedY)
}

/** Expected native bounds on `workArea`: the open drawer, the Island rail tab and the Hide reveal band. */
export function rightEdgeExpectedRects(workArea) {
  const right = workArea.x + workArea.width
  const drawerHeight = Math.min(RIGHT_EDGE.drawerHeight, Math.max(RIGHT_EDGE.tab, workArea.height - RIGHT_EDGE.margin * 2))
  const drawerY = rightEdgeY(drawerHeight, workArea)
  return {
    drawer: { x: right - RIGHT_EDGE.margin - RIGHT_EDGE.drawerWidth, y: drawerY, width: RIGHT_EDGE.drawerWidth, height: drawerHeight },
    tab: { x: right - RIGHT_EDGE.margin - RIGHT_EDGE.tab, y: rightEdgeY(RIGHT_EDGE.tab, workArea), width: RIGHT_EDGE.tab, height: RIGHT_EDGE.tab },
    band: { x: right - RIGHT_EDGE.band, y: drawerY, width: RIGHT_EDGE.band, height: drawerHeight }
  }
}

function rectMatches(actual, expected, tolerance = 2) {
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(actual[key] - expected[key]) <= tolerance)
}

/**
 * Parked Hide against the reveal band main requests. Windows enforces a minimum width on frameless
 * windows, so the band may read back wider; main then keeps its right edge at the work-area edge
 * (src/main/island/geometry.ts rightAnchoredParkPosition). Accept the requested y, height and right edge
 * at any width the OS allowed, never a window that crosses the edge or sits inset from it.
 */
export function rightEdgeHideParkMatches(bounds, band, tolerance = 2) {
  return (
    Math.abs(bounds.y - band.y) <= tolerance &&
    Math.abs(bounds.height - band.height) <= tolerance &&
    Math.abs(bounds.x + bounds.width - (band.x + band.width)) <= tolerance &&
    bounds.width >= band.width - tolerance
  )
}

function insideWorkArea(bounds, workArea) {
  return (
    bounds.x >= workArea.x &&
    bounds.y >= workArea.y &&
    bounds.x + bounds.width <= workArea.x + workArea.width &&
    bounds.y + bounds.height <= workArea.y + workArea.height
  )
}

/**
 * Pure verdict on one observation. `state` is 'revealed' or 'parked'; `layout` is 'hide' or 'island'.
 * Revealed: drawer bounds, opacity 1, click-through off, the 'Métis' drawer rendered.
 * Parked Hide: reveal-band bounds, opacity 0, click-through on. Parked Island: rail bounds, opacity 1,
 * click-through off, the rail rendered with no open drawer. Every park sits inside the work area.
 */
export function rightEdgeStateMatches(observation, state, layout) {
  return rightEdgeStateMismatches(observation, state, layout).length === 0
}

/** The criteria of `rightEdgeStateMatches` that `observation` misses, by name; empty when it matches. */
export function rightEdgeStateMismatches(observation, state, layout) {
  const win = observation?.win
  const page = observation?.page
  if (!win || !page) return ['observation']
  const expected = rightEdgeExpectedRects(win.workArea)
  const checks =
    state === 'revealed'
      ? { bounds: rectMatches(win.bounds, expected.drawer), opacity: win.opacity === 1, clickThrough: win.clickThrough === false, drawer: page.drawer === true }
      : layout === 'hide'
        ? { insideWorkArea: insideWorkArea(win.bounds, win.workArea), drawer: !page.drawer, bounds: rightEdgeHideParkMatches(win.bounds, expected.band), opacity: win.opacity === 0, clickThrough: win.clickThrough === true }
        : { insideWorkArea: insideWorkArea(win.bounds, win.workArea), drawer: !page.drawer, bounds: rectMatches(win.bounds, expected.tab), opacity: win.opacity === 1, clickThrough: win.clickThrough === false, rail: page.rail === true }
  return Object.keys(checks).filter((key) => !checks[key])
}

/**
 * Installs (idempotently) the cursor stub, the click-through capture and the geometry trace on every live
 * window. The trace keeps the last frames of the overlay: each app write ('write', the requested rect), each
 * minimum-size write ('minimum', its size), each window call that can change the native style mask or trigger
 * a reframe ('call', its name and primitive arguments, with the frame at the call; applyOverlaySurfaceChrome
 * shows as its setBackgroundColor/setOpacity calls) and each native move/resize ('frame', the resulting rect),
 * so a frame no write asked for shows as native, next to the call that preceded it.
 */
const MAIN_RE_HIDE_SHIM = `(() => {
  const { screen, BrowserWindow } = globalThis.__metisReHideElectron
  const state = (globalThis.__metisReHide ??= { cursor: null, clickThrough: new WeakMap(), geometry: [] })
  if (!state.realCursor) {
    state.realCursor = screen.getCursorScreenPoint.bind(screen)
    screen.getCursorScreenPoint = () => state.cursor ?? state.realCursor()
  }
  const trace = (w, kind, bounds, call) => {
    try {
      if (!/\\/renderer\\/index\\.html/.test(w.webContents.getURL())) return
      state.geometry.push(call ? { t: Date.now(), kind, bounds, call } : { t: Date.now(), kind, bounds })
      if (state.geometry.length > 80) state.geometry.shift()
    } catch {
      /* a closing window: the trace is evidence only */
    }
  }
  const primitive = (value) => typeof value !== 'object' && typeof value !== 'function'
  const traceArgs = (args) =>
    args.map((arg) =>
      arg && typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).filter(([, value]) => primitive(value))) : arg
    )
  const TRACED_CALLS = [
    'setOpacity',
    'setBackgroundColor',
    'setHasShadow',
    'setResizable',
    'setMovable',
    'setAlwaysOnTop',
    'setVisibleOnAllWorkspaces',
    'setContentProtection',
    'setSize',
    'setContentSize',
    'setContentBounds',
    'setMaximumSize',
    'show',
    'showInactive',
    'hide'
  ]
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.__metisReHideWrapped) continue
    const setIgnoreMouseEvents = w.setIgnoreMouseEvents.bind(w)
    const setBounds = w.setBounds.bind(w)
    const setPosition = w.setPosition.bind(w)
    const setMinimumSize = w.setMinimumSize.bind(w)
    w.__metisReHideWrapped = true
    for (const name of TRACED_CALLS) {
      if (typeof w[name] !== 'function') continue
      const original = w[name].bind(w)
      w[name] = (...args) => {
        trace(w, 'call', w.getBounds(), { name, args: traceArgs(args) })
        return original(...args)
      }
    }
    w.setIgnoreMouseEvents = (ignore, options) => {
      state.clickThrough.set(w, ignore === true)
      trace(w, 'call', w.getBounds(), { name: 'setIgnoreMouseEvents', args: traceArgs([ignore, options]) })
      return setIgnoreMouseEvents(ignore, options)
    }
    w.setBounds = (bounds, animate) => {
      trace(w, 'write', { ...w.getBounds(), ...bounds })
      return setBounds(bounds, animate)
    }
    w.setPosition = (x, y, animate) => {
      trace(w, 'write', { ...w.getBounds(), x, y })
      return setPosition(x, y, animate)
    }
    w.setMinimumSize = (width, height) => {
      trace(w, 'minimum', { width, height })
      return setMinimumSize(width, height)
    }
    w.on('move', () => trace(w, 'frame', w.getBounds()))
    w.on('resize', () => trace(w, 'frame', w.getBounds()))
  }
  return true
})()`

/** The overlay geometry trace since `since` (ms epoch): rects and call names only, never page content. */
const mainReHideGeometrySince = (since) =>
  `(() => globalThis.__metisReHide.geometry.filter((entry) => entry.t >= ${Number(since)}).map(({ t, ...entry }) => ({ ms: t - ${Number(since)}, ...entry })))()`

const MAIN_RE_HIDE_SNAPSHOT = `(() => {
  const { screen, BrowserWindow } = globalThis.__metisReHideElectron
  const state = globalThis.__metisReHide
  const w = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed() && /\\/renderer\\/index\\.html/.test(c.webContents.getURL()))
  if (!w) return null
  const bounds = w.getBounds()
  const display = screen.getDisplayMatching(bounds)
  return {
    bounds,
    opacity: w.getOpacity(),
    visible: w.isVisible(),
    clickThrough: state.clickThrough.has(w) ? state.clickThrough.get(w) : null,
    displayBounds: display.bounds,
    workArea: display.workArea
  }
})()`

const setMainCursor = (point) =>
  `(() => { globalThis.__metisReHide.cursor = ${point ? JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) }) : 'null'}; return true })()`

async function rightEdgePageState(page) {
  return page.evaluate(() => {
    const input = document.querySelector('.right-edge-sidecar__chat-input')
    const drawer = document.querySelector('.right-edge-sidecar__drawer') !== null
    return {
      dock: document.querySelector('.right-edge-sidecar') !== null,
      drawer,
      rail: !drawer && document.querySelector('.right-edge-sidecar__tab') !== null,
      hideControl: document.querySelector('button[aria-label="Hide Métis"]') !== null,
      meetingLive: document.querySelector('[aria-label="Meeting controls"]') !== null,
      composerFocused: input !== null && document.activeElement === input,
      draft: input instanceof HTMLInputElement ? input.value : null
    }
  })
}

/** Content-free evidence: geometry kind and chrome flags only, never page text. */
function summarize(observation) {
  const win = observation?.win
  if (!win) return null
  const expected = rightEdgeExpectedRects(win.workArea)
  const kind = rectMatches(win.bounds, expected.drawer)
    ? 'drawer'
    : rightEdgeHideParkMatches(win.bounds, expected.band)
      ? 'hide-band'
      : rectMatches(win.bounds, expected.tab)
        ? 'island-rail'
        : 'other'
  return {
    kind,
    // Requested vs actual: the OS may widen a parked Hide band (Windows minimum window width).
    requestedHideBand: expected.band,
    bounds: win.bounds,
    workArea: win.workArea,
    opacity: win.opacity,
    clickThrough: win.clickThrough,
    drawerRendered: observation.page?.drawer ?? null,
    railRendered: observation.page?.rail ?? null,
    dockRendered: observation.page?.dock ?? null
  }
}

/**
 * Runs the RE-HIDE rows against a live overlay. `main(expression)` evaluates a JavaScript expression in the
 * Electron main process after `globalThis.__metisReHideElectron` holds the electron module; `page` is the
 * overlay renderer page. Rows never throw: a failure is recorded on its row.
 */
export async function runRightEdgeHideRows({ page, main, rows, wait = sleep }) {
  const complete = (id, patch) => {
    const row = rows.find((entry) => entry.id === id)
    if (row) Object.assign(row, patch)
  }
  const observe = async () => {
    await main(MAIN_RE_HIDE_SHIM)
    return { win: await main(MAIN_RE_HIDE_SNAPSHOT), page: await rightEdgePageState(page) }
  }
  const waitUntil = async (predicate, timeoutMs) => {
    const started = Date.now()
    let observed = await observe()
    while (!predicate(observed) && Date.now() - started < timeoutMs) {
      await wait(50)
      observed = await observe()
    }
    return { ok: predicate(observed), observed, ms: Date.now() - started }
  }
  const setCursor = (point) => main(setMainCursor(point))
  const awayPoint = (win) => ({ x: win.workArea.x + 40, y: win.workArea.y + Math.round(win.workArea.height / 2) })
  const edgePoint = (win) => {
    const { drawer } = rightEdgeExpectedRects(win.workArea)
    return { x: win.displayBounds.x + win.displayBounds.width - 1, y: drawer.y + Math.round(drawer.height / 2) }
  }
  // Main broadcasts the placement/layout change, and the page re-renders from its refreshed settings.
  // Give that refresh time to land, so an Escape below never reaches a stale top-center page.
  const setLayout = async (layout) => {
    await page.evaluate(
      (next) => window.toto.setSettings({ overlayPlacement: 'right-edge', overlayLayout: next, autoHideOverlay: true }),
      layout
    )
    for (let waited = 0; waited < 1_500 && !(await rightEdgePageState(page)).dock; waited += 100) await wait(100)
  }
  // The navigation rows before these leave a full view (History/Review) open, which replaces the dock
  // entirely. Escape backs out of it exactly as a user would; it is only sent while no dock is rendered.
  const leaveFullViews = async () => {
    for (let attempt = 0; attempt < 4 && !(await rightEdgePageState(page)).dock; attempt++) {
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      await wait(200)
    }
  }
  const park = async (layout) => {
    const current = await observe()
    if (!current.win) throw new Error('overlay window not found in the main process')
    await setCursor(awayPoint(current.win))
    await setLayout(layout)
    await leaveFullViews()
    if (!rightEdgeStateMatches(await observe(), 'parked', layout)) {
      await page.evaluate(() => window.toto.parkAfterHide(true))
    }
    const parked = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', layout), 5_000)
    if (!parked.ok) {
      const missed = rightEdgeStateMismatches(parked.observed, 'parked', layout).join(',')
      throw new Error(`could not park right-edge ${layout} (missed: ${missed}): ${JSON.stringify(summarize(parked.observed))}`)
    }
    return parked.observed
  }
  const revealAtEdge = async () => {
    const current = await observe()
    await setCursor(edgePoint(current.win))
    const revealed = await waitUntil((o) => rightEdgeStateMatches(o, 'revealed'), 3_000)
    if (!revealed.ok) {
      const missed = rightEdgeStateMismatches(revealed.observed, 'revealed').join(',')
      throw new Error(`the right-edge band did not reveal the drawer (missed: ${missed}): ${JSON.stringify(summarize(revealed.observed))}`)
    }
    return revealed.observed
  }
  const composer = () => page.getByRole('textbox', { name: 'Ask Métis anything' })
  const hideControl = () => page.getByRole('button', { name: 'Hide Métis' })
  const step = async (id, fn) => {
    try {
      const outcome = await fn()
      complete(id, { status: outcome.status ?? (outcome.pass ? 'PASS' : 'FAIL'), evidence: outcome.evidence, unblock: outcome.unblock ?? (outcome.pass ? null : 'Inspect the packaged-smoke artifact; the RE-HIDE evidence shows the observed window and page state.') })
    } catch (err) {
      complete(id, {
        status: 'FAIL',
        evidence: null,
        unblock: `Inspect the packaged-smoke artifact; RE-HIDE scenario failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 700)}`
      })
    }
  }

  await main(MAIN_RE_HIDE_SHIM)

  await step('RE-HIDE-1-edge-reveals', async () => {
    const parked = await park('hide')
    await setCursor(edgePoint(parked.win))
    await wait(400)
    const at400 = await observe()
    // Main must have revealed by 400 ms; the page may take one more paint to mount the drawer.
    const mainRevealed = rightEdgeStateMatches({ ...at400, page: { ...at400.page, drawer: true } }, 'revealed')
    const settled = await waitUntil((o) => rightEdgeStateMatches(o, 'revealed'), 1_000)
    return { pass: mainRevealed && settled.ok, evidence: { parked: summarize(parked), at400ms: summarize(at400), settled: summarize(settled.observed) } }
  })

  await step('RE-HIDE-2-inset-stays-parked', async () => {
    const parked = await park('hide')
    const { tab } = rightEdgeExpectedRects(parked.win.workArea)
    await setCursor({ x: parked.win.workArea.x + parked.win.workArea.width - 40, y: tab.y + 20 })
    await wait(600)
    const after = await observe()
    const unchanged = rectMatches(after.win.bounds, parked.win.bounds, 0)
    return { pass: unchanged && rightEdgeStateMatches(after, 'parked', 'hide'), evidence: { parked: summarize(parked), after600ms: summarize(after) } }
  })

  await step('RE-HIDE-3-draft-hide-and-escape', async () => {
    const draft = 'Draft kept on Hide'
    await park('hide')
    await revealAtEdge()
    await composer().fill(draft)
    const hideVisible = await hideControl().isVisible()
    await hideControl().click({ timeout: 5_000 })
    const byControl = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', 'hide'), 3_000)
    await setCursor(awayPoint(byControl.observed.win))
    await wait(100)
    const reopened = await revealAtEdge()
    const keptAfterControl = reopened.page.draft === draft
    await composer().focus()
    await page.keyboard.press('Escape')
    const byEscape = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', 'hide'), 3_000)
    await setCursor(awayPoint(byEscape.observed.win))
    await wait(100)
    const reopenedAgain = await revealAtEdge()
    const keptAfterEscape = reopenedAgain.page.draft === draft
    await composer().fill('')
    return {
      pass: hideVisible && byControl.ok && keptAfterControl && byEscape.ok && keptAfterEscape,
      evidence: { hideVisibleWithDraft: hideVisible, parkedByControl: byControl.ok, draftKeptAfterControl: keptAfterControl, parkedByEscape: byEscape.ok, draftKeptAfterEscape: keptAfterEscape }
    }
  })

  await step('RE-HIDE-5-toggle-hide-latches', async () => {
    await park('hide')
    const revealed = await revealAtEdge()
    await page.evaluate(() => window.toto.toggle())
    const hidden = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', 'hide'), 2_000)
    // The pointer stays over the band the Hide was issued from.
    await wait(600)
    const after600 = await observe()
    const latched = rightEdgeStateMatches(after600, 'parked', 'hide')
    await setCursor(awayPoint(revealed.win))
    await wait(150)
    await setCursor(edgePoint(revealed.win))
    const released = await waitUntil((o) => rightEdgeStateMatches(o, 'revealed'), 2_000)
    return {
      pass: hidden.ok && latched && released.ok,
      evidence: { hidden: summarize(hidden.observed), after600ms: summarize(after600), bandWorksAfterLeaving: released.ok }
    }
  })

  for (const layout of ['hide', 'island']) {
    await step(`RE-HIDE-6-toggle-reveals-${layout}`, async () => {
      await park(layout)
      // Hide first goes through an explicit Hide, the path that left the page dismissed after a reveal.
      if (layout === 'hide') {
        const revealed = await revealAtEdge()
        await hideControl().click({ timeout: 5_000 })
        await setCursor(awayPoint(revealed.win))
      }
      const parked = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', layout), 3_000)
      await page.evaluate(() => window.toto.toggle())
      const revealed = await waitUntil((o) => rightEdgeStateMatches(o, 'revealed') && o.page.composerFocused, 3_000)
      const autoParked = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', layout), RIGHT_EDGE_UNHOVERED_REVEAL_GRACE_MS + 5_000)
      return {
        pass: parked.ok && revealed.ok && autoParked.ok,
        evidence: {
          parked: summarize(parked.observed),
          revealed: summarize(revealed.observed),
          composerFocused: revealed.observed.page.composerFocused,
          autoParkedAfterMs: autoParked.ok ? revealed.ms + autoParked.ms : null
        }
      }
    })
  }

  await step('RE-HIDE-7-layout-change-chrome', async () => {
    await park('hide')
    await setLayout('island')
    const island = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', 'island'), 3_000)
    await setLayout('hide')
    const hide = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', 'hide'), 3_000)
    return { pass: island.ok && hide.ok, evidence: { island: summarize(island.observed), hide: summarize(hide.observed) } }
  })

  // Meeting rows run last: a started meeting changes the page for everything after it.
  let meetingLive = false
  await step('RE-HIDE-3-meeting-hide', async () => {
    await park('hide')
    await revealAtEdge()
    await page.getByRole('button', { name: 'Start listening' }).click({ timeout: 5_000 })
    const live = await waitUntil((o) => o.page.meetingLive, 10_000)
    meetingLive = live.ok
    if (!meetingLive) return { status: 'BLOCKED_EXTERNAL', evidence: { meetingLive: false }, unblock: MEETING_UNBLOCK }
    const hideVisible = await hideControl().isVisible()
    const clickedAt = await main('Date.now()')
    await hideControl().click({ timeout: 5_000 })
    const parked = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', 'hide'), 3_000)
    // Held: the band is still the park after a late native frame change (M2-0526). A stricter assertion,
    // not a retry.
    await wait(LATE_NATIVE_FRAME_HOLD_MS)
    const held = await observe()
    const heldOk = rightEdgeStateMatches(held, 'parked', 'hide')
    const geometry = await main(mainReHideGeometrySince(clickedAt))
    // No native frame of the overlay may leave the work area at any point of the Hide, even one reverted
    // before the held read: drawer, band and tab all lie inside it.
    const workAreaY = held.win?.workArea?.y
    const framesAboveWorkArea = geometry.filter((entry) => entry.kind === 'frame' && !(entry.bounds.y >= workAreaY))
    return {
      pass: hideVisible && parked.ok && heldOk && framesAboveWorkArea.length === 0,
      evidence: { meetingLive: true, hideVisible, parked: summarize(parked.observed), after500ms: summarize(held), framesAboveWorkArea, geometry }
    }
  })

  await step('RE-HIDE-4-island-meeting-leave-parks', async () => {
    await park('island')
    const revealed = await revealAtEdge()
    const { drawer } = rightEdgeExpectedRects(revealed.win.workArea)
    await setCursor({ x: drawer.x - 200, y: drawer.y + 40 })
    await wait(1_500)
    const after = await observe()
    const parked = rightEdgeStateMatches(after, 'parked', 'island')
    const evidence = { meetingLive, after1500ms: summarize(after) }
    if (!parked) return { pass: false, evidence }
    if (!meetingLive) return { status: 'BLOCKED_EXTERNAL', evidence, unblock: MEETING_UNBLOCK }
    return { pass: true, evidence }
  })

  if (meetingLive) {
    try {
      await revealAtEdge()
      await page.getByRole('button', { name: 'Stop meeting' }).click({ timeout: 5_000 })
    } catch {
      /* best effort: quit still flushes a live meeting */
    }
  }
  await setCursor(null).catch(() => undefined)
}

/** Minimal Chrome DevTools Protocol client for the main process's Node inspector. */
async function mainInspector(inspectPort) {
  const deadline = Date.now() + 30_000
  let wsUrl = null
  while (!wsUrl && Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
      wsUrl = targets.find((target) => typeof target.webSocketDebuggerUrl === 'string')?.webSocketDebuggerUrl ?? null
    } catch {
      /* the inspector is not listening yet */
    }
    if (!wsUrl) await sleep(250)
  }
  if (!wsUrl) throw new Error('no main-process inspector: the EnableNodeCliInspectArguments fuse may be off')
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const resolve = pending.get(message.id)
    if (!resolve) return
    pending.delete(message.id)
    resolve(message)
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('main-process inspector socket failed to connect')))
  })
  const evaluate = async (expression) => {
    const id = nextId++
    const answer = new Promise((resolve) => pending.set(id, resolve))
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('main-process evaluate timed out')), 10_000))
    const message = await Promise.race([answer, timeout])
    if (message.error) throw new Error(message.error.message)
    if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text)
    return message.result?.result?.value
  }
  await evaluate("globalThis.__metisReHideElectron = process.mainModule.require('electron'); true")
  return { evaluate, close: () => socket.close() }
}

async function runPackagedRightEdgeHideRows({ port, inspectPort, rows }) {
  let inspector = null
  try {
    inspector = await mainInspector(inspectPort)
  } catch (err) {
    for (const row of rows) {
      Object.assign(row, { status: 'FAIL', evidence: null, unblock: `Inspect the packaged-smoke artifact; ${err?.message ?? String(err)}` })
    }
    return
  }
  try {
    await withOverlayPage(port, (page) => runRightEdgeHideRows({ page, main: inspector.evaluate, rows }))
  } finally {
    inspector.close()
  }
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
    navigationGuard: initialNavigationGuardRows(),
    rightEdgeHide: initialRightEdgeHideRows(),
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
