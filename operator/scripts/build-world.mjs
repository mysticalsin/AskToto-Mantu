#!/usr/bin/env node
/**
 * Precomputes the world map: reads the checked-in world-atlas 50m topology
 * (operator/shoey-ref/data/countries-50m.json), simplifies it, decodes it with the vendored
 * topojson-feature.mjs `feature()` decoder, projects every country with the exact
 * reference Mercator constants (WorldMap.tsx's 1152x576 realtime map and CountryMap.tsx's
 * 520x300 corner map — see operator/src/world/mercator.ts), and writes
 * operator/src/world/paths.generated.ts.
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
 * Plan 3.7 item 2 / Tony's reference (OpenPanel + bklit): Mercator centred [0, 20], 16:9,
 * scale derived from width (see ./world/mercator.ts's MERCATOR_VARIANTS) — both variants'
 * translate/scale/center come from that one module so the generator and the runtime can
 * never drift apart. Each country entry also carries its English display name (resolved
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
const MERCATOR_ENTRY = join(WORLD_DIR, 'mercator.ts')
const ISO_ENTRY = join(WORLD_DIR, 'iso.ts')
const OUT_FILE = join(WORLD_DIR, 'paths.generated.ts')

const MAX_BYTES_1152 = 350 * 1024
const MAX_BYTES_520 = 120 * 1024

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
 * removed and its former neighbours' areas recomputed, until the smallest remaining area is
 * at or above `areaThreshold`. The first and last point are never removed — for a topology
 * arc these are the shared junction points other arcs/rings connect to, so keeping them
 * fixed is what keeps every ring built from these arcs closed and every shared border
 * between two rings identical.
 */
function visvalingamWhyatt(points, areaThreshold) {
  const n = points.length
  if (n <= 2 || areaThreshold <= 0) return points.slice()
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
  while (heap.size > 0) {
    const top = heap.pop()
    const i = top.index
    if (removed[i] || top.area !== area[i]) continue // stale heap entry
    if (top.area >= areaThreshold) break
    removed[i] = true
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

/** Simplify every arc in the topology once (in absolute lon/lat) and return a new,
 * transform-free topology whose arcs are the simplified absolute coordinates — ready for
 * feature() to decode with no further per-ring processing. */
function simplifyTopology(topology, areaThreshold) {
  const absoluteArcs = decodeAbsoluteArcs(topology)
  const simplifiedArcs = absoluteArcs.map((arc) => visvalingamWhyatt(arc, areaThreshold))
  return { ...topology, transform: undefined, arcs: simplifiedArcs }
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

async function buildVariant({ features, rawFeatures, pathGenerator, precision, numericToAlpha2, variantLabel }) {
  const entries = []
  const centroids = {}
  const pointCounts = []
  let droppedRings = 0
  const fellBackToRaw = []
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
    if (!raw) continue
    const label = `${variantLabel} ${alpha2 || id} (feature id ${id})`
    const { d, points, dropped } = buildValidatedPath(raw, label)
    droppedRings += dropped
    if (!d) continue
    pointCounts.push({ alpha2: alpha2 || id, points })
    entries.push({ id, alpha2, name: resolveCountryName(alpha2, id), d: roundPath(d, precision) })
    if (alpha2 && !centroids[alpha2]) {
      // world-atlas reuses one numeric id for a country and a tiny dependent territory
      // (036 = Australia and Ashmore and Cartier Islands); keep the first (larger) landmass.
      const c = pathGenerator.centroid(feature)
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        centroids[alpha2] = [round(2)(c[0]), round(2)(c[1])]
      }
    }
  }
  return { entries, centroids, pointCounts, droppedRings, fellBackToRaw }
}

/** The standard 10-degree graticule (d3-geo's own geoGraticule10()) projected and rounded the
 * same way land is — plan 3.7 item 2's "faint 10 degree graticule". */
function buildGraticule(pathGenerator, precision) {
  const d = pathGenerator(geoGraticule10()) ?? ''
  return roundPath(d, precision)
}


export async function buildWorldData() {
  const [mercatorMod, isoMod] = await Promise.all([importTsModule(MERCATOR_ENTRY), importTsModule(ISO_ENTRY)])
  const { MERCATOR_VARIANTS } = mercatorMod
  const { NUMERIC_TO_ALPHA2 } = isoMod

  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, 'utf8'))

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
  const features1152 = feature(topology1152, topology1152.objects.countries).features
  const features520 = feature(topology520, topology520.objects.countries).features

  // Unsimplified features, in the same array order as features1152/features520 (simplifying
  // a topology never touches topology.objects, only topology.arcs, so index i is always the
  // same geometry in both) — the fallback source for the rare feature whose simplified ring
  // comes out suspicious (see the file doc comment's "third failure mode" and AREA_SANITY_MAX
  // below). Matched by array index, not id: see buildVariant's doc comment for why.
  const rawFeatures = feature(topology, topology.objects.countries).features

  const mercator1152 = MERCATOR_VARIANTS['1152']
  const mercator520 = MERCATOR_VARIANTS['520']
  const geoPath1152 = geoPath(geoMercator().center(mercator1152.center).translate(mercator1152.translate).scale(mercator1152.scale))
  const geoPath520 = geoPath(geoMercator().center(mercator520.center).translate(mercator520.translate).scale(mercator520.scale))

  const world1152 = await buildVariant({
    features: features1152,
    rawFeatures,
    pathGenerator: geoPath1152,
    precision: PRECISION_1152,
    numericToAlpha2: NUMERIC_TO_ALPHA2,
    variantLabel: '1152'
  })
  const world520 = await buildVariant({
    features: features520,
    rawFeatures,
    pathGenerator: geoPath520,
    precision: PRECISION_520,
    numericToAlpha2: NUMERIC_TO_ALPHA2,
    variantLabel: '520'
  })

  const graticule1152 = buildGraticule(geoPath1152, PRECISION_1152)
  const graticule520 = buildGraticule(geoPath520, PRECISION_520)

  const code = renderGeneratedFile(world1152, world520, graticule1152, graticule520)
  const bytes = Buffer.byteLength(code, 'utf8')
  const bytes1152 = Buffer.byteLength(JSON.stringify(world1152.entries), 'utf8')
  const bytes520 = Buffer.byteLength(JSON.stringify(world520.entries), 'utf8')

  if (bytes1152 > MAX_BYTES_1152) {
    throw new Error(`build-world: WORLD_1152 is ${(bytes1152 / 1024).toFixed(0)} KB, over the ${MAX_BYTES_1152 / 1024} KB budget. Raise AREA_THRESHOLD_1152.`)
  }
  if (bytes520 > MAX_BYTES_520) {
    throw new Error(`build-world: WORLD_520 is ${(bytes520 / 1024).toFixed(0)} KB, over the ${MAX_BYTES_520 / 1024} KB budget. Raise AREA_THRESHOLD_520.`)
  }

  return { code, world1152, world520, graticule1152, graticule520, bytes, bytes1152, bytes520 }
}

