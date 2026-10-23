import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'

/** index.ts boots Electron at import time, so the ordering contract is read from its source (M2 pattern). */
const index = readModuleSource(__dirname, './index').text.replace(/\r\n/g, '\n')

describe('G85 startup ordering', () => {
  it('claims startup (OS floor + single-instance lock) before whenReady, with no direct lock call left', () => {
    const claim = index.indexOf('claimStartup(')
    const ready = index.indexOf('.whenReady()', claim)
    expect(claim).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(claim)
    expect(index).not.toMatch(/app\.requestSingleInstanceLock\(\)/)
  })

  it('nothing at module level before the claim opens a window, mic or usage event', () => {
    const before = index.slice(0, index.indexOf('claimStartup('))
    const topLevel = before
      .split('\n')
      .filter(
        (l) =>
          /^[A-Za-z]/.test(l) &&
          !/^(import|export|function|async function|const|let|type|interface|class|enum|declare)\b/.test(l)
      )
    for (const line of topLevel.filter((l) => !l.startsWith('if (QA_IDENTITY_BUILD)'))) {
      expect(line, line).not.toMatch(/createWindow|ensureWindow|startMic|usage|auditLog|new BrowserWindow/)
    }
  })

  it('the second-instance handler only reveals and forwards argv', () => {
    const body = index.slice(
      index.indexOf('claimStartup('),
      index.indexOf('.whenReady()', index.indexOf('claimStartup('))
    )
    expect(body).toMatch(/reveal\('second-instance', \{ focus: true \}\)/)
    expect(body).toMatch(/argv: handleSmokeReopenProbe/)
    expect(body).not.toMatch(/createWindow|startMic|auditLog/)
  })

  it('boot reconcile delegates to the OS-authority module', () => {
    expect(index).toMatch(/reconcileLoginItem\(/)
    expect(index).not.toMatch(/app\.setLoginItemSettings\(\{ openAtLogin: want \}\)/)
  })
})
