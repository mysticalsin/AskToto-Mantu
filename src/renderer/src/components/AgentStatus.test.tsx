import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS, type AgentStatusKind } from '../lib/agent-status'
import { AgentStatus, InlineOrb } from './AgentStatus'
import { Spinner } from './ui'

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: {
    state: string
    size: number
    theme: string
    speed: number
    'aria-label'?: string
  }) =>
    createElement('canvas', {
      'data-thinking-orb': '1',
      'data-state': props.state,
      'data-size': String(props.size),
      'data-theme': props.theme,
      'data-speed': String(props.speed),
      'aria-label': props['aria-label'],
      role: 'img'
    }),
  resolvePreset: () => ({ mode: 'orbits', speed: 1, opts: {} }),
  MODE_DRAWS: { orbits: () => {} }
}))

function html(node: ReactNode): string {
  return renderToStaticMarkup(node)
}

describe('AgentStatus composition', () => {
  it('renders the word first, then the orb, for every mapped kind', () => {
    for (const kind of Object.keys(AGENT_STATUS) as AgentStatusKind[]) {
      const spec = AGENT_STATUS[kind]
      const markup = html(<AgentStatus kind={kind} size="hero" />)
      expect(markup).toContain(`data-agent-status="${kind}"`)
      expect(markup).toContain(`data-orb-state="${spec.state}"`)
      expect(markup).toContain('data-orb-size="64"')
      expect(markup).toContain(`data-state="${spec.state}"`)
      expect(markup).toContain('data-size="64"')
      expect(markup).toContain('data-theme="dark"')
      expect(markup).toContain('data-speed="1"')
      expect(markup).toContain('agent-status--hero')
      expect(markup).toContain('agent-status__word')
      expect(markup).toContain('agent-status__orb')
      expect(markup).toContain('--orb-size:64px')
      const captionAt = markup.indexOf(spec.caption)
      const orbAt = markup.indexOf('data-thinking-orb')
      expect(captionAt).toBeGreaterThan(-1)
      expect(orbAt).toBeGreaterThan(captionAt)
    }
  })

  it('keeps inline named waits as the word then the 20px sphere', () => {
    const markup = html(<AgentStatus kind="listening" size="inline" caption />)
    expect(markup).toContain('Listening')
    expect(markup).toContain('data-orb-size="20"')
    expect(markup.indexOf('Listening')).toBeLessThan(markup.indexOf('data-thinking-orb'))
  })

  it('uses size 20 for inline and omits the caption by default', () => {
    const markup = html(<AgentStatus kind="searching" size="inline" />)
    expect(markup).toContain('data-orb-size="20"')
    expect(markup).not.toMatch(/>Searching</)
  })

  it('sits the 20px orb beside a real percent and keeps the number', () => {
    const markup = html(<AgentStatus kind="loading-model" size="hero" percent={42} />)
    expect(markup).toContain('42%')
    expect(markup).toContain('data-orb-size="20"')
    expect(markup).toContain('data-state="weaving"')
  })

  it('InlineOrb is captionless size 20', () => {
    const markup = html(<InlineOrb kind="connecting" />)
    expect(markup).toContain('data-orb-state="connecting"')
    expect(markup).toContain('data-orb-size="20"')
    expect(markup).not.toMatch(/>Connecting</)
  })

  it('InlineOrb loading can sit beside a real percent', () => {
    const markup = html(<InlineOrb kind="loading" percent={42} />)
    expect(markup).toContain('data-agent-status="loading"')
    expect(markup).toContain('42%')
    expect(markup).not.toMatch(/>needed</)
  })

  it('does not throw when prefers-reduced-motion is reduce', () => {
    const matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('matchMedia', matchMedia)
    expect(() => html(<AgentStatus kind="thinking" size="hero" />)).not.toThrow()
    vi.unstubAllGlobals()
  })

  it('unmounts without leftover work (static markup has no spinner keyframes)', () => {
    const markup = html(<AgentStatus kind="loading" size="hero" />)
    expect(markup).not.toContain('animate-spin')
    expect(markup).not.toContain('loading-spinner')
    expect(markup).not.toContain('shimmer')
  })
})

describe('Spinner is the inline orb, not an SVG keyframe spinner', () => {
  it('renders a thinking orb and no SVG spinner markup', () => {
    const markup = html(<Spinner />)
    expect(markup).toContain('data-thinking-orb')
    expect(markup).toContain('data-orb-state="breathing"')
    expect(markup).not.toContain('loading-spinner')
    expect(markup).not.toContain('animate-spin')
    expect(markup).not.toContain('<circle')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})
