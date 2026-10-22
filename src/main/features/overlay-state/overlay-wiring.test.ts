import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

// Source pins compare LF text; a Windows checkout may carry CRLF.
const lf = (text: string): string => text.replace(/\r\n/g, '\n')
const index = lf(readModuleSource(__dirname, '../../index').text)
const reconciler = lf(readModuleSource(__dirname, './overlay-reconciler').text)
const state = lf(readModuleSource(__dirname, './overlay-state').text)

function body(source: string, start: string): string {
  const at = source.indexOf(start)
  expect(at, `marker not found: ${start}`).toBeGreaterThan(-1)
  return source.slice(at, at + 1800)
}

describe('G17 overlay reconciler wiring in main', () => {
  it('constructs one reconciler over the real powerMonitor and screen, and starts it with the screen listeners', () => {
    expect(index).toMatch(/import \{ createOverlayReconciler \} from '\.\/features\/overlay-state'/)
    expect(index.match(/createOverlayReconciler\(/g)).toHaveLength(1)
    expect(body(index, 'const overlayReconciler = createOverlayReconciler({')).toMatch(/powerMonitor,\r?\n\s+screen,/)
    expect(body(index, 'function registerScreenListeners(): void {')).toMatch(
      /^function registerScreenListeners\(\): void \{\r?\n\s+overlayReconciler\.start\(\)/
    )
  })

  it('binds each overlay window when it is created and captures intent at every overlay transition note', () => {
    expect(body(index, 'applyOverlayAlwaysOnTop(win)\n    overlayReconciler.bindWindow(win)')).toBeTruthy()
    expect(body(index, 'function noteOverlay(cause: OverlayTransitionCause): void {')).toMatch(
      /overlayReconciler\.captureDesired\(\)/
    )
  })

  it('no longer subscribes to display events directly: the reconciler owns display, resume and unlock', () => {
    expect(index).not.toMatch(/screen\.on\('display-(added|removed|metrics-changed)'/)
    expect(reconciler).toMatch(/'display-added', 'display-removed', 'display-metrics-changed'/)
    expect(reconciler).toMatch(/\['resume', 'resume'\]/)
    expect(reconciler).toMatch(/\['unlock-screen', 'unlock'\]/)
  })

  it('takes protection and click-through from the live settings, never from a stored copy', () => {
    const live = body(index, 'const overlayReconciler = createOverlayReconciler({')
    expect(live).toMatch(/contentProtection: contentProtectionOn\(\)/)
    expect(live).toMatch(/clickThrough: overlayClickThrough\(\)/)
  })

  it('adds no polling: the overlay-state modules arm no timer themselves (bounded passes live in infra/scheduler)', () => {
    for (const source of [reconciler, state]) {
      expect(source).not.toMatch(/\bsetInterval\s*\(/)
      expect(source).not.toMatch(/\bsetTimeout\s*\(/)
    }
    expect(reconciler).toMatch(/from '\.\.\/\.\.\/infra\/scheduler\/bounded-passes'/)
  })
})
