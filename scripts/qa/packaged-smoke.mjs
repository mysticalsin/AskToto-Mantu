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
 * The History navigation-guard rows (HIST-*, M2-0232) need a post-onboarding bar, not a fresh profile's
 * exclusive onboarding tour: main stamps `?exclusiveOnboarding=1` on the very first window it creates
 * whenever `getSettings().onboardingDone` is still false (see `overlayRendererUrl` in main/index.ts), and
 * exiting that tour destroys and recreates the whole `BrowserWindow` (`replaceTransparentOverlayWithExclusiveOnboarding`
 * / `recreateOverlayWindow`) rather than merely reloading it. Driving that exit live over CDP — as the
 * reverted M2-0232 attempt (#271) did — races Playwright's in-flight `page.evaluate()` against the old
 * page's own destruction and can hang indefinitely with no report on Windows. Seeding `settings.json`
 * (plaintext-JSON is one of the three formats `readUserRaw` accepts, see main/store.ts) into the profile
 * BEFORE the app ever launches sidesteps the whole class of bug: the very first window main creates is
 * already the ordinary bar overlay, exactly the cold boot of a returning user who finished onboarding.
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

/** The settings.json body (plaintext JSON — one of the three formats main/store.ts's readUserRaw() reads)
 *  seeded into the smoke profile before launch, so main's first window is already the ordinary bar
 *  overlay instead of the exclusive onboarding stage. */
export function navigationGuardProfileSettings(now = Date.now()) {
  return { ...NAVIGATION_GUARD_BOOTSTRAP_PATCH, onboardingDoneAt: now }
}

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

    await restoreHoverParkableLayout(page)
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

/**
 * A .lnk shortcut cannot carry process environment variables, so Windows-shortcut reopen targets a tiny
 * generated .cmd that sets ASKTOTO_USERDATA (and the smoke reopen probe) before starting Metis.exe.
 * Without that indirection, the shortcut launches the executable directly with none of this run's
 * isolated env, so the relaunch resolves the real default profile instead of colliding with this run's
 * single-instance lock: it never reveals the window under test, and it is never quit, leaving an
 * unmanaged orphan under the install root after quit.
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
    '$shortcut.Save()',
    `Start-Process -FilePath ${JSON.stringify(shortcutPath)}`
  ].join('; ')
  return { shortcutPath, launcherPath, launcherBody, shortcutScript }
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
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-3-windows-exe-relaunch',
      reason: 'second-instance',
      prepare: hideBeforeReveal,
      run: () => runProcess(executable, [], 10_000, { env }),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing second-instance reveal event.'
    })

    const { launcherPath, launcherBody, shortcutScript } = buildWindowsShortcutLauncher({
      auditLogDir: dirname(auditLogPath),
      executable,
      userData: env.ASKTOTO_USERDATA,
      reopenProbe: env.ASKTOTO_SMOKE_REOPEN_PROBE
    })
    writeFileSync(launcherPath, launcherBody, 'utf8')
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
    seedOnboardedProfile(profile)
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
      await runPackagedNavigationGuardRows({ port, rows: observation.navigationGuard, executable, env })
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
