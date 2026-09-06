import { describe, expect, it } from 'vitest'
import { formatAvgDuration, geoCountryRollup, geoRegionRows, realtimeGeoRows } from './realtime-geo'

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
      { country: 'CA', count: 2, unique_sessions: 2, avg_duration: 90_000 },
      { country: 'US', count: 1, unique_sessions: 1, avg_duration: 0 }
    ])
  })

  it('rolls region from request.cf.region, not city-as-country', () => {
    expect(
      geoRegionRows([
        {
          device_id: 'a',
          country: 'CA',
          city: 'Longueuil',
          region: 'Quebec',
          first_seen: 1,
          last_seen: 2
        },
        {
          device_id: 'b',
          country: 'CA',
          city: 'Longueuil',
          region: null,
          first_seen: 1,
          last_seen: 2
        }
      ])
    ).toEqual([
      { country: 'CA', region: 'Quebec', count: 1, unique_sessions: 1, avg_duration: 1 }
    ])
  })

  it('formats avg_duration for the GeoTable', () => {
    expect(formatAvgDuration(0)).toBe('0s')
    expect(formatAvgDuration(90_000)).toBe('2m')
    expect(formatAvgDuration(4500)).toBe('5s')
  })

  it('drops country-only seats so city is required', () => {
    expect(
      realtimeGeoRows([{ device_id: 'x', country: 'CA', city: null, first_seen: 1, last_seen: 2 }])
    ).toEqual([])
  })

  it('uses sessions (gap-bounded pulses), not seat lifetime, when a sessions table is passed', () => {
    const seats = [
      { device_id: 'a', country: 'CA', city: 'Longueuil', first_seen: 0, last_seen: 1_000_000 }
    ]
    const sessions = [
      { device_id: 'a', country: 'CA', city: 'Longueuil', started_at: 0, last_pulse_at: 60_000, ended_at: 60_000 },
      { device_id: 'a', country: 'CA', city: 'Longueuil', started_at: 500_000, last_pulse_at: 560_000, ended_at: null }
    ]
    const rows = realtimeGeoRows(seats, sessions)
    expect(rows).toEqual([
      { country: 'CA', city: 'Longueuil', count: 1, unique_sessions: 2, avg_duration: 60_000 }
    ])
  })

  it('region rows also prefer sessions over seat lifetime when given', () => {
    const seats = [{ device_id: 'a', country: 'CA', city: 'Longueuil', region: 'Quebec', first_seen: 0, last_seen: 1_000_000 }]
    const sessions = [
      { device_id: 'a', country: 'CA', city: 'Longueuil', region: 'Quebec', started_at: 0, last_pulse_at: 30_000, ended_at: 30_000 }
    ]
    expect(geoRegionRows(seats, sessions)).toEqual([
      { country: 'CA', region: 'Quebec', count: 1, unique_sessions: 1, avg_duration: 30_000 }
    ])
  })
})
