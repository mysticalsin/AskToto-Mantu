import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ActivityPillBody } from './ActivityPill'
import { activityPillView } from './activity-pill-model'

const NOW = 1_000_000

describe('ActivityPillBody (G30)', () => {
  it('is a polite status with the conversation countdown and a real Stop button', () => {
    const view = activityPillView({
      conversation: {
        state: 'listening',
        active: true,
        stopAvailable: true,
        idleExpiresAt: NOW + 120_000,
        maxExpiresAt: NOW + 1_800_000,
        message: null,
        enabled: true
      },
      now: NOW
    })!
    const html = renderToStaticMarkup(<ActivityPillBody view={view} placement="top-center" onAction={vi.fn()} />)
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Conversation on · listening')
    expect(html).toContain('Ends in 2 min')
    expect(html).toContain('aria-label="Stop conversation"')
    expect(html).toContain('data-activity-source="conversation"')
  })

  it('offers no button when nothing can be stopped, and never shows speech text', () => {
    const view = activityPillView({ dictation: { state: 'thinking', enabled: true }, now: NOW })!
    const html = renderToStaticMarkup(<ActivityPillBody view={view} placement="right-edge" onAction={vi.fn()} />)
    expect(html).not.toContain('<button')
    expect(html).toContain('Writing it out…')
    expect(html).toContain('voice-layer--right-edge')
  })

  it('names the reply Stop for assistive technology', () => {
    const view = activityPillView({ spokenReply: { playback: 'reply' }, now: NOW })!
    const html = renderToStaticMarkup(<ActivityPillBody view={view} placement="top-center" onAction={vi.fn()} />)
    expect(html).toContain('aria-label="Stop reading aloud"')
  })
})
