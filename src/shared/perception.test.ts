import { describe, expect, it } from 'vitest'
import { formatScreenFreshness } from './perception'

describe('formatScreenFreshness', () => {
  it('shows "Seen now" for a just-captured screen', () => {
    expect(formatScreenFreshness(1_000, 1_100)).toBe('Seen now')
  })

  it('shows one decimal place below one second', () => {
    expect(formatScreenFreshness(1_000, 1_450)).toBe('Seen 0.5s ago')
  })

  it('rounds to whole seconds at and above one second', () => {
    expect(formatScreenFreshness(1_000, 2_600)).toBe('Seen 2s ago')
  })

  it('clamps clock skew to now', () => {
    expect(formatScreenFreshness(2_000, 1_000)).toBe('Seen now')
  })
})
