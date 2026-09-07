/**
 * Mercator projection math, plus the exact scale/translate every city dot has to project
 * with to land on the same pixels as the country outlines under it.
 *
 * Those numbers are NOT guessed here (they used to be: a hardcoded `width / (2*pi)` scale
 * that assumed the whole 360° of longitude exactly fills the canvas width, without ever
 * checking whether the projected geometry fit the canvas HEIGHT — it didn't, which is why
 * Russia/Greenland/Canada/Norway rendered clipped against the top edge). They come from
 * operator/scripts/build-world.mjs's `geoMercator().fitExtent(...)` fit against the real
 * land geometry, which provably fits every included country inside the canvas, and are
 * exported as PROJECTION_1152/PROJECTION_520 in ./paths.generated.ts (imported below) so
 * this module's single-point `projectPoint` (city dots) can never drift from the exact
 * numbers the land paths themselves were projected with. This is a one-way dependency
 * (generated data -> this module); build-world.mjs never reads anything back from this
 * file, so it can always rebuild paths.generated.ts from the raw topology alone.
 */
import { PROJECTION_1152, PROJECTION_520 } from './paths.generated'

export type MapVariant = '1152' | '520'

export interface MercatorVariant {
  width: number
  height: number
  translate: [number, number]
  scale: number
  /** [lon, lat] in degrees — matches d3-geo's `geoMercator().center([lon, lat])`. Left at
   * d3's own default, [0, 0]: build-world.mjs's fitExtent recomputes `translate` to centre
   * whatever bounding box the fit produces regardless of any center offset, so a non-zero
   * value here would only be silently cancelled back out — [0, 0] is the honest value, not
   * a simplification. */
  center: [number, number]
}

const CENTER: [number, number] = [0, 0]

function makeVariant(width: number, projection: { scale: number; translate: [number, number] }): MercatorVariant {
  const height = Math.round((width * 9) / 16)
  return {
    width,
    height,
    translate: projection.translate,
    scale: projection.scale,
    center: CENTER
  }
}

/** Reference projection: `geoMercator().translate(translate).scale(scale)` (center left at
 * d3's default [0, 0] — see MercatorVariant.center above) for the 1152-wide realtime map and
 * the 520-wide corner map, both 16:9. scale/translate come from PROJECTION_1152/520
 * (./paths.generated.ts), build-world.mjs's fitExtent result. */
export const MERCATOR_VARIANTS: Record<MapVariant, MercatorVariant> = {
  '1152': makeVariant(1152, PROJECTION_1152),
  '520': makeVariant(520, PROJECTION_520)
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
