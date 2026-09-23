// Visual end-to-end smoke test for the built, unpackaged Métis app.
// It deliberately starts the project root (not out/main/index.js) so Electron reads package.json's
// `main`, uses a disposable profile, and drives the same onboarding a new user sees.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const APP_EXECUTABLE = process.env.E2E_APP_EXECUTABLE ? resolve(process.env.E2E_APP_EXECUTABLE) : null
const SHOT_DIR = process.env.E2E_SHOT_DIR || '/tmp'
const OWN_PROCESS_TIMEOUT_MS = 5_000
const RIGHT_EDGE_MARGIN_PX = 12
const RIGHT_EDGE_TAB = { width: 52, height: 52 }
const RIGHT_EDGE_DRAWER = { width: 360, height: 560 }
const TOP_CENTER_MARGIN_PX = 8
const TOP_CENTER_BAR_WIDTH = 880
// This response deliberately contains the three shapes that previously made the narrow right-edge
// drawer look broken: a long unbroken prose token, a wide code line, and a wide markdown table. It is
// delivered through the normal ask IPC/stream lifecycle by an isolated test-only main-process handler;
// no network provider or user credential is involved.
const SIDECAR_LONG_RESPONSE = [
  '## Sidecar layout check',
  `The sidecar must wrap this unbroken token without widening: ${'metisrightedge'.repeat(72)}`,
  '```ts\nconst deliberatelyWideCodeLine = "' + 'sidecar-code'.repeat(54) + '"\n```',
  '| Surface | Required behavior | Regression payload |',
  '| --- | --- | --- |',
  `| Composer | Stays anchored | ${'table-cell'.repeat(42)} |`
].join('\n\n')
const steps = []
const rendererDiagnostics = []
const watchedPages = new WeakSet()
let userDataDir = mkdtempSync(join(tmpdir(), 'metis-e2e-'))
let app
let win

mkdirSync(SHOT_DIR, { recursive: true })

function builtArtifactPaths() {
  if (!APP_EXECUTABLE) {
    // Electron executes all three of these from the project root. Checking only the renderer made a
    // renderer-only rebuild look fresh even when the main IPC or preload bridge under test was stale.
    return [
      join(ROOT, 'out', 'renderer', 'index.html'),
      join(ROOT, 'out', 'main', 'index.js'),
      join(ROOT, 'out', 'preload', 'index.js')
    ]
  }
  // electron-builder keeps the runtime at Contents/MacOS/<name> on macOS and beside resources/ on
  // Windows. The asar contains the renderer/main code, unlike the copied Electron executable itself.
  return [
    APP_EXECUTABLE.includes('/Contents/MacOS/')
      ? resolve(dirname(APP_EXECUTABLE), '..', 'Resources', 'app.asar')
      : resolve(dirname(APP_EXECUTABLE), 'resources', 'app.asar')
  ]
}

function assertFreshBuild() {
  const artifacts = builtArtifactPaths()
  const missing = artifacts.filter((artifact) => !existsSync(artifact))
  if (missing.length > 0) {
    throw new Error(`Cannot verify the current build: expected ${APP_EXECUTABLE ? 'packaged app.asar' : 'renderer, main, and preload output'} at ${missing.join(', ')}.`)
  }
  const sources = [
    join(ROOT, 'src', 'renderer', 'src', 'App.tsx'),
    join(ROOT, 'src', 'renderer', 'src', 'components', 'RightEdgeSidecar.tsx'),
    join(ROOT, 'src', 'renderer', 'src', 'components', 'OnboardingExperience.tsx'),
    join(ROOT, 'src', 'renderer', 'src', 'components', 'OnboardingAppearance.tsx'),
    join(ROOT, 'src', 'renderer', 'src', 'components', 'OverlayChromePicker.tsx'),
    join(ROOT, 'src', 'renderer', 'src', 'components', 'OverlayPlacementPicker.tsx'),
    join(ROOT, 'src', 'renderer', 'src', 'lib', 'onboarding-appearance.ts'),
    join(ROOT, 'src', 'renderer', 'src', 'lib', 'overlay-motion.ts'),
    join(ROOT, 'src', 'shared', 'overlay-chrome.ts'),
    join(ROOT, 'src', 'shared', 'overlay-placement.ts'),
    join(ROOT, 'src', 'shared', 'overlay-presentation.ts'),
    join(ROOT, 'src', 'renderer', 'src', 'styles.css'),
    join(ROOT, 'src', 'main', 'index.ts'),
    join(ROOT, 'src', 'main', 'island', 'geometry.ts'),
    join(ROOT, 'src', 'preload', 'index.ts')
  ]
  const newestSource = Math.max(...sources.map((path) => statSync(path).mtimeMs))
  const staleArtifacts = artifacts.filter((artifact) => statSync(artifact).mtimeMs < newestSource)
  if (staleArtifacts.length > 0) {
    throw new Error(`Refusing stale E2E evidence: ${staleArtifacts.join(', ')} predates the edited right-edge source. Rebuild/package before running this smoke test.`)
  }
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
const ok = (name) => { steps.push({ name, ok: true }); console.log(`  ✓ ${name}`) }
const fail = (name, error) => {
  const message = String(error?.message || error)
  steps.push({ name, ok: false, err: message })
  console.log(`  ✗ ${name} — ${message}`)
}

function withTimeout(operation, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer))
}

function watchPage(page) {
  if (watchedPages.has(page)) return
  watchedPages.add(page)
  page.on('console', (message) => {
    if (message.type() === 'error') rendererDiagnostics.push(message.text())
  })
  page.on('pageerror', (error) => rendererDiagnostics.push(error.stack || error.message))
  page.on('crash', () => rendererDiagnostics.push('renderer process crashed'))
}

async function latestMétisWindow({ onboardingDone } = {}) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const candidates = app?.windows?.() || []
    for (const candidate of [...candidates].reverse()) {
      watchPage(candidate)
      try {
        const matches = await candidate.evaluate(async (requireDone) => {
          if (!window.toto) return false
          if (requireDone === undefined) return true
          return (await window.toto.getSettings()).onboardingDone === requireDone
        }, onboardingDone)
        if (matches) return candidate
      } catch {
        // This is expected while the opaque onboarding window is being replaced.
      }
    }
    await delay(150)
  }
  throw new Error(`No ${onboardingDone === undefined ? 'Métis' : onboardingDone ? 'completed' : 'onboarding'} window appeared within 15s.`)
}

