import { describe, expect, it } from 'vitest'
import {
  OVERLAY_RECOVERY_PASS_MS,
  nearestDisplay,
  planOverlayPass,
  reanchorFreeBounds,
  type DisplayInfo,
  type OverlayApplied,
  type OverlayDesired,
  type OverlayObserved
} from './overlay-state'

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

const bar = { x: 316, y: 47, width: 880, height: 120 }
const topEdge = (width: number, _height: number, display: DisplayInfo): { x: number; y: number } => ({
  x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
  y: display.workArea.y + 8
})

function desired(patch: Partial<OverlayDesired> = {}): OverlayDesired {
  return {
    anchor: bar,
    anchorDisplayId: 1,
    visible: true,
    alwaysOnTop: true,
    contentProtection: true,
    clickThrough: false,
    layout: 'bar',
    parked: false,
    ...patch
  }
}
const observed = (patch: Partial<OverlayObserved> = {}): OverlayObserved => ({
  bounds: bar,
  visible: true,
  alwaysOnTop: true,
  ...patch
})
const unknownApplied: OverlayApplied = { contentProtection: null, clickThrough: null }

function plan(
  over: {
    desired?: Partial<OverlayDesired>
    observed?: Partial<OverlayObserved>
    applied?: OverlayApplied
    displays?: DisplayInfo[]
    mode?: 'free' | 'delegate'
    forceReanchor?: boolean
    reassert?: boolean
  } = {}
): ReturnType<typeof planOverlayPass> {
  return planOverlayPass({
    desired: desired(over.desired),
    observed: observed(over.observed),
    applied: over.applied ?? { contentProtection: true, clickThrough: false },
    displays: over.displays ?? [left, right],
    mode: over.mode ?? 'free',
    forceReanchor: over.forceReanchor ?? false,
    reassert: over.reassert ?? false,
    barMinHeight: 44,
    topEdgePosition: topEdge
  })
}

describe('OVERLAY_RECOVERY_PASS_MS', () => {
  it('is the bounded schedule 0, 250, 1000, 2500', () => {
    expect([...OVERLAY_RECOVERY_PASS_MS]).toEqual([0, 250, 1000, 2500])
  })
})

describe('nearestDisplay', () => {
  it('prefers the display with the largest overlap, else the nearest by centre', () => {
    expect(nearestDisplay({ x: 1600, y: 100, width: 880, height: 120 }, [left, right])?.id).toBe(2)
    expect(nearestDisplay({ x: 4000, y: 100, width: 880, height: 120 }, [left, right])?.id).toBe(2)
    expect(nearestDisplay({ x: -3000, y: 100, width: 880, height: 120 }, [left, right])?.id).toBe(1)
    expect(nearestDisplay(bar, [])).toBeNull()
  })
})

describe('reanchorFreeBounds', () => {
  it('leaves a window that is still on the work area alone', () => {
    expect(reanchorFreeBounds(bar, left.workArea, 44)).toEqual(bar)
  })
  it('clamps a window grown past the work area height and slides it up to fit', () => {
    const tall = { x: 316, y: 600, width: 880, height: 900 }
    const next = reanchorFreeBounds(tall, left.workArea, 44)
    expect(next.height).toBeLessThanOrEqual(left.workArea.height - 48)
    expect(next.y + next.height).toBeLessThanOrEqual(left.workArea.y + left.workArea.height)
  })
  it('pulls a window that is entirely off the work area back inside it', () => {
    const next = reanchorFreeBounds({ x: 4000, y: 4000, width: 880, height: 120 }, left.workArea, 44)
    expect(next.x + next.width).toBeLessThanOrEqual(left.workArea.x + left.workArea.width)
    expect(next.y).toBeLessThanOrEqual(left.workArea.y + left.workArea.height - 120)
  })
})

describe('planOverlayPass', () => {
  it('plans nothing when applied already equals desired', () => {
    expect(plan()).toEqual([])
  })

  it('restores the desired position when the OS moved the window, keeping the live size', () => {
    const moved = { x: 100, y: 500, width: 880, height: 164 }
    const actions = plan({ observed: { bounds: moved } })
    expect(actions).toEqual([{ kind: 'setBounds', bounds: { x: 316, y: 47, width: 880, height: 164 } }])
  })

  it('re-anchors to the top edge of the nearest work area when its display disappeared', () => {
    const actions = plan({
      desired: { anchor: { x: 2000, y: 60, width: 880, height: 120 }, anchorDisplayId: 2 },
      observed: { bounds: { x: 2000, y: 60, width: 880, height: 120 } },
      displays: [left]
    })
    expect(actions).toEqual([{ kind: 'setBounds', bounds: { x: 316, y: 47, width: 880, height: 120 } }])
  })

  it('shows a window that should be visible and is not, but never hides one', () => {
    expect(plan({ observed: { visible: false } })).toEqual([{ kind: 'show' }])
    expect(plan({ desired: { visible: false }, observed: { visible: true } })).toEqual([])
    expect(plan({ desired: { visible: false }, observed: { visible: false } })).toEqual([])
  })

  it('restores always-on-top when it was lost', () => {
    expect(plan({ observed: { alwaysOnTop: false } })).toEqual([{ kind: 'alwaysOnTop' }])
  })

  it('reasserts unobservable properties from the live desired values when asked or when never applied', () => {
    expect(plan({ applied: unknownApplied })).toEqual([
      { kind: 'contentProtection', on: true },
      { kind: 'clickThrough', on: false }
    ])
    expect(plan({ reassert: true })).toEqual([
      { kind: 'alwaysOnTop' },
      { kind: 'contentProtection', on: true },
      { kind: 'clickThrough', on: false }
    ])
  })

  it('applies a desired change in content protection (and only that)', () => {
    expect(plan({ desired: { contentProtection: false } })).toEqual([{ kind: 'contentProtection', on: false }])
  })

  it('delegate mode asks the app to re-anchor only when forced or the window drifted', () => {
    expect(plan({ mode: 'delegate' })).toEqual([])
    expect(plan({ mode: 'delegate', forceReanchor: true })).toEqual([{ kind: 'reanchor' }])
    expect(plan({ mode: 'delegate', observed: { bounds: { x: 0, y: 300, width: 8, height: 2 } } })).toEqual([
      { kind: 'reanchor' }
    ])
    expect(plan({ mode: 'delegate', desired: { anchorDisplayId: 7 } })).toEqual([{ kind: 'reanchor' }])
  })

  it('plans no bounds action without displays', () => {
    expect(plan({ displays: [], observed: { bounds: { x: 1, y: 1, width: 880, height: 120 } } })).toEqual([])
  })
})
