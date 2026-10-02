/**
 * Packaged overlay-stability rows (OV-*, M2-0431, split out by M2-0410). They reuse the right-edge
 * main-process cursor shim and inspector so packaged-smoke keeps orchestration only.
 */
import { sleep } from '../lib/app-driver.mjs'
import {
  MAIN_RE_HIDE_SHIM,
  MAIN_RE_HIDE_SNAPSHOT,
  mainInspector,
  pinnedBridgeCall,
  setMainCursor
} from './right-edge-hide-rows.mjs'
import { withOverlayPage } from './navigation-guard-rows.mjs'
import { parseAuditLog, readAuditLog } from './smoke-support.mjs'

export const OVERLAY_STABILITY_SCENARIOS = Object.freeze([{ id: 'OV-STABLE' }, { id: 'OV-BG' }])
export const OV_STABLE_PATH_MS = 180_000
const OV_STOP_MS = 400
const OV_MENU_BAR_STOPS_X = Object.freeze([24, 1253, 1770])
const OV_REFERENCE_WIDTH = 1920
/** src/main/island/geometry.ts TOP_CENTER_HOVER_HALF_WIDTH_PX (OD-23) plus clearance: a stop never grazes the notch area. */
const OV_NOTCH_HALF_WIDTH = 150
const OV_NOTCH_CLEARANCE = 60
const OV_HOVER_HOLD_MS = 2_500
const OV_TRANSPARENT_READBACK = new Set(['#000000', '#00000000'])
const OV_REST_BACKGROUND = '#00000000'

export function initialOverlayStabilityRows() {
  return OVERLAY_STABILITY_SCENARIOS.map((scenario) => ({ id: scenario.id, status: 'PENDING', evidence: null, unblock: null }))
}

export function overlayStablePath(displayBounds, workArea) {
  const centerX = workArea.x + Math.round(workArea.width / 2)
  const minFromCenter = OV_NOTCH_HALF_WIDTH + OV_NOTCH_CLEARANCE
  const outsideNotch = (x) => (Math.abs(x - centerX) >= minFromCenter ? x : centerX + (x < centerX ? -minFromCenter : minFromCenter))
  const onDisplay = (x) => Math.min(displayBounds.x + displayBounds.width - 1, Math.max(displayBounds.x, x))
  const right = displayBounds.x + displayBounds.width
  const bandY = workArea.y + Math.round(workArea.height * 0.35)
  return [
    ...OV_MENU_BAR_STOPS_X.map((x) => ({
      label: `menu-bar-${x}`,
      point: { x: onDisplay(outsideNotch(displayBounds.x + Math.round((x * displayBounds.width) / OV_REFERENCE_WIDTH))), y: displayBounds.y + 8 },
      ms: OV_STOP_MS
    })),
    { label: 'right-edge-band', point: { x: right - 1, y: bandY }, ms: OV_STOP_MS },
    { label: 'right-edge-approach', point: { x: right - 200, y: bandY }, ms: OV_STOP_MS },
    { label: 'desktop-center', point: { x: centerX, y: workArea.y + Math.round(workArea.height / 2) }, ms: OV_STOP_MS },
    { label: 'desktop-bottom-left', point: { x: workArea.x + 40, y: workArea.y + workArea.height - 40 }, ms: OV_STOP_MS }
  ]
}

const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
const sameSize = (a, b, tolerance = 2) => Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
const surfaceShown = (state) => state.visible && state.opacity > 0

export function overlaySurfaceChanges(events) {
  const target = new Map()
  for (const event of events) target.set(event.turn, event.after.bounds)
  let reveals = 0
  let parks = 0
  for (const event of events) {
    if (!surfaceShown(event.before) && surfaceShown(event.after)) reveals += 1
    if (surfaceShown(event.before) && !surfaceShown(event.after)) parks += 1
  }
  return {
    changes: events.filter(
      (e) => !sameRect(e.before.bounds, e.after.bounds) || e.before.opacity !== e.after.opacity || e.before.visible !== e.after.visible
    ).length,
    reveals,
    parks,
    opacityBeforeTarget: events.filter((e) => e.after.visible && e.after.opacity === 1 && !sameSize(e.after.bounds, target.get(e.turn))).length,
    slabBeforeResize: events.filter(
      (e) => e.call === 'setBackgroundColor' && e.arg !== OV_REST_BACKGROUND && !sameSize(e.after.bounds, target.get(e.turn))
    ).length
  }
}

