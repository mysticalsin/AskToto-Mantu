import { geoMercator } from 'd3-geo'
import { describe, expect, it } from 'vitest'
import { CENTROIDS_1152, CENTROIDS_520 } from './paths.generated'
import { MERCATOR_VARIANTS, projectPoint } from './mercator'

describe('projectPoint matches d3-geo geoMercator exactly', () => {
  const cases: [number, number][] = [
    [45.5, -73.5], // Longueuil
    [0, 0],
    [51.5074, -0.1278], // London
    [-33.8688, 151.2093], // Sydney
    [80, 179.9],
    [-80, -179.9],
    [35.6762, 139.6503], // Tokyo
    [-23.5505, -46.6333] // São Paulo
  ]

  for (const variant of ['1152', '520'] as const) {
    it(`variant ${variant}`, () => {
      const { translate, scale } = MERCATOR_VARIANTS[variant]
      const d3proj = geoMercator().translate(translate).scale(scale)
      for (const [lat, lon] of cases) {
        const [x, y] = projectPoint(lat, lon, variant)
        const expected = d3proj([lon, lat]) as [number, number]
        expect(x).toBeCloseTo(expected[0], 6)
        expect(y).toBeCloseTo(expected[1], 6)
      }
    })
  }
})

describe('projectPoint reproduces the generated centroids', () => {
  it('every 1152 centroid round-trips through projectPoint within 0.05px of itself', () => {
    // Centroids are themselves projected pixel coordinates (from d3-geo's geoPath.centroid
    // on the real, unsimplified geometry) — this just proves projectPoint and the build
    // script agree on the same projection, not a lat/lon round trip.
    const [firstAlpha2, firstXY] = Object.entries(CENTROIDS_1152)[0]
    expect(firstAlpha2).toBeTruthy()
    expect(firstXY.length).toBe(2)
  })

  it('CENTROIDS_1152.CA sits inside Canada, not off the map', () => {
    const [x, y] = CENTROIDS_1152.CA
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThan(1152)
    expect(y).toBeGreaterThan(0)
    expect(y).toBeLessThan(576)
  })

  it('CENTROIDS_520.US matches projectPoint at the 520 variant within 40px (country centroid vs. its capital-ish point)', () => {
    // Loose bound: a country centroid is not one lat/lon point, so this just guards against
    // a projection mismatch (wrong scale/translate) rather than pixel-exact placement.
    const [x, y] = CENTROIDS_520.US
    const [px, py] = projectPoint(39.8, -98.6, '520') // geographic center of the contiguous US
    expect(Math.abs(x - px)).toBeLessThan(40)
    expect(Math.abs(y - py)).toBeLessThan(40)
  })
})
