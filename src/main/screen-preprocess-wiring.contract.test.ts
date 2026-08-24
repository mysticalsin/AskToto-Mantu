import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source-contract tests for how the background screen pre-analysis engine is WIRED (MQA-178, MQA-179).
 * The engine itself is unit-tested in screen-preprocess.test.ts; the defects here are in main's boot
 * sequence and in the readiness flag Settings renders, both of which live inside index.ts closures that
 * boot Electron at import time. Same pattern as signout-revocation.contract.test.ts /
 * main-lifecycle.contract.test.ts: assert against the shipped source.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const settingsSrc = readFileSync(
  join(__dirname, '..', 'renderer', 'src', 'components', 'Settings.tsx'),
  'utf8'
)

/** Slice the source from `from` up to (excluding) the next occurrence of `to`. Sliced inside each test so
 *  one drifted marker reports as its own failure instead of aborting collection for the whole file. */
function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = src.indexOf(to, start)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return src.slice(start, end)
}

describe('MQA-178 — the engine is armed at boot, not only when some other setting happens to change', () => {
  it('MQA-178 — the app.whenReady() boot sequence reconciles background screen pre-analysis', () => {
    // screen-preprocess.ts documents refresh() as "Call on startup and after settings change"; only the
    // second half was ever wired, so an opted-in user relaunching Métis got an inert fast path for the
    // whole session and every screen ask silently fell back to a cloud image upload.
    const boot = sliceBetween(indexSrc, 'app.whenReady().then(async () => {', "app.on('activate'")
    expect(boot).toContain('refreshScreenPreprocess')
  })

  it('MQA-178 — the local-model download re-arms it when the weights land mid-session', () => {
    // First run fetches ~760 MB unawaited, so the boot reconcile above runs while localReady is still
    // false. Nothing else notices when it finishes, so without this the feature stays dead all session.
    const download = sliceBetween(
      indexSrc,
      'ensureLocalModel(best.id)',
      'app.setAppUserModelId'
    )
    expect(download).toContain('refreshScreenPreprocess')
  })
})

describe('MQA-209 — arming at boot must not raise the macOS Screen Recording prompt', () => {
  it('MQA-209 — the engine is wired with a darwin-only screen-grant gate', () => {
    // On macOS the background loop's own capture is what registers the app with TCC and raises the
    // system dialog (captureScreenshotOnce lets `not-determined` through on purpose), so the boot
    // reconcile MQA-178 added would pop an unexplained prompt ~6s after launch. Off darwin the dep
    // stays undefined: Windows has no queryable screen grant and its capture raises no prompt.
    const deps = sliceBetween(
      indexSrc,
      'createScreenPreprocess({',
      'function refreshScreenPreprocess'
    )
    expect(deps).toMatch(/screenCaptureGranted:[\s\S]{0,80}process\.platform === 'darwin'/)
    expect(deps).toContain("getMediaAccessStatus('screen') === 'granted'")
  })

  it('MQA-209 — the "not running" copy no longer blames the window signal on macOS', () => {
    // The gate adds a SECOND way to be off on a Mac (no Screen Recording grant), and the existing copy
    // asserted the other one as fact. Same rule as MQA-179: never describe a state the engine isn't in.
    const toggle = sliceBetween(
      settingsSrc,
      'label="Preload screen context (on-device)"',
      '</Section>'
    )
    expect(toggle).toContain('Screen Recording')
    expect(toggle).toMatch(/isWindows[\s\S]{0,400}can't tell when you switch windows/)
  })

  it('MQA-209 — onboarding reconciles the engine right after it asks for the grant', () => {
    // permissionsRequestUpfront is where the prompt belongs, and it is the one moment the gate above can
    // change. macOS usually defers a fresh grant to the next launch (where the boot reconcile catches
    // it), so this is the cheap cover for the case where the status has already flipped.
    const handler = sliceBetween(
      indexSrc,
      'ipcMain.handle(IPC.permissionsRequestUpfront',
      'return getPlatformPermissions()'
    )
    expect(handler).toContain('refreshScreenPreprocess()')
  })
})

describe('MQA-179 — Settings reads the engine’s own gate, not a second expression', () => {
  it('MQA-179 — backgroundScreenReady is derived from screenPreprocess.canRun()', () => {
    expect(indexSrc).toContain('backgroundScreenReady: screenPreprocess.canRun()')
  })

  it('MQA-179 — the old settings-only expression is gone (it ignored the macOS OCR engine)', () => {
    // `s.backgroundScreenContext && localReady` said "not running" on every Mac where Vision OCR alone
    // satisfies the engine's eligible() — while the engine captured the screen every 6 seconds.
    expect(indexSrc).not.toMatch(/backgroundScreenReady:\s*s\.backgroundScreenContext/)
  })

  it('MQA-179 — the toggle copy no longer claims the on-device MODEL does the reading', () => {
    // On macOS the reader can be the Vision OCR helper with no local model at all, so "with the on-device
    // model" is false in exactly the state this fix makes reachable.
    const toggle = sliceBetween(
      settingsSrc,
      'label="Preload screen context (on-device)"',
      '</Section>'
    )
    expect(toggle).not.toContain('on-device model')
  })

  it('MQA-179 — the "not running" copy distinguishes no-local-AI from a dead window signal', () => {
    // backgroundScreenReady is now false for two different reasons; telling a user with Local AI already
    // on to "Enable Local AI" would just be the opposite lie.
    const toggle = sliceBetween(
      settingsSrc,
      'label="Preload screen context (on-device)"',
      '</Section>'
    )
    expect(toggle).toContain('settings.localReady')
  })
})
