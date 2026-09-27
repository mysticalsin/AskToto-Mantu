import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Source-contract test for the will-quit crash fix (same structural-proof pattern as
 * local-routing.test.ts / crash-capture.test.ts). The observed crash was an UNCAUGHT
 * "globalShortcut cannot be used before the app is ready" thrown from the will-quit handler when the
 * app quit before it ever finished becoming ready (a quit during async startup, an automation
 * app.close(), or an early abort). The raw invariant: at module scope, before the app is ready,
 * globalShortcut.unregisterAll() throws exactly that string — so the handler must gate the call behind
 * an app.isReady() check. This test pins that guard so a future edit can't silently reintroduce the
 * crash.
 */
describe('will-quit handler crash guard', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const handler = (() => {
    const start = source.indexOf("app.on('will-quit'")
    expect(start).toBeGreaterThan(-1)
    // Grab a generous slice of the handler body (wide enough to include the isReady() guard around
    // globalShortcut.unregisterAll() and the tracked background-timer cancellation loop that follows it —
    // owned-sidecar teardown itself now runs earlier, through installExitPaths's own will-quit listener).
    return source.slice(start, start + 2800)
  })()

  it('gates globalShortcut on app.isReady() (never calls it before ready)', () => {
    // The isReady() check must appear BEFORE the globalShortcut call in the handler.
    const guardIdx = handler.indexOf('app.isReady()')
    const callIdx = handler.indexOf('globalShortcut.unregisterAll()')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(callIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(callIdx)
  })

  it('wraps the globalShortcut call in try/catch so a throw never escapes as uncaught', () => {
    // Between the guard and the background-timer cleanup that follows it, there must be a try around the
    // globalShortcut call.
    const seg = handler.slice(handler.indexOf('app.isReady()'), handler.indexOf('if (notifTimer)'))
    expect(seg).toMatch(/try\s*\{/)
    expect(seg).toMatch(/catch/)
  })
})
