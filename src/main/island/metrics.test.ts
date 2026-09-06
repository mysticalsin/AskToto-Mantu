import { describe, it, expect, vi, beforeEach } from 'vitest'

const screenListeners: Record<string, (() => void)[]> = {}
const powerMonitorListeners: Record<string, (() => void)[]> = {}

vi.mock('electron', () => ({
  screen: {
    on: (evt: string, fn: () => void) => {
      ;(screenListeners[evt] ??= []).push(fn)
    }
  },
  powerMonitor: {
    on: (evt: string, fn: () => void) => {
      ;(powerMonitorListeners[evt] ??= []).push(fn)
    }
  }
}))

const getMacScreenMetrics = vi.fn()
vi.mock('../mac-helper', () => ({ getMacScreenMetrics: (...args: unknown[]) => getMacScreenMetrics(...args) }))
vi.mock('../logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

import { getDisplayMetrics, invalidateDisplayMetricsCache, registerDisplayMetricsInvalidation } from './metrics'

const DISPLAY = { id: 7, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 0, width: 1512, height: 944 } }

/**
 * island/metrics.test.ts — MQA-275. Covers the helper-JSON-present path, the malformed/missing-helper
 * fallback to the heuristic, and cache invalidation on display/power events. Real Swift compilation and
 * an actual notch Mac are NOT exercisable here — see this file's and metrics.ts's header notes.
 */
describe('MQA-275 — island display metrics: helper path', () => {
  beforeEach(() => {
    invalidateDisplayMetricsCache()
    getMacScreenMetrics.mockReset()
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
  })

  it('returns the heuristic immediately on a cold cache, never blocking on the helper spawn', () => {
    getMacScreenMetrics.mockReturnValue(new Promise(() => {})) // never resolves within this test
    const m = getDisplayMetrics(DISPLAY)
    expect(m.source).toBe('heuristic')
  })

  it('uses the helper metrics once the background fetch resolves, joined by displayID', async () => {
    getMacScreenMetrics.mockResolvedValue([
      { displayID: 7, notchWidth: 200, safeAreaInsetTop: 37, frame: [0, 0, 1512, 982], visibleFrame: [0, 0, 1512, 944], auxLeftWidth: 656, auxRightWidth: 656, backingScaleFactor: 2 },
      { displayID: 99, notchWidth: 0, safeAreaInsetTop: 24, frame: [0, 0, 1920, 1080], visibleFrame: [0, 0, 1920, 1032], auxLeftWidth: 0, auxRightWidth: 0, backingScaleFactor: 1 }
    ])
    getDisplayMetrics(DISPLAY) // kicks off the fetch
    await new Promise((r) => setTimeout(r, 0)) // let the mocked promise settle
    const m = getDisplayMetrics(DISPLAY)
    expect(m.source).toBe('helper')
    expect(m.hasNotch).toBe(true)
    expect(m.notchWidth).toBe(200)
    expect(m.menuBarHeight).toBe(37)
    // bounds/workArea are ALWAYS the live Electron display's — never the helper's AppKit frame/
    // visibleFrame (bottom-left origin), which would silently mis-position the window if mixed in.
    expect(m.bounds).toEqual(DISPLAY.bounds)
    expect(m.workArea).toEqual(DISPLAY.workArea)
  })

  it('reports source "helper" with hasNotch false for a display present in the payload but notch-free', async () => {
    getMacScreenMetrics.mockResolvedValue([{ displayID: 7, notchWidth: 0, safeAreaInsetTop: 24, frame: [0, 0, 1, 1], visibleFrame: [0, 0, 1, 1], auxLeftWidth: 0, auxRightWidth: 0, backingScaleFactor: 1 }])
    getDisplayMetrics(DISPLAY)
    await new Promise((r) => setTimeout(r, 0))
    const m = getDisplayMetrics(DISPLAY)
    expect(m.source).toBe('helper')
    expect(m.hasNotch).toBe(false)
  })

  it('falls back to the heuristic when the display id is absent from the helper payload', async () => {
    getMacScreenMetrics.mockResolvedValue([{ displayID: 999, notchWidth: 200, safeAreaInsetTop: 37, frame: [0, 0, 1, 1], visibleFrame: [0, 0, 1, 1], auxLeftWidth: 0, auxRightWidth: 0, backingScaleFactor: 1 }])
    getDisplayMetrics(DISPLAY)
    await new Promise((r) => setTimeout(r, 0))
    const m = getDisplayMetrics(DISPLAY)
    expect(m.source).toBe('heuristic')
    // A notch-shaped menu-bar gap (982 - 944 = 38px) still flags true on the heuristic path.
    expect(m.hasNotch).toBe(true)
  })

  it('falls back to the heuristic when the helper resolves null (missing binary / spawn failure)', async () => {
    getMacScreenMetrics.mockResolvedValue(null)
    getDisplayMetrics(DISPLAY)
    await new Promise((r) => setTimeout(r, 0))
    const m = getDisplayMetrics(DISPLAY)
    expect(m.source).toBe('heuristic')
  })

  it('falls back to the heuristic when the helper promise rejects, without throwing', async () => {
    getMacScreenMetrics.mockRejectedValue(new Error('spawn ENOENT'))
    expect(() => getDisplayMetrics(DISPLAY)).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(() => getDisplayMetrics(DISPLAY)).not.toThrow()
    expect(getDisplayMetrics(DISPLAY).source).toBe('heuristic')
  })

  it('invalidateDisplayMetricsCache() forces a fresh fetch on the next call', async () => {
    getMacScreenMetrics.mockResolvedValue([{ displayID: 7, notchWidth: 200, safeAreaInsetTop: 37, frame: [0, 0, 1, 1], visibleFrame: [0, 0, 1, 1], auxLeftWidth: 0, auxRightWidth: 0, backingScaleFactor: 1 }])
    getDisplayMetrics(DISPLAY)
    await new Promise((r) => setTimeout(r, 0))
    expect(getDisplayMetrics(DISPLAY).source).toBe('helper')
    invalidateDisplayMetricsCache()
    expect(getMacScreenMetrics).toHaveBeenCalledTimes(1)
    expect(getDisplayMetrics(DISPLAY).source).toBe('heuristic') // cold again until the re-fetch resolves
    await new Promise((r) => setTimeout(r, 0))
    expect(getMacScreenMetrics).toHaveBeenCalledTimes(2)
  })

  it('does not spawn the helper at all on non-darwin platforms', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const m = getDisplayMetrics(DISPLAY)
    expect(getMacScreenMetrics).not.toHaveBeenCalled()
    expect(m.source).toBe('heuristic')
    expect(m.hasNotch).toBe(false) // hasNotchHeuristic always false off darwin, whatever the math says
  })
})

