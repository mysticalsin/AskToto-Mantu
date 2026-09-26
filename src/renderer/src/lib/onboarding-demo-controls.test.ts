import { describe, expect, it } from 'vitest'
import {
  createDemoPlaybackClock,
  demoPlaybackStatus,
  readDemoEnvironment,
  runOptionalDemoMedia,
  watchDemoEnvironment,
  type DemoPlaybackSnapshot
} from './onboarding-demo-controls'

function harness(duration = 1000) {
  let time = 0
  let nextId = 0
  const pending = new Map<number, (timestamp: number) => void>()
  const frames: DemoPlaybackSnapshot[] = []
  const scheduler = {
    now: () => time,
    request: (callback: (timestamp: number) => void) => {
      const id = nextId++
      pending.set(id, callback)
      return id
    },
    cancel: (id: number) => { pending.delete(id) }
  }
  const clock = createDemoPlaybackClock(duration, scheduler, (frame) => frames.push(frame))
  return {
    clock, pending, frames,
    at(value: number) { time = value },
    tick(value: number) {
      time = value
      const callbacks = [...pending.values()]
      pending.clear()
      callbacks.forEach((callback) => callback(value))
    }
  }
}

describe('onboarding demo pacing and lifecycle', () => {
  it('starts only after play, and owns one frame even after repeated play', () => {
    const h = harness()
    expect(h.pending.size).toBe(0)
    h.clock.play()
    h.clock.play()
    expect(h.pending.size).toBe(1)
    h.tick(100)
    expect(h.clock.snapshot()).toEqual({ elapsedMs: 100, phase: 'playing' })
  })

  it('preserves the exact between-frame position and excludes hidden time', () => {
    const h = harness()
    h.clock.play()
    h.tick(100)
    h.at(150)
    h.clock.pause()
    h.at(600150)
    h.clock.play()
    h.tick(600175)
    expect(h.clock.snapshot().elapsedMs).toBe(175)
  })

  it('holds at the current step without automatic navigation or restart', () => {
    const h = harness(2999)
    h.clock.play()
    h.tick(100000)
    h.clock.play()
    expect(h.clock.snapshot()).toEqual({ elapsedMs: 2999, phase: 'held' })
    expect(h.pending.size).toBe(0)
  })

  it('does not trust callbacks already queued before cancellation', () => {
    const h = harness()
    h.clock.play()
    const stale = [...h.pending.values()][0]
    h.at(25)
    h.clock.pause()
    h.at(10025)
    h.clock.play()
    stale(900000)
    expect(h.clock.snapshot().elapsedMs).toBe(25)
    h.tick(10050)
    expect(h.clock.snapshot().elapsedMs).toBe(50)
  })

  it('disposal releases frame id zero and emits no unmounted state', () => {
    const h = harness()
    h.clock.play()
    expect([...h.pending.keys()]).toEqual([0])
    const stale = [...h.pending.values()][0]
    const count = h.frames.length
    h.clock.dispose()
    h.clock.dispose()
    stale(999)
    expect(h.frames.length).toBe(count)
    expect(h.pending.size).toBe(0)
  })

  it('reduced motion settles immediately and remains held', () => {
    const h = harness()
    h.clock.finish()
    h.clock.play()
    expect(h.clock.snapshot()).toEqual({ elapsedMs: 1000, phase: 'held' })
    expect(h.pending.size).toBe(0)
    expect(demoPlaybackStatus('held', { hidden: false, reducedMotion: true }, false))
      .toContain('All content')
  })

  it('optional synchronous and rejected media attempts never own navigation', async () => {
    const calls: string[] = []
    expect(() => runOptionalDemoMedia(() => { throw new Error('test media error') })).not.toThrow()
    runOptionalDemoMedia(() => {
      calls.push('media')
      return Promise.reject(new Error('test rejection'))
    })
    calls.push('navigation')
    await Promise.resolve()
    expect(calls).toEqual(['media', 'navigation'])
  })

  it('watchers are removed symmetrically, including stale event callbacks', () => {
    const documentEvents = new Map<string, () => void>()
    const motionEvents = new Map<string, () => void>()
    const owner = {
      visibilityState: 'visible',
      addEventListener: (name: string, callback: () => void) => documentEvents.set(name, callback),
      removeEventListener: (name: string) => documentEvents.delete(name)
    }
    const media = {
      matches: false,
      addEventListener: (name: string, callback: () => void) => motionEvents.set(name, callback),
      removeEventListener: (name: string) => motionEvents.delete(name)
    }
    const changes: unknown[] = []
    const stop = watchDemoEnvironment(
      owner as unknown as Document, media as unknown as MediaQueryList,
      (next) => changes.push(next)
    )
    const stale = documentEvents.get('visibilitychange')!
    owner.visibilityState = 'hidden'
    stale()
    expect(changes).toEqual([
      { hidden: false, reducedMotion: false },
      { hidden: true, reducedMotion: false }
    ])
    stop()
    stop()
    stale()
    expect(changes).toHaveLength(2)
    expect(documentEvents.size + motionEvents.size).toBe(0)
    expect(readDemoEnvironment(null, null)).toEqual({ hidden: false, reducedMotion: false })
  })
})
