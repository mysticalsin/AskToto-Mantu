import { WORLD_PATHS } from './world-paths'
import { stripMapBands } from './map-bands'
import type { MapCountry, MapDot, MixBar, SeriesPoint, TokenPoint } from './dashboard'

const MONO = ['#2a2a2e', '#3f3f46', '#71717a', '#a1a1aa', '#e4e4e7']

export function sparklineArea(values: number[], w = 220, h = 56): string {
  if (!values.length || values.every((v) => v === 0)) {
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h - 2}" x2="${w}" y2="${h - 2}" stroke="var(--hair)" /></svg>`
  }
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`)
  const d = `M0,${h} L${pts.join(' L')} L${w},${h} Z`
  const line = `M${pts.join(' L')}`
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="url(#spark-fill)" />
    <path d="${line}" fill="none" stroke="var(--chart-4)" stroke-width="1.5" />
  </svg>`
}

export function sparklineLine(values: number[], w = 220, h = 56): string {
  if (!values.length || values.every((v) => v === 0)) {
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="var(--hair)" /></svg>`
  }
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 6) - 3).toFixed(1)}`)
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="M${pts.join(' L')}" fill="none" stroke="var(--chart-4)" stroke-width="1.6" />
  </svg>`
}

export function dualLine(series: SeriesPoint[], w = 520, h = 140): string {
  const hb = series.map((s) => s.heartbeats)
  const asks = series.map((s) => s.asks)
  if (!series.length || (hb.every((v) => v === 0) && asks.every((v) => v === 0))) {
    return `<div class="empty">No heartbeats or Asks in this window.</div>`
  }
  const max = Math.max(...hb, ...asks, 1)
  const step = series.length > 1 ? w / (series.length - 1) : w
  const path = (vals: number[]): string =>
    vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 18 - (v / max) * (h - 28)).toFixed(1)}`).join(' L')
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="M${path(hb)}" fill="none" stroke="var(--chart-5)" stroke-width="1.6" />
    <path d="M${path(asks)}" fill="none" stroke="var(--accent)" stroke-width="1.4" />
  </svg>`
}

function layerPath(vals: number[], w: number, h: number, max: number): string {
  const step = vals.length > 1 ? w / (vals.length - 1) : w
  const top = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 8 - (v / max) * (h - 16)).toFixed(1)}`)
  return `M0,${h} L${top.join(' L')} L${w},${h} Z`
}

export function stackedTokens(tokens: TokenPoint[], w = 520, h = 140): string {
  if (!tokens.length || tokens.every((t) => t.read + t.write + t.uncached === 0)) {
    return `<div class="empty">No cache token fields reported in this window.</div>`
  }
  const max = Math.max(...tokens.map((t) => t.read + t.write + t.uncached), 1)
  const read = tokens.map((t) => t.read)
  const write = tokens.map((t) => t.read + t.write)
  const all = tokens.map((t) => t.read + t.write + t.uncached)
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${layerPath(all, w, h, max)}" fill="var(--chart-2)" />
    <path d="${layerPath(write, w, h, max)}" fill="var(--chart-3)" />
    <path d="${layerPath(read, w, h, max)}" fill="var(--chart-5)" />
  </svg>`
}

export function bars(items: MixBar[], w = 520, h = 140): string {
  if (!items.length) return `<div class="empty">No seats in the field yet.</div>`
  const max = Math.max(...items.map((i) => i.value), 1)
  const gap = 8
  const bw = Math.min(28, Math.max(8, (w - gap * (items.length + 1)) / items.length))
  const rects = items
    .slice(0, 12)
    .map((it, i) => {
      const bh = Math.max(2, (it.value / max) * (h - 28))
      const x = gap + i * (bw + gap)
      const y = h - 18 - bh
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--chart-4)" />
        <text x="${(x + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" class="tick">${escapeXml(it.label)}</text>`
    })
    .join('')
  return `<svg class="chart" viewBox="0 0 ${w} ${h}">${rects}</svg>`
}

