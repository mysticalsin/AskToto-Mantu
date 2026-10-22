import { describe, expect, it } from 'vitest'
import { relatedMessage } from './Related'

describe('Related connections panel message', () => {
  it('Related catch shows "Connections are unavailable right now."', () => {
    expect(relatedMessage(null, true)).toBe('Connections are unavailable right now.')
  })

  it('keeps the loading text only while a request is pending', () => {
    expect(relatedMessage(null, false)).toBe('Loading connections…')
  })

  it("passes through the graph's own answer", () => {
    expect(relatedMessage({ ok: false, error: 'Graph is rebuilding.', topics: [], notes: [] }, false)).toBe(
      'Graph is rebuilding.'
    )
    expect(relatedMessage({ ok: false, topics: [], notes: [] }, false)).toBe('No graph yet.')
    expect(relatedMessage({ ok: true, topics: [], notes: [] }, false)).toBe('No connections found yet.')
    expect(relatedMessage({ ok: true, topics: ['x'], notes: [] }, false)).toBeNull()
  })
})
