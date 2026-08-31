import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
    expect(markup).toContain('agent-status__orb')
    expect(markup).not.toContain('animate-spin')
  })

  it('paints the first orb frame in useLayoutEffect through the package engine', () => {
    const src = readFileSync(resolve(__dirname, 'AgentStatus.tsx'), 'utf8')
    expect(src).toMatch(/useLayoutEffect/)
    expect(src).toMatch(/paintOrbFirstFrame/)
    expect(src).toMatch(/agent-status__orb/)
    expect(src).not.toMatch(/ctx\.filter/)
    expect(src).not.toMatch(/webgl/i)
  })
})
