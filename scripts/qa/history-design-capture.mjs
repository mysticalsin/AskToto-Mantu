#!/usr/bin/env node
/**
 * History design evidence from the real packaged renderer (M2-0032): every state in
 * lib/history-design.mjs's HISTORY_DESIGN_STATES, in every DESIGN_VARIANTS entry (light/dark x 1x/2x x
 * motion allowed/reduced), as a screenshot, judged by automated WCAG AA contrast and clipping checks, with
 * the History view's accessibility roles and keyboard Tab order. Runs on a hosted runner only (D-28),
 * against an installed candidate, on a fresh temp profile that the sandbox guard confirms before anything
 * is written.
 *
 * The app is spawned like packaged-smoke.mjs does (onboarded bar profile, `--remote-debugging-port` for
 * the renderer, `--inspect` on loopback for main). The local rows are real meetings saved through the
 * app's own saveTranscript. The states a hosted runner has no source for (a slow, failed or cloud-only
 * OneDrive) are served by replacing History's IPC handlers in the main process through the inspector:
 * the renderer, its bridge and its markup are the shipped ones, only the answers are fixtures. The real
 * cloud row is reported BLOCKED_EXTERNAL with its unblock step.
 *
 * Every capture's page is composited over its appearance's backdrop (see lib/history-design.mjs), set
 * with Emulation.setDefaultBackgroundColorOverride; 2x is Emulation.setDeviceMetricsOverride with a
 * device scale factor of 2, and reduced motion is the emulated prefers-reduced-motion media feature. The
 * appearance also sets main's nativeTheme.themeSource.
 *
 * Output (`--out`, default out/history-design): <state>/<variant>.png, <state>/aria.yml (the History
 * view's accessibility snapshot), history-design-report.json and SUMMARY.md. Only synthetic meetings are
 * ever on screen.
 *
 * Usage: node scripts/qa/history-design-capture.mjs <installed .app | Metis.exe> [--out <dir>]
 * Exit codes: 0 PASS, 1 FAIL or INCOMPLETE, 2 usage.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NAVIGATION_GUARD_BOOTSTRAP_PATCH, clickHistory, ensureIdleBar, findOverlayPage } from './golden-flows/navigation-guard-rows.mjs'
import { mainInspector } from './golden-flows/right-edge-hide-rows.mjs'
import { isOverlayUrl, parseAuditLog } from './golden-flows/smoke-support.mjs'
import { freeLoopbackPort } from './lib/app-driver.mjs'
import { assertAttachedAppIsSandboxed } from './lib/sandbox-guard.mjs'
import {
  BACKDROPS,
  BLOCKED_EXTERNAL_ROWS,
  DESIGN_VARIANTS,
  HISTORY_DESIGN_STATES,
  IPC_CHANNELS,
  KEYBOARD_VARIANT_ID,
  designVerdict,
  deviceMetricsForVariant,
  historyTransitions,
  judgeCapture,
  listAnswer,
  solidGradientLayers
} from './lib/history-design.mjs'

const READY_TIMEOUT_MS = 150_000
export const STATE_TIMEOUT_MS = 10_000
const SETTLE_TIMEOUT_MS = 1_000
const QUIT_TIMEOUT_MS = 30_000
const TAB_STOPS_MAX = 80
const DOWNLOAD_ERROR = 'OneDrive is offline. Connect, then retry.'
const SAMPLE_MEETINGS = ['Quarterly planning sample', 'Design review sample']

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  const [target, ...rest] = argv
  let out = join('out', 'history-design')
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out' && rest[i + 1]) out = rest[++i]
    else return null
  }
  return target ? { target, out } : null
}

function executableOf(target) {
  const resolved = realpathSync.native(target)
  return process.platform === 'darwin' ? join(resolved, 'Contents', 'MacOS', basename(resolved, '.app')) : resolved
}

function readAudit(profile) {
  try {
    return parseAuditLog(readFileSync(join(profile, 'logs', 'audit.log'), 'utf8'))
  } catch {
    return []
  }
}

async function waitForRendererReady(profile, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('the app exited before app.renderer.ready')
    if (readAudit(profile).some((record) => record.event === 'app.renderer.ready')) return
    await sleep(250)
  }
  throw new Error(`no app.renderer.ready within ${READY_TIMEOUT_MS} ms`)
}

/** Replaces History's list, search and explicit-open handlers with fixtures driven by __historyDesign. */
export const INSTALL_FIXTURE_HANDLERS = `(() => {
  const { ipcMain } = globalThis.__metisReHideElectron
  const C = ${JSON.stringify(IPC_CHANNELS)}
  const error = ${JSON.stringify(DOWNLOAD_ERROR)}
  const state = (globalThis.__historyDesign = {
    list: { kind: 'rows', rows: [] },
    search: { kind: 'rows', rows: [] },
    read: 'hydrating',
    parked: [],
    requests: { list: 0, search: 0 },
    requestedAt: { list: 0, search: 0 }
  })
  const park = () => new Promise((resolve) => { state.parked.push(resolve) })
  const answer = (channel, spec) => {
    state.requests[channel]++
    state.requestedAt[channel] = Date.now()
    if (spec.kind === 'pending') return park()
    if (spec.kind === 'failed') return Promise.reject(new Error('History design fixture: the source failed'))
    return Promise.resolve(spec.rows)
  }
  // The real handlers' contract (recall-hydration.ts): 'hydrating', then exactly one 'done' or 'failed'.
  const explicitOpen = (e, file, failedAnswer) => {
    const key = String(file ?? '')
    e.sender.send(C.recallHydration, { file: key, state: 'hydrating' })
    if (state.read === 'hydrating') return park()
    setTimeout(() => e.sender.send(C.recallHydration, { file: key, state: 'failed', error }), 50)
    return failedAnswer
  }
  for (const name of [C.recallList, C.recallSearch, C.recallRead, C.recallOpen]) ipcMain.removeHandler(name)
  ipcMain.handle(C.recallList, () => answer('list', state.list))
  ipcMain.handle(C.recallSearch, () => answer('search', state.search))
  ipcMain.handle(C.recallRead, (e, file) => explicitOpen(e, file, { ok: false, error }))
  ipcMain.handle(C.recallOpen, (e, file) => explicitOpen(e, file, error))
  return true
})()`

