/**
 * iso2 -> land path `d` (1152x576 viewport), derived from the generated world-atlas data
 * in ./world/paths.generated.ts (real Mercator projection, real country boundaries).
 * Superseded by ./world/map.ts for new rendering (renderRealtimeMapSvg, renderCornerMapSvg);
 * kept only for the flat iso-keyed Record shape charts.ts's legacy per-country renderers
 * (choropleth, shoeyLandSvg) already use.
 */
import { WORLD_1152 } from './world/paths.generated'

export const WORLD_PATHS: Record<string, string> = (() => {
  const merged: Record<string, string> = {}
  for (const entry of WORLD_1152) {
    if (!entry.alpha2) continue
    // world-atlas reuses one numeric id for a country and a tiny dependent territory
    // (036 = Australia and Ashmore and Cartier Islands); concatenate so no landmass drops.
    merged[entry.alpha2] = (merged[entry.alpha2] ?? '') + entry.d
  }
  return merged
})()
