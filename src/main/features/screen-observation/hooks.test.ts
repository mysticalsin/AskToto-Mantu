import { describe, expect, it, vi } from 'vitest'
import { createScreenObservation, type ScreenObservationDeps } from './screen-observation'

/** G43: the observation tells its marks consumer about each new frame and each revocation, and never breaks on it. */
function make(over: Partial<ScreenObservationDeps> = {}) {
  return createScreenObservation({
    captureOnce: async (r) => ({
      image: `synthetic-${r.displayId}`,
      width: 2880,
      height: 1800,
      dispId: r.displayId,
      displayMismatch: false
    }),
    cursorDisplayId: () => 3,
    privateViewOn: () => false,
    privateViewBlockedError: () => new Error('private'),
    screenAccess: () => 'granted',
    backgroundAllowed: () => true,
    prewarmAllowed: () => true,
    now: () => 1000,
    ...over
  })
}

describe('screen observation hooks for marks (G43)', () => {
  it('reports a new frame once, with its identity and region, and not a reused one', async () => {
    const onIssued = vi.fn()
    const obs = make({ onIssued })
    const first = await obs.capture({ reason: 'ask' })
    await obs.capture({ reason: 'ask' }) // reused inside the window
    expect(onIssued).toHaveBeenCalledTimes(1)
    expect(onIssued.mock.calls[0][0].observation.observationId).toBe(first.observation.observationId)
    expect(onIssued.mock.calls[0][1]).toEqual({ reason: 'ask' })
    await obs.capture({ reason: 'ask', scope: { kind: 'region', region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } } })
    expect(onIssued.mock.calls[1][1]).toEqual({ reason: 'ask', region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } })
  })

  it('reports each revocation with its reason and new generation', () => {
    const onRevoked = vi.fn()
    const obs = make({ onRevoked })
    obs.revoke('session-ended')
    obs.noteScreenLocked(true)
    expect(onRevoked.mock.calls).toEqual([
      ['session-ended', 1],
      ['screen-locked', 2]
    ])
  })

  it('swallows a throwing consumer', async () => {
    const obs = make({
      onIssued: () => {
        throw new Error('consumer bug')
      },
      onRevoked: () => {
        throw new Error('consumer bug')
      }
    })
    await expect(obs.capture({ reason: 'ask' })).resolves.toBeDefined()
    expect(() => obs.revoke('signed-out')).not.toThrow()
  })
})
