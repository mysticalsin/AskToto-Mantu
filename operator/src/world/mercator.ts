/**
 * Mercator projection math, plus the exact scale/translate every city dot has to project
 * with to land on the same pixels as the country outlines under it.
 *
 * Those numbers are NOT guessed here — they are the reference's own fixed projection
 * (SPEC.md: `geoMercator().translate([576,288]).scale(152.948)` on a 1152x576 viewBox for
 * the realtime map, `.translate([260,180]).scale(70)` on 520x300 for the corner map), held
 * as a single source of truth in operator/scripts/build-world.mjs and exported as
 * PROJECTION_1152/PROJECTION_520 in ./paths.generated.ts (imported below) — including the
 * width/height of the exact frame that scale/translate was clipped to — so this module's
 * single-point `projectPoint` (city dots) can never drift from the exact numbers the land
 * paths themselves were projected and clipped with. This is a one-way dependency (generated
 * data -> this module); build-world.mjs never reads anything back from this file, so it can
 * always rebuild paths.generated.ts from the raw topology alone.
 */
import { PROJECTION_1152, PROJECTION_520 } from './paths.generated'

export type MapVariant = '1152' | '520'

export interface MercatorVariant {
  width: number
  height: number
  translate: [number, number]
  scale: number
  /** [lon, lat] in degrees — matches d3-geo's `geoMercator().center([lon, lat])`. Left at
   * d3's own default, [0, 0]: the reference's own translate already centres the frame it
   * wants, so a non-zero value here would only be a second, redundant offset — [0, 0] is the
   * honest value, not a simplification. */
  center: [number, number]
}

const CENTER: [number, number] = [0, 0]

function makeVariant(projection: { width: number; height: number; scale: number; translate: [number, number] }): MercatorVariant {
  return {
    width: projection.width,
    height: projection.height,
    translate: projection.translate,
    scale: projection.scale,
    center: CENTER
  }
}

/** Reference projection: `geoMercator().translate(translate).scale(scale)` (center left at
 * d3's default [0, 0] — see MercatorVariant.center above), clipped to its own fixed
 * width/height, for the 1152-wide realtime map (1152x576) and the 520-wide corner map
 * (520x300). Every field comes from PROJECTION_1152/520 (./paths.generated.ts),
 * build-world.mjs's copy of the reference's exact numbers. */
export const MERCATOR_VARIANTS: Record<MapVariant, MercatorVariant> = {
  '1152': makeVariant(PROJECTION_1152),
  '520': makeVariant(PROJECTION_520)
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
