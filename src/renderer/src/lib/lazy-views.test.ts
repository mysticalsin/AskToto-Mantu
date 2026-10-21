import { describe, expect, it } from 'vitest'
import { intentViewFor, preloadableLazy, surfaceLabel, VIEW_INTENT_TARGETS } from './lazy-views'

/** C32: Settings and History load on intent (hover or focus of their Bar control); a preloaded chunk renders
 *  without suspending. */
describe('view intent preload', () => {
  const target = (match: string | null) => ({ closest: (selector: string) => (selector === match ? {} : null) })

  it('maps the Mantu M to Settings and the History control to History, nothing else', () => {
    expect(intentViewFor(target('[data-bar-mark]') as unknown as EventTarget)).toBe('settings')
    expect(intentViewFor(target('[data-bar-history]') as unknown as EventTarget)).toBe('history')
    expect(intentViewFor(target(null) as unknown as EventTarget)).toBeNull()
    expect(intentViewFor(null)).toBeNull()
    expect(intentViewFor({} as EventTarget)).toBeNull()
    expect(VIEW_INTENT_TARGETS.map(([, view]) => view)).toEqual(['settings', 'history'])
  })

  it('names every surface for its loading announcement', () => {
    expect(surfaceLabel('settings')).toBe('Settings')
    expect(surfaceLabel('brain')).toBe('Mantu Intelligence')
    expect(surfaceLabel('unknown')).toBe('Métis')
  })
})

describe('preloadableLazy', () => {
  it('loads once, never rejects, and retries a failed chunk on the next intent', async () => {
    let calls = 0
    let fail = true
    const view = preloadableLazy(async () => {
      calls += 1
      if (fail) throw new Error('chunk failed')
      return { default: () => null }
    })
    await expect(view.preload()).resolves.toBeUndefined()
    fail = false
    await view.preload()
    await view.preload()
    expect(calls).toBe(2)
  })
})
