import { describe, expect, it } from 'vitest'
import type { RightEdgePin, RightEdgeSurfaceState } from '@shared/right-edge-state'
import { RE_BLUR_TOGGLE_GRACE_MS } from '@shared/right-edge-timing'
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

describe('right-edge session: the Reader (M2-0202 S3, RE-P01 Reader rows)', () => {
  function readerSession() {
    const changes: boolean[] = []
    let retries = 0
    const s = createRightEdgeSession({
      surface: () => REST,
      send: () => {},
      onPinsCleared: () => {
        retries += 1
      },
      onReaderChange: (reader) => changes.push(reader)
    })
    const report = (surface: 'island' | 'reader' | 'rest' | 'top-center', pins: RightEdgePin[] = []) =>
      s.report({ surface, contentHeight: 0, pins })
    return { s, report, changes, retries: () => retries }
  }

  it('the Reader is pending from its report, through a park, until the page reports the island', () => {
    const h = readerSession()
    h.report('island')
    expect(h.s.readerPending()).toBe(false)
    h.report('reader')
    expect(h.s.readerPending()).toBe(true)
    expect(h.s.pageSurface()).toBe('reader')
    // A park keeps it: the next explicit reveal restores the Reader.
    h.report('rest')
    expect(h.s.readerPending()).toBe(true)
    h.report('island')
    expect(h.s.readerPending()).toBe(false)
    expect(h.changes).toEqual([true, false])
  })

  it('a reveal that must open the island drops a parked Reader; top-center and a reload drop it too', () => {
    const h = readerSession()
    h.report('reader')
    h.report('rest')
    h.s.noteIslandReveal()
    expect(h.s.readerPending()).toBe(false)
    h.report('reader')
    h.report('top-center')
    expect(h.s.readerPending()).toBe(false)
    h.report('reader')
    h.s.reset()
    expect(h.s.readerPending()).toBe(false)
    // Every change of the pending Reader is reported once: open, the island reveal, open, top-center, open, reload.
    expect(h.changes).toEqual([true, false, true, false, true, false])
  })

  it('while the Reader is open only an explicit park applies; clearing the pins never parks it', () => {
    const h = readerSession()
    h.report('reader', ['typing'])
    expect(h.s.parkAllowed('pointer-leave')).toBe(false)
    expect(h.s.parkAllowed('auto-park')).toBe(false)
    expect(h.s.parkAllowed('explicit')).toBe(true)
    h.report('reader')
    expect(h.retries()).toBe(0)
    expect(h.s.parkAllowed('pointer-leave')).toBe(false)
    // An IME composition still owns the keyboard in the Reader.
    h.report('reader', ['ime'])
    expect(h.s.parkAllowed('explicit')).toBe(false)
  })

  it('RE_BLUR_TOGGLE_GRACE_MS absorbs only a tray toggle after a blur park, once', () => {
    const h = readerSession()
    h.s.noteBlurPark(1_000)
    expect(h.s.toggleAbsorbedByBlur('tray', 1_000 + RE_BLUR_TOGGLE_GRACE_MS - 1)).toBe(true)
    expect(h.s.toggleAbsorbedByBlur('tray', 1_000 + RE_BLUR_TOGGLE_GRACE_MS - 1)).toBe(false)
    // The hotkey never blurs the window: blur, then the hotkey within 500 ms reveals (the Reader is restored).
    h.s.noteBlurPark(2_000)
    expect(h.s.toggleAbsorbedByBlur('hotkey', 2_100)).toBe(false)
    expect(h.s.toggleAbsorbedByBlur('tray', 2_200)).toBe(false)
    // A tray toggle after the grace is a reveal of its own.
    h.s.noteBlurPark(3_000)
    expect(h.s.toggleAbsorbedByBlur('tray', 3_000 + RE_BLUR_TOGGLE_GRACE_MS)).toBe(false)
  })
})
