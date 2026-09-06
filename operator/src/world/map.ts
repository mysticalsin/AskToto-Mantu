/**
 * Pure, isomorphic world-map rendering. No DOM access anywhere in this module (that lives in
 * ./map-dom.ts, imported only by the client bundle). Ports the OpenPanel "Shoey" demo
 * (WorldMap.tsx, shared/MapCanvas.tsx, shared/ZoomPan.tsx, demo-shoey-0c94a954/CountryMap.tsx)
 * plus bklit's Choropleth Chart behaviours, per plan 3.7 item 2 and Tony's exact words this
 * round: "fix the maps because they look terrible, it should look like this with a pulsing
 * green dot on where people are using it and the city they are from."
 *
 * That is the spec this file now implements: white ocean, `--map-land` filled countries with
 * 0.5px `--map-stroke` borders, a faint 10-degree graticule, one pulsing `--live` (green) dot
 * per city with a live seat (sized by how many seats are stacked there) and its city name
 * rendered next to the dot — not only in a tooltip. A city seen today but with no heartbeat in
 * the last two minutes is a smaller, static `--accent` (violet) dot, no pulse. Countries with
 * more than one reporting place also get a pill (flag, country name, seat count, place count)
 * anchored at the country's real centroid, dropped when the country already shows a single
 * city label (nothing left for the pill to add). Hovering a country tints it
 * `--map-land-hover` and fades every other country to 40%; a tooltip (wired up in
 * ./map-dom.ts on hydration) carries flag, city, country, seats, live seats, asks in the last
 * 30 minutes and time saved. Zoom/pan is ./map-dom.ts's `attachMapInteraction`; this module
 * only renders the markup those hooks bind to (`data-map-svg`, `data-viewport`, `data-pin`,
 * `data-pill`, `data-zoom-in`, `data-zoom-out`).
 *
 * No inline `style=` attributes: colour/typography/motion come from CSS classes
 * (operator/src/spa/css-realtime.ts) that reference tokens (`--map-*`, `--live`, `--accent`,
 * `--chart-scale-01..05`) — this module never writes a hex literal. Only per-instance
 * geometry (`cx`, `cy`, `r`, `transform`, `d`) is a presentation attribute.
 */
import { CENTROIDS_1152, CENTROIDS_520, GRATICULE_1152, GRATICULE_520, WORLD_1152, WORLD_520, type WorldEntry } from './paths.generated'
import { MAP_DIMENSIONS, MERCATOR_VARIANTS, projectPoint, type MapVariant } from './mercator'

export type { MapVariant }
export { MAP_DIMENSIONS, MERCATOR_VARIANTS, projectPoint }

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()

/** Country name for an alpha-2 code, via Intl.DisplayNames, falling back to the code itself
 * (never throws — Workers/older runtimes may lack a region for an unusual code). */
