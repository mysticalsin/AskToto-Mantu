import { describe, expect, it } from 'vitest'
import { choropleth } from './charts'
import { findBandSubpaths, stripMapBands, subpathIsBand } from './map-bands'
import { WORLD_PATHS } from './world-paths'

describe('map band artifacts', () => {
  it('flags the known Russia and Fiji date-line slivers', () => {
    expect(findBandSubpaths(WORLD_PATHS.RU).length).toBeGreaterThan(0)
    expect(findBandSubpaths(WORLD_PATHS.FJ).length).toBeGreaterThan(0)
    expect(findBandSubpaths(WORLD_PATHS.CA)).toEqual([])
  })

  it('strips full-width slivers so painted SVG has no horizontal bands', () => {
    expect(findBandSubpaths(stripMapBands(WORLD_PATHS.RU))).toEqual([])
    expect(findBandSubpaths(stripMapBands(WORLD_PATHS.FJ))).toEqual([])
    const svg = choropleth(
      [{ iso: 'CA', devices: 2 }],
      [{
        lat: 45.5,
        lon: -73.5,
        city: 'Longueuil',
        country: 'CA',
        device: 'dev-ca-1',
        hostname: 'Tonys-MacBook-Pro',
        email: 'twalteur@amaris.com',
        os: 'darwin',
        appVersion: '1.8.2',
        lastSeen: Date.now()
      }],
      'analytics'
    )
    expect(findBandSubpaths(svg)).toEqual([])
    expect(svg).toContain('data-iso="CA"')
    expect(svg).not.toMatch(/repeating-linear-gradient/)
  })

  it('does not treat a real country outline as a band', () => {
    expect(subpathIsBand('M159 114L175 114L186 114L159 114Z')).toBe(false)
  })
})
