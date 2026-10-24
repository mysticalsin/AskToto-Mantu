// SYNTHETIC fixtures only.
import { describe, expect, it } from 'vitest'
import { FakeSessionContext } from '../../test-helpers/intervention-context'
import { CardSwapGuard } from './card-swap-guard'

const hasCode = (code: string) => expect.objectContaining({ code })

describe('CardSwapGuard', () => {
  it('a duplicate result can restore the prior card only for its newest valid swap ticket', () => {
    const ctx = new FakeSessionContext()
    const cards = new CardSwapGuard(ctx)
    const snapshot = ctx.snapshot('conversation')
    const first = cards.swap(snapshot, { id: 'synthetic-card-1', text: 'First synthetic card' })
    expect(cards.confirm(first)).toBe(true)
    const duplicate = cards.swap(snapshot, { id: 'synthetic-card-2', text: 'Duplicate synthetic card' })
    expect(cards.current?.id).toBe('synthetic-card-2')
    expect(cards.rollback(duplicate)).toBe(true)
    expect(cards.current?.id).toBe('synthetic-card-1')
    expect(() => cards.rollback(duplicate)).toThrow(hasCode('CARD_TICKET_NOT_ISSUED'))
    expect(() => cards.rollback({ swapRevision: 2, cardId: 'synthetic-card-2' })).toThrow(
      hasCode('CARD_TICKET_NOT_ISSUED')
    )
    cards.dispose()
  })

  it('an older duplicate callback cannot overwrite a newer card; context invalidation cannot restore old content', () => {
    const ctx = new FakeSessionContext()
    const cards = new CardSwapGuard(ctx)
    const snapshot = ctx.snapshot('conversation')
    const oldest = cards.swap(snapshot, { id: 'synthetic-oldest', text: 'Oldest synthetic card' })
    const middle = cards.swap(snapshot, { id: 'synthetic-middle', text: 'Middle synthetic card' })
    const newest = cards.swap(snapshot, { id: 'synthetic-newest', text: 'Newest synthetic card' })
    expect(cards.rollback(middle)).toBe(false)
    expect(cards.current?.id).toBe('synthetic-newest')
    expect(cards.rollback(oldest)).toBe(false)
    ctx.setPermissions(['notes.write'])
    expect(cards.current).toBeNull()
    expect(cards.rollback(newest)).toBe(false)
    expect(cards.current).toBeNull()
    cards.dispose()
  })

  it('stamps the card with the snapshot identity and swap revision, and freezes it', () => {
    const ctx = new FakeSessionContext()
    const cards = new CardSwapGuard(ctx)
    const snapshot = ctx.snapshot('conversation')
    cards.swap(snapshot, { id: 'synthetic-card-1', text: 'Synthetic card' })
    expect(cards.current).toMatchObject({
      id: 'synthetic-card-1',
      generation: snapshot.generation,
      contextRevision: snapshot.contextRevision,
      swapRevision: 1
    })
    expect(Object.isFrozen(cards.current)).toBe(true)
    cards.dispose()
  })

  it('rolls back to nothing when the prior card belongs to an older context', () => {
    const ctx = new FakeSessionContext()
    const cards = new CardSwapGuard(ctx)
    const old = ctx.snapshot('conversation')
    cards.swap(old, { id: 'synthetic-card-1', text: 'First' })
    ctx.setScreen('changed')
    expect(cards.current).toBeNull()
    const fresh = ctx.snapshot('conversation')
    const second = cards.swap(fresh, { id: 'synthetic-card-2', text: 'Second' })
    expect(cards.rollback(second)).toBe(true)
    expect(cards.current).toBeNull()
    cards.dispose()
  })

  it('refuses a stale snapshot, a malformed card and use after dispose', () => {
    const ctx = new FakeSessionContext()
    const cards = new CardSwapGuard(ctx)
    const snapshot = ctx.snapshot('conversation')
    expect(() => cards.swap(snapshot, { id: 'bad id', text: 'x' })).toThrow(hasCode('CARD_SCHEMA'))
    expect(() => cards.swap(snapshot, { id: 'ok', text: 'x'.repeat(8_001) })).toThrow(hasCode('CARD_SCHEMA'))
    expect(() => cards.swap(snapshot, { id: 'ok', text: 'x', extra: 1 } as never)).toThrow(hasCode('CARD_SCHEMA'))
    ctx.setScreen('changed')
    expect(() => cards.swap(snapshot, { id: 'ok', text: 'x' })).toThrow(hasCode('STALE_CONTEXT'))
    const ticket = cards.swap(ctx.snapshot('conversation'), { id: 'ok', text: 'x' })
    cards.dispose()
    expect(cards.rollback(ticket)).toBe(false)
    expect(() => cards.swap(ctx.snapshot('conversation'), { id: 'ok', text: 'x' })).toThrow(
      hasCode('CARD_GUARD_CLOSED')
    )
  })
})
