#!/usr/bin/env node
/**
 * Precomputes the world map: reads the checked-in world-atlas 50m topology
 * (operator/shoey-ref/data/countries-50m.json), simplifies it, decodes it with the vendored
 * topojson-feature.mjs `feature()` decoder, FITS a Mercator projection to the actual land
 * geometry (see "Projection fit" below — WorldMap.tsx's 1152x648 realtime map and
 * CountryMap.tsx's 520x293 corner map), and writes operator/src/world/paths.generated.ts.
 *
 * Projection fit (task report, "Russia seems weird"): earlier versions hardcoded a Mercator
 * centre/scale (width / (2*pi), guessing the whole 360° of longitude exactly fills the
 * canvas width) without ever checking whether the resulting geometry actually fit the
 * canvas HEIGHT. It didn't: projected land ran from y=-139 (most of Greenland, the northern
 * third of Russia and Canada, and Norway, all above the top edge) to y=905 (Antarctica,
 * entirely below the bottom edge). The fix is `geoMercator().fitExtent(...)` (below):
 * measure the real bounding box of every country's actual geometry and solve for the
 * scale/translate that makes it fit inside a padded 0..width/0..height box, rather than
 * assuming a scale and hoping. Antarctica is excluded from the geometry entirely (`010`
 * dropped from the topology before anything else touches it, see below) — Mercator's polar
 * distortion sends its latitude span to many times any other country's, so fitting it in
 * would force every populated country down to a sliver just to make room for a landmass
 * with no live seat activity to show. The resulting scale/translate are exported into
 * paths.generated.ts (PROJECTION_1152/PROJECTION_520) so operator/src/world/mercator.ts's
 * single-point `projectPoint` (city dots) can read the exact same numbers used to build the
 * paths here, instead of a second, independently-guessed formula.
 *
 * Simplification: the raw 50m topology projects to ~1.4 MB of `d` string for the 1152 set
 * alone — far past a sane budget for a file checked into git, and full coastline detail is
 * invisible at these sizes anyway. The FIRST version of this script simplified each
 * country's *projected* ring independently (Ramer-Douglas-Peucker in pixel space, after
 * d3-geo's antimeridian clipping). That was wrong: two countries sharing a border are two
 * separate rings that both reference the same shared topology arc, and simplifying each
 * ring on its own let the shared border drift apart or fold back on itself, painting as
 * dark self-intersecting wedges across Canada/the US/Africa/Central Asia/South America/
 * Antarctica (caught visually — see world/README below).
 *
 * The fix (this version) simplifies the shared topology ARCS once, in lon/lat space,
 * *before* any feature is decoded — the standard topojson-simplify approach:
 * Visvalingam-Whyatt effective-area thresholding per arc, with each arc's two endpoints
 * (topology junction points, shared by every ring that meets there) always kept. Every
 * ring built from these arcs afterward — for both viewports — shares exactly the same
 * simplified border geometry, so adjacent countries can never drift apart or self-cross.
 * After that, geometry goes through d3-geo's own geoPath (real antimeridian clipping) and
 * is only ever rounded, never re-simplified or reordered.
 *
 * A THIRD failure mode survived the arc-level rewrite and is what actually produced the
 * "unfilled slivers, missing continents" render Tony flagged: Visvalingam-Whyatt simplifying
 * a very thin/needle-shaped ring down to very few points can flip that ring's effective
 * winding. d3-geo's spherical clipping trusts ring winding to decide which side of a ring is
 * "inside"; a flipped ring gets read as "everywhere on Earth except this sliver" — a single
 * path spanning the full canvas width that, filled in the same flat land colour as every real
 * country, reads as a wash that makes every genuinely small/thin country look like a bare
 * outline (and, layered under/over its neighbours, corrupts the visible shapes around it).
 * Caught here by comparing d3-geo's own `geoArea` (a real country is always a tiny fraction
 * of the sphere, `4*pi` steradians) before and after simplification — see `buildVariant`'s
 * `AREA_SANITY_MAX` check, which falls back to that one feature's unsimplified geometry
 * rather than raising every country's simplification budget to dodge one bad ring.
 *
 * Run directly (`node operator/scripts/build-world.mjs`, or `npm run build:operator-world`)
 * or import `buildWorldData` from a test to rebuild in memory and compare against the
 * committed file (operator/src/world/paths.generated.contract.test.ts).
 *
 * Plan 3.7 item 2 / Tony's reference (OpenPanel + bklit): Mercator, 16:9, scale/translate
 * FIT to the real geometry (see "Projection fit" above) rather than derived from width. This
 * script no longer reads anything from ./world/mercator.ts — it computes the fit itself and
 * writes the result out (PROJECTION_1152/PROJECTION_520 below); mercator.ts imports those
 * numbers back for its own point projection, a one-way dependency (generated data -> runtime
 * module) with nothing on this side ever reading from that module, so this generator can
 * always rebuild from the raw topology alone, even if paths.generated.ts is missing or
 * broken. Each country entry also carries its English display name (resolved
 * once here via Intl.DisplayNames, the same table map.ts's countryName() uses at runtime)
 * so the map can label a country without needing Intl at all. Two more precomputed shapes
 * ships alongside the per-country paths: GRATICULE_* (d3-geo's geoGraticule10(), the standard
 * 10-degree grid). A land outline (every country's `d` joined into one path — the countries
 * never overlap, so one <path> with all of them fills identically to drawing them separately)
 * is deliberately NOT also stored here: it is 100% derivable from WORLD_1152/WORLD_520 with a
 * single `.map(e => e.d).join('')` (see world/map.ts's `worldOutline()`), so committing a
 * second, byte-for-byte-larger copy of the same land data would roughly double this file for
 * a shape nothing in the interactive render actually draws (hover/tint needs the per-country
 * paths regardless) — simplicity over a literal-but-wasteful precompute.
 */