export function countryName(code: string): string {
  if (!code) return code
  try {
    return regionNames?.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

function escapeXml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function flagHref(iso: string): string {
  return `/assets/flags/${iso.toLowerCase()}.svg`
}

/** Every WORLD_* entry's `d` joined into one path — see build-world.mjs's doc comment for why
 * this is computed on demand rather than also committed to paths.generated.ts. Not used by
 * the default hover-interactive render (which needs per-country paths); available for a base
 * layer or an accessibility silhouette. */
export function worldOutline(entries: WorldEntry[]): string {
  return entries.map((e) => e.d).join('')
}

// ---------------------------------------------------------------------------------------
// Clustering (ported from WorldMap.tsx). Kept as a pure, tested helper for tooltip
// aggregation and any future proximity-based badge UI; the realtime map's own pills use
// countryPills() below instead — pills are anchored at a country's real centroid, not a
// proximity cluster's running average, so a pill always sits inside its country.
// ---------------------------------------------------------------------------------------

export interface ClusterPoint {
  country: string
  city: string
  count: number
  x: number
  y: number
}

export interface Cluster {
  x: number
  y: number
  count: number
  members: ClusterPoint[]
}

export interface ClusterOptions {
  radiusPx: number
  maxBadges: number
  minBadgeDistancePx: number
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  radiusPx: 22,
  maxBadges: 42,
  minBadgeDistancePx: 90
}

export interface ClusterResult {
  clusters: Cluster[]
  badgeClusters: Cluster[]
}

/** Greedy clustering in projected pixel space, identical to WorldMap.tsx: a point joins the
 * first cluster whose anchor (first member) is within `radiusPx`, else starts a new cluster.
 * Then badges are chosen by count descending, greedily accepting one only if it is at least
 * `minBadgeDistancePx` from every badge already accepted, capped at `maxBadges`. */
export function clusterPins(points: ClusterPoint[], options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS): ClusterResult {
  const clusters: Cluster[] = []
  for (const point of points) {
    const target = clusters.find((cluster) => {
      const dx = point.x - cluster.x
      const dy = point.y - cluster.y
      return Math.sqrt(dx * dx + dy * dy) <= options.radiusPx
    })
    if (target) {
      target.members.push(point)
      target.count += point.count
    } else {
      clusters.push({ x: point.x, y: point.y, count: point.count, members: [point] })
    }
  }

  const sortedByCount = [...clusters].sort((a, b) => b.count - a.count)
  const badgeClusters: Cluster[] = []
  const acceptedPositions: { x: number; y: number }[] = []
  for (const cluster of sortedByCount) {
    if (badgeClusters.length >= options.maxBadges) break
    const farEnough = acceptedPositions.every((p) => {
      const dx = cluster.x - p.x
      const dy = cluster.y - p.y
      return Math.sqrt(dx * dx + dy * dy) >= options.minBadgeDistancePx
    })
    if (farEnough) {
      badgeClusters.push(cluster)
      acceptedPositions.push({ x: cluster.x, y: cluster.y })
    }
  }

  return { clusters, badgeClusters }
}

/** "Longueuil" for a single member, "Canada, 3 places" for one country with several members,
 * "5 places" once more than one country is represented. */
export function clusterLabel(cluster: Cluster): string {
  const { members } = cluster
  if (members.length === 1) {
    const [member] = members
    return member.city ? member.city : countryName(member.country)
  }
  const countryCodes = new Set(members.map((m) => m.country))
  if (countryCodes.size === 1) {
    const [code] = countryCodes
    return `${countryName(code)}, ${members.length} places`
  }
  return `${members.length} places`
}

// ---------------------------------------------------------------------------------------
// Rendering
//
// No theme branching anywhere below: every colour is a CSS custom property
// (operator/src/spa/css-realtime.ts), so light/dark/`prefers-color-scheme` are the
// stylesheet's problem, not this module's — the same markup is correct in both themes.
// ---------------------------------------------------------------------------------------

function landPaths(entries: WorldEntry[]): string {
  return entries
    .map(
      (c) =>
        `<path class="world-land" data-iso="${escapeXml(c.alpha2 || c.id)}" data-country="${escapeXml(c.name)}" tabindex="0" d="${c.d}" />`
    )
    .join('')
}

export interface RealtimeMapPoint {
  country: string
  city: string
  lat: number
  lon: number
  /** Seats reporting from this exact point (stacked seats enlarge the dot). */
  count: number
  /** A heartbeat in the last two minutes. Defaults to true — every point handed to this
   * renderer represents real activity, and only a caller that can tell "seen today" apart
   * from "live right now" (charts.ts's groupDotsToPoints, once the data layer carries that
   * distinction) ever passes `false`. Live renders a pulsing `--live` (green) dot; not-live
   * renders a smaller, static `--accent` (violet) dot. */
  live?: boolean
  /** Seats at this point that are live right now, when known and different from `count`
   * (which is every seat seen today at this point). Omitted from the tooltip data when not
   * supplied — numbers stay honest, never a fabricated duplicate of `count`. */
  liveSeats?: number
  /** Asks in the last 30 min from this point, when known. Omitted entirely from the tooltip
   * when not supplied — numbers stay honest, never a fabricated zero. */
  asks?: number
  /** Pre-formatted ("3.2h") — there is no shared duration formatter in this module. Omitted
   * when not known. */
  timeSaved?: string
}

export interface RealtimeMapOptions {
  points: RealtimeMapPoint[]
}

/** `labelDy` shifts only the city-name text (never the dot itself) — the output of the
 * collision nudge in `layoutPoints` below, so two nearby cities' names never overlap. */
function renderPin(point: RealtimeMapPoint, variant: MapVariant, labelDy = 0): string {
  const [x, y] = projectPoint(point.lat, point.lon, variant)
  const live = point.live ?? true
  const dotRadius = live ? (point.count > 1 ? 6.5 : 4.5) : point.count > 1 ? 5 : 3.5
  const label = point.city || countryName(point.country)
  const asksAttr = point.asks == null ? '' : ` data-asks="${point.asks}"`
  const liveSeatsAttr = point.liveSeats == null ? '' : ` data-live-seats="${point.liveSeats}"`
  const timeSavedAttr = point.timeSaved ? ` data-time-saved="${escapeXml(point.timeSaved)}"` : ''
  const halo = live ? '<circle class="rt-pin-halo" data-beacon r="4.5" />' : ''
  const labelX = (dotRadius + 5).toFixed(2)
  const labelY = (3 + labelDy).toFixed(2)
  return `<g class="rt-pin" data-pin tabindex="0" data-live="${live ? '1' : '0'}" data-iso="${escapeXml(point.country)}" data-country="${escapeXml(countryName(point.country))}" data-city="${escapeXml(label)}" data-seats="${point.count}"${liveSeatsAttr}${asksAttr}${timeSavedAttr} transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
      <g class="rt-pin-inner" data-pin-inner>
        ${halo}
        <circle class="rt-pin-dot" r="${dotRadius}" />
        <text class="rt-pin-label" data-pin-label x="${labelX}" y="${labelY}">${escapeXml(label)}</text>
      </g>
    </g>`
}

export interface CountryPillEntry {
  iso: string
  country: string
  seats: number
  places: number
  x: number
  y: number
}

export interface CountryPillOptions {
  /** A country needs at least this many distinct reporting places before it gets a pill —
   * below that, its one city label already carries the information (Tony: "drop a pill when
   * its country already shows a single city label"). */
  minPlaces: number
}

export const DEFAULT_PILL_OPTIONS: CountryPillOptions = { minPlaces: 2 }

/** One pill per country with >= minPlaces distinct reporting places, anchored at that
 * country's real centroid (CENTROIDS_1152/520 — computed from the actual landmass at build
 * time), never a points' average which can drift onto a neighbour or the ocean. Countries
 * with no centroid (an id with no resolved alpha-2, vanishingly rare) are skipped rather than
 * guessed at. */
export function countryPills(points: RealtimeMapPoint[], variant: MapVariant, options: CountryPillOptions = DEFAULT_PILL_OPTIONS): CountryPillEntry[] {
  const byCountry = new Map<string, { seats: number; places: Set<string> }>()
  for (const p of points) {
    const entry = byCountry.get(p.country) ?? { seats: 0, places: new Set<string>() }
    entry.seats += p.count
    entry.places.add(`${p.city}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`)
    byCountry.set(p.country, entry)
  }
  const centroids = variant === '1152' ? CENTROIDS_1152 : CENTROIDS_520
  const pills: CountryPillEntry[] = []
  for (const [iso, { seats, places }] of byCountry) {
    if (places.size < options.minPlaces) continue
    const centroid = centroids[iso]
    if (!centroid) continue
    pills.push({ iso, country: countryName(iso), seats, places: places.size, x: centroid[0], y: centroid[1] })
  }
  return pills.sort((a, b) => b.seats - a.seats)
}

interface LayoutBox {
  x: number
  y: number
  width: number
  height: number
}

/** Simple collision nudge (plan 3.7 item 2: pills "never overlapping, simple collision
 * nudge"): pills are placed in seat-count order against every fixed obstacle (city labels,
 * which never move — moving a label away from its own dot would break the visual link) and
 * every pill already placed, dropping straight down until clear. A handful of pills and
 * labels at a time, so the O(n*m) scan costs nothing worth optimising. */
function nudgeDown(box: LayoutBox, obstacles: LayoutBox[]): void {
  for (let guard = 0; guard < 8; guard++) {
    const hit = obstacles.find(
      (o) => box.x < o.x + o.width && box.x + box.width > o.x && box.y < o.y + o.height && box.y + box.height > o.y
    )
    if (!hit) return
    box.y = hit.y + hit.height + 2
  }
}

/** Rough label-width estimate for server-rendered layout with no real text metrics
 * (map-dom.ts refines every box to its actual `getBBox()` width on hydration) — generous
 * enough that the common case does not visibly overflow before that refinement runs. */
function estimateTextWidth(text: string, pxPerChar: number): number {
  return text.length * pxPerChar
}

function renderPillLayer(pills: CountryPillEntry[], cityLabelBoxes: LayoutBox[]): { markup: string; boxes: LayoutBox[] } {
  const placed: LayoutBox[] = []
  let markup = ''
  const height = 20
  const padX = 8
  const dotR = 3
  const gapDotFlag = 6
  const flagW = 14
  const flagH = 10
  const gapFlagText = 5
  const leading = padX + dotR * 2 + gapDotFlag + flagW + gapFlagText
  for (const pill of pills) {
    const text = `${pill.country} · ${pill.seats} seat${pill.seats === 1 ? '' : 's'} · ${pill.places} places`
    const textWidth = estimateTextWidth(text, 5.6)
    const width = leading + textWidth + padX
    const box: LayoutBox = { x: pill.x - width / 2, y: pill.y - height / 2, width, height }
    nudgeDown(box, [...cityLabelBoxes, ...placed])
    placed.push(box)
    const midY = box.y + height / 2
    const dotCx = box.x + padX + dotR
    const flagX = dotCx + dotR + gapDotFlag
    const flagY = midY - flagH / 2
    const textX = flagX + flagW + gapFlagText
    const textY = midY + 3.5
    markup += `<g class="rt-pill" data-pill data-iso="${escapeXml(pill.iso)}" data-country="${escapeXml(pill.country)}" data-seats="${pill.seats}" data-places="${pill.places}">
      <rect class="rt-pill-bg" data-pill-bg x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${width.toFixed(2)}" height="${height}" rx="${height / 2}" />
      <circle class="rt-pill-live" data-beacon cx="${dotCx.toFixed(2)}" cy="${midY.toFixed(2)}" r="${dotR}" />
      <image class="rt-pill-flag" href="${flagHref(pill.iso)}" x="${flagX.toFixed(2)}" y="${flagY.toFixed(2)}" width="${flagW}" height="${flagH}" />
      <text class="rt-pill-text" data-pill-text x="${textX.toFixed(2)}" y="${textY.toFixed(2)}">${escapeXml(text)}</text>
    </g>`
  }
  return { markup, boxes: placed }
}

/** Full realtime map SVG: white ocean, faint 10-degree graticule, `--map-land` filled
 * countries with 0.5px `--map-stroke` borders, one dot per reporting point (pulsing `--live`
 * green when live, static `--accent` violet otherwise) with its city name next to it, a pill
 * per country with more than one reporting place, zoom/pan viewport group and +/- control
 * buttons rendered as markup so ./map-dom.ts only has to bind handlers, and a tooltip
 * container it fills in on hover/pointermove. */
export function renderRealtimeMapSvg(options: RealtimeMapOptions): string {
  const { points } = options
  const variant: MapVariant = '1152'
  const { width, height } = MAP_DIMENSIONS[variant]
  const empty = points.length === 0

  const land = landPaths(WORLD_1152)

  // City labels must not collide with each other either (two nearby cities' names used to
  // print on top of one another) — nudge each one, in turn, clear of every label already
  // placed, then render every pin with the resulting vertical offset applied to its text
  // only (the dot itself never moves).
  const placedLabels: LayoutBox[] = []
  const labelDy: number[] = []
  if (!empty) {
    for (const p of points) {
      const [x, y] = projectPoint(p.lat, p.lon, variant)
      const label = p.city || countryName(p.country)
      const dotRadius = (p.live ?? true) ? (p.count > 1 ? 6.5 : 4.5) : p.count > 1 ? 5 : 3.5
      const labelX = x + dotRadius + 5
      const w = estimateTextWidth(label, 5.4)
      const box: LayoutBox = { x: labelX, y: y - 7, width: w, height: 14 }
      const originalY = box.y
      nudgeDown(box, placedLabels)
      placedLabels.push(box)
      labelDy.push(box.y - originalY)
    }
  }
  const pins = empty ? '' : points.map((p, i) => renderPin(p, variant, labelDy[i])).join('')
  const pills = empty ? [] : countryPills(points, variant)
  const { markup: pillMarkup } = renderPillLayer(pills, placedLabels)
  const caption = empty
    ? `<div class="empty map-empty">No seat has checked in during the last 30 minutes.</div>`
    : ''
  const svg = `<svg class="rt-map-svg" data-map-svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Live seat locations">
    <rect class="map-ocean" width="${width}" height="${height}" />
    <g class="rt-viewport" data-viewport transform="translate(0,0) scale(1)">
      <path class="map-graticule" data-graticule d="${GRATICULE_1152}" />
      <g class="world-land-group" data-hover-fade>${land}</g>
      <g class="rt-pins" data-pins>${pins}</g>
      <g class="rt-pills" data-pills>${pillMarkup}</g>
    </g>
  </svg>`
  const controls = `<div class="rt-map-controls" data-map-controls>
    <button type="button" class="rt-map-zoom" data-zoom-in aria-label="Zoom in">+</button>
    <button type="button" class="rt-map-zoom" data-zoom-out aria-label="Zoom out">&minus;</button>
  </div>`
  const tooltip = `<div class="rt-map-tooltip" data-map-tooltip role="tooltip" hidden></div>`
  const fade = `<div class="rt-map-fade" aria-hidden="true"></div>`
  return `${caption}<div class="rt-map" data-map-root>${svg}${tooltip}${controls}${fade}</div>`
}

// ---------------------------------------------------------------------------------------
// Corner choropleth (CountryMap.tsx port, plan 3.7 item 2: "the Overview corner map is the
// same component as a choropleth: fill by seats per country through --chart-scale-01..05, no
// data countries in --data-track").
// ---------------------------------------------------------------------------------------

export interface CornerCountry {
  iso: string
  count: number
}

export interface CornerMapOptions {
  countries: CornerCountry[]
}

const CHART_SCALE_STEPS = 5

/** 520x300-ish (16:9) corner choropleth: a 5-step `--chart-scale-01..05` sequential fill by
 * seat count, `--map-ocean` strokes between cells (the reference's "white 0.5px strokes" —
 * `--map-ocean` is white in light theme and the correct dark separator in dark theme), no
 * data in `--data-track`, invisible hit pins at centroids for tooltips. */
export function renderCornerMapSvg(options: CornerMapOptions): string {
  const variant: MapVariant = '520'
  const { width, height } = MAP_DIMENSIONS[variant]
  const byIso = new Map(options.countries.map((c) => [c.iso, c.count]))
  const max = Math.max(1, ...options.countries.map((c) => c.count))
  const land = WORLD_520.map((c) => {
    const count = byIso.get(c.alpha2)
    const step = count == null || count <= 0 ? 0 : Math.min(CHART_SCALE_STEPS, Math.max(1, Math.ceil((count / max) * CHART_SCALE_STEPS)))
    const cls = step === 0 ? 'no-data' : `scale-${String(step).padStart(2, '0')}`
    return `<path class="world-land corner-cell ${cls}" data-iso="${escapeXml(c.alpha2 || c.id)}" data-country="${escapeXml(c.name)}" d="${c.d}" />`
  }).join('')
  const pins = options.countries
    .filter((c) => byIso.has(c.iso) && CENTROIDS_520[c.iso])
    .map((c) => {
      const [x, y] = CENTROIDS_520[c.iso]
      const count = byIso.get(c.iso) ?? 0
      return `<g class="corner-pin" data-pin tabindex="0" data-country="${escapeXml(countryName(c.iso))}" data-count="${count}" transform="translate(${x} ${y})"><circle class="corner-pin-hit" r="6" /></g>`
    })
    .join('')
  return `<svg class="corner-map-svg" data-map-svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Countries by activity"><rect class="map-ocean" width="${width}" height="${height}" />${land}${pins}</svg>`
}

export { CENTROIDS_1152, CENTROIDS_520, GRATICULE_1152, GRATICULE_520, WORLD_1152, WORLD_520 }
