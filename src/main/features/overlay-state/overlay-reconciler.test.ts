import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { PassTimers } from '../../infra/scheduler/bounded-passes'
import { createOverlayReconciler, type OverlayLive, type OverlayReconcilerPorts } from './overlay-reconciler'
import type { DisplayInfo, Rect } from './overlay-state'

const left: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 39, width: 1512, height: 943 }
}
const right: DisplayInfo = {
  id: 2,
  bounds: { x: 1512, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1512, y: 25, width: 1920, height: 1055 }
}
const bar: Rect = { x: 316, y: 47, width: 880, height: 120 }

function fakeClock(): PassTimers & { advance(ms: number): void; pending(): number } {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    setTimeout(run, ms) {
      const id = next++
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].run()
      }
      now = target
    },
    pending: () => timers.size
  }
}

class FakeWindow extends EventEmitter {
  bounds: Rect = { ...bar }
  visible = true
  onTop = true
  destroyed = false
  setBoundsCalls: Rect[] = []
  showCalls = 0
  protectionCalls: boolean[] = []
  clickThroughCalls: boolean[] = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  getBounds(): Rect {
    return { ...this.bounds }
  }
  setBounds(b: Rect): void {
    this.setBoundsCalls.push(b)
    this.bounds = { ...b }
    this.emit('resize')
    this.emit('move')
  }
  isVisible(): boolean {
    return this.visible
  }
  isAlwaysOnTop(): boolean {
    return this.onTop
  }
  showInactive(): void {
    this.showCalls += 1
    this.visible = true
  }
  setContentProtection(on: boolean): void {
    this.protectionCalls.push(on)
  }
  setIgnoreMouseEvents(on: boolean): void {
    this.clickThroughCalls.push(on)
  }
}

function rig(patch: { live?: Partial<OverlayLive>; displays?: DisplayInfo[] } = {}) {
  const clock = fakeClock()
  const win = new FakeWindow()
  const powerMonitor = new EventEmitter()
  const screen = new EventEmitter()
  let displays = patch.displays ?? [left, right]
  const live: OverlayLive = {
    layout: 'bar',
    parked: false,
    contentProtection: true,
    clickThrough: false,
    exclusive: false,
    delegateBounds: false,
    ...patch.live
  }
  const delegateReanchor = vi.fn()
  const assertAlwaysOnTop = vi.fn(() => {
    win.onTop = true
  })
  const ports: OverlayReconcilerPorts<DisplayInfo> = {
    window: () => (win.destroyed ? null : win),
    displays: () => displays,
    live: () => live,
    delegateReanchor,
    assertAlwaysOnTop,
    topEdgePosition: (width, _height, display) => ({
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: display.workArea.y + 8
    }),
    barMinHeight: 44,
    timers: clock,
    powerMonitor,
    screen
  }
  const reconciler = createOverlayReconciler(ports)
  reconciler.start()
  reconciler.bindWindow(win)
  reconciler.captureDesired()
  return {
    clock,
    win,
    powerMonitor,
    screen,
    live,
    reconciler,
    delegateReanchor,
    assertAlwaysOnTop,
    setDisplays: (next: DisplayInfo[]) => {
      displays = next
    }
  }
}

describe('overlay reconciler: desired versus applied', () => {
  it('records the desired state separately from what was last applied', () => {
    const t = rig()
    const { desired, applied } = t.reconciler.state()
    expect(desired).toMatchObject({ anchor: bar, anchorDisplayId: 1, visible: true, contentProtection: true })
    expect(applied).toEqual({ contentProtection: null, clickThrough: null })
    t.powerMonitor.emit('resume')
    expect(t.reconciler.state().applied).toEqual({ contentProtection: true, clickThrough: false })
  })

  it('captures an intentional move but not an unreachable one', () => {
    const t = rig()
    t.win.bounds = { x: 700, y: 60, width: 880, height: 120 }
    t.win.emit('move')
    expect(t.reconciler.state().desired.anchor).toEqual({ x: 700, y: 60, width: 880, height: 120 })
    t.win.bounds = { x: 90_000, y: 90_000, width: 880, height: 120 }
    t.win.emit('move')
    expect(t.reconciler.state().desired.anchor).toEqual({ x: 700, y: 60, width: 880, height: 120 })
  })
})

