import { describe, expect, it, vi } from 'vitest'
import { paintOrbFirstFrame } from './orb-first-frame'

function stubCanvas(): HTMLCanvasElement {
  const calls: string[] = []
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    setTransform: () => {
      calls.push('setTransform')
    },
    clearRect: () => {
      calls.push('clearRect')
    },
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    clip: () => {},
    closePath: () => {}
  }
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    __calls: calls
  } as unknown as HTMLCanvasElement & { __calls: string[] }
}

describe('paintOrbFirstFrame (package engine, not a rewrite)', () => {
  it('sizes the canvas and paints through MODE_DRAWS for every product size', () => {
    for (const size of [64, 20] as const) {
      const canvas = stubCanvas() as HTMLCanvasElement & { __calls: string[] }
      expect(() => paintOrbFirstFrame(canvas, 'solving', size, true)).not.toThrow()
      expect(canvas.width).toBeGreaterThan(0)
      expect(canvas.height).toBe(canvas.width)
      expect(canvas.__calls).toContain('setTransform')
      expect(canvas.__calls).toContain('clearRect')
    }
  })

  it('keeps a 2x avatar backing when the window reports 1x DPR', () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const canvas = stubCanvas()
    paintOrbFirstFrame(canvas, 'solving', 64, true, 2)
    expect(canvas.width).toBe(128)
    expect(canvas.height).toBe(128)
    vi.unstubAllGlobals()
  })

  it('uses the package static pose when reduced-motion is on', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true })
    vi.stubGlobal('matchMedia', matchMedia)
    const canvas = stubCanvas()
    expect(() => paintOrbFirstFrame(canvas, 'breathing', 64, true)).not.toThrow()
    expect(matchMedia).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
