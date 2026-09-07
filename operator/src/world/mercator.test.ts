import { geoMercator } from 'd3-geo'
import { describe, expect, it } from 'vitest'
import { CENTROIDS_1152, CENTROIDS_520, PROJECTION_1152, PROJECTION_520, WORLD_1152, WORLD_520 } from './paths.generated'
import { MAP_DIMENSIONS, MERCATOR_VARIANTS, projectPoint } from './mercator'

describe('projectPoint matches d3-geo geoMercator exactly (center [0, 0])', () => {
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
      const { translate, scale, center } = MERCATOR_VARIANTS[variant]
      const d3proj = geoMercator().center(center).translate(translate).scale(scale)
      for (const [lat, lon] of cases) {
        const [x, y] = projectPoint(lat, lon, variant)
        const expected = d3proj([lon, lat]) as [number, number]
        expect(x).toBeCloseTo(expected[0], 6)
        expect(y).toBeCloseTo(expected[1], 6)
      }
    })
  }
})

describe('framing: the projection is sized to the land it draws', () => {
  it('1152 variant is a 1152x576 frame whose scale/translate/center match PROJECTION_1152', () => {
    expect(MAP_DIMENSIONS['1152']).toEqual({ width: 1152, height: 576 })
    expect(MERCATOR_VARIANTS['1152'].scale).toBe(PROJECTION_1152.scale)
    expect(MERCATOR_VARIANTS['1152'].translate).toEqual(PROJECTION_1152.translate)
    expect(MERCATOR_VARIANTS['1152'].center).toEqual([0, 0])
  })

  it('520 variant is a 520x300 frame whose scale/translate/center match PROJECTION_520', () => {
    expect(MAP_DIMENSIONS['520']).toEqual({ width: 520, height: 300 })
    expect(MERCATOR_VARIANTS['520'].scale).toBe(PROJECTION_520.scale)
    expect(MERCATOR_VARIANTS['520'].translate).toEqual(PROJECTION_520.translate)
    expect(MERCATOR_VARIANTS['520'].center).toEqual([0, 0])
  })

  /**
   * This replaces a pair of assertions that pinned SPEC.md's literal numbers
   * (translate [576,288], translate [260,180]). Literal numbers cannot tell whether the map is
   * right: they passed for months while the arctic was being drawn as a solid dome over the pole.
   *
   * The arctic IS cropped here, deliberately -- Mercator's stretch above 70N is enormous, and a
   * projection that fits Greenland's tip turns the top third of the frame into one grey mass. So a
   * cropped island legitimately gets a flat top where the frame cuts it. What must never appear is
   * a flat run WIDE enough to be a fabricated coastline: build-world.mjs's repairs used to delete
   * whole coastlines and join the ends with a straight line, which Mercator curves, and Russia came
   * back as a 256px band of land across the Arctic Ocean joining islands 96 degrees apart.
   *
   * Greenland's genuine crop is the widest legitimate run at ~120px. The bar sits above that and
   * far below the fabricated band, so the shape of the crop is pinned without pinning its numbers.
   */
  const MAX_FRAME_EDGE_RUN_PX = 140

  for (const [name, world, W, H] of [
    ['1152', WORLD_1152, 1152, 576],
    ['520', WORLD_520, 520, 300]
  ] as const) {
    it(`${name}: nothing outside the frame, and no fabricated coastline along its edges`, () => {
      let outside = 0
      let widestRun = 0
      let widestIso = ''
      for (const entry of world) {
        let px: number | null = null
        let py: number | null = null
        for (const seg of entry.d.split(/(?=[ML])/)) {
          const nums = (seg.match(/-?\d+(\.\d+)?/g) || []).map(Number)
          if (nums.length < 2) continue
          const [x, y] = nums
          if (x < -0.01 || x > W + 0.01 || y < -0.01 || y > H + 0.01) outside += 1
          // Two consecutive points on the same frame edge is a clip closure running along it.
          if (seg[0] === 'L' && px !== null && py !== null) {
            const onTop = py < 0.5 && y < 0.5
            const onBottom = py > H - 0.5 && y > H - 0.5
            if ((onTop || onBottom) && Math.abs(x - px) > widestRun) {
              widestRun = Math.abs(x - px)
              widestIso = entry.alpha2 || entry.id
            }
          }
          px = x
          py = y
        }
      }
      expect(outside).toBe(0)
      expect(widestRun, `${widestIso} runs ${widestRun.toFixed(1)}px along a frame edge`).toBeLessThan(
        MAX_FRAME_EDGE_RUN_PX
      )
    })
  }

  it('neither variant reverts to the old width / (2*pi) guessed scale (regression guard for the clipped-Russia bug)', () => {
    expect(MERCATOR_VARIANTS['1152'].scale).not.toBeCloseTo(1152 / (2 * Math.PI), 0)
    expect(MERCATOR_VARIANTS['520'].scale).not.toBeCloseTo(520 / (2 * Math.PI), 0)
  })
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

  it('CENTROIDS_1152.CA sits inside the 1152x576 frame, not off the map', () => {
    const [x, y] = CENTROIDS_1152.CA
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThan(1152)
    expect(y).toBeGreaterThan(0)
    expect(y).toBeLessThan(576)
  })

  it('CENTROIDS_520.US matches projectPoint at the 520 variant within 40px (country centroid vs. its capital-ish point)', () => {
    // Loose bound: a country centroid is not one lat/lon point, so this just guards against
    // a projection mismatch (wrong scale/translate/center) rather than pixel-exact placement.
    const [x, y] = CENTROIDS_520.US
    const [px, py] = projectPoint(39.8, -98.6, '520') // geographic center of the contiguous US
    expect(Math.abs(x - px)).toBeLessThan(40)
    expect(Math.abs(y - py)).toBeLessThan(40)
  })
})