async function bodyText() {
  try {
    return (await win.locator('body').innerText()).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

async function screenshot(name) {
  const path = join(SHOT_DIR, `e2e-${name}.png`)
  await win.screenshot({ path })
  if (statSync(path).size === 0) throw new Error(`Screenshot ${name} was empty.`)
}

async function assertOpaqueOnboardingStage(phase) {
  const stage = win.locator('.onboard-stage').first()
  await stage.waitFor({ state: 'visible', timeout: 5_000 })
  const state = await stage.evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      background: style.backgroundColor,
      opacity: style.opacity,
      animation: style.animationName,
      mask: style.getPropertyValue('mask-image').trim(),
      webkitMask: style.getPropertyValue('-webkit-mask-image').trim(),
      coversViewport:
        rect.left <= 0 && rect.top <= 0 && rect.right >= window.innerWidth && rect.bottom >= window.innerHeight
    }
  })
  if (state.background !== 'rgb(5, 1, 10)' || state.opacity !== '1' || !state.coversViewport) {
    throw new Error(`Onboarding stage background is not opaque during ${phase}: ${JSON.stringify(state)}`)
  }
  if (![state.mask, state.webkitMask].every((mask) => mask === '' || mask === 'none')) {
    throw new Error(`Onboarding stage still has a mask during ${phase}: ${JSON.stringify(state)}`)
  }
  if (state.animation !== 'none') {
    throw new Error(`Onboarding stage is still animating during ${phase}: ${JSON.stringify(state)}`)
  }
  ok(`onboarding stage stays opaque ${phase}`)
}

async function waitFor(check, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(150)
  }
  throw new Error(`${message}${lastError ? ` (${lastError.message || lastError})` : ''}`)
}

async function overlayWindowGeometry() {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (!window) return null
    const bounds = window.getBounds()
    return { bounds, workArea: screen.getDisplayMatching(bounds).workArea }
  })
}

function rightEdgeExpectedSize(workArea, open) {
  return open
    ? {
        width: RIGHT_EDGE_DRAWER.width,
        height: Math.min(RIGHT_EDGE_DRAWER.height, Math.max(RIGHT_EDGE_TAB.height, workArea.height - RIGHT_EDGE_MARGIN_PX * 2))
      }
    : RIGHT_EDGE_TAB
}

async function verifyNativeRightEdgeBounds(open, phase) {
  const geometry = await waitFor(async () => {
    const candidate = await overlayWindowGeometry()
    if (!candidate) return null
    const expected = rightEdgeExpectedSize(candidate.workArea, open)
    const edgeGap = candidate.workArea.x + candidate.workArea.width - (candidate.bounds.x + candidate.bounds.width)
    const correctSize = candidate.bounds.width === expected.width && candidate.bounds.height === expected.height
    const correctRightEdge = Math.abs(edgeGap - RIGHT_EDGE_MARGIN_PX) <= 2
    const inWorkArea = candidate.bounds.y >= candidate.workArea.y && candidate.bounds.y + candidate.bounds.height <= candidate.workArea.y + candidate.workArea.height
    return correctSize && correctRightEdge && inWorkArea ? candidate : null
  }, `Right-edge native window did not reach its ${open ? '360px drawer' : '52px rail'} bounds after ${phase}.`)

  const expected = rightEdgeExpectedSize(geometry.workArea, open)
  ok(`right-edge native ${open ? 'drawer' : 'rail'} bounds are ${expected.width}×${expected.height} after ${phase}`)
  return geometry
}

async function settingsMatch(expected) {
  return waitFor(
    async () => {
      const settings = await win.evaluate(() => window.toto.getSettings())
      return Object.entries(expected).every(([key, value]) => settings[key] === value)
    },
    `Settings did not persist ${JSON.stringify(expected)}`
  )
}

function sameBounds(actual, expected) {
  return actual.x === expected.x && actual.y === expected.y && actual.width === expected.width && actual.height === expected.height
}

async function onboardingNativeGeometry() {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const overlay = BrowserWindow.getAllWindows()
      .filter((candidate) => !candidate.isDestroyed() && candidate.isVisible())
      .sort((a, b) => b.id - a.id)[0]
    if (!overlay) return null
    const bounds = overlay.getBounds()
    const display = screen.getDisplayMatching(bounds)
    return { bounds, displayBounds: display.bounds, workArea: display.workArea, displayId: display.id }
  })
}

/**
 * Record the exact native boundary where the former transparent overlay closes. A later screenshot only
 * proves the settled result; this proves the opaque, edge-to-edge successor already existed when desktop
 * could otherwise have been exposed. The trace lives only in the Electron main process used by this smoke.
 */
async function armReplayOpaqueCoverageTrace() {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const old = BrowserWindow.getAllWindows()
      .filter((candidate) => !candidate.isDestroyed() && candidate.isVisible())
      .sort((a, b) => b.id - a.id)[0]
    if (!old) throw new Error('No visible Settings overlay is available for the replay handoff trace.')
    const oldBounds = old.getBounds()
    const trace = { oldId: old.id, oldDisplayBounds: screen.getDisplayMatching(oldBounds).bounds, closed: null }
    globalThis.__metisReplayOpaqueCoverageTrace = trace
    old.once('closed', () => {
      trace.closed = {
        oldDisplayBounds: trace.oldDisplayBounds,
        windows: BrowserWindow.getAllWindows()
          .filter((candidate) => !candidate.isDestroyed())
          .map((candidate) => {
            const bounds = candidate.getBounds()
            return {
              id: candidate.id,
              visible: candidate.isVisible(),
              bounds,
              displayBounds: screen.getDisplayMatching(bounds).bounds,
              background: candidate.getBackgroundColor(),
              opacity: candidate.getOpacity()
            }
          })
      }
    })
    return old.id
  })
}

async function assertReplayOpaqueCoverage(oldId) {
  const trace = await waitFor(
    () => app.evaluate(() => globalThis.__metisReplayOpaqueCoverageTrace?.closed ?? null),
    'The retiring Settings overlay did not emit its native close handoff trace.'
  )
  const successor = trace.windows.find((candidate) => {
    const background = String(candidate.background || '').toLowerCase()
    const opaqueOnboardingBackground = background === '#05010a' || background === '#ff05010a'
    return (
      candidate.id !== oldId &&
      candidate.visible &&
      sameBounds(candidate.bounds, trace.oldDisplayBounds) &&
      opaqueOnboardingBackground &&
      candidate.opacity === 1
    )
  })
  if (!successor) {
    throw new Error(`The transparent Settings overlay closed without an opaque full-display successor on its own display: ${JSON.stringify(trace)}`)
  }
  ok('Settings replay closes only after its opaque full-display successor is visible')
}

async function assertExclusiveOnboardingNativeBounds(phase) {
  const geometry = await waitFor(async () => {
    const candidate = await onboardingNativeGeometry()
    return candidate && sameBounds(candidate.bounds, candidate.displayBounds) ? candidate : null
  }, `Onboarding native window did not fill its display ${phase}.`)
  ok(`onboarding native window fills its display ${phase}`)
  return geometry
}

