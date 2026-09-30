/**
 * The packaged right-edge Hide rows (RE-HIDE-*, M2-0428, split out by M2-0410). They switch the live app to
 * the right-edge placement and prove Hide/Island park and reveal from the screen edge. The rows drive main's
 * cursor watch by stubbing `screen.getCursorScreenPoint` inside the main process, and read the click-through
 * flag by wrapping `win.setIgnoreMouseEvents` (Electron has no getter). Hosted runners have no pointer to
 * move, and moving the real one would not be deterministic. Geometry mirrors src/main/island/geometry.ts for
 * a fresh profile (normalized sidecar Y 0.2). See the header of ../packaged-smoke.mjs.
 */
import { sleep } from '../lib/app-driver.mjs'
import { withOverlayPage } from './navigation-guard-rows.mjs'

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

/** Installs (idempotently) the cursor stub and the click-through capture on every live window. */
const MAIN_RE_HIDE_SHIM = `(() => {
  const { screen, BrowserWindow } = globalThis.__metisReHideElectron
  const state = (globalThis.__metisReHide ??= { cursor: null, clickThrough: new WeakMap() })
  if (!state.realCursor) {
    state.realCursor = screen.getCursorScreenPoint.bind(screen)
    screen.getCursorScreenPoint = () => state.cursor ?? state.realCursor()
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.__metisReHideWrapped) continue
    const setIgnoreMouseEvents = w.setIgnoreMouseEvents.bind(w)
    w.__metisReHideWrapped = true
    w.setIgnoreMouseEvents = (ignore, options) => {
      state.clickThrough.set(w, ignore === true)
      return setIgnoreMouseEvents(ignore, options)
    }
  }
  return true
})()`

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
    await hideControl().click({ timeout: 5_000 })
    const parked = await waitUntil((o) => rightEdgeStateMatches(o, 'parked', 'hide'), 3_000)
    return { pass: hideVisible && parked.ok, evidence: { meetingLive: true, hideVisible, parked: summarize(parked.observed) } }
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

export async function runPackagedRightEdgeHideRows({ port, inspectPort, rows }) {
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
