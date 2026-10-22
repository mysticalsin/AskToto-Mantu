import { describe, expect, it } from 'vitest'
import { afterCloudTrackRecovered, cloudTrackErrorNote } from './listen-cloud-track'
import { cloudTrackLostMessage, cloudTrackReconnectingMessage } from './listen-notes'

describe('Q03 cloud track banner projection (D2-4)', () => {
  it('marks the side that dropped, reconnecting then lost', () => {
    expect(cloudTrackErrorNote('you', true)).toEqual({
      side: 'you',
      note: cloudTrackReconnectingMessage('you'),
      permission: false
    })
    expect(cloudTrackErrorNote('them', false)).toEqual({
      side: 'them',
      note: cloudTrackLostMessage('them'),
      permission: false
    })
  })

  it('clears only its own note on recovery', () => {
    const own = cloudTrackErrorNote('them', true)
    expect(afterCloudTrackRecovered({ error: own.note, captureDegraded: own }, 'them')).toEqual({
      error: null,
      captureDegraded: null
    })
    const other = { error: 'Back online.', captureDegraded: null }
    expect(afterCloudTrackRecovered(other, 'them')).toBe(other)
    const otherSide = { error: own.note, captureDegraded: own }
    expect(afterCloudTrackRecovered(otherSide, 'you')).toBe(otherSide)
  })
})
