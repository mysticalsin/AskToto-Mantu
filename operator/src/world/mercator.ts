/**
 * Mercator projection constants and math, isolated in their own zero-dependency module so
 * operator/scripts/build-world.mjs can esbuild-bundle just this file (mirroring how
 * build-client.mjs bundles charts.ts) and share the exact same numbers the runtime uses —
 * no risk of the generated paths and the runtime projection drifting apart. Do not import
 * anything else from here; ./map.ts imports the generated output, so importing it back
 * from this file would be circular.
 */

export type MapVariant = '1152' | '520'

/** Exact reference projection constants:
 * WorldMap.tsx: geoMercator().translate([576, 288]).scale(152.948) for the 1152x576 realtime map.
 * CountryMap.tsx: geoMercator().translate([260, 180]).scale(70) for the 520x300 corner map. */
export const MERCATOR_VARIANTS: Record<MapVariant, { translate: [number, number]; scale: number }> = {
  '1152': { translate: [576, 288], scale: 152.948 },
  '520': { translate: [260, 180], scale: 70 }
}

export const MAP_DIMENSIONS: Record<MapVariant, { width: number; height: number }> = {
  '1152': { width: 1152, height: 576 },
  '520': { width: 520, height: 300 }
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
