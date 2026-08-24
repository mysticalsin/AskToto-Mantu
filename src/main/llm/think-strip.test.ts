import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ThinkStripper, stripThinking } from './think-strip'

/** Feed a string one character at a time — the worst case for boundary handling. */
function streamCharByChar(text: string): string {
  const s = new ThinkStripper()
  let out = ''
  for (const ch of text) out += s.push(ch)
  return out + s.flush()
}

/** Feed a string in fixed-size chunks, like a real SSE stream. */
function streamInChunks(text: string, size: number): string {
  const s = new ThinkStripper()
  let out = ''
  for (let i = 0; i < text.length; i += size) out += s.push(text.slice(i, i + size))
  return out + s.flush()
}

describe('stripThinking', () => {
  it('passes ordinary text through untouched', () => {
    expect(stripThinking('The renewal is 120k for 12 months.')).toBe('The renewal is 120k for 12 months.')
  })

  it('removes a leading think block and the blank lines it leaves behind', () => {
    const raw = '<think>They asked about price. I should anchor high.</think>\n\nWe are proposing 120k.'
    expect(stripThinking(raw)).toBe('We are proposing 120k.')
  })

  it('removes a think block that appears mid-answer, keeping both sides', () => {
    expect(stripThinking('Before. <think>hidden</think>After.')).toBe('Before. After.')
  })

  it('handles the other tag dialects, case-insensitively, with attributes', () => {
    expect(stripThinking('<thinking>x</thinking>ok')).toBe('ok')
    expect(stripThinking('<Reasoning>x</Reasoning>ok')).toBe('ok')
    expect(stripThinking('<THOUGHT>x</THOUGHT>ok')).toBe('ok')
    expect(stripThinking('<think type="internal">x</think>ok')).toBe('ok')
  })

  it('removes several think blocks in one answer', () => {
    expect(stripThinking('a<think>1</think>b<think>2</think>c')).toBe('abc')
  })

  it('never loses real text — a lone < or a non-think tag is emitted verbatim', () => {
    expect(stripThinking('2 < 3 and 5 > 4')).toBe('2 < 3 and 5 > 4')
    expect(stripThinking('use <div> for layout')).toBe('use <div> for layout')
    expect(stripThinking('a < b')).toBe('a < b')
    expect(stripThinking('trailing <')).toBe('trailing <')
    expect(stripThinking('<thinker> is not a think tag')).toBe('<thinker> is not a think tag')
  })

  it('catches a tag split across chunk boundaries', () => {
    const s = new ThinkStripper()
    let out = s.push('Answer: ')
    out += s.push('<thi')
    out += s.push('nk>secret')
    out += s.push('</thi')
    out += s.push('nk>done')
    out += s.flush()
    expect(out).toBe('Answer: done')
  })

  it('is chunk-size independent — same result at every granularity', () => {
    const raw = '<think>plan: anchor at 120k, concede to 110k</think>We propose 120k for 12 months.'
    const expected = 'We propose 120k for 12 months.'
    expect(streamCharByChar(raw)).toBe(expected)
    for (const size of [1, 2, 3, 5, 7, 13, 64]) {
      expect(streamInChunks(raw, size)).toBe(expected)
    }
  })

  it('preserves whitespace INSIDE the answer, trimming only the leading gap', () => {
    expect(stripThinking('<think>x</think>\n\nLine one.\n\nLine two.')).toBe('Line one.\n\nLine two.')
  })

  it('shows the thinking rather than nothing when a think block never closes', () => {
    // A truncated reasoning stream would otherwise render a blank answer, which is the worse failure.
    expect(stripThinking('<think>I was cut off mid-thought')).toBe('I was cut off mid-thought')
  })

  it('still suppresses an unterminated block when a real answer was already emitted', () => {
    expect(stripThinking('The answer is 120k.<think>now let me second-guess')).toBe('The answer is 120k.')
  })

  it('does not buffer without bound on a long unterminated think block', () => {
    const s = new ThinkStripper()
    for (let i = 0; i < 500; i++) s.push('<think>'.slice(0, i === 0 ? 7 : 0) + 'reasoning text ')
    // Nothing emitted while thinking; flush releases it since no real answer ever arrived.
    expect(s.flush()).toContain('reasoning text')
  })

  it('handles an empty stream and empty deltas', () => {
    expect(stripThinking('')).toBe('')
    const s = new ThinkStripper()
    expect(s.push('')).toBe('')
    expect(s.flush()).toBe('')
  })
})

