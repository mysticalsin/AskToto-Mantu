import { describe, expect, it } from 'vitest'
import { formatAvgDuration, geoCountryRollup, geoRegionRows, realtimeGeoRows, placeKey, realtimePlaceActivity, realtimePlaces } from './realtime-geo'

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

describe('realtimePlaces (Rock 1 live map contract)', () => {
  const NOW = 1_725_000_000_000
  const base = {
    seat_hash: 's', os: 'darwin', app_version: '1.9.6', first_seen: NOW - 3_600_000, region: null,
    last_index_at: null, hostname: null, sso_email: null, license: null, approval: 'approved'
  }
  const seat = (o: Record<string, unknown>) => ({ ...base, country: 'CA', city: 'Montreal', lat: 45.5017, lon: -73.5673, last_seen: NOW, ...o }) as never

  it('groups by ISO2 + city + lat/lon at 2 dp and counts seats and open sessions', () => {
    const places = realtimePlaces(
      [seat({ device_id: 'a' }), seat({ device_id: 'b', lat: 45.5049, lon: -73.5711 }), seat({ device_id: 'c', city: 'Laval', lat: 45.6, lon: -73.75 })],
      [{ id: 's1', device_id: 'a', started_at: NOW - 1000, last_pulse_at: NOW, ended_at: null, pulses: 1, asks: 0, recaps: 0, country: 'CA', city: 'Montreal', os: null, app_version: null }],
      NOW
    )
    expect(places).toEqual([
      { iso2: 'CA', country: 'Canada', region: null, city: 'Montreal', lat: 45.5, lon: -73.57, seats: 2, sessions: 1 },
      { iso2: 'CA', country: 'Canada', region: null, city: 'Laval', lat: 45.6, lon: -73.75, seats: 1, sessions: 0 }
    ])
    expect(placeKey(places[0])).toBe('CA|Montreal|45.50|-73.57')
  })

  it('keeps seats exactly 30 min old, drops older ones, synthetic seats, and out-of-range coordinates', () => {
    const places = realtimePlaces(
      [
        seat({ device_id: 'edge', last_seen: NOW - 30 * 60_000 }),
        seat({ device_id: 'old', city: 'Old', last_seen: NOW - 30 * 60_000 - 1 }),
        seat({ device_id: 'usage-import-1', city: 'Synthetic' }),
        seat({ device_id: 'bad', city: 'Bad', lat: 123, lon: 10 })
      ],
      [],
      NOW
    )
    expect(places.map((p) => p.city)).toEqual(['Montreal'])
  })

  it('placeActivity counts modes and skills per place in the window only', () => {
    const seats = [seat({ device_id: 'a' })]
    const places = realtimePlaces(seats, [], NOW)
    const activity = realtimePlaceActivity(places, seats, [
      { device_id: 'a', ts: NOW - 60_000, mode: 'sales', skill_id: 'deal-desk' },
      { device_id: 'a', ts: NOW - 120_000, mode: 'sales', skill_id: null },
      { device_id: 'a', ts: NOW - 31 * 60_000, mode: 'answer', skill_id: null },
      { device_id: 'ghost', ts: NOW - 60_000, mode: 'interview', skill_id: null }
    ], NOW)
    expect(activity).toEqual({ 'CA|Montreal|45.50|-73.57': { modes: [['sales', 2]], skills: [['deal-desk', 1]] } })
  })
})