import { build } from 'esbuild'
import { geoArea, geoGraticule10, geoMercator, geoPath } from 'd3-geo'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { feature } from './topojson-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const WORLD_DIR = join(OPERATOR_ROOT, 'src', 'world')
const TOPOLOGY_PATH = join(OPERATOR_ROOT, 'shoey-ref', 'data', 'countries-50m.json')
const ISO_ENTRY = join(WORLD_DIR, 'iso.ts')
const OUT_FILE = join(WORLD_DIR, 'paths.generated.ts')

const MAX_BYTES_1152 = 350 * 1024
const MAX_BYTES_520 = 120 * 1024

/** Numeric ISO 3166-1 id for Antarctica in the topology (world-atlas keys features by this,
 * zero-padded to 3 digits — see operator/src/world/iso.ts's NUMERIC_TO_ALPHA2['010']). */
const ANTARCTICA_NUMERIC_ID = '010'

/** 1152x648 / 520x293, 16:9 — matches operator/src/world/mercator.ts's MAP_DIMENSIONS (that
 * module no longer feeds anything back into this script, see the file doc comment above, so
 * these are this script's own copy of the same width -> height formula, not a shared import). */
function mapHeight(width) {
  return Math.round((width * 9) / 16)
}

/** Padding (px), inset from every edge of the canvas, that geoMercator().fitExtent() below
 * treats as the box to fit land into — never 0: a country whose real extreme point lands
 * exactly on 0 or the canvas edge would round (PRECISION_1152/520 below) to sit flush
 * against it, one rounding error away from drawing half a coastline pixel off-canvas. ~0.7%
 * of width for both variants (proportional, not a shared literal, so a future variant at a
 * different width gets the same relative breathing room without retuning by hand). */
function fitPad(width) {
  return Math.round(width * 0.007)
}

/** Bundle a small dependency-free TS module with esbuild and import it in Node, so the
 * generator and the runtime share a single source of truth for constants/data instead of
 * two hand-kept copies drifting apart (same technique build-client.mjs uses for charts.ts). */
async function importTsModule(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    write: false
  })
  const tmpDir = mkdtempSync(join(tmpdir(), 'metis-operator-world-'))
  const tmpFile = join(tmpDir, 'mod.mjs')
  try {
    writeFileSync(tmpFile, result.outputFiles[0].text)
    return await import(pathToFileURL(tmpFile).href)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------
// Arc-level Visvalingam-Whyatt simplification (topojson-simplify's approach).
// ---------------------------------------------------------------------------------------

function identityTransform(x) {
  return x
}

/** Same delta/quantization decode as topojson-feature.mjs's internal transform(), exposed
 * here so we can decode every arc to absolute [lon, lat] once, simplify, and hand the
 * *un*-transformed absolute coordinates back to feature() as a transform-free topology. */
function makeTransform(tf) {
  if (tf == null) return identityTransform
  let x0
  let y0
  const kx = tf.scale[0]
  const ky = tf.scale[1]
  const dx = tf.translate[0]
  const dy = tf.translate[1]
  return function (input, i) {
    if (!i) {
      x0 = 0
      y0 = 0
    }
    const output = new Array(input.length)
    output[0] = (x0 += input[0]) * kx + dx
    output[1] = (y0 += input[1]) * ky + dy
    for (let j = 2; j < input.length; j++) output[j] = input[j]
    return output
  }
}

function decodeAbsoluteArcs(topology) {
  const transformPoint = makeTransform(topology.transform)
  return topology.arcs.map((arc) => arc.map((point, i) => transformPoint(point.slice(), i)))
}

function triangleArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2
}

/** Minimal binary min-heap keyed by area, with lazy deletion (a popped entry is skipped if
 * it is stale — its point's area has since been recomputed to a different value). */
class MinHeap {
  constructor() {
    this.items = []
  }
  get size() {
    return this.items.length
  }
  push(index, area) {
    const items = this.items
    items.push([area, index])
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (items[parent][0] <= items[i][0]) break
      ;[items[parent], items[i]] = [items[i], items[parent]]
      i = parent
    }
  }
  pop() {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (items.length && last !== undefined) {
      items[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let m = i
        if (l < items.length && items[l][0] < items[m][0]) m = l
        if (r < items.length && items[r][0] < items[m][0]) m = r
        if (m === i) break
        ;[items[m], items[i]] = [items[i], items[m]]
        i = m
      }
    }
    return top ? { area: top[0], index: top[1] } : undefined
  }
}

/**
 * Visvalingam-Whyatt polyline simplification: every interior point has an "effective area"
 * (the triangle formed with its current neighbours); the smallest-area point is repeatedly
 * removed and its former neighbours' areas recomputed, until `shouldStop(smallestArea,
 * remainingPointCount)` says to stop. The first and last point are never removed -- for a
 * topology arc these are the shared junction points other arcs/rings connect to, so keeping
 * them fixed is what keeps every ring built from these arcs closed and every shared border
 * between two rings identical. Shared by `visvalingamWhyatt` (stop once the smallest area
 * clears a real-world/pixel threshold -- the normal case) and `visvalingamWhyattToCount` (stop
 * once a fixed number of points remain -- see that function's own doc comment for why a small
 * arc needs a point-count budget instead of an area one).
 */
function visvalingamWhyattCore(points, shouldStop) {
  const n = points.length
  if (n <= 2) return points.slice()
  const prev = new Array(n)
  const next = new Array(n)
  const removed = new Array(n).fill(false)
  const area = new Array(n).fill(Infinity)
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1
    next[i] = i + 1
  }
  next[n - 1] = -1

  function computeArea(i) {
    if (i <= 0 || i >= n - 1 || removed[i]) return Infinity
    const p = prev[i]
    const q = next[i]
    if (p < 0 || q < 0) return Infinity
    return triangleArea(points[p], points[i], points[q])
  }

  const heap = new MinHeap()
  for (let i = 1; i < n - 1; i++) {
    area[i] = computeArea(i)
    heap.push(i, area[i])
  }
  let remaining = n
  while (heap.size > 0) {
    const top = heap.pop()
    const i = top.index
    if (removed[i] || top.area !== area[i]) continue // stale heap entry
    if (shouldStop(top.area, remaining)) break
    removed[i] = true
    remaining--
    const p = prev[i]
    const q = next[i]
    next[p] = q
    prev[q] = p
    if (p > 0) {
      area[p] = computeArea(p)
      heap.push(p, area[p])
    }
    if (q < n - 1) {
      area[q] = computeArea(q)
      heap.push(q, area[q])
    }
  }

  const out = []
  let cur = 0
  while (cur !== -1) {
    out.push(points[cur])
    cur = next[cur]
  }
  return out
}

