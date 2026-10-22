import { describe, expect, it } from 'vitest'
import { createHoldChordRecognizer, type HoldChordEvent } from './hold-chord'
import { MODIFIER_BITS as B } from './modifier-mask'

const RCMD = B.rightCommand
const T0 = 10_000

function makeRecognizer(overrides: Partial<Parameters<typeof createHoldChordRecognizer>[0]> = {}) {
  const recognizer = createHoldChordRecognizer({ chordMask: RCMD, ...overrides })
  let seq = 100
  const log: HoldChordEvent[] = []
  const sample = (mask: number, now: number, keyPressed = false): HoldChordEvent[] => {
    if (keyPressed) seq += 1
    const events = recognizer.feed({ mask, seq }, now)
    log.push(...events)
    return events
  }
  const tick = (now: number): HoldChordEvent[] => {
    const events = recognizer.tick(now)
    log.push(...events)
    return events
  }
  // The helper prints a first line on start; it is the baseline, never an "other key".
  sample(0, T0 - 1_000)
  return { recognizer, sample, tick, log }
}

describe('hold threshold', () => {
  it('ignores a press released before 250 ms: no events at all', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(RCMD, T0)
    expect(tick(T0 + 249)).toEqual([])
    sample(0, T0 + 249)
    expect(log).toEqual([])
  })

  it('arms exactly once at 250 ms and releases on key-up', () => {
    const { recognizer, sample, tick, log } = makeRecognizer()
    sample(RCMD, T0)
    expect(recognizer.nextDeadline()).toBe(T0 + 250)
    expect(tick(T0 + 250)).toEqual([{ type: 'armed' }])
    expect(tick(T0 + 900)).toEqual([])
    expect(sample(0, T0 + 1_200)).toEqual([{ type: 'released', reason: 'release' }])
    expect(log.map((e) => e.type)).toEqual(['armed', 'released'])
    expect(recognizer.state()).toBe('idle')
    expect(recognizer.nextDeadline()).toBeNull()
  })

  it('a late tick still arms before it applies the release that arrived with it', () => {
    const { sample, log } = makeRecognizer()
    sample(RCMD, T0)
    sample(0, T0 + 400)
    expect(log).toEqual([{ type: 'armed' }, { type: 'released', reason: 'release' }])
  })

  it('honours a configured threshold', () => {
    const { recognizer, sample, tick } = makeRecognizer({ holdThresholdMs: 600 })
    sample(RCMD, T0)
    expect(tick(T0 + 599)).toEqual([])
    expect(recognizer.nextDeadline()).toBe(T0 + 600)
    expect(tick(T0 + 600)).toEqual([{ type: 'armed' }])
  })
})