async function simulateNativeOnboardingClampAndRequireRecovery(phase) {
  // Inject after the two-second startup watcher expires. A fresh windowMode call would rearm that
  // watcher and hide a late compositor regression instead of testing the native geometry guard.
  await delay(2_500)
  const result = await app.evaluate(({ BrowserWindow, screen }) => {
    const overlay = BrowserWindow.getAllWindows()
      .filter((candidate) => !candidate.isDestroyed() && candidate.isVisible())
      .sort((a, b) => b.id - a.id)[0]
    if (!overlay) throw new Error('No visible onboarding BrowserWindow is available for the clamp recovery check.')
    const display = screen.getDisplayMatching(overlay.getBounds())
    const insetX = Math.max(1, Math.min(80, Math.floor(display.bounds.width / 8)))
    const insetY = Math.max(1, Math.min(60, Math.floor(display.bounds.height / 8)))
    const clamped = {
      x: display.bounds.x + insetX,
      y: display.bounds.y + insetY,
      width: Math.max(1, display.bounds.width - insetX * 2),
      height: Math.max(1, display.bounds.height - insetY * 2)
    }
    overlay.setBounds(clamped, false)
    return { clamped, after: overlay.getBounds(), displayBounds: display.bounds }
  })

  if (sameBounds(result.after, result.displayBounds)) {
    throw new Error(`Could not inject an inset native-window clamp for ${phase}: ${JSON.stringify(result)}`)
  }
  await delay(400)
  await assertExclusiveOnboardingNativeBounds(`after recovering from an injected native clamp (${phase})`)
  ok(`onboarding reconciles an injected native clamp ${phase}`)
}

async function verifyRightEdgeOnboardingPreview(expectedLayout, screenshotName) {
  const preview = win.locator('[data-placement-preview="right-edge"]').first()
  await preview.waitFor({ state: 'visible', timeout: 5_000 })
  await waitFor(
    async () => (await preview.getAttribute('data-appearance-preview')) === expectedLayout,
    `Right-edge preview did not render the expected ${expectedLayout} layout.`
  )
  await waitFor(
    async () => (await preview.getAttribute('data-appearance-phase')) === 'rest',
    'Right-edge preview did not settle at rest before interaction.'
  )

  const previewRail = preview.locator('[data-edge-tab="true"]')
  const previewGlow = preview.locator('[data-edge-glow="true"]')
  if (expectedLayout === 'island') {
    await previewRail.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
      throw new Error('Right-edge Island preview did not render its compact rail.')
    })
    if (await previewGlow.count()) throw new Error('Right-edge Island preview rendered a Hidden edge glow at rest.')
  } else {
    if (await previewRail.count()) throw new Error('Right-edge Hidden preview rendered a visible rail at rest.')
    await previewGlow.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
      throw new Error('Right-edge Hidden preview did not render its faint edge glow.')
    })
  }
  if (await preview.locator('[data-edge-drawer="true"]').count()) {
    throw new Error('Right-edge preview rendered a drawer before it was hovered.')
  }

  const previewHit = preview.locator('.onboard-appearance-preview__hit')
  await previewHit.hover({ timeout: 5_000 })
  const previewDrawer = preview.locator('[data-edge-drawer="true"]')
  await previewDrawer.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
    throw new Error('Right-edge preview did not reveal its drawer on rail hover.')
  })
  // The drawer uses a transform-only entrance. Measure after it settles, otherwise its temporary
  // +12px translation would falsely look like a detached right edge.
  await waitFor(
    async () => (await preview.getAttribute('data-appearance-phase')) === 'settled',
    'Right-edge preview did not finish its entry transition.'
  )
  const previewMetrics = await preview.evaluate((element) => {
    const rail = element.querySelector('[data-edge-tab="true"]')
    const drawer = element.querySelector('[data-edge-drawer="true"]')
    if (!(drawer instanceof HTMLElement)) return null
    const previewRect = element.getBoundingClientRect()
    const drawerRect = drawer.getBoundingClientRect()
    return {
      previewWidth: previewRect.width,
      previewBottom: previewRect.bottom,
      rail: rail instanceof HTMLElement
        ? {
            width: rail.getBoundingClientRect().width,
            right: rail.getBoundingClientRect().right,
            bottom: rail.getBoundingClientRect().bottom
          }
        : null,
      drawerWidth: drawerRect.width,
      drawerRight: drawerRect.right,
      drawerBottom: drawerRect.bottom,
      previewRight: previewRect.right
    }
  })
  if (!previewMetrics || (expectedLayout === 'island' && (!previewMetrics.rail || previewMetrics.rail.width > 12))) {
    throw new Error(`Right-edge Island preview did not render its compact rail: ${JSON.stringify(previewMetrics)}`)
  }
  if (previewMetrics.drawerWidth > previewMetrics.previewWidth * 0.42) {
    throw new Error(`Right-edge preview drawer is too wide: ${JSON.stringify(previewMetrics)}`)
  }
  if (
    Math.abs(previewMetrics.drawerRight - previewMetrics.previewRight) > 1
  ) {
    throw new Error(`Right-edge preview is not anchored to the preview edge: ${JSON.stringify(previewMetrics)}`)
  }
  if (expectedLayout === 'island' && (!previewMetrics.rail || Math.abs(previewMetrics.rail.right - previewMetrics.previewRight) > 1)) {
    throw new Error(`Right-edge Island preview rail is not anchored to the preview edge: ${JSON.stringify(previewMetrics)}`)
  }
  if (
    (previewMetrics.rail && previewMetrics.rail.bottom > previewMetrics.previewBottom + 1) ||
    previewMetrics.drawerBottom > previewMetrics.previewBottom + 1
  ) {
    throw new Error(`Right-edge preview is clipped inside the compact onboarding surface: ${JSON.stringify(previewMetrics)}`)
  }
  ok(`right-edge ${expectedLayout} onboarding preview stays compact and expands from its ${expectedLayout === 'hide' ? 'edge zone' : 'rail'}`)
  await screenshot(screenshotName)

  await preview.hover({ position: { x: 8, y: 8 }, timeout: 5_000 })
  await previewDrawer.waitFor({ state: 'detached', timeout: 5_000 })
}

async function continueToAppearance() {
  const continueButton = win.getByRole('button', { name: 'Continue to appearance', exact: true }).last()
  await continueButton.waitFor({ state: 'visible', timeout: 5_000 })
  await assertOpaqueOnboardingStage('before Continue to appearance')
  await continueButton.click({ timeout: 5_000 })
  await assertOpaqueOnboardingStage('immediately after Continue to appearance')
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await assertOpaqueOnboardingStage('after the next compositor frame')
  await assertExclusiveOnboardingNativeBounds('after Continue to appearance')
  await win.locator('[data-onboard-appearance-step="appearance"]').first().waitFor({ state: 'visible', timeout: 5_000 })
  await screenshot('02-placement-to-appearance-transition')
}

