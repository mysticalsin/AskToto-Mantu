import { describe, expect, it } from 'vitest'
import { choropleth } from './charts'
import { findBandSubpaths, stripMapBands, subpathIsBand } from './map-bands'
import { WORLD_PATHS } from './world-paths'

/**
 * The old hand-approximated world-paths.ts baked in real date-line slivers for Russia and
 * Fiji (a naive equirectangular projection let antimeridian-crossing rings paint as
 * full-width horizontal lines). ./world/paths.generated.ts instead comes from a real
 * world-atlas topology through d3-geo-equivalent Mercator math (operator/src/world/mercator.ts),
 * which already splits antimeridian-crossing landmasses into separate closed rings — see
 * operator/scripts/build-world.mjs's header comment. So the new data has no bands to strip;
 * this file keeps `stripMapBands`/`findBandSubpaths`/`subpathIsBand` covered against
 * synthetic fixtures (the algorithm itself is still real, still used defensively by
 * charts.ts) and adds a positive proof that the generated pipeline stays clean.
 */

const SYNTHETIC_BAND = 'M0 100L900 102L905 100L0 100Z'
const SYNTHETIC_COUNTRY = 'M159 114L175 114L186 114L159 114Z'

describe('map band helpers (synthetic fixtures)', () => {
  it('flags a wide, short subpath as a band', () => {
    expect(findBandSubpaths(SYNTHETIC_BAND).length).toBeGreaterThan(0)
  })

  it('does not treat a real country outline as a band', () => {
    expect(subpathIsBand(SYNTHETIC_COUNTRY)).toBe(false)
    expect(findBandSubpaths(SYNTHETIC_COUNTRY)).toEqual([])
  })

  it('strips a synthetic band and leaves a normal subpath untouched', () => {
    const mixed = SYNTHETIC_COUNTRY + SYNTHETIC_BAND
    const stripped = stripMapBands(mixed)
    expect(findBandSubpaths(stripped)).toEqual([])
    expect(stripped).toContain('159')
  })
})

describe('generated world data has no band artifacts', () => {
  it('WORLD_PATHS (world/paths.generated.ts, real topology + real Mercator) is already clean', () => {
    for (const [iso, d] of Object.entries(WORLD_PATHS)) {
      expect(findBandSubpaths(d), `${iso} should have no date-line sliver`).toEqual([])
    }
    expect(Object.keys(WORLD_PATHS).length).toBeGreaterThan(50)
  })

  it('the rendered choropleth has no repeating horizontal band', () => {
    const svg = choropleth(
      [{ iso: 'CA', devices: 2 }],
      [{ lat: 45.5, lon: -73.5, city: 'Longueuil', country: 'CA' }],
      'analytics'
    )
    expect(findBandSubpaths(svg)).toEqual([])
    expect(svg).toContain('data-iso="CA"')
    expect(svg).not.toMatch(/repeating-linear-gradient/)
  })
})
