/**
 * Pins the Settings / overlay screen-capture self-check wiring in index.ts.
 * index.ts boots Electron at import, so this is a source-contract test (same pattern as
 * ask-routing-fixes.contract.test.ts). Behavior of probe vs vision vs failover lives in
 * screen-capture-check.test.ts against the live runner.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const preloadSrc = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')

function blockAfter(source: string, marker: string): string {
  const at = source.indexOf(marker)
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced block after ${marker}`)
}

const handler = blockAfter(indexSrc, 'ipcMain.handle(IPC.screenCaptureCheck')

describe('screen-capture self-check wiring', () => {
  it('the second check is runScreenCaptureCheck(vision), not a second OS probe', () => {
    expect(handler).toMatch(/runScreenCaptureCheck\(parsed\.pass/)
    expect(handler).toMatch(/askVision:\s*askVisionForScreenCheck/)
    expect(handler).toMatch(/probe:\s*probeScreenCapture/)
    expect(handler).toMatch(/getScreenshot\('screen-check'\)/)
    // The handler must not treat vision as another probeScreenCapture-only path.
    expect(handler).not.toMatch(/if \(parsed\.pass === 'vision'\)[\s\S]{0,200}probeScreenCapture\(\)/)
  })

  it('the vision ask goes through createStream (local or API), never askStart', () => {
    expect(indexSrc).toMatch(/function askVisionForScreenCheck/)
    const start = indexSrc.indexOf('Isolated vision ask for the Settings self-check')
    const end = indexSrc.indexOf('// --- Background screen preprocessing', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const ask = indexSrc.slice(start, end)
    expect(ask).toMatch(/createStream\(/)
    expect(ask).toMatch(/providerId: 'local'/)
    expect(ask).toMatch(/freshConversation:\s*true/)
    expect(ask).not.toMatch(/IPC\.askStart/)
    expect(ask).not.toMatch(/mcp\.push|outlookCreate|timeSavedRecord/)
    expect(handler).not.toMatch(/IPC\.askStart|mcp\.push|outlookCreate/)
  })

  it('is a signed-in Settings self-check and audits without sending the frame to a teammate', () => {
    expect(handler).toMatch(/if \(!requireAuth\(\)\)/)
    expect(handler.indexOf('if (!requireAuth())')).toBeLessThan(handler.indexOf('runScreenCaptureCheck'))
    expect(handler).toMatch(/auditLog\('capture.check'/)
    expect(handler).not.toMatch(/win\?\.webContents\.send\(IPC\.stream/)
  })

  it('preload exposes the dedicated channel and not a chat ask', () => {
    expect(preloadSrc).toMatch(/screenCaptureCheck:\s*\(pass: 'probe' \| 'vision'\)/)
    expect(preloadSrc).toMatch(/IPC\.screenCaptureCheck/)
  })
})
