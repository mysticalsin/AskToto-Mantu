import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'

/**
 * Q12 wiring pins for src/main/index.ts (the behaviour lives in extracted modules with their own tests):
 * D10-5 shortcut push, D10-11 tray label, D10-12 reanchor guard, D10-13 crash-log pruning, D2-9/D9-6 notifier.
 */
const source = readModuleSource(__dirname, './index').text.replace(/\r\n/g, '\n')

function body(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start, startMarker).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(end, endMarker).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('index.ts Q12 wiring', () => {
  it('shortcut failures are pushed to the overlay after registerShortcuts (D10-5)', () => {
    const fn = body('function registerShortcuts(): void {', '\nlet notifTimer')
    expect(fn).toMatch(/win\.webContents\.send\(IPC\.shortcutFailuresChanged, shortcutFailures\)/)
    // The push is the last thing registerShortcuts does, after every failure has been recorded.
    expect(fn.lastIndexOf('shortcutFailures.push')).toBeLessThan(fn.indexOf('IPC.shortcutFailuresChanged'))
  })

  it('the tray listen item follows listeningActive (D10-11)', () => {
    const fn = body('function buildTrayMenu(): Menu {', 'const startTrayBuild')
    expect(fn).toMatch(/trayListenBase\(listeningActive\)/)
    expect(fn).not.toContain('Listen / Stop listening')
  })

  it('reanchor skips a destroyed window and never throws out of a screen listener (D10-12)', () => {
    // G17: the screen listeners moved into the overlay reconciler; the guard and the catch live on that path.
    const fn = body('function reanchorOverlayWindow(): void {', 'const overlayReconciler')
    expect(fn).toMatch(/if \(!win \|\| win\.isDestroyed\(\)\) return/)
    const wiring = body('const overlayReconciler = createOverlayReconciler({', '\n})')
    expect(wiring).toMatch(/window: \(\) => \(win && !win\.isDestroyed\(\) \? win : null\)/)
    expect(wiring).toMatch(/onError: .*mainLog\.warn/)
    const reconciler = readModuleSource(__dirname, './features/overlay-state/overlay-reconciler').text
    expect(reconciler).toMatch(/try \{\s*apply\(win, action\)\s*\} catch \(error\) \{\s*report\(/)
  })

  it('prunes crash logs after each persisted crash and throttles renderer reports (D10-13)', () => {
    expect(body('function persistCrash(', '\n/**')).toMatch(/pruneCrashLogs\(/)
    expect(body('ipcMain.handle(IPC.rendererCrash', 'persistCrash(')).toMatch(/allowRendererCrashFile\(\)/)
  })

  it('delegates the meeting notifier to calendar/meeting-alert and reveals on click without starting (D2-9, D9-6)', () => {
    const fn = body('function startMeetingNotifier(): void {', 'function buildTrayMenu')
    expect(fn).toContain('createMeetingAlert(')
    expect(fn).toMatch(/denyIfLimited\('graph-calendar'\)/)
    expect(fn).toMatch(/\.on\('click', \(\) => reveal\('notification-click', \{ focus: false \}\)\)/)
    expect(fn).not.toMatch(/starts in 1 minute/)
    expect(fn).not.toMatch(/sendHotkey\('toggle-listen'\)|meetingStartActivationAuthority/)
  })
})