function visvalingamWhyatt(points, areaThreshold) {
  if (areaThreshold <= 0) return points.slice()
  return visvalingamWhyattCore(points, (smallestArea) => smallestArea >= areaThreshold)
}

/** Same removal order as `visvalingamWhyatt`, but stops once `maxPoints` remain rather than
 * once the smallest area clears a threshold -- used only by `simplifyArcsPixelSpace` for an arc
 * whose own projected footprint is already too small to show meaningful additional detail. An
 * area threshold big enough to visibly declutter a ~10px island is also big enough to remove
 * every one of its interior points on a smaller/thinner one, collapsing the whole island (later
 * dropped for having under 4 points -- task report: this is exactly how West Falkland briefly
 * vanished while tuning the threshold). A point-count budget instead always leaves a small,
 * simple, visible shape -- never nothing. */
function visvalingamWhyattToCount(points, maxPoints) {
  const floor = Math.max(2, maxPoints)
  if (points.length <= floor) return points.slice()
  return visvalingamWhyattCore(points, (_smallestArea, remaining) => remaining <= floor)
}

function ccw(a, b, c) {
  return (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0])
}

/** True when open segments a->b and c->d cross (a proper crossing, not merely touching at
 * a shared endpoint — the only kind two non-adjacent segments of one simplified arc should
 * ever produce, given real coastline data). */
function segmentsIntersect(a, b, c, d) {
  const d1 = ccw(c, d, a)
  const d2 = ccw(c, d, b)
  const d3 = ccw(a, b, c)
  const d4 = ccw(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/**
 * Visvalingam-Whyatt removes points purely by triangle-area significance: it has no
 * built-in guarantee that the resulting polyline never crosses itself. On a coastline
 * that already wiggles back close to itself (a fjord, a tight headland), an aggressive
 * threshold can leave a short "loop" — two non-adjacent edges of the SAME simplified arc
 * that cross — which renders as a small self-intersecting notch (caught here by an
 * independent segment-intersection check across every generated ring; see
 * scripts/_verify_world.mjs-style checks in paths.generated.contract.test.ts).
 *
 * Repaired at the ARC level (an open polyline, before any ring is assembled) so every
 * ring built from this arc — forward or reversed, by either neighbouring country — gets
 * the identical fix: when edges i->i+1 and j->j+1 cross, the points strictly between them
 * (i+1..j) form the small loop; dropping them and connecting i directly to j+1 is the
 * minimal-change repair. Repeats until no crossing remains — each repair strictly shrinks
 * the arc, so this always terminates, and it never touches the arc's first/last point
 * (the shared topology junctions every neighbouring ring anchors to).
 */
function removeArcSelfIntersections(points) {
  let pts = points
  // Bounded by construction (each pass removes at least one point), but capped defensively.
  for (let guard = pts.length; guard >= 0; guard--) {
    const n = pts.length
    let crossing = null
    for (let i = 0; i < n - 1 && !crossing; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        if (segmentsIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1])) {
          crossing = [i, j]
          break
        }
      }
    }
    if (!crossing) break
    const [i, j] = crossing
    pts = pts.slice(0, i + 1).concat(pts.slice(j + 1))
  }
  return pts
}

/** Visit the arc-index array of every ring in every geometry (Polygon and MultiPolygon
 * only — Point/LineString geometries have no closed ring to check). */
function walkRingArcIndices(topology, visit) {
  function walkGeometry(g) {
    if (g.type === 'GeometryCollection') return g.geometries.forEach(walkGeometry)
    if (g.type === 'Polygon') return g.arcs.forEach(visit)
    if (g.type === 'MultiPolygon') return g.arcs.forEach((polygon) => polygon.forEach(visit))
  }
  topology.objects.countries.geometries.forEach(walkGeometry)
}

/** Decode one ring's arc-index list against `topology.arcs`, returning both its points
 * (each optionally run through `project` — identity for a lon/lat-space check, or a
 * variant's own Mercator projection for a pixel-space check) AND, for each point, which
 * arc (and which index within that arc's OWN array — already oriented, so this is a
 * direct splice target) it came from. Mirrors topojson-feature.mjs's arc-stitching (pop
 * the shared point before appending the next arc, reverse a negatively-indexed arc) but
 * keeps the provenance a plain per-arc repair cannot: which shared arc to trim from when
 * a crossing straddles the JOIN between two different arcs. */
function ringPointsWithProvenance(topology, arcIndices, project) {
  const points = []
  const provenance = []
  for (const ai of arcIndices) {
    const arcIndex = ai < 0 ? ~ai : ai
    const arcPts = topology.arcs[arcIndex]
    if (points.length) {
      points.pop()
      provenance.pop()
    }
    if (ai < 0) {
      for (let k = arcPts.length - 1; k >= 0; k--) {
        points.push(project(arcPts[k]))
        provenance.push({ arcIndex, localIndex: k })
      }
    } else {
      for (let k = 0; k < arcPts.length; k++) {
        points.push(project(arcPts[k]))
        provenance.push({ arcIndex, localIndex: k })
      }
    }
  }
  return { points, provenance }
}

/** Same crossing test as `removeArcSelfIntersections`, but over a CLOSED ring (edges wrap
 * from the last point back to the first) since this runs on assembled rings, not open
 * arcs. Returns the first crossing pair found, or null. */
function findClosedRingCrossing(points) {
  const n = points.length
  if (n < 4) return null
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue // the wraparound edge is adjacent to edge 0, not a crossing candidate
      if (segmentsIntersect(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return [i, j]
    }
  }
  return null
}

