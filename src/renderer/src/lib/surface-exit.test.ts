import { describe, expect, it } from 'vitest'
import { SURFACE_EXIT_MS, createSurfaceExit, isSurfaceExiting, type SurfaceExitDeps } from './surface-exit'

/** C32 (HIG Motion): a close plays the surface's exit before the view changes; Reduce Motion and a second
 *  request land at once; the exit never sticks. */
function harness(over: Partial<SurfaceExitDeps> = {}) {
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = []
  const deps: SurfaceExitDeps = {
    reducedMotion: () => false,
    surfaceShown: () => true,
    schedule: (run, ms) => {
      const t = { run, ms, live: true }
      timers.push(t)
      return () => {
        t.live = false
      }
    },
    ...over
  }
  const fire = (): void => {
    const t = timers.find((x) => x.live)
    if (!t) throw new Error('no live timer')
    t.live = false
    t.run()
  }
  return { exit: createSurfaceExit(deps), timers, fire }
}

describe('createSurfaceExit', () => {
  it('marks the surface exiting and commits after SURFACE_EXIT_MS', () => {
    const { exit, timers, fire } = harness()
    const commits: string[] = []
    exit.run(() => commits.push('close'))
    expect(isSurfaceExiting()).toBe(true)
    expect(commits).toEqual([])
    expect(timers[0].ms).toBe(SURFACE_EXIT_MS)
    fire()
    expect(commits).toEqual(['close'])
    // Still exiting until the surface unmounts (or the backstop clears a close that committed nothing).
    expect(isSurfaceExiting()).toBe(true)
    fire()
    expect(isSurfaceExiting()).toBe(false)
  })

  it('closes at once under Reduce Motion or with no surface on screen', () => {
    for (const over of [{ reducedMotion: () => true }, { surfaceShown: () => false }]) {
      const { exit, timers } = harness(over)
      const commits: string[] = []
      exit.run(() => commits.push('close'))
      expect(commits).toEqual(['close'])
      expect(timers).toHaveLength(0)
      expect(isSurfaceExiting()).toBe(false)
    }
  })

  it('a second request during the exit lands at once and replaces the first (people can cancel motion)', () => {
    const { exit, timers } = harness()
    const commits: string[] = []
    exit.run(() => commits.push('first'))
    exit.run(() => commits.push('second'))
    expect(commits).toEqual(['second'])
    expect(timers.filter((t) => t.live)).toHaveLength(0)
    expect(isSurfaceExiting()).toBe(false)
  })

  it('cancel shows the surface again and drops the pending close', () => {
    const { exit, timers } = harness()
    const commits: string[] = []
    exit.run(() => commits.push('close'))
    exit.cancel()
    expect(isSurfaceExiting()).toBe(false)
    expect(timers.filter((t) => t.live)).toHaveLength(0)
    expect(commits).toEqual([])
  })
})