describe('alone rule', () => {
  it('another key before the threshold silently disqualifies the press (Right Command + C)', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(RCMD, T0)
    sample(RCMD, T0 + 100, true)
    expect(tick(T0 + 400)).toEqual([])
    sample(0, T0 + 500)
    expect(log).toEqual([])
  })

  it('a key that lands in the same poll as the press disqualifies it', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(RCMD, T0, true)
    expect(tick(T0 + 400)).toEqual([])
    sample(0, T0 + 500)
    expect(log).toEqual([])
  })

  it('another key after arming aborts silently and nothing re-arms until release', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(RCMD, T0)
    tick(T0 + 250)
    expect(sample(RCMD, T0 + 600, true)).toEqual([{ type: 'aborted', reason: 'other-input' }])
    expect(tick(T0 + 5_000)).toEqual([])
    expect(sample(0, T0 + 5_100)).toEqual([])
    expect(log.map((e) => e.type)).toEqual(['armed', 'aborted'])
    sample(RCMD, T0 + 6_000)
    expect(tick(T0 + 6_250)).toEqual([{ type: 'armed' }])
  })

  it('a key typed in the same poll as the release aborts instead of releasing', () => {
    const { sample, tick } = makeRecognizer()
    sample(RCMD, T0)
    tick(T0 + 250)
    expect(sample(0, T0 + 700, true)).toEqual([{ type: 'aborted', reason: 'other-input' }])
  })

  it('an added modifier before the threshold disqualifies the press, and dropping it does not arm a lone chord', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(RCMD, T0)
    sample(RCMD | B.leftShift, T0 + 80)
    sample(RCMD, T0 + 160)
    expect(tick(T0 + 900)).toEqual([])
    sample(0, T0 + 1_000)
    expect(log).toEqual([])
  })

  it('holding another modifier first, then adding the chord, never arms', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(B.leftShift, T0)
    sample(B.leftShift | RCMD, T0 + 50)
    sample(RCMD, T0 + 100)
    expect(tick(T0 + 1_000)).toEqual([])
    sample(0, T0 + 1_100)
    expect(log).toEqual([])
  })

  it('an added modifier after arming aborts', () => {
    const { sample, tick } = makeRecognizer()
    sample(RCMD, T0)
    tick(T0 + 250)
    expect(sample(RCMD | B.leftAlt, T0 + 500)).toEqual([{ type: 'aborted', reason: 'other-modifier' }])
  })

  it('Fn (arrow keys and F-keys set it) and the unsided modifier bit are other modifiers', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(RCMD | B.fn, T0)
    expect(tick(T0 + 400)).toEqual([])
    sample(0, T0 + 500)
    sample(B.unsided, T0 + 1_000)
    expect(tick(T0 + 1_500)).toEqual([])
    sample(0, T0 + 1_600)
    expect(log).toEqual([])
  })

  it('the left Command key does not arm a Right Command chord', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(B.leftCommand, T0)
    expect(tick(T0 + 1_000)).toEqual([])
    sample(0, T0 + 1_100)
    expect(log).toEqual([])
  })

  it('the first sample after a start is a baseline, never another key, even if its counter is large', () => {
    const recognizer = createHoldChordRecognizer({ chordMask: RCMD })
    expect(recognizer.feed({ mask: RCMD, seq: 987_654 }, T0)).toEqual([])
    expect(recognizer.tick(T0 + 250)).toEqual([{ type: 'armed' }])
  })

  it('the keystroke counter wrapping to a smaller value still counts as another key', () => {
    const recognizer = createHoldChordRecognizer({ chordMask: RCMD })
    recognizer.feed({ mask: 0, seq: 4_294_967_295 }, T0 - 10)
    recognizer.feed({ mask: RCMD, seq: 4_294_967_295 }, T0)
    expect(recognizer.tick(T0 + 250)).toEqual([{ type: 'armed' }])
    expect(recognizer.feed({ mask: RCMD, seq: 0 }, T0 + 300)).toEqual([{ type: 'aborted', reason: 'other-input' }])
  })
})

describe('cap', () => {
  it('finishes a hold at 15 s and waits for the release before it can arm again', () => {
    const { recognizer, sample, tick } = makeRecognizer()
    sample(RCMD, T0)
    tick(T0 + 250)
    expect(recognizer.nextDeadline()).toBe(T0 + 250 + 15_000)
    expect(tick(T0 + 250 + 14_999)).toEqual([])
    expect(tick(T0 + 250 + 15_000)).toEqual([{ type: 'released', reason: 'cap' }])
    expect(tick(T0 + 40_000)).toEqual([])
    expect(sample(0, T0 + 40_100)).toEqual([])
    sample(RCMD, T0 + 41_000)
    expect(tick(T0 + 41_250)).toEqual([{ type: 'armed' }])
  })
})