describe('MQA-275 — registerDisplayMetricsInvalidation wiring', () => {
  it('subscribes to every display-topology event and powerMonitor resume', () => {
    for (const key of Object.keys(screenListeners)) delete screenListeners[key]
    for (const key of Object.keys(powerMonitorListeners)) delete powerMonitorListeners[key]
    registerDisplayMetricsInvalidation()
    expect(screenListeners['display-added']?.length).toBeGreaterThan(0)
    expect(screenListeners['display-removed']?.length).toBeGreaterThan(0)
    expect(screenListeners['display-metrics-changed']?.length).toBeGreaterThan(0)
    expect(powerMonitorListeners['resume']?.length).toBeGreaterThan(0)
  })

  it('firing a registered listener actually invalidates the cache', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    getMacScreenMetrics.mockResolvedValue([{ displayID: 7, notchWidth: 200, safeAreaInsetTop: 37, frame: [0, 0, 1, 1], visibleFrame: [0, 0, 1, 1], auxLeftWidth: 0, auxRightWidth: 0, backingScaleFactor: 1 }])
    getDisplayMetrics(DISPLAY)
    await new Promise((r) => setTimeout(r, 0))
    expect(getDisplayMetrics(DISPLAY).source).toBe('helper')
    screenListeners['display-metrics-changed']?.forEach((fn) => fn())
    expect(getDisplayMetrics(DISPLAY).source).toBe('heuristic')
  })
})