describe('overlay reconciler: resume and unlock', () => {
  for (const event of ['resume', 'unlock-screen'] as const) {
    it(`${event}: restores bounds, always-on-top and protection at pass 0 and then settles`, () => {
      const t = rig()
      t.win.bounds = { x: 20, y: 700, width: 880, height: 120 }
      t.win.onTop = false
      t.powerMonitor.emit(event)
      expect(t.win.bounds).toEqual(bar)
      expect(t.win.onTop).toBe(true)
      expect(t.win.protectionCalls).toEqual([true])
      expect(t.win.setBoundsCalls).toHaveLength(1)
      t.clock.advance(250)
      t.clock.advance(750)
      t.clock.advance(1500)
      // Converged: the later passes move nothing again.
      expect(t.win.setBoundsCalls).toHaveLength(1)
      expect(t.clock.pending()).toBe(0)
    })
  }

  it('a late OS change (after pass 0) is repaired by a later pass', () => {
    const t = rig()
    t.powerMonitor.emit('resume')
    t.clock.advance(100)
    t.win.bounds = { x: 5, y: 5, width: 880, height: 120 }
    t.win.onTop = false
    t.clock.advance(150) // 250 ms pass
    expect(t.win.bounds).toEqual(bar)
    expect(t.win.onTop).toBe(true)
  })

  it('runs exactly four passes (0, 250, 1000, 2500 ms) and then stops', () => {
    const t = rig()
    t.powerMonitor.emit('resume')
    const protectionAfterZero = t.win.protectionCalls.length
    expect(protectionAfterZero).toBe(1)
    t.clock.advance(249)
    expect(t.win.protectionCalls).toHaveLength(1)
    t.clock.advance(1)
    expect(t.win.protectionCalls).toHaveLength(2)
    t.clock.advance(750)
    expect(t.win.protectionCalls).toHaveLength(3)
    t.clock.advance(1499)
    expect(t.win.protectionCalls).toHaveLength(3)
    t.clock.advance(1)
    expect(t.win.protectionCalls).toHaveLength(4)
    t.clock.advance(120_000)
    expect(t.win.protectionCalls).toHaveLength(4)
    expect(t.clock.pending()).toBe(0)
  })

  it('a new trigger restarts the sequence instead of stacking another one', () => {
    const t = rig()
    t.powerMonitor.emit('resume')
    t.clock.advance(300)
    t.powerMonitor.emit('unlock-screen')
    expect(t.clock.pending()).toBe(3)
    t.clock.advance(60_000)
    // pass 0 + pass 1 of the first sequence, then a whole second sequence of four.
    expect(t.win.protectionCalls).toHaveLength(2 + 4)
  })

  it('never re-enables content protection the user turned off (M212-P07)', () => {
    const t = rig({ live: { contentProtection: false } })
    t.powerMonitor.emit('resume')
    t.powerMonitor.emit('unlock-screen')
    t.clock.advance(60_000)
    expect(t.win.protectionCalls.length).toBeGreaterThan(0)
    expect(t.win.protectionCalls.every((on) => on === false)).toBe(true)
  })

  it('follows a live click-through change between passes', () => {
    const t = rig()
    t.powerMonitor.emit('resume')
    t.live.clickThrough = true
    t.clock.advance(250)
    expect(t.win.clickThroughCalls.at(-1)).toBe(true)
  })

  it('shows a window the OS hid, but not one the user hid', () => {
    const t = rig()
    t.win.visible = false
    t.powerMonitor.emit('unlock-screen')
    expect(t.win.showCalls).toBe(1)

    const hidden = rig()
    hidden.win.visible = false
    hidden.reconciler.captureDesired() // an intentional hide is captured at its transition
    hidden.powerMonitor.emit('unlock-screen')
    hidden.clock.advance(60_000)
    expect(hidden.win.showCalls).toBe(0)
  })

  it('asks the app to re-anchor a parked or sidecar window only when it drifted', () => {
    const t = rig({ live: { delegateBounds: true, parked: true, layout: 'hide' } })
    t.powerMonitor.emit('resume')
    expect(t.delegateReanchor).not.toHaveBeenCalled()
    t.win.bounds = { x: 0, y: 300, width: 8, height: 2 }
    t.clock.advance(250)
    expect(t.delegateReanchor).toHaveBeenCalledTimes(1)
  })
})

