/**
 * Mercator projection constants and math, isolated in their own zero-dependency module so
 * operator/scripts/build-world.mjs can esbuild-bundle just this file (mirroring how
 * build-client.mjs bundles charts.ts) and share the exact same numbers the runtime uses —
 * no risk of the generated paths and the runtime projection drifting apart. Do not import
 * anything else from here; ./map.ts imports the generated output, so importing it back
 * from this file would be circular.
 */

export type MapVariant = '1152' | '520'

/** Projection constants. Scales are the reference's (WorldMap.tsx 152.948, CountryMap.tsx 70);
 * the vertical frame is ours. The reference's 1152x576 frame (translate y 288) clips everything
 * north of ~72.7°N, cutting north Greenland, Svalbard and the Canadian Arctic. Antarctica is not
 * drawn at all (operator/scripts/build-world.mjs drops feature 010), so the frame now runs from
 * ~83.7°N down to ~56.5°S:
 * - 1152: translate y 449, height 642 (y=5.5 at 83.7°N, y=633 at 56.5°S).
 * - 520:  translate y 206, height 292 (y=3 at 83.7°N, y=290 at 56.5°S). */
export const MERCATOR_VARIANTS: Record<MapVariant, { translate: [number, number]; scale: number }> = {
  '1152': { translate: [576, 449], scale: 152.948 },
  '520': { translate: [260, 206], scale: 70 }
}

export const MAP_DIMENSIONS: Record<MapVariant, { width: number; height: number }> = {
  '1152': { width: 1152, height: 642 },
  '520': { width: 520, height: 292 }
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
