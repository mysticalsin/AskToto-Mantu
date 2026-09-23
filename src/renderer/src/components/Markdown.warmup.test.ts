import { describe, expect, it } from 'vitest'
import { shouldWarmHighlighter } from './Markdown'

describe('Markdown highlighter warm-up', () => {
  it('does not warm Shiki for ordinary streamed prose', () => {
    expect(shouldWarmHighlighter(false, 'A concise meeting summary with `inline code`.')).toBe(false)
    expect(shouldWarmHighlighter(false, '`` two ticks are not a fence.')).toBe(false)
  })

  it('warms when a real backtick or tilde fence begins, including an unfinished streamed block', () => {
    expect(shouldWarmHighlighter(false, '```ts\nconst answer = 42')).toBe(true)
    expect(shouldWarmHighlighter(false, '  ~~~python\nprint("ready")')).toBe(true)
  })

  it('warms once when a fence arrives after initial prose and never schedules it again', () => {
    let warmed = shouldWarmHighlighter(false, 'The answer is still streaming.')
    expect(warmed).toBe(false)
    warmed = shouldWarmHighlighter(warmed, 'The answer is still streaming.\n\n```json\n{')
    expect(warmed).toBe(true)
    expect(shouldWarmHighlighter(warmed, 'The completed block follows.\n```json\n{}\n```')).toBe(false)
  })
})