const MAIN_OV_RECORDER = `(() => {
  const { BrowserWindow } = globalThis.__metisReHideElectron
  const rec = (globalThis.__metisOv ??= { events: [], turn: 0, turnOpen: false, recording: false, requestedBackground: null })
  const w = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed() && /\\/renderer\\/index\\.html/.test(c.webContents.getURL()))
  if (!w) return false
  if (w.__metisOvWrapped) return true
  w.__metisOvWrapped = true
  const state = () => ({ bounds: w.getBounds(), opacity: w.getOpacity(), visible: w.isVisible() })
  for (const call of ['setBounds', 'setPosition', 'setSize', 'setOpacity', 'show', 'showInactive', 'hide', 'setBackgroundColor']) {
    const original = w[call].bind(w)
    w[call] = (...args) => {
      const before = state()
      const result = original(...args)
      const arg = call === 'setBackgroundColor' ? String(args[0]).toLowerCase() : call === 'setOpacity' ? args[0] : null
      if (call === 'setBackgroundColor') rec.requestedBackground = arg
      if (rec.recording) {
        if (!rec.turnOpen) {
          rec.turnOpen = true
          rec.turn += 1
          setImmediate(() => { rec.turnOpen = false })
        }
        rec.events.push({ turn: rec.turn, call, arg, before, after: state() })
      }
      return result
    }
  }
  return true
})()`

const mainOvRecording = (on) =>
  `(() => { const rec = globalThis.__metisOv; rec.recording = ${on ? 'true' : 'false'}; const events = rec.events; if (${on ? 'true' : 'false'}) rec.events = []; return events })()`

const MAIN_OV_BACKGROUND = `(() => {
  const { BrowserWindow } = globalThis.__metisReHideElectron
  const w = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed() && /\\/renderer\\/index\\.html/.test(c.webContents.getURL()))
  return w ? { readback: w.getBackgroundColor().toLowerCase(), requested: globalThis.__metisOv?.requestedBackground ?? null } : null
})()`

/**
 * Runs the OV rows against a live overlay (same `main`/`page` contract as runRightEdgeHideRows). `flashCount`
 * reads how many `overlay.flash` audit records the app has written so far. `openSettings` drives the app's own
 * main-process Settings entry (the tray click → sendHotkey('settings') in src/main/index.ts), so OV-BG covers
 * applySettingsSurface's resize and background order, not only the renderer's view switch; it resolves false
 * when that entry is unavailable. Rows never throw.
 */