const identityProject = (p) => p

/**
 * Final, whole-topology safety net for the two kinds of self-intersection a per-arc repair
 * cannot see, both of which show up as a ring folding back on itself right at the JOIN
 * between two arcs that are each individually clean on their own:
 *  - a lon/lat-space fold (their simplified tail and head directions cross one another
 *    once stitched together) — caught by calling this with the identity projection;
 *  - a PROJECTION-induced fold: Mercator's y-coordinate is a nonlinear function of
 *    latitude (`log(tan(...))`), so two lon/lat edges that do not cross can still project
 *    to pixel-space chords that do, once each edge is drawn as a straight line between its
 *    two projected endpoints — caught by calling this once per viewport with that
 *    viewport's own projection (its scale/threshold differ, so this must run separately
 *    for topology1152 and topology520 — see buildWorldData).
 *
 * Repairing this on a ring's own decoded copy would reintroduce exactly the bug this whole
 * file exists to fix (a neighbouring ring sharing one of those two arcs, paired with some
 * OTHER arc on its far side, would keep the untouched points — the shared border drifts
 * apart again). So every offending point found here is traced back to the shared ARC that
 * owns it (`ringPointsWithProvenance`) and spliced out of `topology.arcs` directly, never
 * touching an arc's first/last point (the topology junction every ring anchors to) — the
 * fix reaches every ring that uses that arc, in whichever direction. Iterates a full pass
 * over every ring to a fixed point; each round removes at least one point somewhere in the
 * topology, so this always terminates.
 */
function repairCrossArcJunctions(topology, project = identityProject) {
  for (let round = 0; round < 50; round++) {
    let changedAny = false
    walkRingArcIndices(topology, (arcIndices) => {
      const { points, provenance } = ringPointsWithProvenance(topology, arcIndices, project)
      const crossing = findClosedRingCrossing(points)
      if (!crossing) return
      const [i, j] = crossing
      const byArc = new Map()
      for (let k = i + 1; k <= j; k++) {
        const { arcIndex, localIndex } = provenance[k]
        if (!byArc.has(arcIndex)) byArc.set(arcIndex, new Set())
        byArc.get(arcIndex).add(localIndex)
      }
      for (const [arcIndex, localIndices] of byArc) {
        const arcPts = topology.arcs[arcIndex]
        const sorted = [...localIndices].sort((a, b) => b - a)
        for (const localIndex of sorted) {
          if (localIndex <= 0 || localIndex >= arcPts.length - 1) continue // never touch a shared junction endpoint
          arcPts.splice(localIndex, 1)
          changedAny = true
        }
      }
    })
    if (!changedAny) return
  }
  throw new Error('build-world: repairCrossArcJunctions did not converge after 50 rounds')
}

/** Simplify every arc in the topology once (in absolute lon/lat) and return a new,
 * transform-free topology whose arcs are the simplified absolute coordinates — ready for
 * feature() to decode with no further per-ring processing. Only the lon/lat-space cross-
 * arc-junction pass runs here; the projection-space pass needs this variant's own Mercator
 * projection and runs afterward in buildWorldData, once that projection is built. */
function simplifyTopology(topology, areaThreshold) {
  const absoluteArcs = decodeAbsoluteArcs(topology)
  const simplifiedArcs = absoluteArcs.map((arc) => removeArcSelfIntersections(visvalingamWhyatt(arc, areaThreshold)))
  const simplified = { ...topology, transform: undefined, arcs: simplifiedArcs }
  repairCrossArcJunctions(simplified)
  return simplified
}

/**
 * Second simplification pass, arc-by-arc again but this time in the variant's own PROJECTED
 * pixel space, and only for an arc whose own projected footprint is already smaller than
 * `smallArcMaxSidePx` -- fixes the exact defect task report findings 1/2/3/9 flagged (Tierra
 * del Fuego's neighbouring skerries, the Falklands, the Alaska Peninsula/Kodiak cluster all
 * rendering as a "self-intersecting bowtie"). Proven NOT a literal self-intersection: a
 * from-scratch segment-crossing sweep across every ring and every pair of rings in the
 * committed geometry at those exact locations found zero true crossings, self- or cross-ring --
 * the rings are simple polygons (confirmed further by rendering the flagged islands fill-only,
 * with no stroke at all: clean, simple shapes every time). What is real: `simplifyTopology`
 * above simplifies every arc by REAL-WORLD (lon/lat) significance, which rates a wiggle by the
 * actual square-degrees it covers -- identical treatment for a huge country and a tiny island.
 * A wiggle that is rounding-error-sized on a whole continent is exactly as "significant" in
 * lon/lat terms as the same real-world wiggle on an island a thousandth that size, so once both
 * are projected to the same map, the small island has kept proportionally far more of its own
 * detail. At the handful of screen pixels a small island actually occupies, that surviving
 * detail is indistinguishable from noise: several points a fraction of a pixel apart, in a
 * shape whose 0.5px hairline stroke visually reads as a crossing bowtie even though the fill is
 * a perfectly simple polygon.
 *
 * The fix is deliberately scoped to only the arcs that need it: an arc whose own projected
 * bounding box is already under `smallArcMaxSidePx` on both sides gets reduced to at most
 * `smallArcMaxPoints` points (visvalingamWhyattToCount -- a point-count budget, not an area
 * threshold, so a small island shrinks down to a clean small shape rather than the fixed-area
 * threshold this replaced, which was able to remove every interior point of a small enough
 * ring and make the whole island disappear later for having under 4 points). Every other arc --
 * every real country coastline and shared border, however small -- is returned completely
 * untouched, so this pass can only ever affect an already-too-small-to-read island and can
 * never add simplification pressure (and the winding-flip risk that comes with it) to a
 * country that did not have this problem. Same arc-level, endpoints-fixed approach as
 * `simplifyTopology`, so a shared border still cannot drift: every ring built from an arc, on
 * either side, gets the identical simplified pixel shape once reprojected back to lon/lat.
 * `project`/`unproject` are this variant's own Mercator forward/inverse (mercator.ts).
 *
 * Belt-and-suspenders: `removeArcSelfIntersections` can itself remove a point or two more if
 * the point-count-capped shape happens to self-cross (rare, but a real risk at 4-5 points), so
 * the result is used only when it still has at least 4 points left -- the minimum
 * `buildValidatedPath` needs to draw any visible shape at all. Below that, this whole arc is
 * left exactly as the first, lon/lat-space pass produced it: a real, if slightly busier, island
 * is always the safe fallback over a deleted one (this is precisely how the Falkland Islands
 * briefly vanished outright while tuning `smallArcMaxPoints` down to 4 without this guard).
 */
