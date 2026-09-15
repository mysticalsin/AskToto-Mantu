import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACT1_DOM_PROBE_DELAY_MS,
  ACT1_DOM_PROBE_EXPR,
  bindAct1DomProbe,
  summarizeAct1Dom
} from './act1-dom-probe'

const expectedUrl = 'file:///fixture/renderer/index.html?exclusiveOnboarding=1'

class ProbeTarget extends EventEmitter {
  url = 'about:blank'
  destroyed = false
  getURL = (): string => this.url
  isDestroyed = (): boolean => this.destroyed
  executeJavaScript = vi.fn(
    (_source: string, _userGesture?: boolean): Promise<unknown> =>
      Promise.resolve({
        search: '?exclusiveOnboarding=1',
        exclusiveOnboarding: true,
        rootChildCount: 1,
        hasOnboardStage: true,
        portalOpen: true,
        hasHeroWordmark: true,
        hasNextButton: true,
        loadingCaption: false,
        agentStatusCaption: false,
        portalContentOpacity: '1',
        wordmarkOpacity: '1',
        nextOpacity: '1'
      })
  )
}

describe('summarizeAct1Dom', () => {
  it('keeps the QA fields the audit trail needs', () => {
    const s = summarizeAct1Dom({
      exclusiveOnboarding: true,
      hasOnboardStage: true,
      portalOpen: true,
      hasHeroWordmark: true,
      hasNextButton: true,
      loadingCaption: false,
      agentStatusCaption: false,
      portalContentOpacity: '1',
      wordmarkOpacity: '1',
      nextOpacity: '1',
      rootChildCount: 2,
      search: '?exclusiveOnboarding=1'
    })
    expect(s.exclusiveOnboarding).toBe(true)
    expect(s.hasNextButton).toBe(true)
    expect(s.portalContentOpacity).toBe('1')
    expect(s.search).toBe('?exclusiveOnboarding=1')
  })
})

describe('bindAct1DomProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores about:blank and does not probe early', async () => {
    const target = new ProbeTarget()
    const writes: string[] = []
    const audits: Array<Record<string, unknown>> = []
    bindAct1DomProbe(target, {
      expectedUrl,
      outPath: '/tmp/act1-dom.json',
      writeFile: ((path: string) => {
        writes.push(path)
      }) as typeof import('node:fs').writeFileSync,
      mkdir: (() => undefined) as typeof import('node:fs').mkdirSync,
      audit: (s) => audits.push(s),
      setTimer: setTimeout
    })
    target.url = 'about:blank'
    target.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(ACT1_DOM_PROBE_DELAY_MS + 500)
    expect(target.executeJavaScript).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  it('after matching did-finish-load waits ≥2s then writes JSON and audits once', async () => {
    const target = new ProbeTarget()
    const writes: Array<{ path: string; data: string }> = []
    const audits: Array<Record<string, unknown>> = []
    bindAct1DomProbe(target, {
      expectedUrl,
      outPath: '/tmp/act1-dom.json',
      writeFile: ((path: string, data: string | NodeJS.ArrayBufferView) => {
        writes.push({ path, data: typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8') })
      }) as typeof import('node:fs').writeFileSync,
      mkdir: (() => undefined) as typeof import('node:fs').mkdirSync,
      audit: (s) => audits.push(s),
      setTimer: setTimeout
    })
    target.url = 'about:blank'
    target.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(100)

    target.url = expectedUrl
    target.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(ACT1_DOM_PROBE_DELAY_MS - 1)
    expect(target.executeJavaScript).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(target.executeJavaScript).toHaveBeenCalledOnce()
    expect(target.executeJavaScript.mock.calls[0][0]).toBe(ACT1_DOM_PROBE_EXPR)
    // allow microtask for write
    await Promise.resolve()
    await Promise.resolve()
    expect(writes.some((w) => w.path === '/tmp/act1-dom.json')).toBe(true)
    expect(audits).toHaveLength(1)
    expect(audits[0].exclusiveOnboarding).toBe(true)
    expect(audits[0].hasOnboardStage).toBe(true)

    target.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(ACT1_DOM_PROBE_DELAY_MS + 50)
    expect(target.executeJavaScript).toHaveBeenCalledOnce()
  })
})

describe('FITO-185-U wiring in createWindow', () => {
  const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))

  it('registers bindAct1DomProbe under LAUNCH_GATE or exclusive', () => {
    expect(index).toMatch(/import \{ bindAct1DomProbe \} from '\.\/act1-dom-probe'/)
    expect(create).toMatch(/bindAct1DomProbe\(/)
    expect(create).toMatch(/ASKTOTO_MAC_LAUNCH_GATE === '1' \|\| onboardingExclusiveLive\(\)/)
    expect(create).toMatch(/act1-dom\.json/)
    expect(create).toMatch(/auditLog\('app\.act1\.dom'/)
  })

  it('probe registers before loadURL', () => {
    expect(create.indexOf('bindAct1DomProbe(')).toBeGreaterThan(-1)
    expect(create.indexOf('bindAct1DomProbe(')).toBeLessThan(create.indexOf('win.loadURL(rendererUrl)'))
  })

  it('keeps FITO-185-N exclusiveOnboarding=1 on packaged loadURL', () => {
    expect(create).toMatch(/params\.set\('exclusiveOnboarding', '1'\)/)
    expect(create).toMatch(/FITO-185-N/)
  })
})
