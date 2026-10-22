import { describe, expect, it } from 'vitest'
import { RELIST_MIN_GAP_MS, shouldRelist } from './relist'

describe('History re-list on return', () => {
  const base = { visible: true, searching: false, sinceLastMs: RELIST_MIN_GAP_MS }

  it('re-lists when the window returns and no search is active', () => {
    expect(shouldRelist(base)).toBe(true)
  })

  it('never re-lists a hidden window or over an active search', () => {
    expect(shouldRelist({ ...base, visible: false })).toBe(false)
    expect(shouldRelist({ ...base, searching: true })).toBe(false)
  })

  it('does not re-list twice in quick succession (focus and visibility fire together)', () => {
    expect(shouldRelist({ ...base, sinceLastMs: RELIST_MIN_GAP_MS - 1 })).toBe(false)
  })
})
