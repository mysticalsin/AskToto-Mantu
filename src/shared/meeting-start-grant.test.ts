import { describe, expect, it } from 'vitest'
import { MEETING_START_GRANT_TTL_MS, startGrantLikelyExpired } from './meeting-start-grant'

describe('meeting-start grant lifetime', () => {
  it('is the 5 s window main mints', () => {
    expect(MEETING_START_GRANT_TTL_MS).toBe(5_000)
  })

  it('treats a grant as spent a second before it really expires, never earlier', () => {
    expect(startGrantLikelyExpired(0, 3_999)).toBe(false)
    expect(startGrantLikelyExpired(0, 4_000)).toBe(true)
    expect(startGrantLikelyExpired(10_000, 10_100)).toBe(false)
  })
})
