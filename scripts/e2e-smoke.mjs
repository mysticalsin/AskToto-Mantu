// Visual end-to-end smoke test for the built, unpackaged Métis app.
// It deliberately starts the project root (not out/main/index.js) so Electron reads package.json's
// `main`, uses a disposable profile, and drives the same onboarding a new user sees.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const SHOT_DIR = process.env.E2E_SHOT_DIR || '/tmp'
const COMPACT_ONBOARDING = { width: 1280, height: 640 }
const OWN_PROCESS_TIMEOUT_MS = 5_000
const steps = []
const rendererDiagnostics = []
const watchedPages = new WeakSet()
const userDataDir = mkdtempSync(join(tmpdir(), 'metis-e2e-'))
let app
let win

mkdirSync(SHOT_DIR, { recursive: true })

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

async function settingsMatch(expected) {
  return waitFor(
    async () => {
      const settings = await win.evaluate(() => window.toto.getSettings())
      return Object.entries(expected).every(([key, value]) => settings[key] === value)
    },
    `Settings did not persist ${JSON.stringify(expected)}`
  )
}

async function setCompactOnboardingBounds() {
  const result = await app.evaluate(({ BrowserWindow, screen }, target) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (!window) throw new Error('No BrowserWindow is available for compact onboarding validation.')
    const display = screen.getDisplayMatching(window.getBounds())
    const workArea = display.workArea
    if (workArea.width < target.width || workArea.height < target.height) {
      return { supported: false, workArea, target }
    }
    const bounds = {
      x: Math.round(workArea.x + (workArea.width - target.width) / 2),
      y: Math.round(workArea.y + (workArea.height - target.height) / 2),
      ...target
    }
    window.setBounds(bounds)
    return { supported: true, target, bounds: window.getBounds(), workArea }
  }, COMPACT_ONBOARDING)

  if (!result.supported) {
    throw new Error(`The active display is ${result.workArea.width}×${result.workArea.height}; it cannot validate the required 1280×640 compact onboarding view.`)
  }
  if (result.bounds.width !== COMPACT_ONBOARDING.width || result.bounds.height !== COMPACT_ONBOARDING.height) {
    throw new Error(`Electron did not apply the requested compact onboarding bounds: ${JSON.stringify(result.bounds)}`)
  }
  await delay(300)
}

async function selectAppearanceAndRightEdge() {
  const rightEdge = win.getByRole('radio', { name: /^Right edge\b/i }).first()
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
    throw new Error(`Right edge choice is not visible in the 1280×640 onboarding viewport: ${JSON.stringify(visible)}`)
  }
  ok('Right edge choice stays visible on a compact onboarding viewport')

  // Choose Bar before finishing so the post-onboarding overlay remains observable without weakening
  // the app's deliberate Hide-on-hover default. This proves physical placement independently of chrome.
  const bar = win.getByRole('radio', { name: /^Bar\b/i }).first()
  await bar.click({ timeout: 5_000 })
  await settingsMatch({ overlayLayout: 'bar' })
  await rightEdge.click({ timeout: 5_000 })
  await settingsMatch({ overlayPlacement: 'right-edge' })
  const selected = await rightEdge.getAttribute('aria-checked')
  if (selected !== 'true') throw new Error('Right edge was written to settings but the selected control did not update.')
  const preview = win.locator('[data-placement-preview="right-edge"]').first()
  if (await preview.count() !== 1) throw new Error('Right-edge appearance preview did not update after selection.')
  ok('Right edge choice persists during onboarding')
  await screenshot('02-appearance')
}