async function visibleOnboardingRadio(name) {
  const radios = win.locator('button[role="radio"]')
  const match = await waitFor(async () => {
    const options = await radios.evaluateAll((elements) =>
      elements.map((element, index) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          index,
          text: (element.textContent || '').trim(),
          visible:
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0
        }
      })
    )
    return options.find((option) => option.visible && option.text.toLocaleLowerCase().startsWith(name.toLocaleLowerCase())) || null
  }, `Onboarding did not render a visible ${name} choice.`)
  return radios.nth(match.index)
}

async function selectAppearanceAndRightEdge() {
  const rightEdge = await visibleOnboardingRadio('Right edge')
  await rightEdge.waitFor({ state: 'visible', timeout: 8_000 })
  const visible = await rightEdge.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      visible: style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && rect.width > 0 && rect.height > 0,
      withinViewport: rect.top >= 0 && rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    }
  })
  if (!visible.visible || !visible.withinViewport) {
    throw new Error(`Right edge choice is not visible in the full-display onboarding viewport: ${JSON.stringify(visible)}`)
  }
  ok('Right edge choice stays visible on the full-display onboarding viewport')

  // Fresh profiles start hidden. Move that real default to the right edge first so the test covers
  // the exact Hidden path a person gets without an intermediate chrome choice.
  await rightEdge.click({ timeout: 5_000 })
  await settingsMatch({ overlayLayout: 'hide', overlayPlacement: 'right-edge' })
  // The old packaged-app regression wrote the setting, then repainted the prior card on a stale
  // settings snapshot. Keep the check beyond that asynchronous window, not just on click.
  await delay(1_000)
  const selected = await rightEdge.getAttribute('aria-checked')
  if (selected !== 'true') throw new Error('Right edge was written to settings but the selected control did not update.')
  if (await win.getByRole('radio', { name: /^Bar\b/i }).count()) {
    throw new Error('Right edge still exposed the horizontal Bar choice.')
  }
  // Position deliberately demonstrates a visible Island rail even when the saved choice is
  // Hidden; the Appearance step immediately below must show the actual Hidden selection.
  await verifyRightEdgeOnboardingPreview('island', '02-right-edge-position-preview-hover')
  await continueToAppearance()
  await win.mouse.move(40, 40)
  await verifyRightEdgeOnboardingPreview('hide', '02-right-edge-hidden-preview-hover')
  const backToPosition = win.getByRole('button', { name: 'Back to position', exact: true }).last()
  await backToPosition.click({ timeout: 5_000 })
  await win.locator('[data-onboard-appearance-step="position"]').first().waitFor({ state: 'visible', timeout: 5_000 })

  // Now exercise the regression path: an expanded top Island must reset to a rail at right edge,
  // never paint one stale drawer frame before its hover interaction begins.
  const topCenter = await visibleOnboardingRadio('Top center')
  await topCenter.click({ timeout: 5_000 })
  await settingsMatch({ overlayLayout: 'hide', overlayPlacement: 'top-center' })
  await continueToAppearance()
  const island = await visibleOnboardingRadio('Island')
  await island.click({ timeout: 5_000 })
  await settingsMatch({ overlayLayout: 'island', overlayPlacement: 'top-center' })
  const topPreview = win.locator('[data-placement-preview="top-center"]').first()
  await topPreview.locator('.onboard-appearance-preview__hit').hover({ timeout: 5_000 })
  await waitFor(
    async () => (await topPreview.getAttribute('data-appearance-phase')) === 'settled',
    'Top-center Island preview did not expand before the placement switch.'
  )
  await win.getByRole('button', { name: 'Back to position', exact: true }).last().click({ timeout: 5_000 })
  await win.locator('[data-onboard-appearance-step="position"]').first().waitFor({ state: 'visible', timeout: 5_000 })
  const rightEdgeAgain = await visibleOnboardingRadio('Right edge')
  await rightEdgeAgain.click({ timeout: 5_000 })
  await settingsMatch({ overlayLayout: 'island', overlayPlacement: 'right-edge' })
  await continueToAppearance()
  await verifyRightEdgeOnboardingPreview('island', '02-right-edge-island-preview-hover')
  ok('Right edge choice persists and removes the horizontal Bar choice during onboarding')
  await screenshot('02-right-edge-appearance')
}

async function selectAppearanceAndBar() {
  const topCenter = await visibleOnboardingRadio('Top center')
  await topCenter.waitFor({ state: 'visible', timeout: 8_000 })
  await topCenter.click({ timeout: 5_000 })
  await settingsMatch({ overlayPlacement: 'top-center' })
  await waitFor(
    async () => (await topCenter.getAttribute('aria-checked')) === 'true',
    'Top center was written to settings but the selected control did not update.',
    1_000
  )
  await continueToAppearance()
  const bar = await visibleOnboardingRadio('Bar')
  await bar.waitFor({ state: 'visible', timeout: 8_000 })
  await bar.click({ timeout: 5_000 })
  await settingsMatch({ overlayLayout: 'bar' })
  await waitFor(
    async () => (await bar.getAttribute('aria-checked')) === 'true',
    'Bar was written to settings but the selected control did not update.',
    1_000
  )
  ok('Top center Bar choice persists during onboarding')
  await screenshot('02-top-center-bar-appearance')
}

async function finishOnboarding(presentation) {
  const trail = []
  let testedAppearance = false
  for (let step = 0; step < 24; step++) {
    const settings = await win.evaluate(() => window.toto.getSettings())
    if (settings.onboardingDone === true) return trail

    const rightEdge = win.getByRole('radio', { name: /^Right edge\b/i }).first()
    // Hidden scenes remain mounted between the staged onboarding acts. A locator count alone can see
    // the future Appearance card before its controls are actionable, so use its rendered visibility
    // to decide when this scenario may select its presentation.
    if (!testedAppearance && await rightEdge.isVisible().catch(() => false)) {
      if (presentation === 'right-edge') await selectAppearanceAndRightEdge()
      else await selectAppearanceAndBar()
      testedAppearance = true
      continue
    }

    const consent = win.locator('input[type="checkbox"]:not(:checked)').first()
    if (await consent.count()) {
      await consent.check({ timeout: 5_000 })
      trail.push('consent')
      await delay(350)
      continue
    }

    // The no-JS Act 1 shell remains in the document after React takes over; its hidden Next must
    // never win the generic walk over the visible scene's real CTA.
    const primary = win.locator('button.onboard-cta:visible:not([disabled])').last()
    if (!await primary.count()) {
      throw new Error(`Onboarding has no enabled primary action after: ${trail.join(' → ') || '(start)'}`)
    }
    const label = ((await primary.innerText()).trim() || 'Continue').slice(0, 48)
    await primary.click({ timeout: 5_000 })
    trail.push(label)
    if (/^Get started\b/i.test(label)) {
      // A successful completion can replace the exclusive onboarding BrowserWindow. Probe every live
      // Métis window, not only the page that received the click, so destruction of that old page does
      // not turn a completed durable write into a false failure.
      const completedWindow = await waitFor(
        async () => {
          for (const candidate of [...(app?.windows?.() || [])].reverse()) {
            watchPage(candidate)
            try {
              if ((await candidate.evaluate(() => window.toto?.getSettings())).onboardingDone === true) {
                return candidate
              }
            } catch {
              // A window may be closing or opening during the deliberately asynchronous handoff.
            }
          }
          return null
        },
        'Get started did not persist onboarding completion.',
        12_000
      )
      win = completedWindow
      return trail
    }
    await delay(600)
  }
  throw new Error(`Onboarding did not finish after: ${trail.join(' → ') || '(no actions)'}`)
}

