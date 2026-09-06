/**
 * Mercator projection constants and math, isolated in their own zero-dependency module so
 * operator/scripts/build-world.mjs can esbuild-bundle just this file (mirroring how
 * build-client.mjs bundles charts.ts) and share the exact same numbers the runtime uses --
 * no risk of the generated paths and the runtime projection drifting apart. Do not import
 * anything else from here; ./map.ts imports the generated output, so importing it back
 * from this file would be circular.
 */

export type MapVariant = '1152' | '520'

export const MAP_DIMENSIONS: Record<MapVariant, { width: number; height: number }> = {
  '1152': { width: 1152, height: 576 },
  '520': { width: 520, height: 300 }
}

/** Corner choropleth (Overview mini map, CountryMap.tsx port): keeps the reference's exact
 * fixed constants. Plan 3.7 item 2 / 6.3's re-centred projection is scoped to the realtime full
 * map only ("The Overview corner map is the same component as a choropleth" -- unchanged). */
const CORNER_TRANSLATE: [number, number] = [260, 180]
const CORNER_SCALE = 70

function mercatorY(latDeg: number): number {
  const phi = (latDeg * Math.PI) / 180
  return Math.log(Math.tan(Math.PI / 4 + phi / 2))
}

/**
 * Realtime full map (plan 3.7 item 2, 6.3): "Mercator centre [0, 20], scale from width."
 * Longitude 0 sits at the horizontal centre. Scale is derived from the width so the full 360
 * degrees of longitude exactly span it -- the standard whole-world Mercator fit, `width /
 * (2*pi)` (the same relationship Web Mercator's own zoom-level scale uses). Latitude 20, not
 * the equator, sits at the vertical centre: that is what pulls more of the populated northern
 * hemisphere into frame and pushes Antarctica toward the bottom edge, the crop every
 * OpenPanel-style world map uses.
 */
const REALTIME_CENTER_LAT = 20
const REALTIME_SCALE = MAP_DIMENSIONS['1152'].width / (2 * Math.PI)
const REALTIME_TRANSLATE: [number, number] = [
  MAP_DIMENSIONS['1152'].width / 2,
  MAP_DIMENSIONS['1152'].height / 2 + REALTIME_SCALE * mercatorY(REALTIME_CENTER_LAT)
]

export const MERCATOR_VARIANTS: Record<MapVariant, { translate: [number, number]; scale: number }> = {
  '1152': { translate: REALTIME_TRANSLATE, scale: REALTIME_SCALE },
  '520': { translate: CORNER_TRANSLATE, scale: CORNER_SCALE }
}

/**
 * Project a lat/lon pair the same way d3-geo's `geoMercator().translate(tx,ty).scale(s)`
 * does: x = s * lambda + tx, y = ty - s * ln(tan(pi/4 + phi/2)), lambda/phi in radians.
 * Verified against d3-geo output to within floating-point precision for every point in the
 * reference fixture and every generated centroid (see map.test.ts).
 */
export function projectPoint(lat: number, lon: number, variant: MapVariant): [number, number] {
  const { translate, scale } = MERCATOR_VARIANTS[variant]
  const lambda = (lon * Math.PI) / 180
  const phi = (lat * Math.PI) / 180
  const x = scale * lambda + translate[0]
  const y = translate[1] - scale * Math.log(Math.tan(Math.PI / 4 + phi / 2))
  return [x, y]
}
