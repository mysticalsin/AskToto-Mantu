import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConstellationBed } from './onboarding-constellation-engine'

const engineSrc = readFileSync(join(__dirname, './onboarding-constellation-engine.ts'), 'utf8')
const hostSrc = readFileSync(join(__dirname, '../components/OnboardingConstellation.tsx'), 'utf8')

describe('constellation-grid engine — fail, dispose, no throw', () => {
  it('2D context failure returns null so the tour stays alive', () => {
    const canvas = {
      width: 64,
      height: 64,
      clientWidth: 64,
      clientHeight: 64,
      getContext: () => null,
      style: {},
      addEventListener: () => {},
      removeEventListener: () => {}
    } as unknown as HTMLCanvasElement
    expect(createConstellationBed(canvas)).toBeNull()
  })

  it('disposes rAF and listeners on unmount', () => {
    expect(hostSrc).toMatch(/bed\.dispose\(\)/)
    expect(engineSrc).toMatch(/cancelAnimationFrame\(raf\)/)
    expect(engineSrc).toMatch(/removeEventListener\('pointermove'/)
    expect(engineSrc).toMatch(/removeEventListener\('resize'/)
    expect(engineSrc).toMatch(/try \{/)
    expect(engineSrc).not.toMatch(/throw /)
  })

  it('never scales without a setTransform reset', () => {
    expect(engineSrc).toMatch(/setTransform\(1, 0, 0, 1, 0, 0\)/)
    expect(engineSrc).not.toMatch(/ctx\.scale\(/)
    expect(engineSrc).toMatch(/GRID\.dprCap/)
  })

  it('opens one 2d context and dispose cancels rAF plus pointer listeners', () => {
    const transforms: string[] = []
    const ctx = {
      setTransform: (...args: number[]) => transforms.push(args.join(',')),
      fillRect: () => {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      arc: () => {},
      fill: () => {},
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'round'
    }
    const canvas = {
      width: 64,
      height: 64,
      clientWidth: 800,
      clientHeight: 600,
      getContext: (kind: string) => (kind === '2d' ? ctx : null),
      style: { opacity: '0' }
    } as unknown as HTMLCanvasElement

    const g = globalThis as typeof globalThis & { window?: Window }
    const prev = {
      raf: g.requestAnimationFrame,
      caf: g.cancelAnimationFrame,
      performance: g.performance,
      window: g.window
    }
    let rafId = 0
    let cancelled = 0
    const listeners = new Map<string, EventListener>()
    g.performance = { now: () => 16 } as Performance
    g.requestAnimationFrame = () => {
      rafId += 1
      return rafId
    }
    g.cancelAnimationFrame = (id: number) => {
      cancelled = id
    }
    g.window = {
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 3,
      addEventListener: (name: string, fn: EventListener) => {
        listeners.set(name, fn)
      },
      removeEventListener: (name: string) => {
        listeners.delete(name)
      }
    } as unknown as Window & typeof globalThis

    try {
      const bed = createConstellationBed(canvas)
      expect(bed).not.toBeNull()
      expect(transforms[0]).toBe('1,0,0,1,0,0')
      expect(transforms.some((t) => t === '2,0,0,2,0,0')).toBe(true)
      expect(rafId).toBeGreaterThan(0)
      expect(listeners.has('pointermove')).toBe(true)
      expect(listeners.has('resize')).toBe(true)
      bed!.dispose()
      expect(cancelled).toBe(rafId)
      expect(listeners.size).toBe(0)
      expect(canvas.style.opacity).toBe('0')
    } finally {
      g.requestAnimationFrame = prev.raf
      g.cancelAnimationFrame = prev.caf
      g.performance = prev.performance
      g.window = prev.window
    }
  })
})