async function verifyRightEdgeGeometry() {
  const geometry = await verifyNativeRightEdgeBounds(false, 'onboarding completion')
  const expectedX = geometry.workArea.x + geometry.workArea.width - geometry.bounds.width - 12
  const edgeGap = geometry.workArea.x + geometry.workArea.width - (geometry.bounds.x + geometry.bounds.width)
  if (Math.abs(geometry.bounds.x - expectedX) > 2 || Math.abs(edgeGap - 12) > 2) {
    throw new Error(`Right-edge overlay is not anchored to the work-area edge: ${JSON.stringify({ ...geometry, expectedX, edgeGap })}`)
  }
  if (geometry.bounds.y < geometry.workArea.y || geometry.bounds.y + geometry.bounds.height > geometry.workArea.y + geometry.workArea.height) {
    throw new Error(`Right-edge overlay is vertically outside its work area: ${JSON.stringify(geometry)}`)
  }
  ok('right-edge overlay recreated after onboarding')
}

async function verifyIdlePanels(expectedPlacement) {
  const history = win.getByRole('button', { name: /^History\b/i }).first()
  await history.click({ timeout: 5_000 })
  await win.getByRole('textbox', { name: 'Search past meetings' }).waitFor({ state: 'visible', timeout: 8_000 })
  ok('History opens from the idle bar')

  await win.getByRole('button', { name: 'Back' }).first().click({ timeout: 5_000 })
  await win.getByRole('textbox', { name: 'Ask Métis anything' }).waitFor({ state: 'visible', timeout: 8_000 })
  ok('History returns to the idle bar')

  await win.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 5_000 })
  await win.locator('[aria-label="Settings sections"]').waitFor({ state: 'visible', timeout: 8_000 })
  if (expectedPlacement === 'Top center') {
    if (await win.getByRole('complementary', { name: 'Métis' }).count() || await win.getByRole('button', { name: 'Open Métis' }).count()) {
      throw new Error('Top-center Settings rendered right-edge dock chrome.')
    }
  }
  const selectedPlacement = win.getByRole('radio', { name: new RegExp(`^${expectedPlacement}`, 'i') }).first()
  await selectedPlacement.waitFor({ state: 'visible', timeout: 8_000 })
  if ((await selectedPlacement.getAttribute('aria-checked')) !== 'true') {
    throw new Error(`Settings did not show the ${expectedPlacement} choice selected after onboarding.`)
  }
  ok(`Settings preserves the selected ${expectedPlacement} placement`)

  await win.getByRole('button', { name: 'Close settings' }).click({ timeout: 5_000 })
  await win.getByRole('textbox', { name: 'Ask Métis anything' }).waitFor({ state: 'visible', timeout: 8_000 })
  ok('Settings returns to the idle bar')
}

async function verifyRightEdgeReferenceLayout() {
  const layout = await win.evaluate(() => {
    const drawer = document.querySelector('.right-edge-sidecar__drawer')
    const header = document.querySelector('.right-edge-sidecar__header')
    const rail = document.querySelector('[data-right-edge-action-rail="true"]')
    const composer = document.querySelector('.right-edge-sidecar__composer')
    if (!(drawer instanceof HTMLElement) || !(header instanceof HTMLElement) || !(rail instanceof HTMLElement) || !(composer instanceof HTMLElement)) return null

    const rect = (element) => {
      const value = element.getBoundingClientRect()
      return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height }
    }
    return {
      drawer: rect(drawer),
      header: rect(header),
      rail: rect(rail),
      composer: rect(composer),
      actions: [...rail.querySelectorAll('button')].map((button) => ({
        label: button.getAttribute('aria-label'),
        ...rect(button)
      }))
    }
  })

  const expectedActions = ['Capture screen', 'Spotlight Ref', 'Open settings', 'Mantu Intelligence', 'Start listening', 'Open History']
  const actualActions = new Set(layout?.actions.map((action) => action.label))
  const actionTopSpread = layout ? Math.max(...layout.actions.map((action) => action.top)) - Math.min(...layout.actions.map((action) => action.top)) : Number.POSITIVE_INFINITY
  const missingActions = expectedActions.filter((label) => !actualActions.has(label))
  const composerAnchored = layout && layout.composer.bottom >= layout.drawer.bottom - 15 && layout.composer.top > layout.rail.bottom
  const hasStableSections = layout && layout.header.top >= layout.drawer.top && layout.header.bottom <= layout.rail.top && layout.rail.bottom <= layout.composer.top

  if (!layout || missingActions.length || actionTopSpread > 2 || !composerAnchored || !hasStableSections) {
    throw new Error(`right-edge action rail did not keep every action on one compact row: ${JSON.stringify({ layout, missingActions, actionTopSpread, composerAnchored, hasStableSections })}`)
  }
  ok('right-edge reference layout keeps actions in a compact icon rail and composer anchored')
}

async function installSidecarResponseFixture() {
  await app.evaluate(({ ipcMain }, response) => {
    // E2E owns this throwaway Electron process. Replacing just ask:start preserves the production
    // renderer → preload → IPC → stream event path while making the payload deterministic and offline.
    ipcMain.removeHandler('ask:start')
    ipcMain.handle('ask:start', (event, request) => {
      const id = request && typeof request.id === 'string' ? request.id : ''
      if (!id) throw new Error('E2E ask fixture received no request id.')
      queueMicrotask(() => {
        event.sender.send('stream:delta', { id, text: response })
        event.sender.send('stream:done', { id, inputTokens: 1, outputTokens: 1 })
      })
    })
  }, SIDECAR_LONG_RESPONSE)

  const settings = await win.evaluate(async () => {
    // The test-only handler above never sends a request to OpenAI. This inert key solely satisfies the
    // renderer's normal provider-readiness gate, using the disposable local profile created by this run.
    await window.toto.setSettings({ provider: 'openai' })
    await window.toto.setApiKey('openai', 'metis-e2e-fixture-key')
    return window.toto.getSettings()
  })
  if (!settings.providerReady || settings.provider !== 'openai') {
    throw new Error(`Could not prepare the isolated sidecar response fixture: ${JSON.stringify({ provider: settings.provider, providerReady: settings.providerReady })}`)
  }
  // useSettings refreshes after the main-process settings change. Trigger its normal focus refresh and
  // wait long enough for the React gate to observe the disposable ready provider before pressing Enter.
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await delay(300)
}