export async function runOverlayStabilityRows({ page, main, openSettings, rows, flashCount = () => 0, wait = sleep, pathMs = OV_STABLE_PATH_MS }) {
  const complete = (id, patch) => {
    const row = rows.find((entry) => entry.id === id)
    if (row) Object.assign(row, patch)
  }
  const snapshot = () => main(MAIN_RE_HIDE_SNAPSHOT)
  const setCursor = (point) => main(setMainCursor(point))
  const waitUntil = async (predicate, timeoutMs) => {
    const started = Date.now()
    let observed = await snapshot()
    while (!(observed && predicate(observed)) && Date.now() - started < timeoutMs) {
      await wait(50)
      observed = await snapshot()
    }
    return { ok: Boolean(observed && predicate(observed)), observed, ms: Date.now() - started }
  }
  const parkedHide = (o) => o.visible && o.opacity === 0
  const revealedHide = (o) => o.visible && o.opacity === 1
  const step = async (id, fn) => {
    try {
      const outcome = await fn()
      complete(id, { status: outcome.pass ? 'PASS' : 'FAIL', evidence: outcome.evidence, unblock: outcome.pass ? null : 'Inspect the packaged-smoke artifact; the OV evidence shows the recorded native surface calls.' })
    } catch (err) {
      complete(id, { status: 'FAIL', evidence: null, unblock: `Inspect the packaged-smoke artifact; OV scenario failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 700)}` })
    }
  }

  await main(MAIN_RE_HIDE_SHIM)
  const first = await snapshot()
  if (!first) {
    for (const row of rows) complete(row.id, { status: 'FAIL', evidence: null, unblock: 'Inspect the packaged-smoke artifact; overlay window not found in the main process.' })
    return
  }
  const { displayBounds, workArea } = first
  const away = { x: workArea.x + Math.round(workArea.width / 2), y: workArea.y + Math.round(workArea.height * 0.6) }
  const notch = { x: workArea.x + Math.round(workArea.width / 2), y: displayBounds.y + 2 }
  const path = overlayStablePath(displayBounds, workArea)

  await step('OV-STABLE', async () => {
    await setCursor(away)
    await page.evaluate(pinnedBridgeCall, ['setSettings', [{ overlayPlacement: 'top-center', overlayLayout: 'hide', autoHideOverlay: true }]])
    const settingsDeadline = Date.now() + 10_000
    let applied = false
    while (!applied && Date.now() < settingsDeadline) {
      applied = await page.evaluate(async () => {
        const settings = await window.toto.getSettings()
        return settings.overlayPlacement === 'top-center' && settings.overlayLayout === 'hide' && settings.autoHideOverlay === true
      }).catch(() => false)
      if (!applied) await wait(100)
    }
    if (!applied) throw new Error('top-center Hide settings were not applied')
    await wait(1_000)
    if (!parkedHide(await snapshot())) {
      await page.evaluate(pinnedBridgeCall, ['parkAfterHide', [true]])
    }
    const parked = await waitUntil(parkedHide, 5_000)
    if (!parked.ok) throw new Error(`top-center Hide did not park: ${JSON.stringify(parked.observed)}`)
    await main(MAIN_OV_RECORDER)

    const flashesBefore = flashCount()
    await main(mainOvRecording(true))
    const started = Date.now()
    let cycles = 0
    while (Date.now() - started < pathMs) {
      for (const stop of path) {
        await setCursor(stop.point)
        await wait(stop.ms)
      }
      cycles += 1
    }
    const walkedMs = Date.now() - started
    const pathSurface = overlaySurfaceChanges(await main(mainOvRecording(false)))
    const flashesOnPath = flashCount() - flashesBefore

    await main(mainOvRecording(true))
    await setCursor(notch)
    const revealed = await waitUntil(revealedHide, 3_000)
    await wait(OV_HOVER_HOLD_MS)
    await setCursor(away)
    const parkedAgain = await waitUntil(parkedHide, 5_000)
    await wait(1_500)
    const hoverSurface = overlaySurfaceChanges(await main(mainOvRecording(false)))

    return {
      pass:
        pathSurface.changes === 0 &&
        pathSurface.opacityBeforeTarget === 0 &&
        flashesOnPath === 0 &&
        revealed.ok &&
        parkedAgain.ok &&
        hoverSurface.reveals === 1 &&
        hoverSurface.parks === 1 &&
        hoverSurface.opacityBeforeTarget === 0,
      evidence: {
        walkedMs,
        cycles,
        stops: path.map((stop) => ({ label: stop.label, point: stop.point, ms: stop.ms })),
        path: pathSurface,
        flashesOnPath,
        notchHover: { point: notch, revealedAfterMs: revealed.ok ? revealed.ms : null, parkedAfterLeaveMs: parkedAgain.ok ? parkedAgain.ms : null, ...hoverSurface }
      }
    }
  })

  await step('OV-BG', async () => {
    await setCursor(away)
    await main(MAIN_OV_RECORDER)
    const before = await main(MAIN_OV_BACKGROUND)
    await main(mainOvRecording(true))
    if (!(await openSettings())) throw new Error('the Metis tray was not found to open Settings through the main process')
    const sections = page.locator('[aria-label="Settings sections"]')
    await sections.waitFor({ state: 'visible', timeout: 10_000 })
    await wait(500)
    const open = await main(MAIN_OV_BACKGROUND)
    await page.getByRole('button', { name: 'Close settings' }).click({ timeout: 5_000 })
    await sections.waitFor({ state: 'hidden', timeout: 10_000 })
    await wait(1_000)
    const after = await main(MAIN_OV_BACKGROUND)
    const events = await main(mainOvRecording(false))
    const surface = overlaySurfaceChanges(events)
    return {
      pass:
        OV_TRANSPARENT_READBACK.has(before?.readback) &&
        OV_TRANSPARENT_READBACK.has(after?.readback) &&
        after?.requested === OV_REST_BACKGROUND &&
        surface.slabBeforeResize === 0 &&
        surface.opacityBeforeTarget === 0,
      evidence: {
        afterOnboarding: before,
        settingsOpen: open,
        afterSettingsClose: after,
        slabBeforeResize: surface.slabBeforeResize,
        opacityBeforeTarget: surface.opacityBeforeTarget,
        calls: events.slice(0, 60).map((e) => ({ turn: e.turn, call: e.call, arg: e.arg, bounds: e.after.bounds, opacity: e.after.opacity }))
      }
    }
  })

  await setCursor(null).catch(() => undefined)
}

export async function runPackagedOverlayStabilityRows({ port, inspectPort, auditLogPath, rows }) {
  let inspector = null
  try {
    inspector = await mainInspector(inspectPort)
  } catch (err) {
    for (const row of rows) {
      Object.assign(row, { status: 'FAIL', evidence: null, unblock: `Inspect the packaged-smoke artifact; ${err?.message ?? String(err)}` })
    }
    return
  }
  const flashCount = () => parseAuditLog(readAuditLog(auditLogPath)).filter((record) => record.event === 'overlay.flash').length
  try {
    await withOverlayPage(port, (page) =>
      runOverlayStabilityRows({ page, main: inspector.evaluate, openSettings: inspector.clickTray, rows, flashCount })
    )
  } finally {
    inspector.close()
  }
}
