#!/usr/bin/env node
/**
 * Precomputes the world map: reads the checked-in world-atlas 50m topology
 * (operator/shoey-ref/data/countries-50m.json), simplifies it, decodes it with the vendored
 * topojson-feature.mjs `feature()` decoder, projects it with the reference's own fixed
 * Mercator projection (see "Reference framing" below — WorldMap.tsx's 1152x576 realtime map
 * and CountryMap.tsx's 520x300 corner map), and writes operator/src/world/paths.generated.ts.
 *
 * Reference framing (task report: "Russia seems weird", then "framing, not geometry"): the
 * first fix for the clipped-Russia bug (a hardcoded `width / (2*pi)` scale that never checked
 * whether the projected geometry fit the canvas HEIGHT — it didn't, so Greenland/Russia/
 * Canada/Norway rendered clipped against the top edge and Antarctica entirely below the
 * bottom) was `geoMercator().fitExtent(...)` over all land. That made every coastline fit,
 * but fitting the WHOLE world in means Mercator's high-latitude stretch dominates: arctic
 * Russia and Greenland alone filled most of the frame. The reference (SPEC.md:
 * `geoMercator().translate([576,288]).scale(152.948)` on a 1152x576 viewBox,
 * `.translate([260,180]).scale(70)` on 520x300) never fits at all — one fixed scale/translate,
 * framed so the populated latitudes fill the card and the arctic is simply CROPPED at the
 * frame edge, the way a real cropped map looks, rather than either overflowing invisibly (the
 * pre-fitExtent bug) or being shrunk to make room for it (the fitExtent version). This script
 * adopts that scale, moves the vertical offset down so the crop lands on empty ocean rather than
 * on Russia's mainland coast (see REFERENCE_1152 below), and calls the projection's own
 * `.clipExtent([[0,0],[width,height]])` before generating paths (below): d3-geo clips ring
 * geometry to that rectangle in PROJECTED (pixel) space and closes each ring along the frame,
 * so a coastline that runs past the top edge is cut with a straight edge at y=0 instead of
 * spilling off-canvas or being omitted. Antarctica is excluded from the geometry entirely
 * (`010` dropped from the topology before anything else touches it, see below) — at this
 * framing its whole landmass (all south of roughly -72.8°) falls outside the box regardless,
 * so leaving it out of the data is the same picture clipping it would produce, without
 * shipping the dead weight. The exact scale/translate/width/height are exported into
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
 * A FOURTH failure mode is what actually produced the dome over Russia, and it is not
 * simplification at all: both self-intersection repairs below fix a reported crossing by deleting
 * every point between the two crossing edges, and neither bounded how many that could be. The scan
 * walks from the start of the ring, so a crossing pairing an early point with a late one is found
 * before any small loop is — and `repairCrossArcJunctions` then ate Russia's arctic coast from the
 * White Sea to the Bering Strait over successive rounds, leaving a straight lon/lat line that
 * Mercator draws as a curve. `geoArea` rose only 20%, well under `AREA_SANITY_MAX`, so the guard
 * above never saw it. `MAX_SELF_INTERSECTION_REPAIR_SPAN` now bounds both repairs to the small
 * fold they exist for; a wider crossing is left alone, because a hairline is worth less than a
 * coastline.
 *
 * Run directly (`node operator/scripts/build-world.mjs`, or `npm run build:operator-world`)
 * or import `buildWorldData` from a test to rebuild in memory and compare against the
 * committed file (operator/src/world/paths.generated.contract.test.ts).
 *
 * Plan 3.7 item 2 / Tony's reference (OpenPanel + bklit): Mercator, framed exactly as
 * SPEC.md documents it (see "Reference framing" above) rather than fit or derived from width.
 * This script no longer reads anything from ./world/mercator.ts — it holds the reference's
 * own scale/translate/width/height as its own constants and writes the result out
 * (PROJECTION_1152/PROJECTION_520 below); mercator.ts imports those numbers back for its own
 * point projection, a one-way dependency (generated data -> runtime module) with nothing on
 * this side ever reading from that module, so this generator can always rebuild from the raw
 * topology alone, even if paths.generated.ts is missing or broken. Each country entry also
 * carries its English display name (resolved
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

/**
 * The reference's projection scale, with the vertical translate corrected.
 *
 * The reference centres the projection on the equator (translate y = height/2). Mercator is not
 * vertically symmetric about the equator once Antarctica is dropped: at scale 152.948 the remaining
 * land runs from Greenland's tip at y = -154 to Cape Horn at y = 469, so centring the EQUATOR
 * pushes 154px of arctic above the frame while leaving 107px of empty ocean below it. The crop was
 * intended (see the file doc comment), but it was landing in the wrong place -- and what it cut was
 * not just the polar islands. Russia's mainland arctic coast sits at y = -53, so the whole northern
 * edge of the country was sliced off in a dead straight line across the top of the frame, which
 * reads as a rendering fault rather than a cropped map.
 *
 * The scale is unchanged, so the world still fills the frame's width exactly as before. Only the
 * vertical offset moves, spending the wasted ocean at the bottom on the land that was being cut:
 *
 * The scale stays exactly as the reference has it. Cropping the arctic is not the fault -- it is
 * the point. Mercator's stretch above 70N is enormous, and a projection sized to fit Greenland's
 * tip turns the top third of the frame into one grey dome of arctic Russia, Greenland and northern
 * Canada, which looks far more wrong than a crop does. What was actually broken is in
 * `pathForFeature` below: `clipExtent` closes a clipped ring along the frame, and given a whole
 * MultiPolygon it closed ACROSS separate islands, welding Russia's arctic islands together with a
 * band of land drawn straight over the Arctic Ocean. Projecting each polygon separately fixes that
 * without touching the framing.
 *
 * Only the vertical offset moves, and only to stop wasting the frame. Centring the projection on
 * the equator (translate y = height/2) is not centring the LAND once Antarctica is dropped: at
 * scale 152.948 the remaining land runs from y = -154 to y = 469, so the reference's y = 288 threw
 * away 154px of northern land while leaving 107px of empty ocean below it. Moving the offset down
 * spends that ocean on land instead.
 *
 *   1152x576  y = 370  Russia's mainland arctic coast lands at y = 28 instead of 53px off-frame;
 *                      Cape Horn at y = 551. Greenland's tip and the high arctic islands stay
 *                      cropped, now each with its own flat top rather than joined to each other.
 *   520x300   y = 210  The span is 285px in a 300px frame, so here nothing is cut at all.
 *
 * `mercator.ts`'s MAP_DIMENSIONS and MERCATOR_VARIANTS read these back out of PROJECTION_1152 /
 * PROJECTION_520 in the generated file below, so the city dots move with the coastlines and this
 * stays the one place these numbers live.
 */
