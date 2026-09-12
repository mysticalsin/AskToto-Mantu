import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindRendererReadiness, RENDERER_READY_PROBE } from './renderer-readiness'

const expectedUrl = 'file:///fixture/renderer/index.html'
class Renderer extends EventEmitter {
  url = expectedUrl
  destroyed = false
  getURL = () => this.url
  isDestroyed = () => this.destroyed
  executeJavaScript = vi.fn((_source: string): Promise<unknown> => Promise.resolve(true))
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('MQA-318 real renderer readiness signal', () => {
  it('requires document load followed by a successful responsive renderer probe', async () => {
    const renderer = new Renderer()
    const ready = vi.fn()
    bindRendererReadiness(renderer, expectedUrl, ready)
    expect(ready).not.toHaveBeenCalled()
    expect(renderer.executeJavaScript).not.toHaveBeenCalled()
    renderer.emit('did-finish-load')
    expect(ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(renderer.executeJavaScript).toHaveBeenCalledWith(RENDERER_READY_PROBE)
    expect(ready).toHaveBeenCalledOnce()
    renderer.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never probes a different renderer URL', async () => {
    const renderer = new Renderer()
    const ready = vi.fn()
    bindRendererReadiness(renderer, expectedUrl, ready)
    renderer.url = 'https://unexpected.example/'
    renderer.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(0)
    expect(renderer.executeJavaScript).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })

  it('does not evaluate a queued probe after navigation has already invalidated its document', async () => {
    const renderer = new Renderer()
    const ready = vi.fn()
    bindRendererReadiness(renderer, expectedUrl, ready)
    renderer.emit('did-finish-load')
    renderer.url = 'https://unexpected.example/'
    renderer.emit('did-start-loading')
    await vi.advanceTimersByTimeAsync(0)
    expect(renderer.executeJavaScript).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })

  it.each(['did-start-loading', 'did-fail-load', 'render-process-gone', 'destroyed'])(
    'rejects a probe which finishes after %s', async (event) => {
      const renderer = new Renderer()
      const ready = vi.fn()
      let resolve!: (value: unknown) => void
      renderer.executeJavaScript.mockReturnValue(new Promise((r) => { resolve = r }))
      bindRendererReadiness(renderer, expectedUrl, ready)
      renderer.emit('did-finish-load')
      renderer.emit(event)
      resolve(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(ready).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not announce an empty root, rejected script, or hung renderer as ready', async () => {
    for (const outcome of ['empty', 'rejected', 'hung']) {
      const renderer = new Renderer()
      const ready = vi.fn()
      renderer.executeJavaScript.mockImplementation(() => outcome === 'empty'
        ? Promise.resolve(false)
        : outcome === 'rejected' ? Promise.reject(new Error('renderer failed')) : new Promise(() => {}))
      bindRendererReadiness(renderer, expectedUrl, ready)
      renderer.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ready).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('the read-only probe requires the bridge, completed load, and actual mounted root', async () => {
    const bridge = { getSettings: vi.fn() }
    const document = { readyState: 'loading', getElementById: vi.fn(() => ({ childElementCount: 0 })) }
    const context = { document, window: { toto: undefined as unknown }, Date, setTimeout }
    let resolved = false
    const result = (runInNewContext(RENDERER_READY_PROBE, context) as Promise<boolean>).then((value) => {
      resolved = true
      return value
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(resolved).toBe(false)
    document.readyState = 'complete'
    context.window.toto = bridge
    await vi.advanceTimersByTimeAsync(100)
    expect(resolved).toBe(false)
    document.getElementById.mockReturnValue({ childElementCount: 1 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toBe(true)
    expect(bridge.getSettings).not.toHaveBeenCalled()
  })

  it('a missing preload or mounted root times out instead of reporting ready', async () => {
    const result = runInNewContext(RENDERER_READY_PROBE, {
      document: { readyState: 'complete', getElementById: () => null },
      window: {}, Date, setTimeout
    }) as Promise<boolean>
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toBe(false)
  })

  it('binds the isolated launch probe before navigation and preserves app.started', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const body = source.slice(source.indexOf('function createWindow(): void {'), source.indexOf('\nfunction resizeTo('))
    const bind = body.indexOf('bindRendererReadiness(')
    expect(bind).toBeGreaterThan(body.indexOf('win = new BrowserWindow('))
    expect(bind).toBeLessThan(body.indexOf('win.loadURL(rendererUrl)'))
    expect(bind).toBeLessThan(body.indexOf("win.loadFile(join(__dirname, '../renderer/index.html'))", bind))
    expect(body).toContain("auditLog('app.started'")
    expect(body).toContain("auditLog('app.renderer.ready'")
  })
})
