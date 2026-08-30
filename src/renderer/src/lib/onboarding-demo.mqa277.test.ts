import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEMO_LINES,
  DEMO_STAGE_BOUNDARIES,
  DEMO_TIMING,
  demoFrameAt
} from './onboarding-demo'

describe('MQA-277 — Act 2 (Demo) scripted timeline projector (demoFrameAt)', () => {
  it('shows nothing before the first line lands', () => {
    const f = demoFrameAt(0)
    expect(f.lines).toEqual([])
    expect(f.stage).toBe('lines')
    expect(f.suggestion).toBeNull()
    expect(f.factcheck).toBeNull()
    expect(f.meetingEnded).toBe(false)
    expect(f.done).toBe(false)
  })

  it('reveals transcript lines one at a time, in order, never out of order and never skipping ahead', () => {
    const beforeAny = demoFrameAt(DEMO_TIMING.line1 - 1)
    expect(beforeAny.lines).toHaveLength(0)

    const afterFirst = demoFrameAt(DEMO_TIMING.line1)
    expect(afterFirst.lines).toHaveLength(1)
    expect(afterFirst.lines[0].speaker).toBe('them')

    const afterSecond = demoFrameAt(DEMO_TIMING.line2)
    expect(afterSecond.lines).toHaveLength(2)
    expect(afterSecond.lines.map((l) => l.speaker)).toEqual(['them', 'you'])

    const afterThird = demoFrameAt(DEMO_TIMING.line3)
    expect(afterThird.lines).toHaveLength(3)
  })

  it('is a pure, deterministic function of elapsedMs — same input, same (deep-equal) output', () => {
    const a = demoFrameAt(4200)
    const b = demoFrameAt(4200)
    expect(a).toEqual(b)
  })

  it('the suggestion only appears once its beat starts, streams (0<progress<1 => not full text), and ' +
      'settles to the exact full text once the beat ends', () => {
    expect(demoFrameAt(DEMO_TIMING.suggestionTextStart - 1).suggestion).toBeNull()

    const mid = demoFrameAt(Math.round((DEMO_TIMING.suggestionTextStart + DEMO_TIMING.suggestionTextEnd) / 2))
    expect(mid.suggestion).not.toBeNull()
    expect(mid.suggestion!.streaming).toBe(true)
    expect(mid.suggestion!.text.length).toBeGreaterThan(0)

    const settled = demoFrameAt(DEMO_TIMING.suggestionTextEnd)
    expect(settled.suggestion!.streaming).toBe(false)
    expect(settled.suggestion!.text).toMatch(/^\*\*Say this:\*\*/)
  })

  it('the fact-check verdict is parseable the same way Answer.tsx parses a real verdict', () => {
    const settled = demoFrameAt(DEMO_TIMING.factcheckTextEnd)
    expect(settled.factcheck!.streaming).toBe(false)
    expect(settled.factcheck!.text).toMatch(/^VERDICT:\s*MISLEADING\b/)
  })

  it('stages advance monotonically: lines -> suggestion -> factcheck -> recap, never backwards', () => {
    const order = ['lines', 'suggestion', 'factcheck', 'recap']
    const samples = [0, DEMO_TIMING.cursorToSuggestionStart, DEMO_TIMING.cursorToFactcheckStart, DEMO_TIMING.recapStart]
    let lastIdx = -1
    for (const t of samples) {
      const idx = order.indexOf(demoFrameAt(t).stage)
      expect(idx).toBeGreaterThanOrEqual(lastIdx)
      lastIdx = idx
    }
  })

  it('the synthetic cursor targets the suggestion chip during the suggestion stage, arrives (progress 1) ' +
      'exactly at cursorToSuggestionArrive, and flashes "pressed" briefly right after', () => {
    const approaching = demoFrameAt(DEMO_TIMING.cursorToSuggestionStart + 200)
    expect(approaching.cursor.target).toBe('suggestion')
    expect(approaching.cursor.progress).toBeGreaterThan(0)
    expect(approaching.cursor.progress).toBeLessThan(1)
    expect(approaching.cursor.pressed).toBe(false)

    const arrived = demoFrameAt(DEMO_TIMING.cursorToSuggestionArrive)
    expect(arrived.cursor.progress).toBe(1)
    expect(arrived.cursor.pressed).toBe(true)

    const longAfter = demoFrameAt(DEMO_TIMING.cursorToSuggestionArrive + 5000)
    expect(longAfter.cursor.pressed).toBe(false)
  })

  it('the cursor retargets to the fact-check chip during the fact-check stage', () => {
    const approaching = demoFrameAt(DEMO_TIMING.cursorToFactcheckStart + 200)
    expect(approaching.cursor.target).toBe('factcheck')
  })

  it('meetingEnded flips true only once recap starts, and clears the suggestion/fact-check cards', () => {
    const beforeRecap = demoFrameAt(DEMO_TIMING.recapStart - 1)
    expect(beforeRecap.meetingEnded).toBe(false)

    const recap = demoFrameAt(DEMO_TIMING.recapStart)
    expect(recap.meetingEnded).toBe(true)
    expect(recap.suggestion).toBeNull()
    expect(recap.factcheck).toBeNull()
  })

  it('done flips true only once the whole script has played out', () => {
    expect(demoFrameAt(DEMO_TIMING.end - 1).done).toBe(false)
    expect(demoFrameAt(DEMO_TIMING.end).done).toBe(true)
    expect(demoFrameAt(DEMO_TIMING.end + 999999).done).toBe(true)
  })

  it('DEMO_STAGE_BOUNDARIES is sorted ascending and ends at DEMO_TIMING.end (reduced-motion stepper relies on this)', () => {
    for (let i = 1; i < DEMO_STAGE_BOUNDARIES.length; i++) {
      expect(DEMO_STAGE_BOUNDARIES[i]).toBeGreaterThanOrEqual(DEMO_STAGE_BOUNDARIES[i - 1])
    }
    expect(DEMO_STAGE_BOUNDARIES[DEMO_STAGE_BOUNDARIES.length - 1]).toBe(DEMO_TIMING.end)
  })

  it('DEMO_LINES only ever contains "them"/"you" speakers — never "unknown" (this is a scripted, ' +
      'fully-attributed fake meeting, not an imported recording)', () => {
    for (const l of DEMO_LINES) expect(['them', 'you']).toContain(l.speaker)
  })
})

describe('MQA-278 — the demo script structurally cannot read real app/session state (contract test)', () => {
  it('never imports or references window.toto, the live listen engine, or renderer state — its only ' +
      'inputs are its own constants and a plain elapsedMs number, so a real transcript/session can ' +
      'never leak into the demo through this module', () => {
    const src = readFileSync(new URL('./onboarding-demo.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/window\.toto/)
    expect(src).not.toMatch(/from ['"]\.\.\/lib\/listen['"]/)
    expect(src).not.toMatch(/from ['"]\.\/listen['"]/)
    expect(src).not.toMatch(/from ['"]\.\.\/state['"]/)
    expect(src).not.toMatch(/from ['"]\.\.\/App['"]/)
  })
})