const REVEAL_OVERLAY = `(() => {
  const { BrowserWindow } = globalThis.__metisReHideElectron
  let shown = 0
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    let path = ''
    try { path = new URL(win.webContents.getURL()).pathname } catch {}
    if (!path.endsWith('/renderer/index.html')) continue
    win.show()
    win.focus()
    shown++
  }
  return shown
})()`

/**
 * Runs in the renderer: marks the History view's root and returns every visible text, placeholder and
 * named icon in it, with what the contrast and clipping checks need. Colours are resolved by a hidden
 * probe's computed `color` (calc() channels, color-mix) and then go through a canvas so any CSS colour
 * syntax arrives as sRGB [r, g, b, alpha]; one the probe rejects is non-finite. Each ancestor contributes its
 * background-color, then its solid gradient layers bottom to top (solidLayers is solidGradientLayers).
 */
function collectHistoryView(solidLayers) {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const probe = document.createElement('i')
  probe.style.display = 'none'
  document.body.append(probe)
  const rgba = (css) => {
    probe.style.color = ''
    probe.style.color = css
    if (!probe.style.color) return [Number.NaN, Number.NaN, Number.NaN, Number.NaN]
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = getComputedStyle(probe).color
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  const input = document.querySelector('input[aria-label="Search past meetings"]')
  let root = input
  while (root && !(root.classList.contains('h-full') && root.classList.contains('flex-col'))) root = root.parentElement
  const scope = root ? 'history-view' : 'document'
  root = root ?? document.body
  document.querySelectorAll('[data-history-design-root]').forEach((el) => el.removeAttribute('data-history-design-root'))
  root.setAttribute('data-history-design-root', '')
  const hides = (value) => value === 'hidden' || value === 'clip'
  const samples = []
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const icon = el instanceof SVGElement && el.getAttribute('role') === 'img' && el.getAttribute('aria-label')
    const placeholder = el instanceof HTMLInputElement && el.placeholder && !el.value
    const text = [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(' ').trim()
    if (!icon && !placeholder && !text) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const style = getComputedStyle(el)
    let opacity = 1
    const chain = []
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node)
      opacity *= Number.parseFloat(s.opacity)
      chain.unshift(s)
    }
    const layers = []
    let bgImage = false
    for (const s of chain) {
      const bg = rgba(s.backgroundColor)
      if (bg[3] > 0) layers.push(bg)
      const solids = solidLayers(s.backgroundImage, rgba)
      if (solids === null) bgImage = s.backgroundImage
      else for (const color of [...solids].reverse()) if (color[3] > 0) layers.push(color)
    }
    let clipAncestor = null
    for (let node = el.parentElement; node; node = node.parentElement) {
      const s = getComputedStyle(node)
      if (hides(s.overflowX) || hides(s.overflowY)) {
        const a = node.getBoundingClientRect()
        clipAncestor = { left: a.left, right: a.right, top: a.top, bottom: a.bottom, overflowX: s.overflowX, overflowY: s.overflowY, textOverflow: s.textOverflow }
        break
      }
    }
    samples.push({
      kind: icon ? 'icon' : placeholder ? 'placeholder' : 'text',
      label: (icon ? el.getAttribute('aria-label') : placeholder ? `placeholder: ${el.placeholder}` : text).replace(/\s+/g, ' ').slice(0, 60),
      fg: rgba(placeholder ? getComputedStyle(el, '::placeholder').color : style.color),
      opacity,
      layers,
      bgImage,
      disabled: Boolean(el.closest('button:disabled, input:disabled, [aria-disabled="true"]')),
      fontSizePx: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseInt(style.fontWeight, 10),
      rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      box: {
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        textOverflow: style.textOverflow,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      },
      clipAncestor
    })
  }
  probe.remove()
  return { scope, viewport: { width: innerWidth, height: innerHeight }, samples }
}

