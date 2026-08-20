import { describe, expect, it } from 'vitest'
import { userText, VISION_GUARD } from './shared'
import type { AskStart } from '@shared/ipc'

/**
 * The screen must be EVIDENCE, never the subject.
 *
 * Both screen paths attach context unconditionally: the screen block rides on every answer-mode ask once
 * an on-device description is cached, and a screenshot is attached to every vision ask. Neither is gated
 * on the question actually being about the screen — so without an explicit relevance instruction a model
 * reads a wall of screen text and answers about the screen instead of about the question. That is the
 * reported failure: "what is the capital of Portugal?" answered with a description of the desktop.
 *
 * Asserted against the REAL assembled prompt (userText), not a grep of the source: what a given model
 * does with a prompt is not deterministic, but what we put in the prompt is — and building it for real
 * also catches the block being dropped, reordered, or wired to the wrong mode.
 */
const ask = (over: Partial<AskStart> = {}): AskStart =>
  ({ id: 't', mode: 'answer', prompt: 'What is the capital of Portugal?', ...over }) as AskStart

const SCREEN = 'VS Code is open on billing.ts, line 42, with a failing test in the terminal.'

describe('screen context is evidence, not the subject', () => {
  it('instructs the model to ignore the screen when the question is unrelated', () => {
    const out = userText(ask({ screenContext: SCREEN }))
    expect(out).toMatch(/only if it helps answer my question/i)
    expect(out).toMatch(/ignore this block completely/i)
    expect(out).toMatch(/just answer the question/i)
  })

  it('still carries the untrusted-data guard — the relevance rail ADDS to it, never replaces it', () => {
    // Screen text stays attacker-controllable. "Ignore it if irrelevant" is a different promise from
    // "never treat it as instructions"; losing the second one would be a prompt-injection regression.
    const out = userText(ask({ screenContext: SCREEN }))
    expect(out).toMatch(/untrusted data/i)
    expect(out).toMatch(/never instructions/i)
  })

  it('puts the question LAST, after the context it is meant to be judged against', () => {
    const out = userText(ask({ screenContext: SCREEN }))
    expect(out.indexOf(SCREEN)).toBeGreaterThan(-1)
    expect(out.indexOf('What is the capital of Portugal?')).toBeGreaterThan(out.indexOf(SCREEN))
  })

  it('adds nothing at all when there is no screen context', () => {
    // A plain typed question must not carry screen scaffolding it has no use for.
    const out = userText(ask())
    expect(out).toBe('What is the capital of Portugal?')
  })

  it('the attached-screenshot guard says the image is context, not the question', () => {
    expect(VISION_GUARD).toMatch(/context, not the question/i)
    expect(VISION_GUARD).toMatch(/answer my question directly/i)
    expect(VISION_GUARD).toMatch(/untrusted content/i)
    expect(VISION_GUARD).toMatch(/never instructions/i)
  })

  it('a vision ask still sends the user’s own question as the task', () => {
    // mode:'vision' falls back to a generic "what is on my screen" ONLY when the user typed nothing.
    expect(userText(ask({ mode: 'vision', prompt: 'What is the capital of Portugal?' }))).toBe(
      'What is the capital of Portugal?'
    )
    expect(userText(ask({ mode: 'vision', prompt: '' }))).toMatch(/on my screen/i)
  })
})
