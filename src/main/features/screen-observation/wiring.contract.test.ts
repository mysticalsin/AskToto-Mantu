import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

/**
 * Source contract for the G16 wiring. index.ts is one closure with no injectable seam (there is no
 * index.test.ts), so the few lines that connect the screen-observation module to the app are pinned
 * against the real source, the same way screen-ask-replay.contract.test.ts pins the replay path.
 */
const lf = (text: string): string => text.replace(/\r\n/g, '\n')
const mainDir = join(__dirname, '..', '..')
const indexSrc = lf(readModuleSource(mainDir, './index').text)
const preloadSrc = lf(readModuleSource(join(mainDir, '..', 'preload'), './index').text)

function handlerBody(marker: string): string {
  const start = indexSrc.indexOf(marker)
  expect(start, `${marker} not found in index.ts`).toBeGreaterThan(-1)
  const next = indexSrc.indexOf('\n  ipcMain.handle(', start + marker.length)
  return stripLineComments(indexSrc.slice(start, next === -1 ? undefined : next))
}

/** The contract is about code that runs, so a comment that names a function does not count as a call. */
function stripLineComments(text: string): string {
  return text.replace(/^\s*(\/\/|\/\*|\*).*$/gm, '')
}

function functionBody(signature: string): string {
  const start = indexSrc.indexOf(signature)
  expect(start, `${signature} not found in index.ts`).toBeGreaterThan(-1)
  const next = indexSrc.indexOf('\n}\n', start)
  return indexSrc.slice(start, next + 3)
}

describe('G16 — no capture without a named trigger', () => {
  it('a typed or spoken question never captures: the askStart handler has no capture call at all', () => {
    const ask = handlerBody('ipcMain.handle(IPC.askStart')
    expect(ask.length).toBeGreaterThan(5_000) // the whole handler was sliced, not a stub
    expect(ask).not.toMatch(/getScreenshot\(/)
    expect(ask).not.toMatch(/screenObservation\.capture\(/)
    expect(ask).not.toMatch(/captureScreenshotOnce\(/)
    expect(ask).not.toMatch(/desktopCapturer/)
  })

  it('the only native capture is reachable through the observation module, not from a second path', () => {
    expect(indexSrc.match(/captureScreenshotOnce\(/g)?.length ?? 0).toBe(2) // its declaration and the one dependency
    expect(indexSrc).toMatch(/captureOnce:\s*\(request\)\s*=>\s*captureScreenshotOnce\(/)
    expect(indexSrc).not.toMatch(/\bshotCache\b/)
  })

  it('getScreenshot maps the phase onto a trigger and delegates; unknown phases are not admitted', () => {
    const fn = functionBody('function getScreenshot(')
    expect(fn).toMatch(/screenObservation\.capture\(/)
    expect(fn).toMatch(/captureReasonForPhase\(phase\)/)
  })

  it('getScreenshot is called from exactly four places: its own definition, the prewarm, the self-check and the capture IPC', () => {
    const code = stripLineComments(indexSrc)
    const calls = [...code.matchAll(/getScreenshot\(([^\n]*)/g)].map((m) => m[1])
    expect(calls).toHaveLength(4)
    expect(calls[0]).toMatch(/^phase\?: string, scope\?: ScreenScope\)/)
    expect(calls[1]).toMatch(/^'prewarm'\)/)
    expect(calls[2]).toMatch(/^'screen-check'\)/)
    expect(calls[3]).toMatch(/^undefined, ScreenScopeSchema\.parse\(/)
    // The fifth reference is the background engine, which names its own trigger ('bg-screen').
    const engine = code.slice(code.indexOf('const screenPreprocess: ScreenPreprocess = createScreenPreprocess({'))
    expect(engine.slice(0, 200)).toMatch(/getScreenshot,/)
  })

  it('the capture IPC parses an optional scope with the shared schema before it reaches main', () => {
    const capture = handlerBody('ipcMain.handle(IPC.captureScreen')
    expect(capture).toMatch(/ScreenScopeSchema/)
    expect(capture.indexOf('requireAuth()')).toBeLessThan(capture.indexOf('ScreenScopeSchema'))
    expect(capture).toMatch(/takeHotPath\('capture-screen'\)/)
    expect(preloadSrc).toMatch(
      /capture:\s*\(scope\?:[^)]*\)[^=]*=>\s*ipcRenderer\.invoke\(IPC\.captureScreen,\s*scope\)/
    )
  })
})

describe('G16 — revocation drops pending capture work', () => {
  it('askStart refuses a frame that was captured before a revocation', () => {
    const ask = handlerBody('ipcMain.handle(IPC.askStart')
    const guard = ask.indexOf('screenObservation.checkSend(req.image)')
    expect(guard).toBeGreaterThan(-1)
    expect(ask.indexOf('if (req.image && privateViewOn())')).toBeLessThan(guard)
    const block = ask.slice(guard - 80, guard + 700)
    expect(block).toMatch(/auditLog\('capture\.dropped'/)
    expect(block).toMatch(/IPC\.streamError/)
    expect(block).toMatch(/\n\s+return\n/)
  })

  it('signing out revokes through the one session-boundary handler', () => {
    expect(functionBody('function revokePrivilegedSurface(')).toMatch(/screenObservation\.revoke\('signed-out'\)/)
  })

  it('ending the listening session revokes, once, on the true-to-false edge', () => {
    const body = functionBody('function setListeningActive(')
    const edge = body.indexOf('if (listeningActive === on) return')
    expect(edge).toBeGreaterThan(-1)
    const revoke = body.indexOf("screenObservation.revoke('session-ended')")
    expect(revoke).toBeGreaterThan(edge)
  })

  it('a settings write reconciles Private View and the Screen Recording grant before the engine refreshes', () => {
    const body = functionBody('function refreshScreenPreprocess(')
    expect(body.indexOf('screenObservation.reconcile()')).toBeGreaterThan(-1)
    expect(body.indexOf('screenObservation.reconcile()')).toBeLessThan(body.indexOf('screenPreprocess.refresh()'))
  })

  it('lock, unlock, suspend and resume are subscribed at boot beside the input-session hooks', () => {
    const hooks = indexSrc.indexOf('installInputPowerLifecycleHooks()\n')
    expect(hooks).toBeGreaterThan(-1)
    expect(indexSrc).toMatch(/installScreenObservationLifecycle\(powerMonitor,\s*screenObservation,\s*mainLog\)/)
  })

  it('a removed display revokes, and the hover pre-capture is gated by the explicit opt-in setting', () => {
    expect(indexSrc).toMatch(/installDisplayRemovalRevocation\(screen,\s*screenObservation,\s*mainLog\)/)
    expect(indexSrc).toMatch(/prewarmAllowed:\s*\(\)\s*=>\s*getSettings\(\)\.screenHoverPrewarm === true/)
  })

  it('the background engine reads the generation from the same observation, after reconciling', () => {
    const engine = indexSrc.slice(
      indexSrc.indexOf('const screenPreprocess: ScreenPreprocess = createScreenPreprocess({')
    )
    // Reading the generation reconciles first, so a grant or Private View change nothing announced is seen.
    expect(engine.slice(0, 3_500)).toMatch(
      /observationGeneration:\s*\(\)\s*=>\s*\{\s*screenObservation\.reconcile\(\)\s*return screenObservation\.generation\(\)/
    )
  })
})