function tabStop() {
  const el = document.activeElement
  const root = document.querySelector('[data-history-design-root]')
  if (!el || el === document.body) return null
  const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return { name, role: el.getAttribute('role') || el.tagName.toLowerCase(), inView: Boolean(root && root.contains(el)) }
}

/** The Tab order from the search box until focus leaves the History view. */
async function walkTabOrder(page) {
  await page.getByLabel('Search past meetings').focus()
  const stops = []
  for (let i = 0; i < TAB_STOPS_MAX; i++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(tabStop)
    if (!stop || !stop.inView) break
    stops.push({ name: stop.name, role: stop.role })
  }
  return stops
}

async function rolesPresent(page, state) {
  const root = page.locator('[data-history-design-root]')
  const results = []
  for (const want of state.roles) {
    let locator = root.getByRole(want.role, want.name === undefined ? undefined : { name: want.name })
    if (want.text) locator = locator.filter({ hasText: want.text })
    results.push({ ...want, found: (await locator.count()) > 0 })
  }
  return results
}

export function fixtureAnswersForState(state, realRows, nowMs = Date.now()) {
  return {
    list: listAnswer(state.list, realRows, nowMs),
    search: listAnswer(state.search ?? state.list, realRows, nowMs),
    read: state.read ?? 'hydrating'
  }
}

/** Waits for History's next fixture-backed request on one channel; returns when main received it. */
export async function waitForRequest(main, channel, before, wait = sleep) {
  const deadline = Date.now() + STATE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const { requests, requestedAt } = await main('(({ requests, requestedAt }) => ({ requests, requestedAt }))(globalThis.__historyDesign)')
    if ((requests?.[channel] ?? 0) > before) return requestedAt?.[channel] ?? 0
    await wait(50)
  }
  throw new Error(`History did not request its ${channel}`)
}