async function verifyLongSidecarResponse(composer) {
  await installSidecarResponseFixture()
  await composer.fill('Render the offline sidecar layout fixture')
  await composer.press('Enter')

  const response = win.locator('section[aria-label="Métis response"]')
  await response.waitFor({ state: 'visible', timeout: 8_000 })
  await response.getByText('Sidecar layout check', { exact: false }).waitFor({ state: 'visible', timeout: 8_000 })
  const layout = await win.evaluate(() => {
    const drawer = document.querySelector('.right-edge-sidecar__drawer')
    const body = document.querySelector('.right-edge-sidecar__body')
    const answer = document.querySelector('.right-edge-sidecar__answer')
    const composer = document.querySelector('.right-edge-sidecar__composer')
    const drawerScroll = document.querySelector('.right-edge-sidecar__drawer-scroll')
    if (!(drawer instanceof HTMLElement) || !(body instanceof HTMLElement) || !(answer instanceof HTMLElement) || !(composer instanceof HTMLElement) || !(drawerScroll instanceof HTMLElement)) return null
    const rect = (element) => {
      const value = element.getBoundingClientRect()
      return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height }
    }
    return {
      drawer: rect(drawer),
      body: { ...rect(body), clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
      answer: { ...rect(answer), clientWidth: answer.clientWidth, scrollWidth: answer.scrollWidth },
      composer: rect(composer),
      drawerScroll: { clientWidth: drawerScroll.clientWidth, scrollWidth: drawerScroll.scrollWidth },
      code: [...answer.querySelectorAll('pre')].map((pre) => ({ clientWidth: pre.clientWidth, scrollWidth: pre.scrollWidth })),
      table: [...answer.querySelectorAll('table')].map((table) => ({ clientWidth: table.clientWidth, scrollWidth: table.scrollWidth }))
    }
  })
  const horizontalOverflow = layout && [layout.body, layout.answer, layout.drawerScroll, ...layout.table].some((element) => element.scrollWidth > element.clientWidth + 1)
  const composerAnchored = layout && layout.composer.bottom >= layout.drawer.bottom - 15 && layout.composer.top > layout.body.bottom
  if (!layout || horizontalOverflow || !composerAnchored) {
    throw new Error(`Long sidecar response escaped its reading surface: ${JSON.stringify({ layout, horizontalOverflow, composerAnchored })}`)
  }
  ok('long sidecar answer wraps prose and tables while the composer remains anchored')
}

async function verifyRightEdgeSurface() {
  const tab = win.getByRole('button', { name: 'Open Métis' }).first()
  await tab.waitFor({ state: 'visible', timeout: 12_000 })
  if ((await tab.getAttribute('aria-expanded')) !== 'false') {
    throw new Error('Right-edge tab was not collapsed before opening.')
  }
  if (await win.getByRole('textbox', { name: 'Ask Métis anything' }).count()) {
    throw new Error('Right-edge presentation rendered the horizontal Bar input.')
  }
  if (await win.getByRole('button', { name: /^History\b/i }).count()) {
    throw new Error('Right-edge presentation rendered the horizontal Bar toolbar.')
  }
  ok('right-edge surface omits the horizontal Bar chrome')

  await tab.click({ timeout: 5_000 })
  await win.getByRole('complementary', { name: 'Métis' }).waitFor({ state: 'visible', timeout: 8_000 })
  await verifyNativeRightEdgeBounds(true, 'opening the dock')
  ok('right-edge tab opens the sidecar')
  // The reveal uses a translate-only entrance. Let it settle before testing painted bounds, while keeping
  // the computed height check below as the guard against an absolute child collapsing to a notice strip.
  await delay(250)

  const expanded = await win.evaluate(() => {
    const root = document.querySelector('.right-edge-sidecar')
    const drawer = document.querySelector('.right-edge-sidecar__drawer')
    if (!(root instanceof HTMLElement) || !(drawer instanceof HTMLElement)) return null
    const rootRect = root.getBoundingClientRect()
    const drawerRect = drawer.getBoundingClientRect()
    const rootStyle = getComputedStyle(root)
    const drawerStyle = getComputedStyle(drawer)
    const parentRect = root.parentElement?.getBoundingClientRect()
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      root: {
        className: root.className,
        computedHeight: rootStyle.height,
        width: rootRect.width,
        height: rootRect.height,
        parentHeight: parentRect?.height
      },
      drawer: {
        computedHeight: drawerStyle.height,
        width: drawerRect.width,
        height: drawerRect.height
      }
    }
  })
  const nativeHeight = expanded && Number.parseFloat(expanded.drawer.computedHeight)
  // The dock deliberately carries an eight-pixel breathing margin within its fixed native host.
  // Its useful surface must still be essentially the full host height; otherwise a layout sibling
  // has collapsed it back to the thin parked rail shown in the regression report.
  if (!expanded || expanded.drawer.width < 336 || nativeHeight < expanded.viewport.height * 0.95 || expanded.drawer.height < expanded.viewport.height * 0.95) {
    throw new Error(`Right-edge drawer did not occupy its native surface: ${JSON.stringify(expanded)}`)
  }
  ok('right-edge drawer fills its native sidecar surface')

  await verifyRightEdgeReferenceLayout()

  const composer = win.getByRole('textbox', { name: 'Ask Métis anything' })
  await composer.waitFor({ state: 'visible', timeout: 8_000 })
  await composer.fill('Draft without sending')
  if (await composer.inputValue() !== 'Draft without sending') {
    throw new Error('Right-edge composer did not retain typed text.')
  }
  if (await win.getByRole('button', { name: 'Close Métis' }).count()) {
    throw new Error('Right-edge dock exposed a Close control while a draft keeps the overlay intentionally open.')
  }
  await composer.fill('')
  ok('right-edge sidecar exposes a compact editable composer')
  await screenshot('03-right-edge-sidecar-expanded')
  await verifyLongSidecarResponse(composer)
  for (const label of ['Start listening', 'Capture screen', 'Mantu Intelligence', 'Spotlight Ref', 'Open settings', 'Open History']) {
    await win.getByRole('button', { name: label }).waitFor({ state: 'visible', timeout: 8_000 })
  }
  ok('right-edge sidecar exposes its real action routes')
  await screenshot('03-right-edge-sidecar-long-response')

  await win.getByRole('button', { name: 'Open settings' }).click({ timeout: 5_000 })
  await win.locator('[aria-label="Settings sections"]').waitFor({ state: 'visible', timeout: 8_000 })
  if (await win.getByRole('complementary', { name: 'Métis' }).count()) {
    throw new Error('The right-edge dock remained mounted above the full Settings surface.')
  }
  ok('right-edge Settings replaces the dock instead of rendering beneath it')
  await win.getByRole('button', { name: 'Close settings' }).click({ timeout: 5_000 })
  // Settings is a full surface. Returning to a hover-driven right edge is allowed to park at its
  // rail; both the open drawer and the accessible rail are valid recovery states.
  const restored = await waitFor(async () => {
    if (await win.getByRole('complementary', { name: 'Métis' }).isVisible().catch(() => false)) return 'drawer'
    const rail = win.getByRole('button', { name: 'Open Métis' }).first()
    return (await rail.isVisible().catch(() => false)) && (await rail.getAttribute('aria-expanded')) === 'false' ? 'rail' : null
  }, 'Closing Settings did not restore an accessible right-edge entry point.')
  if (restored === 'rail') {
    await win.getByRole('button', { name: 'Open Métis' }).first().click({ timeout: 5_000 })
    await win.getByRole('complementary', { name: 'Métis' }).waitFor({ state: 'visible', timeout: 8_000 })
  }
  ok('closing Settings restores the right-edge dock or its accessible rail')

  // Re-enter the drawer before testing its Close affordance. The sidecar intentionally has a short
  // entrance spring, so this models a user moving onto the visible control rather than racing its mount.
  const closeDock = win.getByRole('button', { name: 'Close Métis' })
  await closeDock.hover({ timeout: 5_000 })
  await delay(250)
  await closeDock.click({ timeout: 5_000 })
  await win.getByRole('complementary', { name: 'Métis' }).waitFor({ state: 'detached', timeout: 8_000 })
  if ((await tab.getAttribute('aria-expanded')) !== 'false') {
    throw new Error('Right-edge tab did not return to its collapsed state after Close.')
  }
  await verifyNativeRightEdgeBounds(false, 'closing the dock')
  ok('right-edge sidecar closes back to its tab')
  await screenshot('04-right-edge-rail')

  // Playwright's page-level hover does not move the operating system cursor after Electron has moved
  // this window from 360px to its 52px right-edge rail, so it cannot exercise main's native cursor
  // watcher faithfully. Exercise the accessible rail click here; the native restored-from-park contract
  // is covered separately and physical hover is checked on a real desktop device.
  await tab.click({ timeout: 5_000 })
  await win.getByRole('complementary', { name: 'Métis' }).waitFor({ state: 'visible', timeout: 8_000 })
  await verifyNativeRightEdgeBounds(true, 'clicking the parked rail')
  ok('right-edge rail click restores matching native and rendered drawer surfaces')
}

