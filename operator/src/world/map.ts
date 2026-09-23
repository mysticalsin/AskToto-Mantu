/**
 * Pure, isomorphic world-map rendering. No DOM access anywhere in this module (that lives
 * in ./map-dom.ts, imported only by the client bundle). The client bundle also imports the
 * layer renderers below (renderPinLayer / renderClusterLayer / clusterPopoverHtml) so a live
 * payload repaints the same markup the server rendered, in place.
 *
 * Two modes, one module:
 * - Realtime (renderRealtimeMapSvg): one small dot per place, cluster pills above groups of
 *   places (pulsing live dot, seat count, divider, label), re-clustered per zoom level.
 * - Overview choropleth (renderCornerMapSvg): country fill = --chart-0 at an opacity linear in
 *   the country's seat count, no zoom.
 *
 * Colours are CSS tokens only (var(--map-*), var(--chart-0)), so light/dark follow the console
 * theme with no JS repaint and no hex anywhere in the markup. Honesty rules (quality-bar):
 * exactly one pin per supplied place, never a sample dot, asks omitted when unknown.
 */
import { CENTROIDS_1152, CENTROIDS_520, WORLD_1152, WORLD_520 } from './paths.generated'
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

// ---------------------------------------------------------------------------------------
// Clustering (ported from WorldMap.tsx).
// ---------------------------------------------------------------------------------------