async function forceMainGarbage(main) {
  if (typeof main.collectGarbage !== 'function') throw new Error('main-process garbage collection is not available')
  await main.collectGarbage()
}

async function locatorVisible(locator) {
  try {
    return await locator.first().isVisible({ timeout: 500 })
  } catch {
    return false
  }
}

function throwWithDrive(error, drive) {
  if (error && typeof error === 'object') error.drive = drive
  throw error
}

async function historySearchValue(locator) {
  if (typeof locator.inputValue === 'function') return locator.inputValue({ timeout: STATE_TIMEOUT_MS })
  if (typeof locator.evaluate === 'function') return locator.evaluate((input) => input.value)
  return ''
}

async function clearHistorySearch(page) {
  const input = page.getByLabel('Search past meetings')
  if ((await historySearchValue(input)) !== '') await input.fill('')
}

/**
 * Waits for the visual cue needed before capture. Accessibility roles are still checked afterwards by
 * rolesPresent/judgeCapture.
 * @param {import('playwright').Page} page
 * @param {{ text: string, role?: string | null, timeoutMs?: number }} cue
 */
export async function waitForHistoryDesignCue(page, { text, role = null, timeoutMs = STATE_TIMEOUT_MS }) {
  const locator = role ? page.getByRole(role).filter({ hasText: text }) : page.getByText(text)
  await locator.first().waitFor({ timeout: timeoutMs })
}

const HISTORY_DESIGN_CUE_BY_STATE = Object.freeze({
  slow: Object.freeze({ text: 'OneDrive is slow to answer', role: 'status' }),
  'slow-with-rows': Object.freeze({ text: 'OneDrive is slow to answer', role: 'status' }),
  failed: Object.freeze({ text: 'Could not load your meetings', role: 'alert' }),
  unavailable: Object.freeze({ text: 'could not be read right now', role: 'status' })
})

function historyDesignCueForState(stateId) {
  return HISTORY_DESIGN_CUE_BY_STATE[stateId] ?? null
}

/**
 * Puts History into `state` from a fresh open; returns when the open was clicked, when History's list
 * or search request reached main, and how it went. The cue wait stays bounded by STATE_TIMEOUT_MS; drive
 * timings are emitted so CI artifacts can explain any first-capture miss without extending that wait.
 */