describe('wiring — the strip runs at the one provider-agnostic choke point', () => {
  const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

  it('every provider delta passes through the stripper, never straight to the renderer', () => {
    // If a future edit sends a raw delta again, thinking leaks for whichever provider it touched.
    expect(source).toMatch(/onDelta: \(text\) => \{[\s\S]{0,400}paint\(think\.push\(text\)\)/)
  })

  it('flushes on done BEFORE the empty-answer failover judges the leg content-less', () => {
    const at = source.indexOf('paint(think.flush())')
    expect(at).toBeGreaterThan(-1)
    const emptyCheck = source.indexOf('if (!gotToken && provider !==', at)
    expect(emptyCheck).toBeGreaterThan(at)
  })

  it('creates one stripper per attempt rather than sharing position state across streams', () => {
    expect(source).toMatch(/const think = new ThinkStripper\(\)/)
  })
})

describe('other reasoning dialects', () => {
  it("strips Kimi's unicode-bracket think block", () => {
    expect(stripThinking('◁think▷hidden working◁/think▷The answer is 68.')).toBe('The answer is 68.')
  })

  it('strips a harmony analysis channel and keeps the final channel (gpt-oss / CF deep tier)', () => {
    const raw = '<|channel|>analysis<|message|>SECRET working out 17x4<|end|><|start|>assistant<|channel|>final<|message|>68'
    const out = stripThinking(raw)
    expect(out).toContain('68')
    expect(out).not.toContain('SECRET')
    expect(out).not.toContain('<|')
  })

  it('strips a harmony commentary channel too', () => {
    const raw = '<|channel|>commentary<|message|>meta chatter<|end|><|channel|>final<|message|>Done.'
    const out = stripThinking(raw)
    expect(out).toBe('Done.')
  })

  it('leaves no bare harmony scaffolding around a plain answer', () => {
    expect(stripThinking('<|start|>assistant<|message|>Plain answer.')).toBe('Plain answer.')
  })

  it('handles harmony split across chunk boundaries', () => {
    const raw = '<|channel|>analysis<|message|>SECRET<|end|><|channel|>final<|message|>68'
    for (const size of [1, 3, 7, 11, 29]) {
      expect(streamInChunks(raw, size)).not.toContain('SECRET')
      expect(streamInChunks(raw, size)).toContain('68')
    }
  })

  it('still never loses ordinary text containing a pipe or triangle', () => {
    expect(stripThinking('a | b and 2 < 3')).toBe('a | b and 2 < 3')
  })
})

describe('reflection-tuned models (NVIDIA NIM and similar)', () => {
  it('strips the <thinking>/<reflection> pair and unwraps <output>', () => {
    const raw =
      '<thinking>SECRET working</thinking><reflection>SECRET second-guessing</reflection><output>68</output>'
    expect(stripThinking(raw)).toBe('68')
  })

  it('strips <reflection> even when <thinking> is absent', () => {
    expect(stripThinking('<reflection>SECRET critique</reflection>The answer is 68.')).toBe('The answer is 68.')
  })

  it('unwraps an answer wrapper without eating the answer inside it', () => {
    for (const w of ['output', 'answer', 'final', 'response', 'result']) {
      expect(stripThinking(`<${w}>68</${w}>`)).toBe('68')
    }
  })

  it('handles the NIM triple split across chunk boundaries', () => {
    const full = '<thinking>SECRET</thinking><reflection>SECRET2</reflection><output>68</output>'
    for (const size of [1, 3, 5, 9, 17, 40]) {
      const out = streamInChunks(full, size)
      expect(out).not.toContain('SECRET')
      expect(out).toBe('68')
    }
  })

  it('covers the other reflection spellings and plan/critique blocks', () => {
    expect(stripThinking('<reflexion>x</reflexion>ok')).toBe('ok')
    expect(stripThinking('<critique>x</critique>ok')).toBe('ok')
    expect(stripThinking('<plan>x</plan>ok')).toBe('ok')
    expect(stripThinking('<inner_monologue>x</inner_monologue>ok')).toBe('ok')
  })

  it('does not eat ordinary words that merely resemble a wrapper', () => {
    expect(stripThinking('The output was 68 and the result is final.')).toBe(
      'The output was 68 and the result is final.'
    )
  })
})