describe('overlay reconciler: displays', () => {
  it('a removed display re-anchors to the top edge of the nearest work area and keeps that anchor', () => {
    const t = rig()
    t.win.bounds = { x: 2000, y: 60, width: 880, height: 120 }
    t.win.emit('move')
    expect(t.reconciler.state().desired.anchorDisplayId).toBe(2)
    t.setDisplays([left])
    t.screen.emit('display-removed')
    expect(t.win.bounds).toEqual({ x: 316, y: 47, width: 880, height: 120 })
    expect(t.reconciler.state().desired.anchorDisplayId).toBe(1)
    t.clock.advance(60_000)
    expect(t.win.setBoundsCalls).toHaveLength(1)
  })

  it('a metrics change clamps a window that no longer fits its display', () => {
    const t = rig()
    t.win.bounds = { x: 316, y: 500, width: 880, height: 900 }
    t.win.emit('resize')
    const shorter: DisplayInfo = { ...left, workArea: { x: 0, y: 39, width: 1512, height: 600 } }
    t.setDisplays([shorter, right])
    t.screen.emit('display-metrics-changed')
    expect(t.win.bounds.y + t.win.bounds.height).toBeLessThanOrEqual(600 + 39)
    expect(t.win.bounds.height).toBeLessThanOrEqual(600 - 48)
  })

  it('a display change always asks a parked window to re-anchor, as before', () => {
    const t = rig({ live: { delegateBounds: true, parked: true, layout: 'hide' } })
    t.screen.emit('display-added')
    expect(t.delegateReanchor).toHaveBeenCalledTimes(1)
  })

  it('an exclusive onboarding window is left to its own stage on a display change and untouched on resume', () => {
    const t = rig({ live: { exclusive: true, delegateBounds: true } })
    t.powerMonitor.emit('resume')
    t.clock.advance(60_000)
    expect(t.delegateReanchor).not.toHaveBeenCalled()
    expect(t.win.protectionCalls).toEqual([])
    t.screen.emit('display-metrics-changed')
    expect(t.delegateReanchor).toHaveBeenCalledTimes(1)
  })
})

describe('overlay reconciler: first show', () => {
  it('never shows a window that has not been shown or captured yet (deferred first show)', () => {
    const clock = fakeClock()
    const win = new FakeWindow()
    win.visible = false
    const reconciler = createOverlayReconciler<DisplayInfo>({
      window: () => win,
      displays: () => [left, right],
      live: () => ({
        layout: 'bar',
        parked: false,
        contentProtection: true,
        clickThrough: false,
        exclusive: false,
        delegateBounds: false
      }),
      delegateReanchor: () => undefined,
      assertAlwaysOnTop: () => undefined,
      topEdgePosition: () => ({ x: 0, y: 0 }),
      barMinHeight: 44,
      timers: clock,
      powerMonitor: new EventEmitter(),
      screen: new EventEmitter()
    })
    reconciler.start()
    reconciler.bindWindow(win)
    reconciler.trigger('display')
    clock.advance(60_000)
    expect(win.showCalls).toBe(0)
    // Once the window has been shown, an OS hide after an unlock is repaired.
    win.emit('show')
    win.visible = false
    reconciler.trigger('unlock')
    expect(win.showCalls).toBe(1)
  })
})

describe('overlay reconciler: Spaces and full-screen', () => {
  it('a full-screen transition runs the bounded passes', () => {
    const t = rig()
    t.win.onTop = false
    t.win.emit('enter-full-screen')
    expect(t.win.onTop).toBe(true)
    t.win.onTop = false
    t.clock.advance(1000)
    expect(t.win.onTop).toBe(true)
  })

  it('losing always-on-top outside a transition is repaired once, without scheduling passes', () => {
    const t = rig()
    t.win.onTop = false
    t.win.emit('always-on-top-changed')
    expect(t.win.onTop).toBe(true)
    expect(t.clock.pending()).toBe(0)
    t.win.emit('always-on-top-changed') // our own re-assert echoes back: nothing to do
    expect(t.assertAlwaysOnTop).toHaveBeenCalledTimes(1)
  })

  it('does not capture OS-driven moves while a recovery sequence is running', () => {
    const t = rig()
    t.powerMonitor.emit('resume')
    t.win.bounds = { x: 5, y: 5, width: 880, height: 120 }
    t.win.emit('move')
    expect(t.reconciler.state().desired.anchor).toEqual(bar)
  })
})

describe('overlay reconciler: lifecycle', () => {
  it('does nothing and throws nothing when the window is gone', () => {
    const t = rig()
    t.powerMonitor.emit('resume')
    t.win.destroyed = true
    expect(() => t.clock.advance(60_000)).not.toThrow()
    expect(() => t.powerMonitor.emit('unlock-screen')).not.toThrow()
  })

  it('dispose cancels pending passes and detaches every listener', () => {
    const t = rig()
    t.powerMonitor.emit('resume')
    t.reconciler.dispose()
    expect(t.clock.pending()).toBe(0)
    expect(t.powerMonitor.listenerCount('resume')).toBe(0)
    expect(t.powerMonitor.listenerCount('unlock-screen')).toBe(0)
    expect(t.screen.listenerCount('display-removed')).toBe(0)
    expect(t.win.listenerCount('move')).toBe(0)
    expect(t.win.listenerCount('enter-full-screen')).toBe(0)
  })

  it('a pass that throws does not stop the later passes', () => {
    const t = rig()
    let calls = 0
    t.win.setContentProtection = (): void => {
      calls += 1
      if (calls === 1) throw new Error('synthetic native failure')
    }
    t.powerMonitor.emit('resume')
    t.clock.advance(60_000)
    expect(calls).toBe(4)
  })
})