export async function driveState(page, main, state, realRows, deps = {}) {
  const wait = deps.wait ?? sleep
  const ensureIdle = deps.ensureIdleBar ?? ensureIdleBar
  const openHistory = deps.clickHistory ?? clickHistory
  const driveStartedAt = Date.now()
  // Bar History ignores a toggle within 400 ms of the last one; a fast capture can end inside that window.
  await wait(450)
  const toggleGuardSettledAt = Date.now()
  // ensureIdleBar owns the close-before-arm invariant: if History is already mounted, close it and wait
  // through the toolbar's toggle guard before fixtures are changed and the next open requests fresh data.
  await ensureIdle(page)
  const idleSettledAt = Date.now()
  const searchInput = page.getByLabel('Search past meetings')
  const closedBeforeArm = !(await locatorVisible(searchInput))
  const closeCheckedAt = Date.now()
  if (!closedBeforeArm) {
    throwWithDrive(new Error('History was still open before fixture arm'), {
      closedBeforeArm,
      timingsMs: {
        toggleGuard: toggleGuardSettledAt - driveStartedAt,
        ensureIdle: idleSettledAt - toggleGuardSettledAt,
        closeCheck: closeCheckedAt - idleSettledAt
      }
    })
  }
  const now = Date.now()
  const fixtures = fixtureAnswersForState(state, realRows, now)
  await main(`(() => {
    const s = globalThis.__historyDesign
    s.list = ${JSON.stringify(fixtures.list)}
    s.search = ${JSON.stringify(fixtures.search)}
    s.read = ${JSON.stringify(fixtures.read)}
    return true
  })()`)
  const armedAt = Date.now()
  const beforeList = await main('globalThis.__historyDesign.requests.list')
  const clickedAt = Date.now()
  await openHistory(page)
  const reopenedQuery = await historySearchValue(searchInput)
  if (reopenedQuery.trim()) {
    throwWithDrive(new Error('History reopened with a non-empty search query'), {
      clickedAt,
      closedBeforeArm,
      requestChannels: {
        list: { before: beforeList, answered: false },
        search: null
      },
      timingsMs: {
        toggleGuard: toggleGuardSettledAt - driveStartedAt,
        ensureIdle: idleSettledAt - toggleGuardSettledAt,
        closeCheck: closeCheckedAt - idleSettledAt,
        armFixture: armedAt - closeCheckedAt,
        openToListRequest: null
      }
    })
  }
  let requestedAt
  try {
    requestedAt = await waitForRequest(main, 'list', beforeList, wait)
  } catch (error) {
    throwWithDrive(error, {
      clickedAt,
      closedBeforeArm,
      requestChannels: {
        list: { before: beforeList, answered: false },
        search: null
      },
      timingsMs: {
        toggleGuard: toggleGuardSettledAt - driveStartedAt,
        ensureIdle: idleSettledAt - toggleGuardSettledAt,
        closeCheck: closeCheckedAt - idleSettledAt,
        armFixture: armedAt - closeCheckedAt,
        openToListRequest: null
      }
    })
  }
  const visible = (text, role = null, timeoutMs = STATE_TIMEOUT_MS) => waitForHistoryDesignCue(page, { text, role, timeoutMs })
  const drive = {
    clickedAt,
    requestedAt,
    closedBeforeArm,
    requestChannels: {
      list: { before: beforeList, answered: true, requestedAt },
      search: null
    },
    timingsMs: {
      toggleGuard: toggleGuardSettledAt - driveStartedAt,
      ensureIdle: idleSettledAt - toggleGuardSettledAt,
      closeCheck: closeCheckedAt - idleSettledAt,
      armFixture: armedAt - closeCheckedAt,
      openToListRequest: requestedAt - clickedAt
    }
  }
  if (fixtures.list.kind === 'pending') {
    try {
      await forceMainGarbage(main)
    } catch (error) {
      throwWithDrive(error, drive)
    }
  }
  if (state.id === 'slow' || state.id === 'unavailable' || state.id === 'failed') {
    const cue = historyDesignCueForState(state.id)
    try {
      await visible(cue.text, cue.role)
    } catch (error) {
      throwWithDrive(error, drive)
    }
    const cueAt = Date.now()
    drive.bannerAfterMs = cueAt - clickedAt
    drive.timingsMs.listRequestToCue = cueAt - requestedAt
  } else if (state.id === 'slow-with-rows') {
    await visible(SAMPLE_MEETINGS[0])
    const beforeSearch = await main('globalThis.__historyDesign.requests.search')
    const typedAt = Date.now()
    await searchInput.fill('planning')
    try {
      drive.requestedAt = await waitForRequest(main, 'search', beforeSearch, wait)
    } catch (error) {
      drive.requestChannels.search = { before: beforeSearch, answered: false }
      throwWithDrive(error, drive)
    }
    drive.requestChannels.search = { before: beforeSearch, answered: true, requestedAt: drive.requestedAt }
    drive.timingsMs.listRequestToSearchFill = typedAt - requestedAt
    drive.timingsMs.searchFillToSearchRequest = drive.requestedAt - typedAt
    if (fixtures.search.kind === 'pending') {
      try {
        await forceMainGarbage(main)
      } catch (error) {
        throwWithDrive(error, drive)
      }
    }
    const cue = historyDesignCueForState(state.id)
    try {
      await visible(cue.text, cue.role)
    } catch (error) {
      throwWithDrive(error, drive)
    }
    const cueAt = Date.now()
    drive.bannerAfterMs = cueAt - typedAt
    drive.timingsMs.searchRequestToCue = cueAt - drive.requestedAt
  } else if (state.list !== 'pending') {
    await visible(state.list === 'rows+notDownloaded' ? 'Not downloaded' : SAMPLE_MEETINGS[0])
  }
  if (state.open) {
    // The explicit open, by keyboard: focus the row's Download action and press Enter.
    await page.getByRole('button', { name: /^Download and open / }).first().focus()
    await page.keyboard.press('Enter')
    if (fixtures.read === 'hydrating') {
      try {
        await forceMainGarbage(main)
      } catch (error) {
        throwWithDrive(error, drive)
      }
    }
    await visible(state.read === 'failed' ? 'Download failed' : 'Downloading…')
  }
  return drive
}

