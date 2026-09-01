import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { IntelligenceUpdateButton } from './IntelligenceUpdateButton'

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: { state: string; size: number }) =>
    createElement('canvas', {
      'data-thinking-orb': '1',
      'data-state': props.state,
      'data-size': String(props.size)
    }),
  resolvePreset: () => ({ mode: 'orbits', speed: 1, opts: {} }),
  MODE_DRAWS: { orbits: () => {} }
}))

function html(node: ReactNode): string {
  return renderToStaticMarkup(node)
}

describe('IntelligenceUpdateButton', () => {
  it('is present with friendly Update copy', () => {
    const markup = html(<IntelligenceUpdateButton updating={false} onClick={() => {}} />)
    expect(markup).toContain('data-intelligence-update')
    expect(markup).toContain('Update Intelligence')
    expect(markup).not.toMatch(/Run agent|Trigger pass|lab-demo/i)
    expect(markup).not.toMatch(/Loader2|animate-spin|loading-spinner/)
  })

  it('shows the working orb while the pass is running', () => {
    const markup = html(<IntelligenceUpdateButton updating onClick={() => {}} />)
    expect(markup).toContain('Updating')
    expect(markup).toContain('data-orb-state')
    expect(markup).toContain('disabled')
  })
})
