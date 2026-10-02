import { describe, expect, it } from 'vitest'
import { projectEvent } from '../infra/observability/projection'
import {
  OVERLAY_FLASH_WINDOW_MS,
  OVERLAY_TRANSITION_CAUSES,
  createOverlayRevealLog,
  overlayRevealZone,
  type OverlayFlash,
  type OverlayTransitionContext
} from './overlay-reveal-log'

const TOP: OverlayTransitionContext = { placement: 'top-center', layout: 'hide' }
const EDGE: OverlayTransitionContext = { placement: 'right-edge', layout: 'island' }

function harness() {
  let t = 1_000
  const lines: string[] = []
  const audits: Array<{ event: string; detail: OverlayFlash }> = []
  const log = createOverlayRevealLog({
    now: () => t,
    log: (line) => lines.push(line),
    audit: (event, detail) => audits.push({ event, detail })
  })
  return { log, lines, audits, advance: (ms: number) => (t += ms) }
}

describe('overlay reveal/park log (M2-0431)', () => {
  it('logs every transition with its cause, placement and layout, and ignores repeats that are not transitions', () => {
    const h = harness()
    h.log.revealed('cursor-watch', TOP)
    h.log.revealed('renderer', TOP) // the page confirms the reveal main already made
    h.advance(5_000)
    h.log.parked('renderer', TOP)
    h.log.parked('cursor-watch', TOP) // main's backstop park after the page already parked
    h.log.revealed('hotkey', EDGE)
    h.advance(3_000)
    h.log.parked('toggle', EDGE)
    h.log.revealed('settings', TOP)
    h.advance(4_000)
    h.log.parked('settings', TOP)
    expect(h.lines).toEqual([
      '[overlay] reveal cause=cursor-watch zone=notch placement=top-center layout=hide',
      '[overlay] park cause=renderer visibleMs=5000 placement=top-center layout=hide',
      '[overlay] reveal cause=hotkey zone=none placement=right-edge layout=island',
      '[overlay] park cause=toggle visibleMs=3000 placement=right-edge layout=island',
      '[overlay] reveal cause=settings zone=none placement=top-center layout=hide',
      '[overlay] park cause=settings visibleMs=4000 placement=top-center layout=hide'
    ])
    expect(h.audits).toEqual([])
  })

  it('audits overlay.flash for a reveal that parks within 2 s with no click or keypress', () => {
    const h = harness()
    h.log.revealed('cursor-watch', TOP)
    h.advance(340)
    h.log.parked('renderer', TOP)
    expect(h.audits).toEqual([{ event: 'overlay.flash', detail: { visibleMs: 340, zone: 'notch', placement: 'top-center', layout: 'hide' } }])
    expect(h.lines.at(-1)).toBe('[overlay] park cause=renderer visibleMs=340 flash placement=top-center layout=hide')

    h.log.revealed('renderer', EDGE)
    h.advance(OVERLAY_FLASH_WINDOW_MS - 1)
    h.log.parked('cursor-watch', EDGE)
    expect(h.audits.at(-1)).toEqual({
      event: 'overlay.flash',
      detail: { visibleMs: OVERLAY_FLASH_WINDOW_MS - 1, zone: 'edge-band', placement: 'right-edge', layout: 'island' }
    })
  })

  it('does not audit a reveal the user clicked or typed in, or one that stayed up for 2 s', () => {
    for (const type of ['mouseDown', 'rawKeyDown', 'keyDown', 'char']) {
      const h = harness()
      h.log.revealed('cursor-watch', TOP)
      h.advance(200)
      h.log.input(type)
      h.advance(200)
      h.log.parked('renderer', TOP)
      expect(h.audits, type).toEqual([])
    }
    const long = harness()
    long.log.revealed('cursor-watch', TOP)
    long.advance(OVERLAY_FLASH_WINDOW_MS)
    long.log.parked('renderer', TOP)
    expect(long.audits).toEqual([])
  })

  it('does not audit a hotkey, toggle or Settings reveal that parks within 2 s: the reveal itself was a keypress or click', () => {
    for (const cause of ['hotkey', 'toggle', 'settings'] as const) {
      const h = harness()
      h.log.revealed(cause, TOP)
      h.advance(300)
      h.log.parked('cursor-watch', TOP)
      expect(h.audits, cause).toEqual([])
      expect(h.lines.at(-1), cause).toBe('[overlay] park cause=cursor-watch visibleMs=300 placement=top-center layout=hide')
    }
  })

  it('does not audit a hover reveal parked or re-confirmed by a hotkey, toggle or Settings action within 2 s', () => {
    for (const cause of ['hotkey', 'toggle', 'settings'] as const) {
      const parkedBy = harness()
      parkedBy.log.revealed('cursor-watch', TOP)
      parkedBy.advance(400)
      parkedBy.log.parked(cause, TOP)
      expect(parkedBy.audits, cause).toEqual([])

      const touchedBy = harness()
      touchedBy.log.revealed('cursor-watch', EDGE)
      touchedBy.advance(200)
      touchedBy.log.revealed(cause, EDGE) // e.g. tray Settings opened while the hover reveal is up
      touchedBy.advance(200)
      touchedBy.log.parked('renderer', EDGE)
      expect(touchedBy.audits, cause).toEqual([])
      expect(touchedBy.lines, cause).toHaveLength(2)
    }
  })

  it('does not count pointer moves, wheel or key-ups, nor input before the reveal, as an interaction', () => {
    const h = harness()
    h.log.input('mouseDown') // lands on the parked window, before this reveal
    h.log.revealed('cursor-watch', TOP)
    for (const type of ['mouseMove', 'mouseEnter', 'mouseLeave', 'mouseWheel', 'keyUp']) h.log.input(type)
    h.advance(500)
    h.log.parked('cursor-watch', TOP)
    expect(h.audits).toHaveLength(1)
  })

  it('appends the caller geometry detail to the log line only, never to the audit', () => {
    const h = harness()
    h.log.revealed('cursor-watch', TOP, 'bounds=880x120@(520,8) cursor=(960,4)')
    h.advance(300)
    h.log.parked('cursor-watch', TOP, 'bounds=8x2@(956,0) cursor=(960,400)')
    expect(h.lines).toEqual([
      '[overlay] reveal cause=cursor-watch zone=notch placement=top-center layout=hide bounds=880x120@(520,8) cursor=(960,4)',
      '[overlay] park cause=cursor-watch visibleMs=300 flash placement=top-center layout=hide bounds=8x2@(956,0) cursor=(960,400)'
    ])
    expect(Object.keys(h.audits[0].detail)).toEqual(['visibleMs', 'zone', 'placement', 'layout'])
  })

  it('logs a boot-time park without a flash, since no reveal was measured', () => {
    const h = harness()
    h.log.parked('toggle', TOP)
    expect(h.lines).toEqual(['[overlay] park cause=toggle placement=top-center layout=hide'])
    expect(h.audits).toEqual([])
  })

  it('knows exactly the causes the ticket names', () => {
    expect(OVERLAY_TRANSITION_CAUSES).toEqual(['cursor-watch', 'renderer', 'hotkey', 'toggle', 'settings'])
  })

  it('names the hover zone only for hover reveals', () => {
    expect(overlayRevealZone('cursor-watch', 'top-center')).toBe('notch')
    expect(overlayRevealZone('renderer', 'right-edge')).toBe('edge-band')
    for (const cause of ['hotkey', 'toggle', 'settings'] as const) {
      expect(overlayRevealZone(cause, 'top-center')).toBe('none')
    }
  })

  it('writes a content-free audit record: the projection keeps exactly the four allowlisted fields', () => {
    const h = harness()
    h.log.revealed('cursor-watch', TOP)
    h.advance(120)
    h.log.parked('renderer', TOP)
    const detail = { ...h.audits[0].detail, cursor: { x: 24, y: 8 }, text: 'meeting notes' }
    expect(projectEvent('overlay.flash', detail)).toEqual({ visibleMs: 120, zone: 'notch', placement: 'top-center', layout: 'hide' })
    expect(projectEvent('overlay.flash', { visibleMs: -1, zone: 'menu-bar', placement: 'left', layout: 'bar' })).toEqual({ layout: 'bar' })
  })
})