async function finishOnboarding() {
  const trail = []
  let testedAppearance = false
  for (let step = 0; step < 24; step++) {
    const settings = await win.evaluate(() => window.toto.getSettings())
    if (settings.onboardingDone === true) return trail

    const rightEdge = win.getByRole('radio', { name: /^Right edge\b/i }).first()
    if (!testedAppearance && await rightEdge.count()) {
      await setCompactOnboardingBounds()
      await selectAppearanceAndRightEdge()
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
  const geometry = await waitFor(
    () => app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      if (!window) return null
      const bounds = window.getBounds()
      const workArea = screen.getDisplayMatching(bounds).workArea
      return { bounds, workArea }
    }),
    'No post-onboarding window geometry was available.'
  )
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

async function verifyIdlePanels() {
  const history = win.getByRole('button', { name: /^History\b/i }).first()
  await history.click({ timeout: 5_000 })
  await win.getByRole('textbox', { name: 'Search past meetings' }).waitFor({ state: 'visible', timeout: 8_000 })
  ok('History opens from the idle bar')

  await win.getByRole('button', { name: 'Back' }).first().click({ timeout: 5_000 })
  await win.getByRole('textbox', { name: 'Ask Métis anything' }).waitFor({ state: 'visible', timeout: 8_000 })
  ok('History returns to the idle bar')

  await win.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 5_000 })
  await win.locator('[aria-label="Settings sections"]').waitFor({ state: 'visible', timeout: 8_000 })
  const rightEdge = win.getByRole('radio', { name: /^Right edge\b/i }).first()
  await rightEdge.waitFor({ state: 'visible', timeout: 8_000 })
  if ((await rightEdge.getAttribute('aria-checked')) !== 'true') {
    throw new Error('Settings did not show the Right edge choice selected after onboarding.')
  }
  ok('Settings preserves the selected Right edge placement')

  await win.getByRole('button', { name: 'Close settings' }).click({ timeout: 5_000 })
  await win.getByRole('textbox', { name: 'Ask Métis anything' }).waitFor({ state: 'visible', timeout: 8_000 })
  ok('Settings returns to the idle bar')
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

try {
  console.log('Launching built Métis app with isolated profile:', userDataDir)
  app = await electron.launch({
    // Electron's app target must be the project root. Passing out/main/index.js makes Electron treat
    // out/main as an app root, bypassing this project's package.json and often opening its stock shell.
    args: [ROOT],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      ASKTOTO_USERDATA: userDataDir,
      ASKTOTO_LOCAL_KEYSTORE: '1',
      // devEnv() ignores this in a packaged app. It is only for screenshot automation of this unpackaged build.
      ASKTOTO_DISABLE_CP: '1'
    },
    timeout: 30_000
  })
  app.on('window', watchPage)
  win = await app.firstWindow({ timeout: 30_000 })
  watchPage(win)
  win = await latestMétisWindow({ onboardingDone: false })
  ok('app launched + first window')
  await win.waitForLoadState('domcontentloaded').catch(() => {})

  await win.waitForFunction(
    () => {
      const text = document.body.innerText
      return text && !/Starting Métis…/.test(text) && text.trim().length > 0 && typeof window.toto !== 'undefined'
    },
    { timeout: 15_000 }
  ).then(() => ok('boot cleared the loading strip')).catch((error) => fail('boot cleared the loading strip (stuck loader?)', error))
  await screenshot('01-boot')
  const initial = await bodyText()
  console.log('   after boot:', initial.slice(0, 120))

  // Copy deliberately changes between onboarding scenes. The durable first-run state, not a marketing
  // phrase from whichever scene has painted, is the authoritative signal that this is onboarding.
  const initialSettings = await win.evaluate(() => window.toto.getSettings())
  if (initialSettings.onboardingDone !== false) {
    throw new Error(`A fresh isolated profile did not show onboarding (onboardingDone=${initialSettings.onboardingDone}).`)
  }
  ok('onboarding shown on first run')
  const trail = await finishOnboarding()
  ok(`completed the onboarding walk (${trail.length} actions: ${trail.join(' → ')})`)

  // Finish replaces the opaque exclusive onboarding window. Re-acquire the new overlay instead of
  // driving a closed page handle, then re-read durable settings from the replacement renderer.
  await delay(800)
  win = await latestMétisWindow({ onboardingDone: true })
  const completedSettings = await win.evaluate(() => window.toto.getSettings())
  if (completedSettings.overlayPlacement !== 'right-edge') {
    throw new Error(`Right edge preference did not survive onboarding completion: ${completedSettings.overlayPlacement}`)
  }
  ok('Right edge setting survives onboarding completion')
  await verifyRightEdgeGeometry()

  await win.waitForSelector('input[placeholder*="Ask anything"], input[placeholder*="Ask a follow-up"]', { timeout: 12_000 })
    .then(() => ok('idle bar rendered')).catch((error) => fail('idle bar rendered', error))
  const historyCount = await win.locator('button:has-text("History")').count()
  if (historyCount > 0) ok('toolbar rendered')
  else fail('toolbar rendered', new Error('No History control'))
  const spotlightRefCount = await win.getByRole('button', { name: /^Spotlight Ref\b/i }).count()
  if (spotlightRefCount > 0) ok('Spotlight Ref control rendered')
  else fail('Spotlight Ref control rendered', new Error('No Spotlight Ref control'))
  await screenshot('03-idle')
  await verifyIdlePanels()

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
  if (rendererDiagnostics.length === 0) ok('no renderer console errors')
  else fail('renderer console errors', new Error(rendererDiagnostics.slice(0, 3).join(' | ')))
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
