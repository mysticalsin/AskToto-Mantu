import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASKTOTO_SHOT_DELAY_MS,
  bindAskTotoShot,
  isRealRendererShotUrl
} from './asktoto-shot'

const expectedUrl = 'file:///fixture/renderer/index.html'

class ShotTarget extends EventEmitter {
  url = 'about:blank'
  destroyed = false
  getURL = (): string => this.url
  isDestroyed = (): boolean => this.destroyed
  isLoading = (): boolean => false
  executeJavaScript = vi.fn((): Promise<unknown> => Promise.resolve({ ok: true }))
  capturePage = vi.fn((): Promise<{ toPNG(): Buffer }> =>
    Promise.resolve({ toPNG: () => Buffer.from('png') })
  )
}

describe('isRealRendererShotUrl', () => {
  it('rejects about:blank and empty', () => {
    expect(isRealRendererShotUrl('about:blank', expectedUrl)).toBe(false)
    expect(isRealRendererShotUrl('', expectedUrl)).toBe(false)
    expect(isRealRendererShotUrl(expectedUrl, '')).toBe(false)
  })

  it('accepts the exact expected renderer index.html URL', () => {
    expect(isRealRendererShotUrl(expectedUrl, expectedUrl)).toBe(true)
  })

  it('rejects unrelated URLs even if loaded', () => {
    expect(isRealRendererShotUrl('https://evil.example/', expectedUrl)).toBe(false)
  })
})

describe('bindAskTotoShot — after real load only', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores about:blank did-finish-load and does not dump early', async () => {
    const target = new ShotTarget()
    const writes: Array<{ path: string; data: string | Buffer }> = []
    bindAskTotoShot(target, {
      shotPath: '/tmp/feel-shot.png',
      expectedUrl,
      writeFile: ((path: string, data: string | NodeJS.ArrayBufferView) => {
        writes.push({ path, data: typeof data === 'string' ? data : Buffer.from(data as Buffer) })
      }) as typeof import('node:fs').writeFileSync,
      setTimer: setTimeout
    })
    target.url = 'about:blank'
    target.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(ASKTOTO_SHOT_DELAY_MS + 500)
    expect(target.executeJavaScript).not.toHaveBeenCalled()
    expect(target.capturePage).not.toHaveBeenCalled()
    expect(writes.some((w) => w.path.endsWith('.loaded.txt'))).toBe(false)
  })

  it('after matching did-finish-load waits ≥2s then dumps once', async () => {
    const target = new ShotTarget()
    const writes: Array<{ path: string }> = []
    bindAskTotoShot(target, {
      shotPath: '/tmp/feel-shot.png',
      expectedUrl,
      writeFile: ((path: string) => {
        writes.push({ path })
      }) as typeof import('node:fs').writeFileSync,
      setTimer: setTimeout
    })
    // about:blank first (K2 race shape)
    target.url = 'about:blank'
    target.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(100)
    expect(target.capturePage).not.toHaveBeenCalled()

    target.url = expectedUrl
    target.emit('did-finish-load')
    expect(writes.some((w) => w.path.endsWith('.loaded.txt'))).toBe(true)
    expect(target.capturePage).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(ASKTOTO_SHOT_DELAY_MS - 1)
    expect(target.capturePage).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(target.executeJavaScript).toHaveBeenCalledOnce()
    expect(target.capturePage).toHaveBeenCalledOnce()

    // Second finish must not re-arm
    target.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(ASKTOTO_SHOT_DELAY_MS + 50)
    expect(target.capturePage).toHaveBeenCalledOnce()
  })

  it('delay floor is at least 2000ms', () => {
    expect(ASKTOTO_SHOT_DELAY_MS).toBeGreaterThanOrEqual(2000)
  })
})

describe('FITO-185-L main wiring contract', () => {
  const main = readFileSync(join(__dirname, './index.ts'), 'utf8')

  it('uses bindAskTotoShot after rendererUrl is known; no early about:blank dump', () => {
    expect(main).toMatch(/import \{ bindAskTotoShot \} from '\.\/asktoto-shot'/)
    expect(main).toMatch(/bindAskTotoShot\(/)
    expect(main).not.toMatch(/if \(!win\.webContents\.isLoading\(\) && win\.webContents\.getURL\(\)\)/)
    expect(main).not.toMatch(/dumpDomAndCapture\('ready'\)/)
    expect(main).not.toMatch(/dumpDomAndCapture\('t0'\)/)
    // Shot must not replace loadURL
    const shotIdx = main.indexOf('bindAskTotoShot(')
    const loadIdx = main.indexOf('win.loadURL(rendererUrl)')
    expect(shotIdx).toBeGreaterThan(0)
    expect(loadIdx).toBeGreaterThan(shotIdx)
  })
})