async function replayOnboardingAndVerifyFullDisplay() {
  await win.getByRole('button', { name: 'Open settings' }).click({ timeout: 5_000 })
  await win.locator('[aria-label="Settings sections"]').waitFor({ state: 'visible', timeout: 8_000 })
  const replay = win.getByRole('button', { name: 'Replay onboarding', exact: true })
  await replay.waitFor({ state: 'visible', timeout: 5_000 })
  const retiringWindowId = await armReplayOpaqueCoverageTrace()
  const confirmation = new Promise((resolveConfirmation, rejectConfirmation) => {
    win.once('dialog', (dialog) => {
      if (dialog.type() !== 'confirm') {
        rejectConfirmation(new Error(`Unexpected dialog while replaying onboarding: ${dialog.type()}`))
        return
      }
      void dialog.accept().then(resolveConfirmation, rejectConfirmation)
    })
  })
  await withTimeout(
    Promise.all([confirmation, replay.click({ timeout: 5_000 })]),
    8_000,
    'Replay onboarding confirmation did not complete.'
  )
  await assertReplayOpaqueCoverage(retiringWindowId)
  win = await latestMétisWindow({ onboardingDone: false })
  await win.locator('.onboard-stage').first().waitFor({ state: 'visible', timeout: 8_000 })
  await assertOpaqueOnboardingStage('after Settings replay')
  await assertExclusiveOnboardingNativeBounds('after Settings replay')
  await delay(400)
  await assertExclusiveOnboardingNativeBounds('after the replay bounds watcher interval')
  await simulateNativeOnboardingClampAndRequireRecovery('after Settings replay')
  await screenshot('05-replayed-onboarding-full-display')
  ok('Settings replay returns to a full-display onboarding window')
}

async function verifyBarSurface() {
  await win.getByRole('textbox', { name: 'Ask Métis anything' }).waitFor({ state: 'visible', timeout: 12_000 })
  if (await win.getByRole('complementary', { name: 'Métis' }).count() || await win.getByRole('button', { name: 'Open Métis' }).count()) {
    throw new Error('Top-center presentation rendered right-edge dock chrome.')
  }
  const geometry = await waitFor(async () => {
    const candidate = await overlayWindowGeometry()
    if (!candidate) return null
    const expectedX = Math.round(candidate.workArea.x + (candidate.workArea.width - candidate.bounds.width) / 2)
    const expectedY = candidate.workArea.y + TOP_CENTER_MARGIN_PX
    return candidate.bounds.width === TOP_CENTER_BAR_WIDTH && Math.abs(candidate.bounds.x - expectedX) <= 2 && Math.abs(candidate.bounds.y - expectedY) <= 2
      ? candidate
      : null
  }, 'Top-center Bar did not occupy its native centered placement.')
  ok(`top-center native Bar is centered at ${geometry.bounds.x},${geometry.bounds.y}`)
  ok('top-center idle bar rendered')

  if (await win.getByRole('button', { name: /^History\b/i }).count()) ok('top-center bar toolbar rendered')
  else throw new Error('No History control in the top-center Bar presentation.')
  if (await win.getByRole('button', { name: /^Spotlight Ref\b/i }).count()) ok('Spotlight Ref control rendered in the Bar')
  else throw new Error('No Spotlight Ref control in the top-center Bar presentation.')
  await screenshot('03-top-center-bar-idle')
  await verifyIdlePanels('Top center')
}

function childHasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null
}

async function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return true
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(childHasExited(child)), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