function simplifyArcsPixelSpace(topology, project, unproject, smallArcMaxSidePx, smallArcMaxPoints) {
  topology.arcs = topology.arcs.map((arc) => {
    if (arc.length <= smallArcMaxPoints) return arc
    const projected = arc.map((p) => project(p))
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const [x, y] of projected) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (maxX - minX >= smallArcMaxSidePx || maxY - minY >= smallArcMaxSidePx) return arc
    const simplifiedPx = removeArcSelfIntersections(visvalingamWhyattToCount(projected, smallArcMaxPoints))
    if (simplifiedPx.length < 4) return arc
    return simplifiedPx.map((p) => unproject(p))
  })
}

// ---------------------------------------------------------------------------------------
// Projection + validation. No point is ever added, dropped, split, or reordered here —
// only d3-geo's own antimeridian clipping (inside pathGenerator) touches ring shape past
// this point; everything else is formatting (rounding numbers in the `d` string).
// ---------------------------------------------------------------------------------------

function round(precision) {
  const factor = 10 ** precision
  return (n) => Math.round(n * factor) / factor
}

/** Round every numeric coordinate in an SVG path `d` string — same approach as the
 * reference's own roundPathPrecision in WorldMap.tsx. Never touches point count or order. */
function roundPath(d, precision) {
  return d.replace(/-?\d+\.\d+/g, (match) => Number.parseFloat(match).toFixed(precision))
}

function splitSubpaths(d) {
  return d.match(/[Mm][^Mm]*/g) ?? []
}

function pointsFromSubpath(subpath) {
  const body = subpath.replace(/^[Mm]\s*/, '').replace(/[Zz]\s*$/, '')
  return body
    .split(/[Ll]/)
    .map((chunk) => chunk.trim().split(/[\s,]+/).map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
}

const BAND_MIN_WIDTH = 700
const BAND_MAX_HEIGHT = 10

/** The old map-bands.ts band detector, reapplied here as a build-time gate: a subpath
 * whose bbox is very wide and very short is the signature of a broken antimeridian-jump
 * or a self-crossing ring, not a real coastline. */
function isBandBox(points) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return maxX - minX >= BAND_MIN_WIDTH && maxY - minY <= BAND_MAX_HEIGHT
}

/**
 * Validate every subpath of one feature's raw (unrounded) `d` string and rebuild `d` from
 * only the valid ones. Two very different failure modes are handled very differently:
 *  - A ring collapsed to fewer than 4 points is a *harmless* consequence of simplifying a
 *    tiny feature (a small island whose entire ring was 1-2 arcs, each reduced to just its
 *    two fixed endpoints) — it has no visible area left to draw, so it is dropped, exactly
 *    like the reference's own WorldMap.tsx dropping empty `d` strings.
 *  - A band-shaped ring (very wide, very short bbox) is never a real coastline at any
 *    simplification level — it is the exact signature of the self-crossing/antimeridian-
 *    jump bug this validation exists to catch, so it fails the build loudly instead of
 *    silently shipping a wedge artifact.
 */
/**
 * Rounding itself can — rarely — turn a clean ring into a self-crossing one: three points
 * A, B, C are "clean" pre-rounding whenever C sits off the line AB by more than a hair,
 * but if C happens to sit only a HAIR off that line (a near-collinear coastline point),
 * truncating every coordinate to `precision` decimal places can flip the sign of that
 * tiny offset — a change invisible at the rendered scale (it is smaller than the rounding
 * unit itself) but technically a crossing if shipped as-is. Caught and repaired here, on
 * the already-rounded text, by collapsing the resulting tiny loop exactly like
 * `removeArcSelfIntersections` does for an open arc — safe to do on one ring's own output
 * text (not the shared topology) because the loop is, by construction, smaller than the
 * rounding step that created it, far too small to visibly separate from a neighbour's
 * border. */
function repairRoundedSubpath(subpath, precision) {
  if (!/[Zz]\s*$/.test(subpath)) return subpath // only closed rings can self-cross
  let points = pointsFromSubpath(subpath)
  if (points.length < 4) return subpath
  for (let guard = points.length; guard >= 0; guard--) {
    const crossing = findClosedRingCrossing(points)
    if (!crossing) break
    const [i, j] = crossing
    points = points.slice(0, i + 1).concat(points.slice(j + 1))
  }
  if (points.length < 4) return '' // the whole ring collapsed to nothing worth drawing
  const fmt = (n) => n.toFixed(precision)
  return `M${fmt(points[0][0])},${fmt(points[0][1])}${points
    .slice(1)
    .map((p) => `L${fmt(p[0])},${fmt(p[1])}`)
    .join('')}Z`
}

/** Run every subpath of an already-rounded `d` string through `repairRoundedSubpath`. */
function repairRoundedPath(d, precision) {
  return splitSubpaths(d)
    .map((sp) => repairRoundedSubpath(sp, precision))
    .join('')
}

function buildValidatedPath(raw, label) {
  let d = ''
  let points = 0
  let dropped = 0
  for (const subpath of splitSubpaths(raw)) {
    const pts = pointsFromSubpath(subpath)
    if (isBandBox(pts)) {
      throw new Error(`build-world: ${label} has a band-shaped ring (self-crossing or antimeridian-jump artifact): ${subpath.slice(0, 160)}`)
    }
    if (pts.length < 4) {
      dropped++
      continue
    }
    d += subpath
    points += pts.length
  }
  return { d, points, dropped }
}