export function heatmapGrid(values: number[]): string {
  const cells = values.length ? values : Array.from({ length: 17 * 7 }, () => 0)
  const max = Math.max(...cells, 0)
  const cols = 17
  const rows = 7
  const size = 11
  const gap = 3
  const w = cols * (size + gap)
  const h = rows * (size + gap)
  let out = `<svg class="heat" viewBox="0 0 ${w} ${h}">`
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const v = cells[c * rows + r] ?? 0
      const step = max === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4))
      const fill = max === 0 ? 'var(--chart-1)' : MONO[step]
      out += `<rect x="${c * (size + gap)}" y="${r * (size + gap)}" width="${size}" height="${size}" rx="2" fill="${fill}" />`
    }
  }
  out += '</svg>'
  return out
}

function project(lat: number, lon: number): { x: number; y: number } {
  return { x: ((lon + 180) / 360) * 1000, y: ((90 - lat) / 180) * 500 }
}

function scaleColor(devices: number, max: number): string {
  if (max <= 0 || devices <= 0) return 'var(--land)'
  const step = Math.min(4, Math.max(1, Math.ceil((devices / max) * 4)))
  return MONO[step]
}

export function choropleth(
  countries: MapCountry[],
  dots: MapDot[],
  variant: 'land' | 'analytics' | 'graticule' | 'hatch'
): string {
  const by = new Map(countries.map((c) => [c.iso, c.devices]))
  const max = Math.max(0, ...countries.map((c) => c.devices))
  const empty = countries.length === 0 && dots.length === 0
  let land = ''
  for (const [iso, d] of Object.entries(WORLD_PATHS)) {
    const n = by.get(iso) ?? 0
    const fill =
      empty || variant === 'land'
        ? 'var(--land)'
        : variant === 'hatch' && n > 0
          ? `url(#hatch-${Math.min(4, Math.max(1, Math.ceil((n / Math.max(max, 1)) * 4)))})`
          : scaleColor(n, max)
    land += `<path data-iso="${iso}" d="${stripMapBands(d)}" fill="${fill}" />`
  }
  let grid = ''
  if (variant === 'graticule') {
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = ((lon + 180) / 360) * 1000
      grid += `<line x1="${x}" y1="0" x2="${x}" y2="500" class="grat" />`
    }
    for (let lat = -60; lat <= 80; lat += 30) {
      const y = ((90 - lat) / 180) * 500
      grid += `<line x1="0" y1="${y}" x2="1000" y2="${y}" class="grat" />`
    }
  }
  const marks = empty
    ? ''
    : dots
        .map((dot) => {
          const p = project(dot.lat, dot.lon)
          return `<circle class="dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" />`
        })
        .join('')
  const caption = empty
    ? `<div class="empty map-empty">No heartbeats yet. The map stays empty until a seat checks in.</div>`
    : ''
  return `${caption}<svg class="world" viewBox="0 0 1000 500" role="img" aria-label="Unique devices by country">
    <defs>
      <pattern id="hatch-1" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--chart-3)" stroke-width="1"/></pattern>
      <pattern id="hatch-2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--chart-4)" stroke-width="1"/></pattern>
      <pattern id="hatch-3" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-5)" stroke-width="1.2"/></pattern>
      <pattern id="hatch-4" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="#fff" stroke-width="1.2"/></pattern>
    </defs>
    ${grid}${land}${marks}
  </svg>`
}

const SHOEY_BLUE = '#2563EB'
/** OpenPanel Shoey realtime land. Must stay this literal so curl /assets proof can see it. */
export const SHOEY_LAND = '#E5E7EB'
const SHOEY_OCEAN = '#FFFFFF'
const SHOEY_LAND_STROKE = '#6B7280'
const SHOEY_DOT = '#111827'
const SHOEY_PILL = '#10B981'

