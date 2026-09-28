import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

function functionBody(name: string): string {
  const marker = `function ${name}(`
  const start = indexSrc.indexOf(marker)
  expect(start, `${name} not found in index.ts`).toBeGreaterThan(-1)
  const braceOpen = indexSrc.indexOf('{', start)
  expect(braceOpen, `${name}: opening brace not found`).toBeGreaterThan(-1)
  let depth = 0
  let i = braceOpen
  for (; i < indexSrc.length; i++) {
    if (indexSrc[i] === '{') depth++
    else if (indexSrc[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  expect(i, `${name}: matching closing brace not found`).toBeLessThan(indexSrc.length)
  return indexSrc.slice(start, i + 1)
}

describe('M2-0036 Restart Métis window tray state wiring', () => {
  it.each(['setListeningActive', 'setAudioArmed', 'setLegacyListeningActive', 'setCloudSttIpcOwner'])(
    '%s refreshes the tray menu when the capture state changes',
    (name) => {
      const body = functionBody(name)
      expect(body).toContain('rebuildTrayMenu()')
    }
  )

  it('the audio arming IPC updates the tray restart state through the setter', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.armAudio')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 400)
    expect(body).toContain('setAudioArmed(!!on)')
  })

  it('cloud STT start, failed start, and stop update the tray restart state through the setter', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.cloudSttStart')
    const stop = indexSrc.indexOf('ipcMain.handle(IPC.cloudSttStop')
    const push = indexSrc.indexOf('ipcMain.handle(IPC.cloudSttPush')
    expect(start).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(start)
    expect(push).toBeGreaterThan(stop)

    expect(indexSrc.slice(start, stop)).toContain('setCloudSttIpcOwner(owner)')
    expect(indexSrc.slice(start, stop)).toContain('setCloudSttIpcOwner(null)')
    expect(indexSrc.slice(stop, push)).toContain('setCloudSttIpcOwner(null)')
  })
})
