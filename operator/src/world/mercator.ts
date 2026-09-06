/**
 * Mercator projection constants and math, isolated in their own zero-dependency module so
 * operator/scripts/build-world.mjs can esbuild-bundle just this file (mirroring how
 * build-client.mjs bundles charts.ts) and share the exact same numbers the runtime uses —
 * no risk of the generated paths and the runtime projection drifting apart. Do not import
 * anything else from here; ./map.ts imports the generated output, so importing it back
 * from this file would be circular.
 *
 * Plan 3.7 item 2 / Tony's reference (OpenPanel + bklit Choropleth Chart): Mercator centred
 * `[0, 20]` (20N keeps the populated northern hemisphere framed instead of wasting height on
 * the Arctic/Antarctic), 16:9 aspect, scale derived from width the same way d3-geo's own
 * "fit the whole world's width" default does: `width / (2*pi)`.
 */

export type MapVariant = '1152' | '520'

export interface MercatorVariant {
  width: number
  height: number
  translate: [number, number]
  scale: number
  /** [lon, lat] in degrees — matches d3-geo's `geoMercator().center([lon, lat])`. */
  center: [number, number]
}

const CENTER: [number, number] = [0, 20]

function makeVariant(width: number): MercatorVariant {
  const height = Math.round((width * 9) / 16)
  return {
    width,
    height,
    translate: [width / 2, height / 2],
    scale: width / (2 * Math.PI),
    center: CENTER
  }
}

/** Exact reference projection: `geoMercator().center([0, 20]).translate([w/2, h/2]).scale(w /
 * (2*pi))` for the 1152-wide realtime map and the 520-wide corner map, both 16:9. */
export const MERCATOR_VARIANTS: Record<MapVariant, MercatorVariant> = {
  '1152': makeVariant(1152),
  '520': makeVariant(520)
}

export const MAP_DIMENSIONS: Record<MapVariant, { width: number; height: number }> = {
  '1152': { width: MERCATOR_VARIANTS['1152'].width, height: MERCATOR_VARIANTS['1152'].height },
  '520': { width: MERCATOR_VARIANTS['520'].width, height: MERCATOR_VARIANTS['520'].height }
}

function mercatorY(phi: number): number {
  return Math.log(Math.tan(Math.PI / 4 + phi / 2))
}

/**
 * Project a lat/lon pair the same way `d3-geo`'s `geoMercator().center(center).translate(tx,
 * ty).scale(s)` does: x = s * (lambda - lambda0) + tx, y = ty - s * (mercatorY(phi) -
 * mercatorY(phi0)), lambda/phi/lambda0/phi0 in radians. Verified against d3-geo output to
 * floating-point precision for every point in the reference fixture and every generated
 * centroid (see mercator.test.ts).
 */
export function projectPoint(lat: number, lon: number, variant: MapVariant): [number, number] {
  const { translate, scale, center } = MERCATOR_VARIANTS[variant]
  const lambda = ((lon - center[0]) * Math.PI) / 180
  const phi = (lat * Math.PI) / 180
  const centerPhi = (center[1] * Math.PI) / 180
  const x = scale * lambda + translate[0]
  const y = translate[1] - scale * (mercatorY(phi) - mercatorY(centerPhi))
  return [x, y]
}
