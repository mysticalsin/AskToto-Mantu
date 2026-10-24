import { describe, expect, it } from 'vitest'
import { createSnapshotOrder } from './snapshot-order'

describe('createSnapshotOrder (G30 — Codex P1: a late getState must not hide an active capture)', () => {
  it('keeps revision 2 from onState when the older getState revision 1 resolves later', () => {
    const order = createSnapshotOrder()
    expect(order.push({ revision: 2, active: true })).toBe(true)
    expect(order.pull({ revision: 1, active: false })).toBe(false)
  })

  it('accepts a newer pull and drops a stale push after it', () => {
    const order = createSnapshotOrder()
    expect(order.pull({ revision: 5 })).toBe(true)
    expect(order.push({ revision: 4 })).toBe(false)
    expect(order.push({ revision: 5 })).toBe(true)
    expect(order.push({ revision: 6 })).toBe(true)
  })

  it('drops a pull without a revision once any push arrived, and never admits null', () => {
    const order = createSnapshotOrder()
    expect(order.pull(null)).toBe(false)
    expect(order.push({ playback: 'reply' })).toBe(true)
    expect(order.pull({ playback: 'idle' })).toBe(false)
    expect(order.push({ playback: 'idle' })).toBe(true)
  })

  it('admits the first pull when nothing was pushed yet', () => {
    expect(createSnapshotOrder().pull({ playback: 'idle' })).toBe(true)
  })
})