async function applyVariant(page, cdp, main, variant) {
  await main(`(() => { globalThis.__metisReHideElectron.nativeTheme.themeSource = ${JSON.stringify(variant.appearance)}; return true })()`)
  await page.emulateMedia({ colorScheme: variant.appearance, reducedMotion: variant.motion })
  const [r, g, b] = BACKDROPS[variant.appearance]
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r, g, b, a: 1 } })
}

/** One state in one variant. Never throws: a state that could not be reached or captured is a FAIL row. */
async function captureState({ page, cdp, main, state, variant, realRows, out }) {
  try {
    return await captureReachedState({ page, cdp, main, state, variant, realRows, out })
  } catch (error) {
    const drive = { ...(error.drive ?? {}), error: error.message }
    const judged = judgeCapture({ state, variant, collected: null, roles: [], tabOrder: null, drive })
    return {
      judged: {
        ...judged,
        bannerAfterMs: drive.bannerAfterMs ?? null,
        capturedAfterMs: drive.capturedAfterMs,
        driveTimingsMs: drive.timingsMs,
        requestChannels: drive.requestChannels,
        closedBeforeArm: drive.closedBeforeArm ?? null,
        tabOrder: null
      },
      screenshot: null
    }
  }
}

/**
 * The overlay window is content-sized: the renderer measures its root and main resizes the window to fit.
 * Waits, bounded, until the window holds the whole root, so a capture never judges a resize still in
 * flight; content that still overflows when the wait ends is left for the clipping check to fail.
 */
async function settleWindow(page) {
  await page
    .waitForFunction(
      () => {
        const root = document.getElementById('root')
        return Boolean(root) && root.scrollHeight <= root.clientHeight + 1
      },
      undefined,
      { polling: 'raf', timeout: SETTLE_TIMEOUT_MS }
    )
    .catch(() => undefined)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function captureReachedState({ page, cdp, main, state, variant, realRows, out }) {
  const screenshot = join(state.id, `${variant.id}.png`)
  let drive
  let collected
  // Width and height 0 leave the viewport the real window's, so the app's own content sizing still
  // applies at 2x (layout there can differ by a few pixels); only the device scale factor is emulated.
  await cdp.send('Emulation.setDeviceMetricsOverride', deviceMetricsForVariant(variant))
  try {
    drive = await driveState(page, main, state, realRows)
    await settleWindow(page)
    await page.screenshot({ path: join(out, screenshot), scale: 'device' })
    drive.capturedAfterMs = Date.now() - drive.requestedAt
    drive.timingsMs.requestToCapture = drive.capturedAfterMs
    collected = await page.evaluate(`(${collectHistoryView})(${solidGradientLayers})`)
  } finally {
    if (state.id === 'slow-with-rows') await clearHistorySearch(page).catch(() => undefined)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
  }
  const roles = await rolesPresent(page, state)
  let tabOrder = null
  if (variant.id === KEYBOARD_VARIANT_ID) {
    try {
      writeFileSync(join(out, state.id, 'aria.yml'), await page.locator('[data-history-design-root]').ariaSnapshot())
    } catch (error) {
      writeFileSync(join(out, state.id, 'aria.yml'), `# accessibility snapshot failed: ${error.message}\n`)
    }
    tabOrder = await walkTabOrder(page)
  }
  const judged = judgeCapture({ state, variant, collected, roles, tabOrder, drive })
  return {
    judged: {
      ...judged,
      scope: collected.scope,
      bannerAfterMs: drive.bannerAfterMs ?? null,
      capturedAfterMs: drive.capturedAfterMs,
      driveTimingsMs: drive.timingsMs,
      requestChannels: drive.requestChannels,
      closedBeforeArm: drive.closedBeforeArm,
      tabOrder
    },
    screenshot
  }
}

/**
 * One unjudged pass through the first fixture-driven History open, device-metrics override and screenshot.
 * It pays cold renderer costs before the judged matrix; nothing from this pass is written or judged, and a
 * failure here is left for the real capture to report.
 */
export async function warmUp({ page, cdp, main, realRows, deps = {} }) {
  const [variant] = DESIGN_VARIANTS
  try {
    await applyVariant(page, cdp, main, variant)
    await driveState(page, main, HISTORY_DESIGN_STATES[0], realRows, deps)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: variant.scale, mobile: false })
    await settleWindow(page)
    await page.screenshot({ scale: 'device' })
  } catch {
    // The matrix drives and judges every state from scratch.
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
  }
}