function renderGeneratedFile(world1152, world520, graticule1152, graticule520) {
  return `/**
 * GENERATED FILE. Do not edit by hand.
 * Run \`npm run build:operator-world\` (node operator/scripts/build-world.mjs) to regenerate.
 * Source: operator/shoey-ref/data/countries-50m.json (world-atlas 50m, public domain),
 * simplified per-arc (Visvalingam-Whyatt) and decoded with
 * operator/scripts/topojson-feature.mjs, then projected with the reference Mercator
 * constants (center [0, 20], 16:9, scale derived from width) in
 * operator/src/world/mercator.ts. See operator/scripts/build-world.mjs.
 */

export interface WorldEntry {
  id: string
  alpha2: string
  /** English display name, resolved once at build time (Intl.DisplayNames) — never a
   * fabricated name; falls back to the raw code/id when Intl does not recognise it. */
  name: string
  d: string
}

export const WORLD_1152: WorldEntry[] = ${JSON.stringify(world1152.entries)}

export const WORLD_520: WorldEntry[] = ${JSON.stringify(world520.entries)}

export const CENTROIDS_1152: Record<string, [number, number]> = ${JSON.stringify(world1152.centroids)}

export const CENTROIDS_520: Record<string, [number, number]> = ${JSON.stringify(world520.centroids)}

/** d3-geo's geoGraticule10() (the standard 10-degree grid), projected and rounded like land. */
export const GRATICULE_1152: string = ${JSON.stringify(graticule1152)}

export const GRATICULE_520: string = ${JSON.stringify(graticule520)}
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
  const { code, world1152, world520, bytes, bytes1152, bytes520 } = await buildWorldData()
  writeFileSync(OUT_FILE, code)
  printPointCounts('WORLD_1152', world1152.pointCounts)
  printPointCounts('WORLD_520', world520.pointCounts)
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
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
