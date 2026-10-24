import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CardView } from '@shared/suggestions'
import type { QuietPolicy } from '@shared/quiet-mode-settings'
import { SuggestionCarousel, SuggestionCarouselView, createOfferLatch, quietGate } from './SuggestionCarousel'
import { carouselReducer, createShownTracker, initialCarousel } from './carousel-model'
import { AdjustSession, ackShown } from './suggestion-actions'
import { acceptOutcomeCopy } from './suggestion-copy'

const NOW = Date.UTC(2026, 9, 24, 12, 0)
const card = (n: number, over: Partial<CardView> = {}): CardView => ({
  id: String(n).padStart(24, '0'),
  revision: 1,
  nonce: 'f'.repeat(32),
  title: `Card ${n}`,
  evidence: [{ sourceKind: 'calendar', label: 'Budget review', eventAt: NOW, retrievedAt: NOW }],
  createdAt: NOW,
  expiresAt: NOW + 3_600_000,
  ...over
})
const policy = (proactiveSuggestion: QuietPolicy['proactiveSuggestion']): QuietPolicy => ({
  toast: 'allow',
  sound: 'allow',
  spokenReply: 'allow',
  proactiveSuggestion,
  autoAnswerCard: 'allow'
})
const handlers = {
  onPrev: vi.fn(),
  onNext: vi.fn(),
  onAccept: vi.fn(),
  onDismiss: vi.fn(),
  onEdit: vi.fn(),
  onEditChange: vi.fn(),
  onEditSave: vi.fn(),
  onEditCancel: vi.fn()
}
function view(cards: CardView[], extra: { announcement?: string; now?: number } = {}) {
  const state = carouselReducer(initialCarousel(extra.now ?? NOW), { type: 'loaded', cards, lastShownId: null })
  return renderToStaticMarkup(
    createElement(SuggestionCarouselView, {
      state,
      mode: 'settings',
      announcement: extra.announcement ?? '',
      editing: null,
      reducedMotion: false,
      ...handlers
    })
  )
}
function suggestionsApi(over: Record<string, unknown> = {}) {
  return {
    list: vi.fn(),
    checkNow: vi.fn(),
    shown: vi.fn(async () => ({ ok: true }) as const),
    accept: vi.fn(),
    dismiss: vi.fn(),
    adjust: vi.fn(async () => ({ ok: true, revision: 2 }) as const),
    ...over
  } as unknown as Window['toto']['suggestions']
}

describe('suggestion carousel (G69)', () => {
  it('overlay renders nothing and offers once when proactiveSuggestion is not allow', () => {
    expect(
      renderToStaticMarkup(createElement(SuggestionCarousel, { mode: 'overlay', quietPolicy: policy('defer') }))
    ).toBe('')
    expect(quietGate('overlay', policy('defer'))).toBe('hold')
    expect(quietGate('overlay', null)).toBe('hold')
    expect(quietGate('overlay', policy('allow'))).toBe('show')
    const offer = vi.fn()
    const latch = createOfferLatch(offer)
    latch.update('hold', true)
    latch.update('hold', true)
    expect(offer).toHaveBeenCalledTimes(1)
    latch.update('hold', false)
    latch.update('hold', true)
    expect(offer).toHaveBeenCalledTimes(2)
    latch.update('show', true)
    expect(offer).toHaveBeenCalledTimes(2)
  })

  it('settings mode ignores quiet', () => {
    expect(quietGate('settings', policy('drop'))).toBe('show')
    expect(quietGate('settings', null)).toBe('show')
  })

  it('carousel and slide ARIA roles and labels', () => {
    const html = view([card(1), card(2)])
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-roledescription="carousel"')
    expect(html).toContain('aria-label="Suggestions"')
    expect(html).toContain('aria-roledescription="slide"')
    expect(html).toContain('aria-label="Suggestion 1 of 2"')
    expect(html).toContain('aria-label="Previous suggestion"')
    expect(html).toContain('aria-label="Next suggestion"')
    expect(html).toContain('aria-live="polite"')
  })

  it('stale card has Accept disabled', () => {
    const fresh = view([card(1)])
    expect(fresh.match(/<button\b[^>]*>Accept<\/button>/)?.[0]).not.toMatch(/\sdisabled(?:=|>)/)
    const expired = view([card(1, { expiresAt: NOW })])
    expect(expired).toContain('Expired')
    expect(expired.match(/<button\b[^>]*>Accept<\/button>/)?.[0]).toMatch(/\sdisabled(?:=|>)/)
  })

  it('accept ok announces Sources list', () => {
    const text = acceptOutcomeCopy({ ok: true, sources: ['Budget review'] })
    expect(view([card(1)], { announcement: text })).toContain('Accepted. Sources: Budget review')
  })

  it('adjust cancel keeps original title', async () => {
    const api = suggestionsApi()
    const original = card(1)
    const session = new AdjustSession(api, original)
    expect((await session.draft('Prep the forecast')).ok).toBe(true)
    await session.cancel()
    const ref = { id: original.id, revision: 1, nonce: original.nonce }
    expect(vi.mocked(api.adjust).mock.calls).toEqual([
      [{ ...ref, action: 'draft', title: 'Prep the forecast' }],
      [{ ...ref, action: 'cancel' }]
    ])
    expect(view([original])).toContain('Card 1')
    const saved = new AdjustSession(api, original)
    await saved.draft('Prep the forecast')
    await saved.save()
    expect(vi.mocked(api.adjust).mock.calls.at(-1)).toEqual([{ ...ref, action: 'commit' }])
    // A session with no draft sends nothing on cancel.
    const idle = new AdjustSession(api, original)
    const before = vi.mocked(api.adjust).mock.calls.length
    await idle.cancel()
    expect(vi.mocked(api.adjust).mock.calls.length).toBe(before)
  })

  it('shown is acked once per revision', async () => {
    const api = suggestionsApi()
    const tracker = createShownTracker()
    await ackShown(api, tracker, card(1))
    await ackShown(api, tracker, card(1))
    await ackShown(api, tracker, card(1, { revision: 2 }))
    expect(vi.mocked(api.shown).mock.calls).toEqual([
      [{ id: card(1).id, revision: 1, nonce: card(1).nonce }],
      [{ id: card(1).id, revision: 2, nonce: card(1).nonce }]
    ])
  })
})