const REFERENCE_1152 = { width: 1152, height: 576, translate: [576, 370], scale: 152.948 }
const REFERENCE_520 = { width: 520, height: 300, translate: [260, 210], scale: 70 }

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

/** Beyond this latitude the weighting below stops growing. `1/cos` runs away to infinity at the
 *  pole, and no arc should become unsimplifiable just for being arctic; at 84 degrees the factor is
 *  already ~9.5, far more than the geometry up there needs. */
const MERCATOR_WEIGHT_MAX_LAT = 84

/**
 * A triangle's effective area measured in the space the map is actually DRAWN in, not the space the
 * coordinates happen to be stored in.
 *
 * Visvalingam-Whyatt ranks points by the area of the triangle they make with their neighbours, and
 * this pass runs on lon/lat degrees. Mercator does not preserve area: it stretches y by 1/cos(lat),
 * so one square degree at 75N covers nearly four times the pixels one square degree at the equator
 * does. A single lon/lat threshold therefore does not mean "remove detail finer than N pixels" -- it
 * means "remove far more of the arctic than of the tropics". Russia paid for that: its whole arctic
 * coastline, from the White Sea to the Bering Strait, was simplified past the point of being a
 * coastline and filled as one solid dome over the pole, while its southern border kept full detail.
 * (Raw, unsimplified geometry projects and clips through the same framing perfectly, which is what
 * ruled out the projection and the clip as the cause.)
 *
 * Dividing by cos(lat) converts the lon/lat area into the projected area it will occupy, so the
 * threshold means the same amount of visible detail everywhere on the map.
 */
