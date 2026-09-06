import { describe, expect, it } from 'vitest'
import { geoCountryRollup, realtimeGeoRows } from './realtime-geo'

describe('realtimeGeoRows', () => {
  it('emits Shoey city rows: country, city, count, unique_sessions, avg_duration', () => {
    const rows = realtimeGeoRows([
      {
        device_id: 'a',
        country: 'CA',
        city: 'Longueuil',
        first_seen: 1_000,
        last_seen: 1_000 + 60_000
      },
      {
        device_id: 'b',
        country: 'ca',
        city: 'Longueuil',
        first_seen: 1_000,
        last_seen: 1_000 + 120_000
      },
      { device_id: 'c', country: 'US', city: 'Austin', first_seen: 1_000, last_seen: 1_000 }
    ])
    expect(rows[0]).toEqual({
      country: 'CA',
      city: 'Longueuil',
      count: 2,
      unique_sessions: 2,
      avg_duration: 90_000
    })
    expect(rows[1]?.city).toBe('Austin')
    expect(geoCountryRollup(rows)).toEqual([
      { country: 'CA', count: 2 },
      { country: 'US', count: 1 }
    ])
  })

  it('drops country-only seats so city is required', () => {
    expect(
      realtimeGeoRows([{ device_id: 'x', country: 'CA', city: null, first_seen: 1, last_seen: 2 }])
    ).toEqual([])
  })
})