export function blueBars(values: number[], w = 220, h = 36): string {
  if (!values.length || values.every((v) => v === 0)) {
    return `<svg class="spark bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h - 2}" x2="${w}" y2="${h - 2}" stroke="#EDEDED" /></svg>`
  }
  const max = Math.max(...values, 1)
  const gap = 1.5
  const n = values.length
  const bw = Math.max(1.5, (w - gap * (n + 1)) / n)
  const rects = values
    .map((v, i) => {
      if (v <= 0) return ''
      const bh = Math.max(2.4, (v / max) * (h - 4))
      const x = gap + i * (bw + gap)
      return `<rect x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${SHOEY_BLUE}" rx="0.6" />`
    })
    .join('')
  return `<svg class="spark bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${rects}</svg>`
}

export function blueArea(
  values: number[],
  labels: string[] = [],
  w = 860,
  h = 220
): string {
  if (!values.length || values.every((v) => v === 0)) {
    return `<div class="empty">No seats in this window.</div>`
  }
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 28 - (v / max) * (h - 40)).toFixed(1)}`)
  const fill = `M0,${h - 24} L${pts.join(' L')} L${w},${h - 24} Z`
  const ticks = labels
    .map((lab, i) => {
      if (!lab) return ''
      const x = i * step
      return `<text x="${x.toFixed(1)}" y="${h - 8}" class="tick" text-anchor="${i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}">${escapeXml(lab)}</text>`
    })
    .join('')
  const yMax = max >= 1000 ? `${Math.round(max / 1000)}k` : String(Math.round(max))
  return `<svg class="chart area" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <text x="8" y="14" class="tick">${escapeXml(yMax)}</text>
    <text x="8" y="${h - 30}" class="tick">0</text>
    <path d="${fill}" fill="url(#shoey-fill)" />
    <path d="M${pts.join(' L')}" fill="none" stroke="${SHOEY_BLUE}" stroke-width="1.6" />
    ${ticks}
  </svg>`
}

type Region = { id: string; x: number; y: number; isos: string[] }

const REGIONS: Region[] = [
  { id: 'na', x: 200, y: 130, isos: ['US', 'CA', 'MX', 'GT', 'BZ', 'HN', 'SV', 'NI', 'CR', 'PA', 'CU', 'HT', 'DO', 'JM', 'PR'] },
  { id: 'sa', x: 300, y: 340, isos: ['BR', 'AR', 'CL', 'PE', 'CO', 'VE', 'EC', 'BO', 'PY', 'UY', 'GY', 'SR'] },
  { id: 'eu', x: 520, y: 115, isos: ['GB', 'IE', 'FR', 'DE', 'ES', 'PT', 'IT', 'NL', 'BE', 'CH', 'AT', 'PL', 'SE', 'NO', 'FI', 'DK', 'CZ', 'HU', 'RO', 'GR', 'UA', 'RU'] },
  { id: 'af', x: 530, y: 270, isos: ['MA', 'DZ', 'TN', 'EG', 'LY', 'SD', 'NG', 'GH', 'CI', 'SN', 'KE', 'ET', 'TZ', 'UG', 'ZA', 'AO', 'CD', 'CM'] },
  { id: 'as', x: 760, y: 155, isos: ['TR', 'SA', 'AE', 'IL', 'IQ', 'IR', 'IN', 'PK', 'BD', 'CN', 'JP', 'KR', 'TW', 'HK', 'TH', 'VN', 'ID', 'MY', 'PH', 'SG', 'MN'] },
  { id: 'oc', x: 870, y: 380, isos: ['AU', 'NZ', 'PG', 'FJ'] }
]

/** Bklit stat-card-choropleth-01 chrome. Intensity by seat count. No sample dots. */
export function choroplethMini(countries: MapCountry[], cls = 'stat-choro'): string {
  const by = new Map(countries.map((c) => [c.iso, c.devices]))
  const max = Math.max(1, ...countries.map((c) => c.devices))
  let land = ''
  for (const [iso, d] of Object.entries(WORLD_PATHS)) {
    const n = by.get(iso) ?? 0
    const fill = n ? `rgba(37,99,235,${(0.2 + (n / max) * 0.7).toFixed(2)})` : '#F3F4F6'
    land += `<path data-iso="${iso}" d="${stripMapBands(d)}" fill="${fill}" stroke="#F5F5F5" stroke-width="0.35" />`
  }
  return `<svg class="${cls}" viewBox="0 0 1000 500" role="img" aria-label="Countries">
    <rect width="1000" height="500" fill="#F8F8F8"/>
    ${land}
  </svg>`
}

/** Ocean + every Natural Earth country. Inlined into #map-root HTML. paintShoeyMap only restyles theme. */
export function shoeyLandSvg(cls = 'world shoey-world'): string {
  let land = ''
  for (const [iso, d] of Object.entries(WORLD_PATHS)) {
    const painted = stripMapBands(d)
    if (!painted) continue
    land += `<path class="world-land" data-iso="${iso}" d="${painted}" fill="${SHOEY_LAND}" stroke="${SHOEY_LAND_STROKE}" stroke-width="1.15" />`
  }
  return `<svg class="${cls}" viewBox="0 0 1000 500" width="1000" height="500" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Unique seats by country" data-land="${SHOEY_LAND}">
    <rect class="world-ocean" width="1000" height="500" fill="${SHOEY_OCEAN}"/>
    ${land}
  </svg>`
}

export const SHOEY_LAND_SVG = shoeyLandSvg()

export function shoeyWorld(countries: MapCountry[], dots: MapDot[], cls = 'world shoey-world'): string {
  const by = new Map(countries.map((c) => [c.iso, c.devices]))
  const empty = countries.length === 0 && dots.length === 0
  const marks = empty
    ? ''
    : dots
        .map((dot) => {
          const p = project(dot.lat, dot.lon)
          return `<circle class="seat-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.2" fill="${SHOEY_DOT}" stroke="#fff" stroke-width="1.2" />`
        })
        .join('')
  const pills = empty
    ? ''
    : REGIONS.map((reg) => {
        const present = reg.isos.filter((iso) => (by.get(iso) ?? 0) > 0)
        const seats = present.reduce((n, iso) => n + (by.get(iso) ?? 0), 0)
        if (!seats) return ''
        const label = present.length === 1 ? countryName(present[0]) : `${present.length} countries`
        const w = Math.max(96, 36 + label.length * 6.4)
        return `<g class="pill-g" transform="translate(${reg.x},${reg.y})">
          <rect x="0" y="-13" width="${w}" height="26" rx="13" fill="#fff" stroke="#E5E5E5"/>
          <circle cx="12" cy="0" r="4" fill="${SHOEY_PILL}"/>
          <text x="22" y="4" font-size="11" font-weight="650" fill="#18181B">${seats}</text>
          <line x1="42" y1="-7" x2="42" y2="7" stroke="#E5E5E5"/>
          <text x="48" y="4" font-size="11" fill="#71717A">${escapeXml(label)}</text>
        </g>`
      }).join('')
  const caption = empty
    ? `<div class="empty map-empty">No heartbeats yet. The map stays empty until a seat checks in. Empty is an empty world, not sample dots.</div>`
    : ''
  const svg = shoeyLandSvg(cls).replace('</svg>', `${marks}${pills}</svg>`)
  return `${caption}${svg}`
}

function countryName(iso: string): string {
  const names: Record<string, string> = {
    US: 'United States',
    CA: 'Canada',
    BR: 'Brazil',
    GB: 'United Kingdom',
    FR: 'France',
    DE: 'Germany',
    AU: 'Australia',
    JP: 'Japan',
    IN: 'India'
  }
  return names[iso] || iso
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
