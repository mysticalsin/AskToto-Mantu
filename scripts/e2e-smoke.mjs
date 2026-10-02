// Visual end-to-end smoke test for the built, unpackaged Métis app.
// It deliberately starts the project root (not out/main/index.js) so Electron reads package.json's
// `main`, uses a disposable profile, and drives the same onboarding a new user sees.
// The onboarding/right-edge/Bar verification flows live in qa/golden-flows/onboarding-flows.mjs and the
// launch/wait/screenshot/close primitives in qa/lib/app-driver.mjs.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createOnboardingFlows } from './qa/golden-flows/onboarding-flows.mjs'
import { closeApp, launch, screenshot as driverScreenshot, sleep } from './qa/lib/app-driver.mjs'

const ROOT = resolve(process.cwd())
const APP_EXECUTABLE = process.env.E2E_APP_EXECUTABLE ? resolve(process.env.E2E_APP_EXECUTABLE) : null
const SHOT_DIR = process.env.E2E_SHOT_DIR || '/tmp'
const OWN_PROCESS_TIMEOUT_MS = 5_000
const steps = []
const rendererDiagnostics = []
const watchedPages = new WeakSet()
let userDataDir = mkdtempSync(join(tmpdir(), 'metis-e2e-'))
// The app and its current window are replaced during onboarding, so every flow reads them from here.
const ctx = { app: null, win: null }

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
    join(ROOT, 'src', 'renderer', 'src', 'tokens.css'),
    ...readdirSync(join(ROOT, 'src', 'renderer', 'src', 'styles')).map((name) =>
      join(ROOT, 'src', 'renderer', 'src', 'styles', name)
    ),
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

const delay = sleep
const ok = (name) => { steps.push({ name, ok: true }); console.log(`  ✓ ${name}`) }
const fail = (name, error) => {
  const message = String(error?.message || error)
  steps.push({ name, ok: false, err: message })
  console.log(`  ✗ ${name} — ${message}`)
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
    const candidates = ctx.app?.windows?.() || []
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
    return (await ctx.win.locator('body').innerText()).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

async function screenshot(name) {
  await driverScreenshot(ctx.win, SHOT_DIR, name)
}

Object.assign(ctx, { ok, fail, screenshot, watchPage, latestMétisWindow })
const {
  assertExclusiveOnboardingNativeBounds,
  simulateNativeOnboardingClampAndRequireRecovery,
  finishOnboarding,
  verifyRightEdgeGeometry,
  verifyRightEdgeSurface,
  verifyRightEdgeHideScenario,
  replayOnboardingAndVerifyFullDisplay,
  verifyBarSurface
} = createOnboardingFlows(ctx)

async function launchFreshProfile(presentation) {
  console.log(`Launching ${APP_EXECUTABLE ? 'packaged' : 'built'} Métis app with isolated ${presentation} profile:`, userDataDir)
  // A packaged-app run uses the exact executable emitted by electron-builder; the unpackaged run starts the
  // project root, because passing out/main/index.js makes Electron treat out/main as an app root, bypass
  // this project's package.json and often open its stock shell. The driver merges process.env.
  ctx.app = await launch({
    executablePath: APP_EXECUTABLE,
    root: ROOT,
    env: {
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      ASKTOTO_USERDATA: userDataDir,
      ASKTOTO_LOCAL_KEYSTORE: '1',
      // devEnv() ignores this in a packaged app. It is only for screenshot automation of the unpackaged run.
      ASKTOTO_DISABLE_CP: '1'
    },
    timeout: 30_000
  })
  ctx.app.on('window', watchPage)
  ctx.win = await ctx.app.firstWindow({ timeout: 30_000 })
  watchPage(ctx.win)
  ctx.win = await latestMétisWindow({ onboardingDone: false })
  ok(`${presentation}: app launched + first window`)
  await ctx.win.waitForLoadState('domcontentloaded').catch(() => {})

  await ctx.win.waitForFunction(
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
  const initialSettings = await ctx.win.evaluate(() => window.toto.getSettings())
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
  ctx.win = await latestMétisWindow({ onboardingDone: true })
  return ctx.win.evaluate(() => window.toto.getSettings())
}

// Métis intentionally stays alive after its last window for background reconciliation. The driver asks the
// specific test process to quit first, then only signals that known child if it did not comply.
const closeOwnApp = () => closeApp(ctx.app, { requestTimeoutMs: OWN_PROCESS_TIMEOUT_MS })

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

  // A fresh right-edge profile for Hide, so the replayed onboarding above cannot leak into these rows.
  await beginFreshProfile()
  await launchFreshProfile('right-edge-hide')
  await verifyRightEdgeHideScenario()
  if (rendererDiagnostics.length === 0) ok('right-edge Hide: no renderer console errors')
  else fail('right-edge Hide: renderer console errors', new Error(rendererDiagnostics.slice(0, 3).join(' | ')))

  await beginFreshProfile()
  const topCenterSettings = await launchFreshProfile('top-center-bar')
  if (topCenterSettings.overlayPlacement !== 'top-center' || topCenterSettings.overlayLayout !== 'bar') {
    throw new Error(`Top-center Bar preference did not survive onboarding completion: ${JSON.stringify({ overlayPlacement: topCenterSettings.overlayPlacement, overlayLayout: topCenterSettings.overlayLayout })}`)
  }
  ok('Top center Bar settings survive onboarding completion')
  await verifyBarSurface()

  const before = await ctx.win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const minimize = ctx.win.getByRole('button', { name: /^Minimize to the orb$/i }).first()
  if (await minimize.count()) {
    await minimize.click({ timeout: 5_000 })
    await delay(900)
    const after = await ctx.win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    if (after.width < before.width && after.width <= 260) ok(`minimize shrank the window (${before.width}→${after.width}px wide)`)
    else fail('minimize shrank the window', new Error(`width ${before.width}→${after.width} (expected ≤260)`))
    const expand = ctx.win.locator('button[aria-label="Expand Métis"], button[title="Expand Métis"]').first()
    if (await expand.count()) {
      await expand.click({ timeout: 5_000 })
      await delay(900)
      const restored = await ctx.win.evaluate(() => ({ width: window.innerWidth }))
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