export interface ClusterPoint {
  /** ISO 3166-1 alpha-2 code. */
  country: string
  city: string
  count: number
  x: number
  y: number
  /** Place key (see placeKey) when the point came from a realtime place. */
  key?: string
  /** Open sessions at this place, when known. */
  sessions?: number
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

/** Reference pill wording: "Longueuil" for a single place (country name when it has no city),
 * "Canada, 3 cities" for several places in one country, "5 countries" across countries. */
export function clusterLabel(cluster: Cluster): string {
  const { members } = cluster
  if (members.length === 1) {
    const [member] = members
    return member.city ? member.city : countryName(member.country)
  }
  const countryCodes = new Set(members.map((m) => m.country))
  if (countryCodes.size === 1) {
    const [code] = countryCodes
    return `${countryName(code)}, ${members.length} cities`
  }
  return `${countryCodes.size} countries`
}

// ---------------------------------------------------------------------------------------
// Realtime places
// ---------------------------------------------------------------------------------------

export interface RealtimeMapPoint {
  /** ISO 3166-1 alpha-2 code (kept under this name for existing callers). */
  country: string
  city: string
  lat: number
  lon: number
  /** Seats reporting from this exact point. */
  count: number
  /** Asks in the last 30 min from this point, when known. Omitted entirely from the markup
   * when not supplied — numbers stay honest, never a fabricated zero. */
  asks?: number
  iso2?: string
  region?: string | null
  /** Open sessions at this point, when known. */
  sessions?: number
  /** Stable place key (see placeKey); derived from the point when absent. */
  placeKey?: string
}

/** The live.json `geo.places[]` entry (operator/src/realtime-geo.ts RealtimePlace). */
export interface RealtimePlaceLike {
  iso2: string
  country: string
  region: string | null
  city: string | null
  lat: number
  lon: number
  seats: number
  sessions: number
}

/** `${iso2}|${city}|${lat 2dp}|${lon 2dp}` — must match operator/src/realtime-geo.ts placeKey. */
export function placeKey(p: { iso2: string; city: string | null; lat: number; lon: number }): string {
  return `${(p.iso2 || '').toUpperCase()}|${(p.city || '').trim()}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`
}

function pointKey(p: RealtimeMapPoint): string {
  return p.placeKey ?? placeKey({ iso2: p.iso2 ?? p.country, city: p.city, lat: p.lat, lon: p.lon })
}

/** Adapter from a live.json place to a map point. */
export function placeToPoint(place: RealtimePlaceLike): RealtimeMapPoint {
  return {
    country: (place.iso2 || '').toUpperCase(),
    city: place.city || '',
    lat: place.lat,
    lon: place.lon,
    count: place.seats,
    iso2: (place.iso2 || '').toUpperCase(),
    region: place.region,
    sessions: place.sessions,
    placeKey: placeKey(place)
  }
}

const VARIANT: MapVariant = '1152'

function toClusterPoint(p: RealtimeMapPoint): ClusterPoint {
  const [x, y] = projectPoint(p.lat, p.lon, VARIANT)
  return { country: (p.country || '').toUpperCase(), city: p.city || '', count: p.count, x, y, key: pointKey(p), sessions: p.sessions }
}

/** Screen-space cluster radius at zoom 1. Divided by the zoom factor, so zooming in splits
 * clusters (the pills are counter-scaled and keep a constant on-screen size). */
export const CLUSTER_RADIUS_PX = 36

/** Cluster places for the current zoom factor `zoomK` (1 = whole world). */
export function clusterPlaces(points: RealtimeMapPoint[], zoomK = 1): Cluster[] {
  const k = Number.isFinite(zoomK) && zoomK > 0 ? zoomK : 1
  const { clusters } = clusterPins(points.map(toClusterPoint), {
    radiusPx: CLUSTER_RADIUS_PX / k,
    maxBadges: Number.MAX_SAFE_INTEGER,
    minBadgeDistancePx: 0
  })
  return clusters
}

/** Seat-weighted centre of a cluster, so the pill sits over the mass of its places rather
 * than over whichever place happened to be listed first. */
function clusterCentre(cluster: Cluster): { x: number; y: number } {
  const total = cluster.members.reduce((sum, m) => sum + Math.max(1, m.count), 0)
  let x = 0
  let y = 0
  for (const m of cluster.members) {
    const w = Math.max(1, m.count) / total
    x += m.x * w
    y += m.y * w
  }
  return { x, y }
}

function pinLabel(p: RealtimeMapPoint): string {
  const name = countryName(p.country)
  const place = p.city ? `${p.city}, ${name}` : name
  return `${place} · ${p.count} ${p.count === 1 ? 'seat' : 'seats'}`
}

function renderPin(point: RealtimeMapPoint): string {
  const [x, y] = projectPoint(point.lat, point.lon, VARIANT)
  const iso = (point.country || '').toUpperCase()
  const city = point.city || countryName(iso)
  const asksAttr = point.asks == null ? '' : ` data-asks="${point.asks}"`
  const sessionsAttr = point.sessions == null ? '' : ` data-sessions="${point.sessions}"`
  return `<g class="rt-pin" data-pin tabindex="0" role="img" aria-label="${escapeXml(pinLabel(point))}" data-place="${escapeXml(pointKey(point))}" data-country="${escapeXml(countryName(iso))}" data-iso="${escapeXml(iso)}" data-city="${escapeXml(city)}" data-seats="${point.count}"${asksAttr}${sessionsAttr} transform="translate(${x.toFixed(2)} ${y.toFixed(2)})"><g class="rt-pin-inner" data-pin-inner><g class="rt-pin-halo" aria-hidden="true"><circle r="3" /></g><circle class="rt-pin-dot" r="3" /></g></g>`
}

/** One dot per supplied place, never more, never fewer. */
export function renderPinLayer(points: RealtimeMapPoint[]): string {
  return `<g class="rt-pin-layer" data-pin-layer>${points.map(renderPin).join('')}</g>`
}

/** Clusters that get a pill: every multi-place cluster plus the busiest single places, capped,
 * then thinned so no two pills overlap on screen (pill boxes are PILL_W x PILL_H screen px). */
const PILL_MAX = 24
const PILL_TOP_SINGLES = 12
const PILL_W = 150
const PILL_H = 30

export function pillClusters(clusters: Cluster[], zoomK = 1): Cluster[] {
  const k = Number.isFinite(zoomK) && zoomK > 0 ? zoomK : 1
  const bySeats = [...clusters].sort((a, b) => b.count - a.count)
  const singles = new Set(bySeats.filter((c) => c.members.length === 1).slice(0, PILL_TOP_SINGLES))
  const wanted = bySeats.filter((c) => c.members.length >= 2 || singles.has(c))
  const accepted: { c: Cluster; x: number; y: number }[] = []
  for (const c of wanted) {
    if (accepted.length >= PILL_MAX) break
    const centre = clusterCentre(c)
    const clear = accepted.every((a) => Math.abs(a.x - centre.x) * k >= PILL_W || Math.abs(a.y - centre.y) * k >= PILL_H)
    if (clear) accepted.push({ c, x: centre.x, y: centre.y })
  }
  return accepted.map((a) => a.c)
}

/** Zoom buckets the client re-clusters on (bucket changes, not every wheel tick). */
export function zoomBucket(zoomK: number): number {
  if (!(zoomK > 1.25)) return 1
  if (zoomK < 1.9) return 1.5
  if (zoomK < 2.7) return 2.25
  return 3
}

function renderClusterPill(cluster: Cluster, index: number): string {
  const { x, y } = clusterCentre(cluster)
  const label = clusterLabel(cluster)
  const seatsWord = cluster.count === 1 ? 'seat' : 'seats'
  const keys = JSON.stringify(cluster.members.map((m) => m.key ?? ''))
  return `<g class="rt-cluster" data-cluster="${index}" data-cluster-count="${cluster.count}" data-cluster-members="${cluster.members.length}" data-cluster-keys="${escapeXml(keys)}" transform="translate(${x.toFixed(2)} ${y.toFixed(2)})"><g class="rt-cluster-inner" data-pin-inner><foreignObject x="-110" y="-40" width="220" height="32"><div xmlns="http://www.w3.org/1999/xhtml" class="rt-pill-wrap"><button type="button" class="rt-pill" data-cluster-pill="${index}" aria-label="${escapeXml(`${label}, ${cluster.count} ${seatsWord}`)}"><span class="rt-pill-dot" aria-hidden="true"></span><span class="rt-pill-count">${cluster.count}</span><span class="rt-pill-sep" aria-hidden="true"></span><span class="rt-pill-label">${escapeXml(label)}</span></button></div></foreignObject></g></g>`
}

/** Pill layer for the given zoom factor. `data-cluster` indexes into clusterPlaces(points, k)
 * order, so the client can recover a pill's members without re-deriving the pixel geometry. */
export function renderClusterLayer(points: RealtimeMapPoint[], zoomK = 1): string {
  const clusters = clusterPlaces(points, zoomK)
  const pills = new Set(pillClusters(clusters, zoomK))
  const markup = clusters
    .map((c, i) => (pills.has(c) ? renderClusterPill(c, i) : ''))
    .join('')
  return `<g class="rt-cluster-layer" data-cluster-layer data-zoom-bucket="${zoomBucket(zoomK)}">${markup}</g>`
}

function landPaths(entries: { id: string; alpha2: string; d: string }[]): string {
  return entries
    .map(
      (c) =>
        `<path class="world-land" data-iso="${escapeXml(c.alpha2 || c.id)}" d="${c.d}" fill="var(--map-land)" stroke="var(--map-stroke)" stroke-width="0.5" vector-effect="non-scaling-stroke" />`
    )
    .join('')
}

export const DEFAULT_EMPTY_CAPTION =
  'No heartbeats yet. The map stays empty until a seat checks in. Empty is an empty world, not sample dots.'

export interface RealtimeMapOptions {
  points: RealtimeMapPoint[]
  /** Current zoom factor for the initial cluster layer (default 1). */
  zoomK?: number
  /** Honest empty-state copy; must keep "not sample dots" (quality-bar). */
  emptyCaption?: string
  /** @deprecated Colours follow the console theme through CSS tokens; ignored. */
  theme?: 'light' | 'dark'
  /** @deprecated Pills now count the seats of the places they group; ignored. */
  countries?: { iso: string; devices: number }[]
}

/** Full realtime map: ocean, land, one dot per place, cluster pills, zoom/pan viewport and
 * +/- controls. Layers are separately addressable (`data-pin-layer`, `data-cluster-layer`)
 * so the client swaps them in place on each live payload and zoom-bucket change. */
export function renderRealtimeMapSvg(options: RealtimeMapOptions): string {
  const { points, zoomK = 1, emptyCaption = DEFAULT_EMPTY_CAPTION } = options
  const { width, height } = MAP_DIMENSIONS[VARIANT]
  const empty = points.length === 0
  const caption = empty ? `<div class="empty map-empty" data-map-empty>${escapeXml(emptyCaption)}</div>` : ''
  const svg = `<svg class="rt-map-svg" data-map-svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Live seat locations">
    <g class="rt-viewport" data-viewport transform="translate(0,0) scale(1)">
      <rect class="world-ocean" width="${width}" height="${height}" fill="var(--map-ocean)" />
      <g class="world-land-layer" aria-hidden="true">${landPaths(WORLD_1152)}</g>
      ${renderPinLayer(points)}
      ${renderClusterLayer(points, zoomK)}
    </g>
  </svg>`
  const controls = `<div class="rt-map-controls" data-map-controls>
    <button type="button" class="rt-map-zoom" data-zoom-in aria-label="Zoom in">+</button>
    <button type="button" class="rt-map-zoom" data-zoom-out aria-label="Zoom out">&minus;</button>
  </div>`
  return `${caption}<div class="rt-map" data-map-root>${svg}${controls}</div>`
}

// ---------------------------------------------------------------------------------------
// Cluster popover (pure HTML; the client positions it next to the clicked pill).
// ---------------------------------------------------------------------------------------

export interface PopoverSession {
  hostname: string | null
  email: string | null
  city: string | null
  country: string | null
  /** ms epoch of the last heartbeat (or session start) when known. */
  lastSeen?: number | null
}

export interface ClusterPopoverCtx {
  modes: [string, number][]
  skills: [string, number][]
  sessions: PopoverSession[]
  /** ms epoch for relative times; omitted → no relative time column. */
  now?: number
}

function shortAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function rankList(rows: [string, number][], empty: string): string {
  if (!rows.length) return `<p class="rt-pop-empty">${escapeXml(empty)}</p>`
  return `<ol class="rt-pop-rank">${rows
    .map(([name, n]) => `<li><span class="rt-pop-name">${escapeXml(name)}</span><span class="rt-pop-n">${n}</span></li>`)
    .join('')}</ol>`
}

export function clusterPopoverHtml(cluster: Cluster, ctx: ClusterPopoverCtx): string {
  const label = clusterLabel(cluster)
  const countries = new Set(cluster.members.map((m) => m.country)).size
  const cities = new Set(cluster.members.map((m) => (m.city || '').trim()).filter(Boolean)).size
  const knownSessions = cluster.members.every((m) => m.sessions != null)
  const sessionsTotal = cluster.members.reduce((sum, m) => sum + (m.sessions ?? 0), 0)
  const seatsWord = cluster.count === 1 ? 'seat' : 'seats'
  const sub = knownSessions
    ? `${cluster.count} ${seatsWord} · ${sessionsTotal} ${sessionsTotal === 1 ? 'session' : 'sessions'}`
    : `${cluster.count} ${seatsWord}`
  const tile = (name: string, n: number) => `<div class="rt-pop-tile"><span>${name}</span><b>${n}</b></div>`
  const sessions = ctx.sessions.length
    ? `<ul class="rt-pop-sessions">${ctx.sessions
        .map((s) => {
          const who = s.hostname || s.email || 'Unnamed seat'
          const where = [s.city, s.country ? countryName(s.country) : null].filter(Boolean).join(', ')
          const when = ctx.now != null && s.lastSeen != null ? `<span class="rt-pop-when">${shortAgo(s.lastSeen, ctx.now)}</span>` : ''
          return `<li><span class="rt-pop-who">${escapeXml(who)}</span><span class="rt-pop-where">${escapeXml(where)}</span>${when}</li>`
        })
        .join('')}</ul>`
    : '<p class="rt-pop-empty">No open sessions here right now.</p>'
  return `<div class="rt-pop" data-rt-popover-body>
    <div class="rt-pop-head">
      <div><p class="rt-pop-eyebrow">REALTIME CLUSTER</p><h3 class="rt-pop-title">${escapeXml(label)}</h3><p class="rt-pop-sub">${escapeXml(sub)}</p></div>
      <button type="button" class="rt-pop-close" data-rt-popover-close aria-label="Close">&times;</button>
    </div>
    <div class="rt-pop-tiles">${tile('Locations', cluster.members.length)}${tile('Countries', countries)}${tile('Cities', cities)}</div>
    <div class="rt-pop-cols">
      <section><h4>Top modes</h4>${rankList(ctx.modes, 'No asks here in the last 30 minutes.')}</section>
      <section><h4>Top skills</h4>${rankList(ctx.skills, 'No skills used here in the last 30 minutes.')}</section>
    </div>
    <section><h4>Recent sessions</h4>${sessions}</section>
  </div>`
}

// ---------------------------------------------------------------------------------------
// Overview choropleth (CountryMap.tsx layout, reference opacity scale).
// ---------------------------------------------------------------------------------------

export interface CornerCountry {
  iso: string
  count: number
}

export interface CornerMapOptions {
  countries: CornerCountry[]
}

/** Reference choropleth opacity: 0.2 at the smallest non-zero value, 0.8 at the maximum,
 * linear in between (react-svg-worldmap's default scale). */
export function choroplethOpacity(count: number, max: number): number {
  if (!(max > 0) || !(count > 0)) return 0
  return 0.2 + 0.6 * Math.min(1, count / max)
}

/** 520-wide overview choropleth: data countries `fill="var(--chart-0)"` at choroplethOpacity,
 * no-data countries in the theme's neutral land colour, a native `<title>` tooltip per data
 * country, and invisible focusable hit pins at centroids. */
export function renderCornerMapSvg(options: CornerMapOptions): string {
  const variant: MapVariant = '520'
  const { width, height } = MAP_DIMENSIONS[variant]
  const byIso = new Map(options.countries.filter((c) => c.count > 0).map((c) => [c.iso.toUpperCase(), c.count]))
  const max = Math.max(0, ...byIso.values())
  const land = WORLD_520.map((c) => {
    const iso = c.alpha2 || c.id
    const count = byIso.get(c.alpha2)
    if (count === undefined) {
      return `<path class="world-land" data-iso="${escapeXml(iso)}" d="${c.d}" fill="var(--map-land)" stroke="var(--map-stroke)" stroke-width="0.5" />`
    }
    const title = `${countryName(c.alpha2)} · ${count} ${count === 1 ? 'seat' : 'seats'}`
    return `<path class="world-land has-data" data-iso="${escapeXml(iso)}" data-count="${count}" d="${c.d}" fill="var(--chart-0)" fill-opacity="${choroplethOpacity(count, max).toFixed(3)}" stroke="var(--map-stroke)" stroke-width="0.5"><title>${escapeXml(title)}</title></path>`
  }).join('')
  const pins = [...byIso.entries()]
    .filter(([iso]) => CENTROIDS_520[iso])
    .map(([iso, count]) => {
      const [x, y] = CENTROIDS_520[iso]
      return `<g class="corner-pin" data-pin tabindex="0" data-country="${escapeXml(countryName(iso))}" data-count="${count}" transform="translate(${x} ${y})"><circle r="6" fill="transparent" /></g>`
    })
    .join('')
  return `<svg class="corner-map-svg" data-map-svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Countries by activity">${land}${pins}</svg>`
}

// ---------------------------------------------------------------------------------------
// Legacy country pills (kept exported for existing importers; the realtime map now draws
// cluster pills instead).
// ---------------------------------------------------------------------------------------

export interface CountryPill {
  iso: string
  name: string
  seats: number
  places: number
  x: number
  y: number
}

/** Roll points up by country. Seat totals prefer `countries` rollup when present. */
export function countryPillsFromPoints(
  points: RealtimeMapPoint[],
  countries: { iso: string; devices: number }[] = [],
  variant: MapVariant = '1152'
): CountryPill[] {
  if (!points.length) return []
  const byIso = new Map<string, { seats: number; places: Set<string>; xs: number[]; ys: number[] }>()
  for (const p of points) {
    const iso = (p.country || '').toUpperCase()
    if (!iso) continue
    const [x, y] = projectPoint(p.lat, p.lon, variant)
    const key = `${(p.city || '').trim().toLowerCase()}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`
    const prev = byIso.get(iso)
    if (prev) {
      prev.seats += p.count
      prev.places.add(key)
      prev.xs.push(x)
      prev.ys.push(y)
    } else {
      byIso.set(iso, { seats: p.count, places: new Set([key]), xs: [x], ys: [y] })
    }
  }
  const deviceByIso = new Map(countries.map((c) => [c.iso.toUpperCase(), c.devices]))
  const centroids = variant === '1152' ? CENTROIDS_1152 : CENTROIDS_520
  return [...byIso.entries()]
    .map(([iso, agg]) => {
      const centroid = centroids[iso]
      return {
        iso,
        name: countryName(iso),
        seats: deviceByIso.get(iso) ?? agg.seats,
        places: agg.places.size,
        x: centroid ? centroid[0] : agg.xs.reduce((a, b) => a + b, 0) / agg.xs.length,
        y: centroid ? centroid[1] : agg.ys.reduce((a, b) => a + b, 0) / agg.ys.length
      }
    })
    .sort((a, b) => b.seats - a.seats)
}

export { CENTROIDS_1152, CENTROIDS_520, WORLD_1152, WORLD_520 }
