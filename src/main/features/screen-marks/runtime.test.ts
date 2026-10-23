import { describe, expect, it, vi } from 'vitest'
import type { Rect } from '@shared/screen-marks'
import { createScreenMarksRuntimeCore } from './runtime-core'
import type { AnnotationWindowHandle } from './annotation-windows'

const D1: Rect = { x: 0, y: 0, width: 1440, height: 900 }

class Win implements AnnotationWindowHandle {
  destroyed = false
  shown = false
  last: unknown[] = []
  setBounds(): void {}
  sendMarks(m: never[]): void {
    this.last = m
  }
  showInactive(): void {
    this.shown = true
  }
  hide(): void {
    this.shown = false
  }
  destroy(): void {
    this.destroyed = true
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

function make() {
  const wins: Win[] = []
  const state = { displays: [{ id: 1, bounds: D1 }] }
  const core = createScreenMarksRuntimeCore({
    displays: () => state.displays,
    createWindow: () => {
      const w = new Win()
      wins.push(w)
      return w
    },
    newId: (() => {
      let n = 0
      return () => `m${++n}`
    })(),
    warn: vi.fn()
  })
  const shot = (id: string) => ({
    observation: { observationId: id, sequence: 1, sourceId: 'display:1', scope: 'display' as const, generation: 0, capturedAt: 1 },
    image: 'x',
    width: 2880,
    height: 1800,
    dispId: 1,
    displayMismatch: false,
    capturedAt: 1
  })
  return { core, wins, state, shot }
}

describe('screen marks runtime (G43)', () => {
  it('creates the window lazily on the first placed mark and draws it', () => {
    const { core, wins, shot } = make()
    core.hooks.onIssued(shot('obs-1'), { reason: 'ask' })
    expect(wins).toHaveLength(0)
    expect(core.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1440, y: 900 } })).toEqual({ ok: true, markId: 'm1' })
    expect(wins).toHaveLength(1)
    expect(wins[0].shown).toBe(true)
    expect(wins[0].last).toEqual([{ markId: 'm1', kind: 'point', x: 720, y: 450 }])
  })

  it('does not rebind marks to a prewarm, self-check or background frame', () => {
    const { core, shot } = make()
    core.hooks.onIssued(shot('obs-1'), { reason: 'ask' })
    core.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 1 } })
    for (const reason of ['prewarm', 'check', 'background'] as const) core.hooks.onIssued(shot('obs-2'), { reason })
    expect(core.markCount()).toBe(1)
  })

  it('removes the marks of the old screenshot when a new capture is issued and hides the window', () => {
    const { core, wins, shot } = make()
    core.hooks.onIssued(shot('obs-1'), { reason: 'ask' })
    core.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 1 } })
    core.hooks.onIssued(shot('obs-2'), { reason: 'ask' })
    expect(core.markCount()).toBe(0)
    expect(wins[0].shown).toBe(false)
  })

  it.each(['session-ended', 'screen-locked', 'suspended', 'private-view', 'permission-revoked', 'display-removed'] as const)(
    'clears marks and hides the window on %s',
    (reason) => {
      const { core, wins, shot } = make()
      core.hooks.onIssued(shot('obs-1'), { reason: 'ask' })
      core.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 1 } })
      core.hooks.onRevoked(reason, 1)
      expect(core.markCount()).toBe(0)
      expect(wins[0].destroyed).toBe(false)
      expect(wins[0].shown).toBe(false)
    }
  )

  it('destroys every window on sign-out, owner switch and quit', () => {
    for (const end of ['signed-out', 'owner-switch', 'quit'] as const) {
      const { core, wins, shot } = make()
      core.hooks.onIssued(shot('obs-1'), { reason: 'ask' })
      core.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 1 } })
      if (end === 'signed-out') core.hooks.onRevoked('signed-out', 1)
      else core.destroy(end)
      expect(core.markCount()).toBe(0)
      expect(wins[0].destroyed).toBe(true)
    }
  })

  it('follows display changes: bounds change recomputes, a removed display hides', () => {
    const { core, wins, state, shot } = make()
    core.hooks.onIssued(shot('obs-1'), { reason: 'ask' })
    core.place({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1440, y: 900 } })
    state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 2880, height: 1800 } }]
    core.displaysChanged()
    expect(wins[0].last).toEqual([{ markId: 'm1', kind: 'point', x: 1440, y: 900 }])
    state.displays = []
    core.displaysChanged()
    expect(wins[0].destroyed).toBe(true)
  })
})