function mercatorTriangleArea(a, b, c) {
  const lat = Math.min(Math.abs((a[1] + b[1] + c[1]) / 3), MERCATOR_WEIGHT_MAX_LAT)
  return triangleArea(a, b, c) / Math.cos((lat * Math.PI) / 180)
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
/** `areaOf` is how a point's significance is measured. The lon/lat pass weights by latitude so the
 *  threshold means projected pixels (see `mercatorTriangleArea`); the pixel-space pass is already in
 *  pixels and ranks by plain triangle area. */
function visvalingamWhyattCore(points, shouldStop, areaOf = triangleArea) {
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
    return areaOf(points[p], points[i], points[q])
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
  return visvalingamWhyattCore(points, (smallestArea) => smallestArea >= areaThreshold, mercatorTriangleArea)
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
/**
 * How many points a single repair may drop.
 *
 * The loop this function exists to remove is a simplification artifact: two edges that ended up
 * crossing because the points between them were thinned out, spanning a handful of points at most.
 * Without a bound, the same "drop everything between the two crossing edges" rule will happily
 * delete a whole coastline on one detection, and it did: run against the RAW, unsimplified topology,
 * this pass deleted 2536 of one arc's 2539 points and 1611 of another's 2844: two of the four arcs
 * in 1959 where the planar crossing test fires at all. What it left behind was a single straight
 * line in lon/lat between the two surviving ends -- and a straight lon/lat line at high latitude is
 * a CURVE once Mercator stretches y, which is precisely the smooth dome that appeared over Russia's
 * arctic, swallowing the coast from the White Sea to the Bering Strait and inflating the country's
 * area by 21%.
 *
 * A crossing that spans more than a small loop is therefore not the defect this repairs. It is
 * either a false positive (the test is planar, and these arcs run to the antimeridian) or real
 * geography, and in both cases the coastline is worth more than the hairline it would cost to leave
 * it alone. Bounding the span also makes the search O(n * span) instead of O(n^2).
 */
const MAX_SELF_INTERSECTION_REPAIR_SPAN = 24

function removeArcSelfIntersections(points) {
  let pts = points
  // Bounded by construction (each pass removes at least one point), but capped defensively.
  for (let guard = pts.length; guard >= 0; guard--) {
    const n = pts.length
    let crossing = null
    for (let i = 0; i < n - 1 && !crossing; i++) {
      for (let j = i + 2; j < n - 1 && j - i <= MAX_SELF_INTERSECTION_REPAIR_SPAN; j++) {
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
/**
 * Both callers repair a reported crossing the same way: drop every point between the two crossing
 * edges. That is the minimal fix for the small fold this is meant to catch, and a catastrophe for
 * anything else, because the span is whatever the scan happened to find first -- and the scan walks
 * `i` from zero, so a crossing involving an early point and a late one is found before any small
 * loop is. Russia's ring hit exactly that: `repairCrossArcJunctions` deleted its way from the White
 * Sea to the Bering Strait over successive rounds, replacing the arctic coast with a straight
 * lon/lat line, which Mercator draws as a curve -- the smooth dome that swallowed the Arctic Ocean
 * and inflated the country's area by 20%. `repairRoundedSubpath` can go further still and return ''
 * for a ring it has emptied.
 *
 * So a crossing is only reported when the repair it implies is small. Past that span the fold is
 * either a false positive (this test is planar, and these rings run to the antimeridian and the
 * poles) or real geography; a hairline artifact is worth far less than a coastline.
 */
function findClosedRingCrossing(points, maxSpan = MAX_SELF_INTERSECTION_REPAIR_SPAN) {
  const n = points.length
  if (n < 4) return null
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n && j - i <= maxSpan; j++) {
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

/**
 * Project one feature, a polygon at a time.
 *
 * `clipExtent` does not merely cut a ring off at the frame: it CLOSES the clipped ring along that
 * boundary. Handed a whole MultiPolygon, d3 clips it as a single subject, so two separate islands
 * that both leave the same edge come back rejoined along it. That is what made Russia look wrong:
 * Franz Josef Land (81.8N) and Severnaya Zemlya (81.3N) sit above the frame's top, and the closure
 * welded them to the New Siberian Islands with a 256px band of land drawn straight across the
 * Arctic Ocean, from 54E to 150E -- a continent that does not exist, in the one part of the map a
 * reader is least able to check.
 *
 * Projecting each polygon on its own keeps every closure inside the island it belongs to: a cropped
 * island gets its own flat top, the mainland is untouched, and nothing is invented in between. The
 * concatenated `d` is identical to what d3 would emit for the unclipped case, because a MultiPolygon
 * path is just its polygons' subpaths in order.
 */
function pathForFeature(pathGenerator, feature) {
  const geometry = feature?.geometry
  if (!geometry || geometry.type !== 'MultiPolygon') return pathGenerator(feature) ?? ''
  let out = ''
  for (const coordinates of geometry.coordinates) {
    out += pathGenerator({ type: 'Feature', properties: feature.properties ?? null, geometry: { type: 'Polygon', coordinates } }) ?? ''
  }
  return out
}

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
    const raw = pathForFeature(pathGenerator, feature)
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
      const fallbackRaw = pathForFeature(pathGenerator, feature)
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

  // Antarctica decision (see the file doc comment's "Reference framing"): drop it from the
  // topology before anything else touches it -- at this framing (crop line ~-72.8°) its whole
  // landmass falls outside the box regardless, so the frame, not a fit, is why it is absent.
  topology.objects.countries.geometries = topology.objects.countries.geometries.filter((g) => g.id !== ANTARCTICA_NUMERIC_ID)

  // Unsimplified features, decoded once from the pristine (Antarctica-excluded) topology.
  // Used below (matched against features1152/features520 further down, by array index -- see
  // buildVariant's doc comment for why not by id) as the fallback source for the rare feature
  // whose simplified ring comes out suspicious (the file doc comment's "third failure mode"
  // and AREA_SANITY_MAX below).
  const rawFeatures = feature(topology, topology.objects.countries).features

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

  // Each viewport's own Mercator projection, at the reference's own fixed scale/translate --
  // see the file doc comment's "Reference framing". `.center()` is left at d3's own default
  // ([0, 0]): the reference's translate already centres the frame it wants, so a non-zero
  // center here would just be a second, redundant offset (see mercator.ts). `.clipExtent()`
  // is the honest fix for geometry that runs past this fixed frame: it clips ring geometry to
  // the given rectangle in PROJECTED (pixel) space and closes each ring along that boundary,
  // so a coastline that would otherwise run off the top/sides is cut with a straight edge at
  // the frame, exactly like a real cropped map -- not fit smaller to avoid it, not left to
  // overflow invisibly past `overflow: hidden`.
  const projection1152 = geoMercator()
    .translate(REFERENCE_1152.translate)
    .scale(REFERENCE_1152.scale)
    .clipExtent([[0, 0], [REFERENCE_1152.width, REFERENCE_1152.height]])
  const projection520 = geoMercator()
    .translate(REFERENCE_520.translate)
    .scale(REFERENCE_520.scale)
    .clipExtent([[0, 0], [REFERENCE_520.width, REFERENCE_520.height]])

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
  // both) was already decoded above, before the projections were built.

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
  // reintroduce a fraction-of-a-pixel drift between a dot and the coastline under it. width/
  // height travel with scale/translate so mercator.ts's MAP_DIMENSIONS reads the same fixed
  // viewBox size this script clipped to, rather than a second, independently-kept literal.
  const projectionFit1152 = { scale: projection1152.scale(), translate: projection1152.translate(), width: REFERENCE_1152.width, height: REFERENCE_1152.height }
  const projectionFit520 = { scale: projection520.scale(), translate: projection520.translate(), width: REFERENCE_520.width, height: REFERENCE_520.height }

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
 * operator/scripts/topojson-feature.mjs, then projected with the reference's own fixed
 * Mercator projection (Antarctica excluded — see build-world.mjs's file doc comment's
 * "Reference framing") and clipped to its exact viewBox via geoMercator().clipExtent().
 * PROJECTION_1152/PROJECTION_520 below are that projection's exact scale/translate/width/
 * height, at full precision — operator/src/world/mercator.ts imports them so its own
 * single-point projectPoint() (city dots) computes pixel positions identical to the land
 * paths in this file, never a second guess at the same numbers. See
 * operator/scripts/build-world.mjs.
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
  width: number
  height: number
}

export const WORLD_1152: WorldEntry[] = ${JSON.stringify(world1152.entries)}

export const WORLD_520: WorldEntry[] = ${JSON.stringify(world520.entries)}

export const CENTROIDS_1152: Record<string, [number, number]> = ${JSON.stringify(world1152.centroids)}

export const CENTROIDS_520: Record<string, [number, number]> = ${JSON.stringify(world520.centroids)}

/** d3-geo's geoGraticule10() (the standard 10-degree grid), projected and rounded like land. */
export const GRATICULE_1152: string = ${JSON.stringify(graticule1152)}

export const GRATICULE_520: string = ${JSON.stringify(graticule520)}

/** The reference's own fixed projection for this viewport (see this file's own header
 * comment) -- the exact scale/translate/width/height WORLD_1152's own \`d\` paths were
 * projected and clipped with. */
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
    `Métis Operator: reference projection -- 1152: scale=${projectionFit1152.scale.toFixed(3)} translate=[${projectionFit1152.translate.map((n) => n.toFixed(2)).join(', ')}], ` +
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