/** English display name for an alpha-2 code, resolved once at build time via Intl.DisplayNames
 * (same source map.ts's runtime countryName() uses) so every WorldEntry ships its name — the
 * runtime never needs Intl just to label a country on the map. Falls back to the code itself
 * for anything Intl does not recognise (never throws, never fabricates a name). */
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()

function resolveCountryName(alpha2, id) {
  if (!alpha2) return id
  try {
    return regionNames?.of(alpha2.toUpperCase()) ?? alpha2
  } catch {
    return alpha2
  }
}

/** A real country's spherical area is always a tiny fraction of the whole sphere (4*pi ≈
 * 12.566 sr; even Russia, the largest, is ≈ 0.42 sr). Two guards catch a bad ring, matched to
 * its unsimplified twin by ARRAY INDEX, not id — world-atlas reuses one numeric id for a
 * country and a tiny dependent territory (036 = Australia and Ashmore and Cartier Islands),
 * two separate geometries at two separate array positions, so an id-keyed lookup would
 * silently compare the wrong pair for either one of them:
 *  - absolute: >= 1 sr is never a real single country/territory, only "the sphere minus a
 *    sliver" from a fully flipped ring (Brunei's bug — see the file doc comment).
 *  - relative: more than 20x its own unsimplified area (with a small floor so two genuinely
 *    near-zero numbers do not look like an "infinite" ratio) is a local self-crossing fold
 *    that inflates area without flipping the whole ring (caught on Ashmore and Cartier
 *    Reef — real raw area ~6e-8 sr, simplified came out at 0.19 sr, 3M times larger). */
const AREA_SANITY_MAX = 1
const AREA_RATIO_MAX = 20
const AREA_RATIO_FLOOR = 0.001

async function buildVariant({ features, rawFeatures, pass1Features, pathGenerator, precision, numericToAlpha2, variantLabel }) {
  const entries = []
  const centroids = {}
  const pointCounts = []
  let droppedRings = 0
  const fellBackToRaw = []
  const fellBackToPass1 = []
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    const id = f.id == null ? 'x' : String(f.id).padStart(3, '0')
    const alpha2 = numericToAlpha2[id] ?? ''
    let feature = f
    const area = geoArea(f)
    const rawFeature = rawFeatures[i]
    const rawArea = rawFeature ? geoArea(rawFeature) : 0
    const suspicious = area >= AREA_SANITY_MAX || area > Math.max(rawArea * AREA_RATIO_MAX, AREA_RATIO_FLOOR)
    if (suspicious) {
      if (!rawFeature) throw new Error(`build-world: ${variantLabel} ${alpha2 || id} simplified to a suspicious ring (geoArea ${area.toFixed(3)} sr) and has no raw fallback`)
      feature = rawFeature
      fellBackToRaw.push(alpha2 || id)
    }
    const raw = pathGenerator(feature) ?? ''
    const label = `${variantLabel} ${alpha2 || id} (feature id ${id})`
    let { d, points, dropped } = raw ? buildValidatedPath(raw, label) : { d: '', points: 0, dropped: 0 }
    droppedRings += dropped
    if (!d && pass1Features && pass1Features[i]) {
      // simplifyArcsPixelSpace's small-arc pass emptied every ring of this feature (its point-
      // count-capped shape, or removeArcSelfIntersections' own cleanup of it, collapsed below
      // the 4-point floor buildValidatedPath needs) -- fall back to the pass-1-only geometry
      // (lon/lat simplified, no small-arc pixel pass) for just this one feature rather than
      // silently deleting a real country/territory from the map (task report: this is exactly
      // how El Salvador briefly vanished outright while tuning smallArcMaxPoints).
      feature = pass1Features[i]
      const fallbackRaw = pathGenerator(feature) ?? ''
      if (fallbackRaw) {
        const fallback = buildValidatedPath(fallbackRaw, `${label} (pass-1 fallback)`)
        if (fallback.d) {
          d = fallback.d
          points = fallback.points
          fellBackToPass1.push(alpha2 || id)
        }
      }
    }
    if (!d) continue
    pointCounts.push({ alpha2: alpha2 || id, points })
    const roundedD = repairRoundedPath(roundPath(d, precision), precision)
    if (!roundedD) continue
    entries.push({ id, alpha2, name: resolveCountryName(alpha2, id), d: roundedD })
    if (alpha2 && !centroids[alpha2]) {
      // world-atlas reuses one numeric id for a country and a tiny dependent territory
      // (036 = Australia and Ashmore and Cartier Islands); keep the first (larger) landmass.
      const c = pathGenerator.centroid(feature)
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        centroids[alpha2] = [round(2)(c[0]), round(2)(c[1])]
      }
    }
  }
  return { entries, centroids, pointCounts, droppedRings, fellBackToRaw, fellBackToPass1 }
}

/** The standard 10-degree graticule (d3-geo's own geoGraticule10()) projected and rounded the
 * same way land is — plan 3.7 item 2's "faint 10 degree graticule". */
function buildGraticule(pathGenerator, precision) {
  const d = pathGenerator(geoGraticule10()) ?? ''
  return roundPath(d, precision)
}


