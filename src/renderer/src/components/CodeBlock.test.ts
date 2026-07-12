import { describe, it, expect } from 'vitest'
import { isFencedBlock } from './CodeBlock'

// Regression test: a single-line fenced ``` block with no language used to render as an inline pill
// because the old heuristic (`lang !== '' || text.includes('\n')`) has no way to tell a bare one-line
// fence from genuine inline code — both have no language and no embedded newline. Streamdown itself
// never passes an `inline` prop; the only reliable signal is whether the `pre` wrapper stamped
// `data-block` onto the code element (see Markdown.tsx). isFencedBlock must gate on that alone.
describe('isFencedBlock — fenced-vs-inline code signal', () => {
  it('treats a code element carrying data-block as a fenced block, regardless of its value', () => {
    expect(isFencedBlock({ 'data-block': true })).toBe(true)
    expect(isFencedBlock({ 'data-block': 'true' })).toBe(true)
    expect(isFencedBlock({ 'data-block': false })).toBe(true) // key PRESENCE is the signal, not truthiness
  })

  it('treats a code element with no data-block key as genuinely inline', () => {
    expect(isFencedBlock({})).toBe(false)
    expect(isFencedBlock({ className: undefined, children: 'ls -la' })).toBe(false)
  })

  it('is unaffected by language or newline content — those no longer decide block-vs-inline', () => {
    // A single-line, no-language fence (the regressed case): still a block once tagged.
    expect(isFencedBlock({ 'data-block': true, className: '', children: 'ls -la' })).toBe(true)
    // Multi-line or language-tagged content with NO data-block (shouldn't normally happen, but the
    // helper must not fall back to guessing from content) is still classified as inline.
    expect(isFencedBlock({ className: 'language-bash', children: 'ls -la\npwd' })).toBe(false)
  })
})
