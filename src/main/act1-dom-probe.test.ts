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
      rootChildCount: 2
    })
    expect(s.exclusiveOnboarding).toBe(true)
    expect(s.hasNextButton).toBe(true)
    expect(s.portalContentOpacity).toBe('1')
    expect(s.rootChildCount).toBe(2)
  })

  it('keeps only structural verdicts, not renderer text, URLs, HTML, or asset paths', () => {
    const privateMarker = 'private-meeting-content-must-not-leave-renderer'
    const s = summarizeAct1Dom({
      exclusiveOnboarding: true,
      hasOnboardStage: true,
      portalOpen: true,
      hasHeroWordmark: true,
      hasNextButton: true,
      href: `file:///private/${privateMarker}`,
      bodyTextHead: privateMarker,
      rootHTML: `<article>${privateMarker}</article>`,
      wordmarkText: privateMarker,
      nextButtonText: privateMarker,
      videoSrc: `https://example.test/${privateMarker}.mp4`,
      videoError: privateMarker,
      search: `?token=${privateMarker}`
    })
    expect(JSON.stringify(s)).not.toContain(privateMarker)
    expect(s).not.toHaveProperty('search')
    expect(s).not.toHaveProperty('videoSrcHead')
    expect(s).not.toHaveProperty('videoError')
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

  it('writes only a sanitized structural summary when the renderer returns private strings', async () => {
    const privateMarker = 'private-meeting-content-must-not-leave-renderer'
    const target = new ProbeTarget()
    target.executeJavaScript.mockResolvedValue({
      exclusiveOnboarding: true,
      hasOnboardStage: true,
      portalOpen: true,
      hasHeroWordmark: true,
      hasNextButton: true,
      href: `file:///private/${privateMarker}`,
      bodyTextHead: privateMarker,
      rootHTML: `<article>${privateMarker}</article>`,
      videoSrc: `https://example.test/${privateMarker}.mp4`,
      videoError: privateMarker
    })
    const writes: string[] = []
    bindAct1DomProbe(target, {
      expectedUrl,
      outPath: '/tmp/act1-dom.json',
      writeFile: ((_path: string, data: string | NodeJS.ArrayBufferView) => {
        writes.push(typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8'))
      }) as typeof import('node:fs').writeFileSync,
      mkdir: (() => undefined) as typeof import('node:fs').mkdirSync,
      setTimer: setTimeout
    })
    target.url = expectedUrl
    target.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(ACT1_DOM_PROBE_DELAY_MS)
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toContain(privateMarker)
  })
})

describe('FITO-185-U wiring in createWindow', () => {
  const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))

  it('registers bindAct1DomProbe under LAUNCH_GATE or exclusive', () => {
    expect(index).toMatch(/import \{ bindAct1DomProbe \} from '\.\/act1-dom-probe'/)
    expect(create).toMatch(/bindAct1DomProbe\(/)
    expect(create).toMatch(/if \(process\.env\.ASKTOTO_MAC_LAUNCH_GATE === '1'\)/)
    expect(create).not.toMatch(/ASKTOTO_MAC_LAUNCH_GATE === '1' \|\| onboardingExclusiveLive\(\)/)
    expect(create).toMatch(/act1-dom\.json/)
    expect(create).toMatch(/auditLog\('app\.act1\.dom'/)
  })

  it('probe registers before loadURL', () => {
    expect(create.indexOf('bindAct1DomProbe(')).toBeGreaterThan(-1)
    expect(create.indexOf('bindAct1DomProbe(')).toBeLessThan(create.indexOf('win.loadURL(rendererUrl)'))
  })

  it('keeps FITO-185-N exclusiveOnboarding=1 on packaged loadURL', () => {
    // URL construction is shared with renderer-crash recovery. Keeping it outside createWindow prevents
    // the recovery path from silently dropping the parser-time onboarding shell flag.
    expect(index).toMatch(/function overlayRendererUrl\(\): string/)
    expect(index).toMatch(/if \(onboardingExclusiveLive\(\)\) params\.set\('exclusiveOnboarding', '1'\)/)
    expect(create).toMatch(/FITO-185-N/)
  })
})

describe('FITO-185-X act1-dom miss artifact', () => {
  it('exports a miss budget and bind writes never-armed when load never matches', async () => {
    const { ACT1_DOM_PROBE_MISS_MS, bindAct1DomProbe } = await import('./act1-dom-probe')
    expect(ACT1_DOM_PROBE_MISS_MS).toBeGreaterThanOrEqual(5000)
    const writes: string[] = []
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
    const target = {
      on(event: string, listener: (...args: unknown[]) => void) {
        ;(listeners[event] ??= []).push(listener)
      },
      getURL: () => 'about:blank',
      isDestroyed: () => false,
      executeJavaScript: async () => ({})
    }
    let now = 0
    const timers: Array<{ ms: number; fn: () => void }> = []
    bindAct1DomProbe(target, {
      expectedUrl: 'file:///private/meeting-content?token=must-not-be-exported',
      outPath: '/tmp/act1-dom-miss-test.json',
      delayMs: 10,
      timeoutMs: 20,
      writeFile: ((path: string, data: string | NodeJS.ArrayBufferView) => {
        writes.push(String(data))
      }) as typeof import('node:fs').writeFileSync,
      mkdir: (() => undefined) as typeof import('node:fs').mkdirSync,
      setTimer: ((fn: () => void, ms: number) => {
        timers.push({ ms, fn: fn as () => void })
        return 1 as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
      now: () => new Date('2026-09-15T21:00:00.000Z')
    })
    // Fire blank load (should not arm) then advance miss timer
    for (const l of listeners['did-finish-load'] ?? []) l()
    const miss = timers.find((t) => t.ms >= 5000) ?? timers.sort((a, b) => b.ms - a.ms)[0]
    expect(miss).toBeTruthy()
    miss!.fn()
    expect(writes.some((w) => w.includes('act1-dom-miss: never-armed'))).toBe(true)
    expect(writes.join('\n')).not.toContain('private/meeting-content')
    expect(writes.join('\n')).not.toContain('must-not-be-exported')
  })
})

describe('MQA-338 — Act 1 diagnostics are evidence-only, never renderer-content export', () => {
  const source = readFileSync(join(__dirname, 'act1-dom-probe.ts'), 'utf8')

  it('does not inspect or serialize document text, markup, URLs, or media locations', () => {
    expect(source).not.toMatch(/document\.body\.innerText/)
    expect(source).not.toMatch(/location\.href/)
    expect(source).not.toMatch(/rootHTML/)
    expect(source).not.toMatch(/bodyTextHead/)
    expect(source).not.toMatch(/videoSrc/)
    expect(source).not.toMatch(/videoError/)
    expect(source).not.toMatch(/expectedUrl,\s*liveUrl/)
    expect(source).not.toMatch(/liveUrl:/)
  })
})