export async function buildWorldData() {
  const isoMod = await importTsModule(ISO_ENTRY)
  const { NUMERIC_TO_ALPHA2 } = isoMod

  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, 'utf8'))

  // Antarctica decision (see the file doc comment's "Projection fit"): drop it from the
  // topology before anything else touches it, so every downstream feature array (raw,
  // pass-1, fully simplified, and the fitExtent land collection below) is Antarctica-free
  // with no special-casing anywhere else in this file. Its arcs are not shared with any
  // other country's border (Antarctica borders no one), so removing its geometry cannot
  // affect any other country's shape.
  topology.objects.countries.geometries = topology.objects.countries.geometries.filter((g) => g.id !== ANTARCTICA_NUMERIC_ID)

  // Unsimplified features, decoded once from the pristine (Antarctica-excluded) topology.
  // Used below both as the geometry geoMercator().fitExtent() fits each viewport's
  // projection to, and (matched against features1152/features520 further down, by array
  // index -- see buildVariant's doc comment for why not by id) as the fallback source for
  // the rare feature whose simplified ring comes out suspicious (the file doc comment's
  // "third failure mode" and AREA_SANITY_MAX below).
  const rawFeatures = feature(topology, topology.objects.countries).features
  const landFeatureCollection = { type: 'FeatureCollection', features: rawFeatures }

  // Separate simplification passes per viewport: the 520 corner map is small enough on
  // screen to tolerate much coarser borders than the full-bleed 1152 realtime map, and
  // each pass is internally consistent (every ring in that viewport shares the exact same
  // simplified arcs), so there is no risk of the two variants disagreeing with themselves.
  const PRECISION_1152 = 2
  const PRECISION_520 = 1
  const AREA_THRESHOLD_1152 = 0.018 // deg^2, tuned to land comfortably under the 350 KB budget
  const AREA_THRESHOLD_520 = 0.1 // deg^2, tuned to land comfortably under the 120 KB budget

  const topology1152 = simplifyTopology(topology, AREA_THRESHOLD_1152)
  const topology520 = simplifyTopology(topology, AREA_THRESHOLD_520)

  // Fit each viewport's own Mercator projection to the real (Antarctica-excluded) land
  // geometry -- see the file doc comment's "Projection fit". geoMercator().fitExtent()
  // measures landFeatureCollection's projected bounding box at a neutral scale, then solves
  // for the scale/translate that fits that box inside [[pad,pad],[w-pad,h-pad]] -- provably
  // no coastline can fall outside the canvas, unlike the old width-derived guess. `.center()`
  // is deliberately left at d3's own default ([0, 0]): fitExtent recomputes translate to
  // centre whatever bounding box the fit produces regardless of any center offset, so a
  // non-zero center here would only be silently cancelled back out (see mercator.ts).
  const pad1152 = fitPad(1152)
  const pad520 = fitPad(520)
  const projection1152 = geoMercator().fitExtent([[pad1152, pad1152], [1152 - pad1152, mapHeight(1152) - pad1152]], landFeatureCollection)
  const projection520 = geoMercator().fitExtent([[pad520, pad520], [520 - pad520, mapHeight(520) - pad520]], landFeatureCollection)

  // Snapshot pass-1-only features BEFORE simplifyArcsPixelSpace mutates topology*.arcs below --
  // the fallback source buildVariant reaches for when the small-arc pixel pass empties a
  // feature's every ring outright (see that pass's own "belt and suspenders" doc comment).
  const pass1Features1152 = feature(topology1152, topology1152.objects.countries).features
  const pass1Features520 = feature(topology520, topology520.objects.countries).features

  // Pixel-space simplification (see simplifyArcsPixelSpace's doc comment): only an arc whose
  // own projected footprint is already under SMALL_ARC_MAX_SIDE_PX gets capped at
  // SMALL_ARC_MAX_POINTS — every normal country coastline and shared border is untouched.
  const SMALL_ARC_MAX_SIDE_PX = 24
  const SMALL_ARC_MAX_POINTS = 5
  simplifyArcsPixelSpace(topology1152, (p) => projection1152(p), (p) => projection1152.invert(p), SMALL_ARC_MAX_SIDE_PX, SMALL_ARC_MAX_POINTS)
  simplifyArcsPixelSpace(topology520, (p) => projection520(p), (p) => projection520.invert(p), SMALL_ARC_MAX_SIDE_PX, SMALL_ARC_MAX_POINTS)

  // A second cross-arc-junction pass, this time in each viewport's own PROJECTED (pixel)
  // space: Mercator's nonlinear latitude term can turn a lon/lat-clean junction into a
  // self-crossing one once drawn as straight pixel chords (see repairCrossArcJunctions'
  // doc comment) — a projection artifact, not a shared-geography one, so it is legitimately
  // checked and repaired separately per viewport, after the shared lon/lat pass above. Also
  // catches anything simplifyArcsPixelSpace's own VW pass might have folded, for the same
  // reason the first, lon/lat-space pass needs its own repair pass.
  repairCrossArcJunctions(topology1152, (p) => projection1152(p))
  repairCrossArcJunctions(topology520, (p) => projection520(p))

  const features1152 = feature(topology1152, topology1152.objects.countries).features
  const features520 = feature(topology520, topology520.objects.countries).features

  // rawFeatures (same array order as features1152/features520: simplifying a topology never
  // touches topology.objects, only topology.arcs, so index i is always the same geometry in
  // both) was already decoded above, before the projection fit.

  const geoPath1152 = geoPath(projection1152)
  const geoPath520 = geoPath(projection520)

  const world1152 = await buildVariant({
    features: features1152,
    rawFeatures,
    pass1Features: pass1Features1152,
    pathGenerator: geoPath1152,
    precision: PRECISION_1152,
    numericToAlpha2: NUMERIC_TO_ALPHA2,
    variantLabel: '1152'
  })
  const world520 = await buildVariant({
    features: features520,
    rawFeatures,
    pass1Features: pass1Features520,
    pathGenerator: geoPath520,
    precision: PRECISION_520,
    numericToAlpha2: NUMERIC_TO_ALPHA2,
    variantLabel: '520'
  })

  const graticule1152 = buildGraticule(geoPath1152, PRECISION_1152)
  const graticule520 = buildGraticule(geoPath520, PRECISION_520)

  // Exported at full double precision, never rounded like the `d` path coordinates or the
  // centroids above -- this is the whole point of writing it out at all: mercator.ts's
  // projectPoint() (city dots) has to compute the exact same pixel position this script's
  // own geoPath(projection1152/520) used for the land paths, and any rounding here would
  // reintroduce a fraction-of-a-pixel drift between a dot and the coastline under it.
  const projectionFit1152 = { scale: projection1152.scale(), translate: projection1152.translate() }
  const projectionFit520 = { scale: projection520.scale(), translate: projection520.translate() }

  const code = renderGeneratedFile(world1152, world520, graticule1152, graticule520, projectionFit1152, projectionFit520)
  const bytes = Buffer.byteLength(code, 'utf8')
  const bytes1152 = Buffer.byteLength(JSON.stringify(world1152.entries), 'utf8')
  const bytes520 = Buffer.byteLength(JSON.stringify(world520.entries), 'utf8')

  if (bytes1152 > MAX_BYTES_1152) {
    throw new Error(`build-world: WORLD_1152 is ${(bytes1152 / 1024).toFixed(0)} KB, over the ${MAX_BYTES_1152 / 1024} KB budget. Raise AREA_THRESHOLD_1152.`)
  }
  if (bytes520 > MAX_BYTES_520) {
    throw new Error(`build-world: WORLD_520 is ${(bytes520 / 1024).toFixed(0)} KB, over the ${MAX_BYTES_520 / 1024} KB budget. Raise AREA_THRESHOLD_520.`)
  }

  return { code, world1152, world520, graticule1152, graticule520, projectionFit1152, projectionFit520, bytes, bytes1152, bytes520 }
}