describe('latched (hands-free) mode', () => {
  const tap = (sample: ReturnType<typeof makeRecognizer>['sample'], at: number): void => {
    sample(RCMD, at)
    sample(0, at + 100)
  }

  it('two quick presses latch listening at the second press-down', () => {
    const { recognizer, sample, log } = makeRecognizer()
    tap(sample, T0)
    expect(sample(RCMD, T0 + 100 + 399)).toEqual([{ type: 'latched' }])
    expect(recognizer.state()).toBe('latched')
    expect(sample(0, T0 + 900)).toEqual([])
    expect(log).toEqual([{ type: 'latched' }])
  })

  it('a second press more than 400 ms after the first is an ordinary press', () => {
    const { recognizer, sample, tick } = makeRecognizer()
    tap(sample, T0)
    expect(sample(RCMD, T0 + 100 + 401)).toEqual([])
    expect(recognizer.state()).toBe('pending')
    expect(tick(T0 + 100 + 401 + 250)).toEqual([{ type: 'armed' }])
  })

  it('one more press ends it, and releasing that press changes nothing', () => {
    const { sample } = makeRecognizer()
    tap(sample, T0)
    sample(RCMD, T0 + 300)
    sample(0, T0 + 400)
    expect(sample(RCMD, T0 + 2_000)).toEqual([{ type: 'latch-ended', reason: 'press' }])
    expect(sample(0, T0 + 2_100)).toEqual([])
  })

  it('Escape or any other key ends it', () => {
    const { sample } = makeRecognizer()
    tap(sample, T0)
    sample(RCMD, T0 + 300)
    sample(0, T0 + 400)
    expect(sample(0, T0 + 1_500, true)).toEqual([{ type: 'latch-ended', reason: 'other-input' }])
  })

  it('a different modifier alone (the user starts typing) does not end it', () => {
    const { recognizer, sample } = makeRecognizer()
    tap(sample, T0)
    sample(RCMD, T0 + 300)
    sample(0, T0 + 400)
    expect(sample(B.leftShift, T0 + 500)).toEqual([])
    expect(sample(0, T0 + 600)).toEqual([])
    expect(recognizer.state()).toBe('latched')
  })

  it('the 15 s cap ends it', () => {
    const { recognizer, sample, tick } = makeRecognizer()
    tap(sample, T0)
    sample(RCMD, T0 + 300)
    sample(0, T0 + 400)
    expect(recognizer.nextDeadline()).toBe(T0 + 300 + 15_000)
    expect(tick(T0 + 300 + 15_000)).toEqual([{ type: 'latch-ended', reason: 'cap' }])
    expect(recognizer.state()).toBe('idle')
  })

  it('a long hold followed by a quick press does not latch', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(RCMD, T0)
    tick(T0 + 250)
    sample(0, T0 + 1_000)
    sample(RCMD, T0 + 1_100)
    expect(log.map((e) => e.type)).toEqual(['armed', 'released'])
  })

  it('a tap that was really a shortcut (key during the press) does not count toward the latch', () => {
    const { sample, tick, log } = makeRecognizer()
    sample(RCMD, T0)
    sample(RCMD, T0 + 50, true)
    sample(0, T0 + 100)
    sample(RCMD, T0 + 200)
    expect(tick(T0 + 450)).toEqual([{ type: 'armed' }])
    expect(log.map((e) => e.type)).toEqual(['armed'])
  })

  it('can be switched off: two quick presses are then just two short presses', () => {
    const { sample, tick, log } = makeRecognizer({ latchEnabled: false })
    tap(sample, T0)
    sample(RCMD, T0 + 300)
    expect(tick(T0 + 550)).toEqual([{ type: 'armed' }])
    expect(log.map((e) => e.type)).toEqual(['armed'])
  })
})

describe('Windows chords and AltGr', () => {
  it('AltGr (Windows reports Left Ctrl + Right Alt) never arms Right Ctrl or Left Ctrl + Left Alt', () => {
    const altGr = B.leftControl | B.rightAlt
    for (const chordMask of [B.rightControl, B.leftControl | B.leftAlt]) {
      const { sample, tick, log } = makeRecognizer({ chordMask })
      sample(altGr, T0)
      expect(tick(T0 + 5_000)).toEqual([])
      sample(0, T0 + 5_100)
      expect(log).toEqual([])
    }
  })

  it('Left Ctrl + Left Alt arms only when exactly those two are down', () => {
    const chordMask = B.leftControl | B.leftAlt
    const { sample, tick } = makeRecognizer({ chordMask })
    sample(B.leftControl, T0)
    sample(chordMask, T0 + 20)
    expect(tick(T0 + 270)).toEqual([{ type: 'armed' }])
  })

  it('a multi-key chord released one key at a time is a release, not an abort', () => {
    const chordMask = B.leftControl | B.leftAlt
    const { sample, tick, log } = makeRecognizer({ chordMask })
    sample(B.leftControl, T0)
    sample(chordMask, T0 + 30)
    tick(T0 + 280)
    expect(sample(B.leftControl, T0 + 900)).toEqual([{ type: 'released', reason: 'release' }])
    expect(sample(0, T0 + 950)).toEqual([])
    expect(log.map((e) => e.type)).toEqual(['armed', 'released'])
  })

  it('a multi-key chord with an extra modifier or another key still aborts', () => {
    const chordMask = B.leftControl | B.leftAlt
    const { sample, tick } = makeRecognizer({ chordMask })
    sample(chordMask, T0)
    tick(T0 + 250)
    expect(sample(chordMask | B.leftShift, T0 + 400)).toEqual([{ type: 'aborted', reason: 'other-modifier' }])
    sample(0, T0 + 500)
    sample(chordMask, T0 + 600)
    tick(T0 + 850)
    expect(sample(chordMask, T0 + 900, true)).toEqual([{ type: 'aborted', reason: 'other-input' }])
  })

  it('Right Ctrl alone arms, and Right Ctrl + C (Windows copy) does not', () => {
    const { sample, tick, log } = makeRecognizer({ chordMask: B.rightControl })
    sample(B.rightControl, T0)
    sample(B.rightControl, T0 + 120, true)
    expect(tick(T0 + 500)).toEqual([])
    expect(log).toEqual([])
    sample(0, T0 + 600)
    sample(B.rightControl, T0 + 1_000)
    expect(tick(T0 + 1_250)).toEqual([{ type: 'armed' }])
  })
})

