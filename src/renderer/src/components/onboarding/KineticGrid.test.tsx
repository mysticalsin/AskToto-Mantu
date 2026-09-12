// MQA-299: idle setup must not keep rasterizing a static full-screen background.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KineticGrid } from './KineticGrid'

const hooks = vi.hoisted(() => ({ wrap: null as unknown, cleanup: undefined as (() => void) | undefined }))
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: () => ({ current: hooks.wrap }),
  useEffect: (effect: () => (() => void) | undefined) => { hooks.cleanup = effect() }
}))

/** Real canvas effect and event handlers; the browser's raster API and frame clock are the boundary.
 * Counting raster passes catches an idle loop without depending on a machine's CPU/GPU speed. */
function mount(reduced = false) {
  let now = 0
  let frameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const gradient = { addColorStop: () => {} }
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    fillRect: vi.fn(), strokeRect: vi.fn(), setTransform: vi.fn(),
    createRadialGradient: vi.fn(() => gradient)
  }
  const canvas = { width: 0, height: 0, style: {}, setAttribute: () => {}, getContext: () => ctx, remove: vi.fn() }
  const doc = Object.assign(new EventTarget(), { hidden: false, createElement: () => canvas })
  const win = Object.assign(new EventTarget(), {
    innerWidth: 280, innerHeight: 168, devicePixelRatio: 2,
    matchMedia: () => ({ matches: reduced })
  })
  hooks.wrap = { clientWidth: 280, clientHeight: 168, appendChild: () => {} }
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  KineticGrid()
  return {
    ctx, canvas,
    queued: () => frames.size,
    frame(at: number): void {
      now = at
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback(at))
    },
    pointer(type: 'pointermove' | 'pointerdown', x: number, y: number): void {
      win.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y }))
    },
    resize: () => win.dispatchEvent(new Event('resize')),
    visible(visible: boolean): void {
      doc.hidden = !visible
      doc.dispatchEvent(new Event('visibilitychange'))
    }
  }
}

afterEach(() => {
  hooks.cleanup?.()
  hooks.cleanup = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('KineticGrid rendering budget', () => {
  it('paints the idle setup background once and retains it without scheduling more frames', () => {
    const grid = mount()
    grid.frame(0)
    expect(grid.ctx.createRadialGradient).toHaveBeenCalledTimes(1)
    expect(grid.queued()).toBe(0)
    for (let at = 16; at < 2000; at += 16) grid.frame(at)
    expect(grid.ctx.createRadialGradient).toHaveBeenCalledTimes(1)
  })

  it('coalesces pointer input, animates to its resting position, then goes idle again', () => {
    const grid = mount()
    grid.frame(0)
    grid.pointer('pointermove', 100, 80)
    grid.pointer('pointermove', 110, 90)
    grid.pointer('pointermove', 120, 100)
    expect(grid.queued()).toBe(1)
    grid.frame(16)
    expect(grid.ctx.createRadialGradient).toHaveBeenCalledTimes(2)
    for (let at = 32; at < 4000 && grid.queued(); at += 16) grid.frame(at)
    expect(grid.queued()).toBe(0)
    const settled = grid.ctx.createRadialGradient.mock.calls.length
    grid.frame(5000)
    expect(grid.ctx.createRadialGradient).toHaveBeenCalledTimes(settled)
    grid.pointer('pointermove', 180, 100)
    expect(grid.queued()).toBe(1)
  })

  it('keeps a click ripple moving until it expires, then stops raster work', () => {
    const grid = mount()
    grid.frame(0)
    grid.pointer('pointerdown', 120, 100)
    grid.frame(16)
    expect(grid.queued()).toBe(1)
    for (let at = 32; at < 4000 && grid.queued(); at += 16) grid.frame(at)
    expect(grid.ctx.createRadialGradient.mock.calls.length).toBeGreaterThan(3)
    expect(grid.queued()).toBe(0)
  })

  it('reduced motion remains static on pointer activity but repaints after resize', () => {
    const grid = mount(true)
    grid.frame(0)
    grid.pointer('pointermove', 120, 100)
    grid.pointer('pointerdown', 120, 100)
    grid.frame(100)
    expect(grid.ctx.createRadialGradient).toHaveBeenCalledTimes(1)
    expect(grid.queued()).toBe(0)
    grid.resize()
    grid.frame(200)
    expect(grid.ctx.createRadialGradient).toHaveBeenCalledTimes(2)
    expect(grid.queued()).toBe(0)
  })

  it('stops when hidden, resumes after showing, and cannot restart after unmount', () => {
    const grid = mount()
    grid.frame(0)
    grid.pointer('pointermove', 120, 100)
    grid.visible(false)
    expect(grid.queued()).toBe(0)
    grid.pointer('pointerdown', 120, 100)
    expect(grid.queued()).toBe(0)
    grid.visible(true)
    expect(grid.queued()).toBe(1)
    grid.frame(2000)
    hooks.cleanup?.()
    hooks.cleanup = undefined
    grid.pointer('pointermove', 180, 100)
    grid.resize()
    expect(grid.queued()).toBe(0)
    expect(grid.canvas.remove).toHaveBeenCalledTimes(1)
  })
})