async function seedMeetings(page) {
  await page.evaluate(async (titles) => {
    const startedAt = Date.now()
    for (const [i, title] of titles.entries()) {
      await window.toto.saveTranscript({
        title,
        mode: 'meeting',
        startedAt: startedAt + i,
        durationMs: 60_000,
        lines: [{ speaker: 'them', text: `Synthetic ${title.toLowerCase()} line.`, t: 1 }],
        recap: `## Overview\n${title} recap.`,
        recapStatus: 'complete'
      })
    }
  }, SAMPLE_MEETINGS)
}

function summaryMarkdown(report) {
  const variants = DESIGN_VARIANTS.map((variant) => variant.id)
  const lines = [
    `# History design evidence (M2-0032): ${report.verdict}`,
    '',
    `App ${report.app?.version ?? 'unknown'} on ${report.app?.platform ?? process.platform}. Backdrops: light ${BACKDROPS.light.join(',')}, dark ${BACKDROPS.dark.join(',')}.`,
    '',
    `| state | ${variants.join(' | ')} |`,
    `|---|${variants.map(() => '---').join('|')}|`
  ]
  for (const state of HISTORY_DESIGN_STATES) {
    const cells = variants.map((id) => report.captures.find((c) => c.state === state.id && c.variant === id)?.verdict ?? 'NOT_RUN')
    lines.push(`| ${state.id} | ${cells.join(' | ')} |`)
  }
  lines.push('', `History transitions recorded by the renderer: ${report.transitions.length}.`, '')
  for (const capture of report.captures.filter((c) => c.verdict !== 'PASS')) lines.push(`- ${capture.state} / ${capture.variant}: ${capture.problems.join('; ')}`)
  for (const row of report.blockedExternal) lines.push(`- ${row.row}: ${row.verdict}. ${row.unblockStep}`)
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args || (process.platform !== 'darwin' && process.platform !== 'win32')) {
    console.error('usage: node scripts/qa/history-design-capture.mjs <installed .app | Metis.exe> [--out <dir>]')
    return 2
  }
  mkdirSync(args.out, { recursive: true })
  for (const state of HISTORY_DESIGN_STATES) mkdirSync(join(args.out, state.id), { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'metis-history-design-'))
  writeFileSync(join(profile, 'settings.json'), `${JSON.stringify({ ...NAVIGATION_GUARD_BOOTSTRAP_PATCH, onboardingDoneAt: Date.now() })}\n`, { mode: 0o600 })
  const captures = []
  let harnessError = null
  let child = null
  let browser = null
  let inspector = null
  try {
    const port = await freeLoopbackPort()
    const inspectPort = await freeLoopbackPort()
    const env = { ...process.env, ASKTOTO_USERDATA: profile }
    for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]
    child = spawn(executableOf(args.target), [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectPort}`], { env, stdio: 'ignore' })
    child.once('error', (error) => {
      harnessError ??= `spawn failed: ${error.message}`
    })
    await waitForRendererReady(profile, child)
    inspector = await mainInspector(inspectPort)
    const main = inspector.evaluate
    main.collectGarbage = inspector.collectGarbage
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 })
    const page = await findOverlayPage(browser, 30_000)
    if (!isOverlayUrl(page.url())) throw new Error('the attached page is not the overlay')
    await assertAttachedAppIsSandboxed(page)
    await main(REVEAL_OVERLAY)
    await page.getByRole('button', { name: 'History' }).first().waitFor({ timeout: STATE_TIMEOUT_MS })
    await seedMeetings(page)
    await ensureIdleBar(page)
    await clickHistory(page)
    const realRows = await page.evaluate(() => window.toto.recallList())
    if (!realRows.some((row) => row.title === SAMPLE_MEETINGS[0])) throw new Error('the saved sample meetings are not listed')
    await main(INSTALL_FIXTURE_HANDLERS)
    const cdp = await page.context().newCDPSession(page)
    await warmUp({ page, cdp, main, realRows })
    for (const variant of DESIGN_VARIANTS) {
      await applyVariant(page, cdp, main, variant)
      for (const state of HISTORY_DESIGN_STATES) {
        const { judged, screenshot } = await captureState({ page, cdp, main, state, variant, realRows, out: args.out })
        captures.push({ ...judged, screenshot })
        console.log(`[history-design] ${state.id} / ${variant.id}: ${judged.verdict}${judged.problems.length ? ` (${judged.problems.join('; ')})` : ''}`)
      }
    }
    // The product's own Quit; the page may close before this evaluation answers.
    await page
      .evaluate(() => {
        void window.toto.quit()
      })
      .catch(() => undefined)
  } catch (error) {
    harnessError ??= error.message
    console.error(`[history-design] ${error.stack ?? error.message}`)
  } finally {
    await browser?.close().catch(() => undefined)
    inspector?.close()
    if (child) {
      const deadline = Date.now() + QUIT_TIMEOUT_MS
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(250)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
  const audit = readAudit(profile)
  rmSync(profile, { recursive: true, force: true })
  const started = audit.find((record) => record.event === 'app.started')
  const transitions = historyTransitions(audit)
  const expected = HISTORY_DESIGN_STATES.length * DESIGN_VARIANTS.length
  const report = {
    schema: 1,
    ticket: 'M2-0032',
    verdict: harnessError ? 'INCOMPLETE' : designVerdict({ captures, transitions, expected }),
    harnessError,
    app: started ? { version: started.version ?? null, platform: started.platform ?? null, arch: started.arch ?? null } : null,
    states: HISTORY_DESIGN_STATES.map(({ id, title, list, search, read }) => ({ id, title, list, search: search ?? null, read: read ?? null })),
    variants: DESIGN_VARIANTS,
    backdrops: BACKDROPS,
    sources: {
      rows: 'real meetings saved through window.toto.saveTranscript and listed by the real recallList',
      fixtures: "slow, failed, cloud-only and unreadable answers served by History's own IPC channels, replaced in main through the inspector"
    },
    rootCause:
      'Pending list/search/read fixture answers must stay strongly referenced; otherwise main-process GC can collect Electron IPC reply state for a never-settling answer, reject the renderer invoke, and show the failed History alert before the slow cue.',
    guard:
      'After each pending fixture request reaches main, the harness forces HeapProfiler.collectGarbage through the main-process inspector; a collectable pending answer fails the capture instead of being hidden by timing.',
    expectedCaptures: expected,
    captures,
    transitions,
    blockedExternal: BLOCKED_EXTERNAL_ROWS,
    validation: 'Pending: an Opus session other than the implementer checks these captures against the design spec.'
  }
  writeFileSync(join(args.out, 'history-design-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(args.out, 'SUMMARY.md'), summaryMarkdown(report))
  console.log(`[history-design] ${report.verdict}: ${captures.filter((c) => c.verdict === 'PASS').length}/${expected} captures passed, ${transitions.length} History transitions`)
  return report.verdict === 'PASS' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[history-design] ${error.stack ?? error.message}`)
      process.exit(1)
    }
  )
}