describe('VoiceOver conflict', () => {
  const controlOption = B.leftControl | B.leftAlt

  it('suspends a Control+Option chord while assistive technology is on', () => {
    const { recognizer, sample, tick, log } = makeRecognizer({
      chordMask: controlOption,
      assistiveTechnologyActive: true
    })
    expect(recognizer.suspendedReason()).toBe('assistive-technology')
    sample(controlOption, T0)
    expect(tick(T0 + 1_000)).toEqual([])
    sample(0, T0 + 1_100)
    expect(log).toEqual([])
  })

  it('turning assistive technology on mid-hold aborts the open turn', () => {
    const { recognizer, sample, tick } = makeRecognizer({ chordMask: controlOption })
    sample(controlOption, T0)
    tick(T0 + 250)
    expect(recognizer.configure({ assistiveTechnologyActive: true }, T0 + 400)).toEqual([
      { type: 'aborted', reason: 'suspended' }
    ])
    expect(recognizer.suspendedReason()).toBe('assistive-technology')
  })

  it('leaves the default Right Command chord alone', () => {
    const { recognizer, sample, tick } = makeRecognizer({ assistiveTechnologyActive: true })
    expect(recognizer.suspendedReason()).toBeNull()
    sample(RCMD, T0)
    expect(tick(T0 + 250)).toEqual([{ type: 'armed' }])
  })
})

describe('clock skew and reset', () => {
  it('time going backwards never arms early and never yields a negative duration', () => {
    const { recognizer, sample, tick } = makeRecognizer()
    sample(RCMD, T0)
    expect(tick(T0 - 5_000)).toEqual([])
    expect(recognizer.nextDeadline()).toBe(T0 + 250)
    expect(tick(T0 + 249)).toEqual([])
    expect(tick(T0 + 250)).toEqual([{ type: 'armed' }])
    expect(tick(T0 - 1)).toEqual([])
  })

  it('ignores non-finite clocks', () => {
    const { sample, tick } = makeRecognizer()
    sample(RCMD, T0)
    expect(tick(Number.NaN)).toEqual([])
    expect(tick(Number.POSITIVE_INFINITY)).toEqual([])
    expect(tick(T0 + 250)).toEqual([{ type: 'armed' }])
  })

  it('reset ends an open hold, an open latch, and does nothing when idle', () => {
    const hold = makeRecognizer()
    expect(hold.recognizer.reset(T0, 'reset')).toEqual([])
    hold.sample(RCMD, T0)
    hold.tick(T0 + 250)
    expect(hold.recognizer.reset(T0 + 300, 'suspended')).toEqual([{ type: 'aborted', reason: 'suspended' }])
    // The chord is still physically down: it has to be released before it can open another turn.
    expect(hold.recognizer.state()).toBe('blocked')
    hold.sample(RCMD, T0 + 400)
    expect(hold.tick(T0 + 5_000)).toEqual([])
    hold.sample(0, T0 + 5_100)
    expect(hold.recognizer.state()).toBe('idle')

    const latch = makeRecognizer()
    latch.sample(RCMD, T0)
    latch.sample(0, T0 + 100)
    latch.sample(RCMD, T0 + 200)
    expect(latch.recognizer.reset(T0 + 300, 'reset')).toEqual([{ type: 'latch-ended', reason: 'reset' }])
  })

  it('after a reset the next sample is a fresh baseline (a helper restart restarts its counter)', () => {
    const { recognizer } = makeRecognizer()
    recognizer.reset(T0, 'reset')
    expect(recognizer.feed({ mask: RCMD, seq: 3 }, T0 + 10)).toEqual([])
    expect(recognizer.tick(T0 + 260)).toEqual([{ type: 'armed' }])
  })

  it('changing the chord resets any open hold', () => {
    const { recognizer, sample, tick } = makeRecognizer()
    sample(RCMD, T0)
    tick(T0 + 250)
    expect(recognizer.configure({ chordMask: B.rightControl }, T0 + 300)).toEqual([
      { type: 'aborted', reason: 'reset' }
    ])
  })
})