async function closeOwnApp() {
  if (!app) return
  const child = app.process()
  // Métis intentionally stays alive after its last window for background reconciliation. Ask the
  // specific test process to quit first, then only signal that known child if it did not comply.
  await withTimeout(
    app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {}),
    OWN_PROCESS_TIMEOUT_MS,
    'Timed out while requesting the isolated test app to quit.'
  ).catch(() => {})
  await withTimeout(app.close().catch(() => {}), OWN_PROCESS_TIMEOUT_MS, 'Timed out while closing the isolated test app.').catch(() => {})
  if (!childHasExited(child)) {
    child.kill('SIGTERM')
    await waitForChildExit(child, 3_000)
  }
  if (!childHasExited(child)) {
    child.kill('SIGKILL')
    await waitForChildExit(child, 3_000)
  }
}

async function launchFreshProfile(presentation) {
  console.log(`Launching ${APP_EXECUTABLE ? 'packaged' : 'built'} Métis app with isolated ${presentation} profile:`, userDataDir)
  app = await electron.launch({
    // Electron's unpackaged app target must be the project root. Passing out/main/index.js makes
    // Electron treat out/main as an app root, bypassing this project's package.json and often opening
    // its stock shell. A packaged-app run uses the exact executable emitted by electron-builder instead.
    ...(APP_EXECUTABLE ? { executablePath: APP_EXECUTABLE } : { args: [ROOT] }),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      ASKTOTO_USERDATA: userDataDir,
      ASKTOTO_LOCAL_KEYSTORE: '1',
      // devEnv() ignores this in a packaged app. It is only for screenshot automation of the unpackaged run.
      ASKTOTO_DISABLE_CP: '1'
    },
    timeout: 30_000
  })
  app.on('window', watchPage)
  win = await app.firstWindow({ timeout: 30_000 })
  watchPage(win)
  win = await latestMétisWindow({ onboardingDone: false })
  ok(`${presentation}: app launched + first window`)
  await win.waitForLoadState('domcontentloaded').catch(() => {})

  await win.waitForFunction(
    () => {
      const text = document.body.innerText
      return text && !/Starting Métis…/.test(text) && text.trim().length > 0 && typeof window.toto !== 'undefined'
    },
    { timeout: 15_000 }
  ).then(() => ok(`${presentation}: boot cleared the loading strip`)).catch((error) => fail(`${presentation}: boot cleared the loading strip (stuck loader?)`, error))
  await screenshot(`01-${presentation}-boot`)
  const initial = await bodyText()
  console.log(`   ${presentation} after boot:`, initial.slice(0, 120))

  // Copy deliberately changes between onboarding scenes. The durable first-run state, not a marketing
  // phrase from whichever scene has painted, is the authoritative signal that this is onboarding.
  const initialSettings = await win.evaluate(() => window.toto.getSettings())
  if (initialSettings.onboardingDone !== false) {
    throw new Error(`A fresh isolated ${presentation} profile did not show onboarding (onboardingDone=${initialSettings.onboardingDone}).`)
  }
  ok(`${presentation}: onboarding shown on first run`)
  await assertExclusiveOnboardingNativeBounds(`${presentation}: first onboarding paint`)
  await simulateNativeOnboardingClampAndRequireRecovery(`${presentation}: first onboarding paint`)
  const trail = await finishOnboarding(presentation)
  ok(`${presentation}: completed the onboarding walk (${trail.length} actions: ${trail.join(' → ')})`)

  // Finish replaces the opaque exclusive onboarding window. Re-acquire the new overlay instead of
  // driving a closed page handle, then re-read durable settings from the replacement renderer.
  await delay(800)
  win = await latestMétisWindow({ onboardingDone: true })
  return win.evaluate(() => window.toto.getSettings())
}

async function beginFreshProfile() {
  await closeOwnApp()
  rmSync(userDataDir, { recursive: true, force: true })
  userDataDir = mkdtempSync(join(tmpdir(), 'metis-e2e-'))
  rendererDiagnostics.length = 0
}

try {
  assertFreshBuild()
  ok('build artifact is newer than the tested right-edge source')
  const rightEdgeSettings = await launchFreshProfile('right-edge')
  if (rightEdgeSettings.overlayPlacement !== 'right-edge') {
    throw new Error(`Right edge preference did not survive onboarding completion: ${rightEdgeSettings.overlayPlacement}`)
  }
  ok('Right edge setting survives onboarding completion')
  await verifyRightEdgeGeometry()
  await verifyRightEdgeSurface()
  await replayOnboardingAndVerifyFullDisplay()
  if (rendererDiagnostics.length === 0) ok('right-edge: no renderer console errors')
  else fail('right-edge: renderer console errors', new Error(rendererDiagnostics.slice(0, 3).join(' | ')))

  await beginFreshProfile()
  const topCenterSettings = await launchFreshProfile('top-center-bar')
  if (topCenterSettings.overlayPlacement !== 'top-center' || topCenterSettings.overlayLayout !== 'bar') {
    throw new Error(`Top-center Bar preference did not survive onboarding completion: ${JSON.stringify({ overlayPlacement: topCenterSettings.overlayPlacement, overlayLayout: topCenterSettings.overlayLayout })}`)
  }
  ok('Top center Bar settings survive onboarding completion')
  await verifyBarSurface()

  const before = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const minimize = win.getByRole('button', { name: /^Minimize to the orb$/i }).first()
  if (await minimize.count()) {
    await minimize.click({ timeout: 5_000 })
    await delay(900)
    const after = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    if (after.width < before.width && after.width <= 260) ok(`minimize shrank the window (${before.width}→${after.width}px wide)`)
    else fail('minimize shrank the window', new Error(`width ${before.width}→${after.width} (expected ≤260)`))
    const expand = win.locator('button[aria-label="Expand Métis"], button[title="Expand Métis"]').first()
    if (await expand.count()) {
      await expand.click({ timeout: 5_000 })
      await delay(900)
      const restored = await win.evaluate(() => ({ width: window.innerWidth }))
      if (restored.width > after.width) ok(`expand restored the bar (${after.width}→${restored.width}px)`)
      else fail('expand restored the bar', new Error(`width stayed ${restored.width}`))
    } else fail('find expand button', new Error('No Expand Métis control'))
  } else {
    fail('find minimize button', new Error('No minimize control in Bar layout'))
  }

  await delay(500)
  if (rendererDiagnostics.length === 0) ok('top-center Bar: no renderer console errors')
  else fail('top-center Bar: renderer console errors', new Error(rendererDiagnostics.slice(0, 3).join(' | ')))
} catch (error) {
  fail('fatal', error)
} finally {
  await closeOwnApp()
  rmSync(userDataDir, { recursive: true, force: true })
  const passed = steps.filter((step) => step.ok).length
  const failed = steps.filter((step) => !step.ok)
  console.log(`\n==== E2E: ${passed}/${steps.length} passed ====`)
  if (failed.length) {
    console.log('FAILURES:')
    for (const failure of failed) console.log(`  ✗ ${failure.name} — ${failure.err}`)
  }
  process.exit(failed.length ? 1 : 0)
}
