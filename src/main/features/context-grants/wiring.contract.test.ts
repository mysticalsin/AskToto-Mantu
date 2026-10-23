import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

const lf = (text: string): string => text.replace(/\r\n/g, '\n')
const mainDir = join(__dirname, '..', '..')
const indexSrc = lf(readModuleSource(mainDir, './index').text)
const askStart = indexSrc.slice(
  indexSrc.indexOf('ipcMain.handle(IPC.askStart'),
  indexSrc.indexOf('ipcMain.handle(IPC.askCancel')
)

describe('context grants are wired into main (contract)', () => {
  it('composes the feature at IPC registration with the real screen observation and reader', () => {
    expect(indexSrc).toMatch(/contextGrants = composeContextGrants\(\{/)
    expect(indexSrc).toMatch(/foreground: \(\) => screenPreprocess\.foreground\(\)/)
  })

  it('ends snapshots and grants whenever screen access is revoked (stop, sign-out, lock, Private View)', () => {
    expect(indexSrc).toMatch(/if \(sourceId === null\) void contextGrants\?\.revokeAll\(/)
  })

  it('every ask prepares its context and manifest once, before dispatch', () => {
    expect(askStart.length).toBeGreaterThan(1000)
    const prepare = askStart.indexOf('contextGrants?.runtime.prepareTurn(')
    expect(prepare).toBeGreaterThan(-1)
    expect(askStart.match(/runtime\.prepareTurn\(/g)).toHaveLength(1)
    expect(prepare).toBeLessThan(askStart.indexOf('planAsk('))
    expect(askStart).toContain('manifest')
  })

  it('the ask handler has no capture call of its own: a typed question never captures the screen', () => {
    expect(askStart).not.toMatch(/getScreenshot\(|screenObservation\.capture\(|captureScreenshotOnce\(|desktopCapturer/)
  })

  it('the memory slice is reported to the manifest when it is really attached', () => {
    expect(askStart).toMatch(
      /onApplied: \(text, sources\) => contextGrants\?\.manifests\.setMemory\(req\.id, text, sources\)/
    )
  })
})
