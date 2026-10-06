import { describe, expect, it } from 'vitest'
import type { RightEdgePin, RightEdgeSurfaceState } from '@shared/right-edge-state'
import { createRightEdgeSession } from './right-edge-session'

const REST: RightEdgeSurfaceState = {
  surface: 'rest',
  restKind: 'none',
  edgeClass: 'W',
  cardMaxHeight: 392,
  slotMax: 236
}

function session() {
  let current = REST
  const sent: RightEdgeSurfaceState[] = []
  const logged: string[] = []
  let retries = 0
  const s = createRightEdgeSession({
    surface: () => current,
    send: (surface) => sent.push(surface),
    onPinsCleared: () => {
      retries += 1
    },
    log: (line) => logged.push(line)
  })
  const report = (pins: RightEdgePin[]) => s.report({ surface: 'island', contentHeight: 0, pins })
  return { s, report, sent, logged, retries: () => retries, set: (next: RightEdgeSurfaceState) => (current = next) }
}

describe('right-edge session (M2-0202 S2)', () => {
  it('answers a report with the current surface and pushes only a changed one', () => {
    const h = session()
    expect(h.report([])).toEqual(REST)
    h.s.push()
    expect(h.sent).toEqual([])
    const island = { ...REST, surface: 'island' as const }
    h.set(island)
    h.s.push()
    h.s.push()
    expect(h.sent).toEqual([island])
    // A reloaded page gets the surface again on the next push.
    h.s.reset()
    h.s.push()
    expect(h.sent).toEqual([island, island])
  })

  it('refuses parks while pinned, logs a refusal once, and retries a refused leave-park when the pins clear', () => {
    const h = session()
    h.report(['typing'])
    for (let tick = 0; tick < 5; tick++) expect(h.s.parkAllowed('pointer-leave')).toBe(false)
    expect(h.s.parkAllowed('explicit')).toBe(true)
    expect(h.logged).toHaveLength(1)
    h.report(['typing', 'approval'])
    expect(h.retries()).toBe(0)
    h.report([])
    expect(h.retries()).toBe(1)
    expect(h.s.parkAllowed('pointer-leave')).toBe(true)
    // Clearing again with nothing refused does not park.
    h.report(['user'])
    h.report([])
    expect(h.retries()).toBe(1)
  })

  it('an auto-park refusal is not retried by the session: the watch fires it again on its own', () => {
    const h = session()
    h.report(['approval'])
    expect(h.s.parkAllowed('auto-park')).toBe(false)
    h.report([])
    expect(h.retries()).toBe(0)
  })

  it('an IME composition refuses even an explicit Hide', () => {
    const h = session()
    h.report(['ime'])
    expect(h.s.parkAllowed('explicit')).toBe(false)
    expect(h.s.pins()).toEqual(['ime'])
  })

  it('a reset drops the pins of a page that reloaded or crashed', () => {
    const h = session()
    h.report(['typing'])
    expect(h.s.parkAllowed('pointer-leave')).toBe(false)
    h.s.reset()
    expect(h.s.pins()).toEqual([])
    expect(h.s.parkAllowed('pointer-leave')).toBe(true)
  })
})
