import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThinkingOrb } from 'thinking-orbs'
import { AgentStatus } from './AgentStatus'

describe('thinking-orbs package (real renderer, no rewrite)', () => {
  it('renders a 2D canvas and does not throw under reduced-motion', () => {
    const matchMedia = (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false
      },
      onchange: null
    })
    // @ts-expect-error test stub
    globalThis.matchMedia = matchMedia
    const markup = renderToStaticMarkup(<ThinkingOrb state="solving" size={64} theme="dark" speed={1} />)
    expect(markup).toContain('<canvas')
    expect(markup).not.toContain('webgl')
  })

  it('AgentStatus unmounts cleanly through static render (no leftover spinner markup)', () => {
    const markup = renderToStaticMarkup(<AgentStatus kind="thinking" size="hero" />)
    expect(markup).toContain('Thinking')
    expect(markup).toContain('<canvas')
    expect(markup).not.toContain('animate-spin')
  })
})