function renderGeneratedFile(world1152, world520, graticule1152, graticule520, projectionFit1152, projectionFit520) {
  return `/**
 * GENERATED FILE. Do not edit by hand.
 * Run \`npm run build:operator-world\` (node operator/scripts/build-world.mjs) to regenerate.
 * Source: operator/shoey-ref/data/countries-50m.json (world-atlas 50m, public domain),
 * simplified per-arc (Visvalingam-Whyatt) and decoded with
 * operator/scripts/topojson-feature.mjs, then projected with a Mercator projection FIT to
 * the real land geometry (16:9, Antarctica excluded — see build-world.mjs's file doc
 * comment's "Projection fit") via geoMercator().fitExtent(). PROJECTION_1152/PROJECTION_520
 * below are that fit's exact scale/translate, at full precision — operator/src/world/
 * mercator.ts imports them so its own single-point projectPoint() (city dots) computes
 * pixel positions identical to the land paths in this file, never a second guess at the
 * same numbers. See operator/scripts/build-world.mjs.
 */

export interface WorldEntry {
  id: string
  alpha2: string
  /** English display name, resolved once at build time (Intl.DisplayNames) — never a
   * fabricated name; falls back to the raw code/id when Intl does not recognise it. */
  name: string
  d: string
}

export interface ProjectionFit {
  scale: number
  translate: [number, number]
}

export const WORLD_1152: WorldEntry[] = ${JSON.stringify(world1152.entries)}

export const WORLD_520: WorldEntry[] = ${JSON.stringify(world520.entries)}

export const CENTROIDS_1152: Record<string, [number, number]> = ${JSON.stringify(world1152.centroids)}

export const CENTROIDS_520: Record<string, [number, number]> = ${JSON.stringify(world520.centroids)}

/** d3-geo's geoGraticule10() (the standard 10-degree grid), projected and rounded like land. */
export const GRATICULE_1152: string = ${JSON.stringify(graticule1152)}

export const GRATICULE_520: string = ${JSON.stringify(graticule520)}

/** geoMercator().fitExtent() result for this viewport (see this file's own header comment) --
 * the exact scale/translate WORLD_1152's own \`d\` paths were projected with. */
export const PROJECTION_1152: ProjectionFit = ${JSON.stringify(projectionFit1152)}

export const PROJECTION_520: ProjectionFit = ${JSON.stringify(projectionFit520)}
`
}

function printPointCounts(label, pointCounts) {
  const sorted = [...pointCounts].sort((a, b) => b.points - a.points)
  const total = pointCounts.reduce((n, c) => n + c.points, 0)
  console.log(`Métis Operator: ${label} per-country point counts (${pointCounts.length} countries, ${total} points total):`)
  for (const { alpha2, points } of sorted) {
    console.log(`  ${alpha2.padEnd(3)} ${points}`)
  }
}

async function main() {
  const { code, world1152, world520, projectionFit1152, projectionFit520, bytes, bytes1152, bytes520 } = await buildWorldData()
  writeFileSync(OUT_FILE, code)
  printPointCounts('WORLD_1152', world1152.pointCounts)
  printPointCounts('WORLD_520', world520.pointCounts)
  console.log(
    `Métis Operator: fitted projection -- 1152: scale=${projectionFit1152.scale.toFixed(3)} translate=[${projectionFit1152.translate.map((n) => n.toFixed(2)).join(', ')}], ` +
      `520: scale=${projectionFit520.scale.toFixed(3)} translate=[${projectionFit520.translate.map((n) => n.toFixed(2)).join(', ')}]`
  )
  console.log(
    `Métis Operator: wrote ${relative(OPERATOR_ROOT, OUT_FILE)} (${(bytes / 1024).toFixed(1)} KB total, ` +
      `1152=${(bytes1152 / 1024).toFixed(1)} KB / ${world1152.entries.length} pieces / ${world1152.droppedRings} degenerate rings dropped, ` +
      `520=${(bytes520 / 1024).toFixed(1)} KB / ${world520.entries.length} pieces / ${world520.droppedRings} degenerate rings dropped, ` +
      `${Object.keys(world1152.centroids).length} centroids)`
  )
  if (world1152.fellBackToRaw.length || world520.fellBackToRaw.length) {
    console.log(
      `Métis Operator: fell back to unsimplified geometry for a flipped-winding sliver — ` +
        `1152: [${world1152.fellBackToRaw.join(', ')}], 520: [${world520.fellBackToRaw.join(', ')}]`
    )
  }
  if (world1152.fellBackToPass1.length || world520.fellBackToPass1.length) {
    console.log(
      `Métis Operator: fell back to pass-1-only geometry for a feature the small-arc pixel pass emptied -- ` +
        `1152: [${world1152.fellBackToPass1.join(', ')}], 520: [${world520.fellBackToPass1.join(', ')}]`
    )
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
