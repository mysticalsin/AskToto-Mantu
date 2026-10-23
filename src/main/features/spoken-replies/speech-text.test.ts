import { describe, expect, it } from 'vitest'
import { MAX_SPOKEN_CHARS, toSpokenText } from './speech-text'

describe('toSpokenText (G27)', () => {
  it('reads prose as it is', () => {
    expect(toSpokenText('The meeting is at three.')).toBe('The meeting is at three.')
  })

  it('drops fenced code blocks and keeps the words around them', () => {
    const text = toSpokenText('Run this:\n```bash\nrm -rf /\n```\nThen restart.')
    expect(text).toBe('Run this:\nThen restart.')
    expect(text).not.toContain('rm')
  })

  it('reads inline code, links and emphasis as their words', () => {
    expect(
      toSpokenText('Use `npm test`, see [the docs](https://example.test/a?b=1) for **bold** and _soft_ ~~old~~ parts.')
    ).toBe('Use npm test, see the docs for bold and soft old parts.')
  })

  it('never reads a bare URL or an image address aloud', () => {
    const text = toSpokenText(
      'Open https://example.test/very/long/path?x=1 now ![chart](https://example.test/c.png) ok'
    )
    expect(text).not.toMatch(/https?:|example\.test/)
    expect(text).toBe('Open now chart ok')
  })

  it('removes list, heading and quote markers', () => {
    expect(toSpokenText('# Plan\n- one\n* two\n1. three\n> quoted')).toBe('Plan\none\ntwo\nthree\nquoted')
  })

  it('collapses blank runs and spaces', () => {
    expect(toSpokenText('a   b\n\n\n\nc')).toBe('a b\nc')
  })

  it('returns an empty string when nothing is speakable', () => {
    expect(toSpokenText('')).toBe('')
    expect(toSpokenText('```\ncode only\n```')).toBe('')
    expect(toSpokenText('   \n  ')).toBe('')
    expect(toSpokenText(undefined as unknown as string)).toBe('')
  })

  it('cuts a very long answer at a sentence end under the cap', () => {
    const sentence = 'This is one sentence. '
    const text = toSpokenText(sentence.repeat(1000))
    expect(text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS)
    expect(text.endsWith('.')).toBe(true)
  })

  it('cuts a very long answer with no sentence end at the cap', () => {
    expect(toSpokenText('x'.repeat(MAX_SPOKEN_CHARS * 2)).length).toBe(MAX_SPOKEN_CHARS)
  })

  it('removes control characters that could confuse a speech engine', () => {
    expect(toSpokenText('a\u0000b\u0007c\u001b[31md')).toBe('abc[31md')
  })
})
