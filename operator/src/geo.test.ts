import { describe, expect, it } from 'vitest'
import { geoFromRequest } from './geo'

function req(cf?: Record<string, unknown>): Request {
  const r = new Request('https://operator.test/v1/heartbeat')
  if (cf) Object.defineProperty(r, 'cf', { value: cf, configurable: true })
  return r
}

describe('geoFromRequest', () => {
  it('reads ISO country, city, and numeric lat/lon from request.cf', () => {
    expect(geoFromRequest(req({ country: 'fr', city: 'Paris', latitude: '48.857', longitude: '2.351' }))).toEqual({
      country: 'FR',
      city: 'Paris',
      lat: 48.857,
      lon: 2.351
    })
  })

  it('returns empty geo when cf is missing and never reads IP', () => {
    const r = req({ ip: '203.0.113.9', clientIp: '203.0.113.9' })
    expect(geoFromRequest(r)).toEqual({ country: null, city: null, lat: null, lon: null })
    expect(geoFromRequest(new Request('https://operator.test/v1/heartbeat'))).toEqual({
      country: null,
      city: null,
      lat: null,
      lon: null
    })
  })

  it('drops garbage country codes and out-of-range coordinates', () => {
    expect(
      geoFromRequest(req({ country: 'France', city: '', latitude: '200', longitude: '-200' }))
    ).toEqual({ country: null, city: null, lat: null, lon: null })
  })
})
