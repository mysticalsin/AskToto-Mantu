import { describe, expect, it } from 'vitest'
import {
  choroplethOpacity,
  CLUSTER_RADIUS_PX,
  clusterLabel,
  clusterPins,
  clusterPlaces,
  clusterPopoverHtml,
  countryName,
  countryPillsFromPoints,
  DEFAULT_CLUSTER_OPTIONS,
  MAP_DIMENSIONS,
  pillClusters,
  placeKey,
  placeToPoint,
  projectPoint,
  renderClusterLayer,
  renderCornerMapSvg,
  renderPinLayer,
  renderRealtimeMapSvg,
  zoomBucket,
  type Cluster,
  type ClusterPoint,
  type RealtimeMapPoint
} from './map'

/**
 * First 40 points of the reference's own fixture (WorldMap.tsx / data.ts `coordinates`),
 * copied verbatim from demo-shoey-realtime-0cafe50e/data.ts so the clustering test
 * reproduces the reference's real outcome, not a hand-picked one.
 */
const REFERENCE_COORDINATES: { country: string; city: string; long: number; lat: number; count: number }[] = [
  { country: 'BR', city: 'São Paulo', long: -46.6361, lat: -23.5475, count: 7 },
  { country: 'KR', city: 'Gangseo-gu', long: 126.853, lat: 37.5699, count: 4 },
  { country: 'BR', city: 'São Paulo', long: -46.6351, lat: -23.6293, count: 3 },
  { country: 'KR', city: 'Seocho-gu', long: 127.0013, lat: 37.5015, count: 3 },
  { country: 'BR', city: 'Blumenau', long: -49.0969, lat: -26.8766, count: 3 },
  { country: 'BR', city: 'Brasília', long: -47.9331, lat: -15.7798, count: 2 },
  { country: 'BR', city: 'Silveiras', long: -44.8528, lat: -22.6644, count: 2 },
  { country: 'BR', city: 'Brusque', long: -48.8997, lat: -27.1147, count: 2 },
  { country: 'BR', city: 'Maringá', long: -51.9576, lat: -23.3836, count: 2 },
  { country: 'BR', city: 'Criciúma', long: -49.3686, lat: -28.6752, count: 2 },
  { country: 'BR', city: 'João Pessoa', long: -34.8617, lat: -7.1712, count: 2 },
  { country: 'BR', city: 'Porto Alegre', long: -51.168, lat: -30.1188, count: 2 },
  { country: 'BR', city: 'Rio de Janeiro', long: -43.0811, lat: -22.9201, count: 2 },
  { country: 'JP', city: 'Tokyo', long: 139.6805, lat: 35.6837, count: 2 },
  { country: 'BR', city: 'Sorocaba', long: -47.4425, lat: -23.4736, count: 2 },
  { country: 'ID', city: 'Bekasi', long: 106.9835, lat: -6.2808, count: 2 },
  { country: 'ID', city: 'Sleman', long: 110.3891, lat: -7.7294, count: 2 },
  { country: 'ZA', city: 'Cape Town', long: 18.4259, lat: -33.9258, count: 2 },
  { country: 'US', city: 'Orlando', long: -81.4317, lat: 28.6225, count: 2 },
  { country: 'BR', city: '', long: -43.2192, lat: -22.8305, count: 2 },
  { country: 'US', city: 'New York', long: -74.0066, lat: 40.7126, count: 1 },
  { country: 'CZ', city: '', long: 14.4112, lat: 50.0848, count: 1 },
  { country: 'BR', city: 'Tianguá', long: -40.9925, lat: -3.6734, count: 1 },
  { country: 'BR', city: 'Criciúma', long: -49.3871, lat: -28.7203, count: 1 },
  { country: 'FR', city: '', long: 2.3387, lat: 48.8582, count: 1 },
  { country: 'US', city: 'New York', long: -73.9712, lat: 40.7428, count: 1 },
  { country: 'DE', city: 'Gera', long: 12.0979, lat: 50.8875, count: 1 },
  { country: 'GB', city: 'Manchester', long: -2.2374, lat: 53.4809, count: 1 },
  { country: 'US', city: '', long: -97.822, lat: 37.751, count: 1 },
  { country: 'BR', city: 'Penápolis', long: -50.0816, lat: -21.4269, count: 1 },
  { country: 'RU', city: 'Moscow', long: 37.6187, lat: 55.7487, count: 1 },
  { country: 'NL', city: '', long: 4.4813, lat: 51.9235, count: 1 },
  { country: 'BR', city: 'Tietê', long: -47.7147, lat: -23.1019, count: 1 },
  { country: 'TR', city: 'Adana', long: 35.3345, lat: 36.9874, count: 1 },
  { country: 'CH', city: 'Bern', long: 7.4584, lat: 46.9698, count: 1 },
  { country: 'BR', city: 'Porto Belo', long: -48.5999, lat: -27.1562, count: 1 },
  { country: 'DE', city: 'Mühlheim am Main', long: 8.8256, lat: 50.1069, count: 1 },
  { country: 'US', city: 'Ashburn', long: -77.4903, lat: 39.0469, count: 1 },
  { country: 'KR', city: 'Buk-gu', long: 126.8876, lat: 35.2118, count: 1 },
  { country: 'CY', city: 'Limassol', long: 33.0366, lat: 34.6874, count: 1 }
]

function toClusterPoints(): ClusterPoint[] {
  return REFERENCE_COORDINATES.map((c) => {
    const [x, y] = projectPoint(c.lat, c.long, '1152')
    return { country: c.country, city: c.city, count: c.count, x, y }
  })
}

describe('clusterPins reproduces the reference outcome on its own fixture', () => {
  it('clusters the first 40 reference coordinates into 16 clusters (radius 22px)', () => {
    const { clusters, badgeClusters } = clusterPins(toClusterPoints(), DEFAULT_CLUSTER_OPTIONS)
    expect(clusters.length).toBe(16)
    expect(badgeClusters.length).toBe(6)
  })

  it('the busiest cluster is 14 Brazilian points totalling 31 events, labelled "Brazil, 14 cities"', () => {
    const { clusters } = clusterPins(toClusterPoints(), DEFAULT_CLUSTER_OPTIONS)
    const top = [...clusters].sort((a, b) => b.count - a.count)[0]
    expect(top.count).toBe(31)
    expect(top.members.length).toBe(14)
    expect(clusterLabel(top)).toBe('Brazil, 14 cities')
  })
})

describe('clusterLabel', () => {
  function cluster(members: ClusterPoint[]): Cluster {
    return { x: 0, y: 0, count: members.reduce((n, m) => n + m.count, 0), members }
  }

  it('a single member with a city uses the city name', () => {
    const c = cluster([{ country: 'CA', city: 'Longueuil', count: 1, x: 0, y: 0 }])
    expect(clusterLabel(c)).toBe('Longueuil')
  })

  it('a single member with no city falls back to the country name', () => {
    const c = cluster([{ country: 'CA', city: '', count: 1, x: 0, y: 0 }])
    expect(clusterLabel(c)).toBe('Canada')
  })

  it('several members in one country: "Canada, 3 cities"', () => {
    const c = cluster([
      { country: 'CA', city: 'Longueuil', count: 1, x: 0, y: 0 },
      { country: 'CA', city: 'Montreal', count: 1, x: 1, y: 1 },
      { country: 'CA', city: '', count: 1, x: 2, y: 2 }
    ])
    expect(clusterLabel(c)).toBe('Canada, 3 cities')
  })

  it('members across several countries: "5 countries" (distinct countries, not places)', () => {
    const c = cluster([
      { country: 'CA', city: 'Longueuil', count: 1, x: 0, y: 0 },
      { country: 'US', city: 'Ashburn', count: 1, x: 1, y: 1 },
      { country: 'FR', city: '', count: 1, x: 2, y: 2 },
      { country: 'DE', city: 'Gera', count: 1, x: 3, y: 3 },
      { country: 'JP', city: 'Tokyo', count: 1, x: 4, y: 4 }
    ])
    expect(clusterLabel(c)).toBe('5 countries')
  })

  it('counts distinct countries, not members, across countries: 3 places in 2 countries → "2 countries"', () => {
    const c = cluster([
      { country: 'CA', city: 'Longueuil', count: 1, x: 0, y: 0 },
      { country: 'CA', city: 'Montreal', count: 1, x: 1, y: 1 },
      { country: 'US', city: 'Ashburn', count: 1, x: 2, y: 2 }
    ])
    expect(clusterLabel(c)).toBe('2 countries')
  })
})

describe('countryName', () => {
  it('resolves known alpha-2 codes to English names', () => {
    expect(countryName('CA')).toBe('Canada')
    expect(countryName('US')).toBe('United States')
    expect(countryName('BR')).toBe('Brazil')
  })

  it('falls back to the code itself for an unknown or empty code, never throws', () => {
    expect(() => countryName('ZZ')).not.toThrow()
    expect(countryName('')).toBe('')
  })
})

const LONGUEUIL: RealtimeMapPoint = { country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 }
const MONTREAL: RealtimeMapPoint = { country: 'CA', city: 'Montreal', lat: 45.5, lon: -73.57, count: 6 }
const ASHBURN: RealtimeMapPoint = { country: 'US', city: 'Ashburn', lat: 39.05, lon: -77.49, count: 3 }
const TOKYO: RealtimeMapPoint = { country: 'JP', city: 'Tokyo', lat: 35.68, lon: 139.68, count: 2 }

describe('renderRealtimeMapSvg', () => {
  it('renders land only, no pins, no pills and an honest empty caption when there are no points', () => {
    const svg = renderRealtimeMapSvg({ points: [] })
    expect(svg).toContain('No heartbeats yet. The map stays empty until a seat checks in. Empty is an empty world, not sample dots.')
    expect(svg).not.toContain('data-pin ')
    expect(svg).not.toContain('data-cluster=')
    expect(svg).toContain('data-iso=')
    expect(svg).toContain('viewBox="0 0 1152 642"')
  })

  it('takes a caller-supplied empty caption verbatim', () => {
    const svg = renderRealtimeMapSvg({ points: [], emptyCaption: 'No seat in the last 30 minutes. Not sample dots.' })
    expect(svg).toContain('>No seat in the last 30 minutes. Not sample dots.<')
  })

  it('never fakes a dot: exactly one pin per supplied point, no more', () => {
    const svg = renderRealtimeMapSvg({ points: [LONGUEUIL, ASHBURN] })
    expect((svg.match(/class="rt-pin"/g) || []).length).toBe(2)
    expect(svg).not.toContain('class="empty')
  })

  it('every place is one r=3 dot with a halo group, the seat count in data-seats, and no per-pin text label', () => {
    const svg = renderRealtimeMapSvg({ points: [LONGUEUIL, { ...ASHBURN, count: 4 }] })
    expect(svg).toMatch(/data-seats="1"[^>]*><g class="rt-pin-inner" data-pin-inner><g class="rt-pin-halo" aria-hidden="true"><circle r="3" \/><\/g><circle class="rt-pin-dot" r="3" \/>/)
    expect(svg).toMatch(/data-seats="4"[^>]*><g class="rt-pin-inner" data-pin-inner><g class="rt-pin-halo" aria-hidden="true"><circle r="3" \/><\/g><circle class="rt-pin-dot" r="3" \/>/)
    expect(svg).not.toContain('<text')
    expect(svg).not.toContain('rt-pin-label')
  })

  it('carries tooltip/popover data: place key, country name, iso, city, seats, and asks when known', () => {
    const svg = renderRealtimeMapSvg({ points: [{ ...LONGUEUIL, count: 2, asks: 5 }] })
    expect(svg).toContain('data-place="CA|Longueuil|45.53|-73.52"')
    expect(svg).toContain('data-country="Canada"')
    expect(svg).toContain('data-iso="CA"')
    expect(svg).toContain('data-city="Longueuil"')
    expect(svg).toContain('data-seats="2"')
    expect(svg).toContain('data-asks="5"')
    expect(svg).toContain('aria-label="Longueuil, Canada · 2 seats"')
  })

  it('omits data-asks and data-sessions entirely when unknown (never a fabricated 0)', () => {
    const svg = renderRealtimeMapSvg({ points: [LONGUEUIL] })
    expect(svg).not.toContain('data-asks')
    expect(svg).not.toContain('data-sessions')
  })

  it('renders zoom/pan controls, a viewport group, and separately swappable pin and cluster layers', () => {
    const svg = renderRealtimeMapSvg({ points: [LONGUEUIL] })
    expect(svg).toContain('data-zoom-in')
    expect(svg).toContain('data-zoom-out')
    expect(svg).toContain('data-viewport')
    expect(svg).toContain('<g class="rt-pin-layer" data-pin-layer>')
    expect(svg).toContain('<g class="rt-cluster-layer" data-cluster-layer data-zoom-bucket="1">')
  })

  it('uses theme tokens only: no hex colour, no inline <style>, no style= attribute, no grid', () => {
    const svg = renderRealtimeMapSvg({ points: [LONGUEUIL, MONTREAL, ASHBURN, TOKYO] })
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(svg).not.toContain('<style')
    expect(svg).not.toContain('style="')
    expect(svg).not.toContain('rt-map-grid')
    expect(svg).toContain('fill="var(--map-ocean)"')
    expect(svg).toMatch(/<path class="world-land" data-iso="CA" d="[^"]+" fill="var\(--map-land\)" stroke="var\(--map-stroke\)" stroke-width="0.5" vector-effect="non-scaling-stroke" \/>/)
  })

  it('never draws Antarctica', () => {
    expect(renderRealtimeMapSvg({ points: [] })).not.toContain('data-iso="AQ"')
  })
})

describe('clusterPlaces / pills', () => {
  it('groups nearby places at zoom 1 and splits them again once zoomed in', () => {
    // Longueuil and Montreal are ~6 km apart: one cluster at every zoom this map allows.
    // Ashburn (~800 km from Montreal) is ~22 px away at zoom 1 (inside the 36 px radius) and
    // ~7 px * 3 = 66 px apart at zoom 3 (outside 36/3 = 12 px): split.
    const points = [LONGUEUIL, MONTREAL, ASHBURN]
    const z1 = clusterPlaces(points, 1)
    const z3 = clusterPlaces(points, 3)
    expect(z1.length).toBe(1)
    expect(z1[0].count).toBe(10)
    expect(clusterLabel(z1[0])).toBe('2 countries')
    expect(z3.length).toBe(2)
    expect(z3.map(clusterLabel).sort()).toEqual(['Ashburn', 'Canada, 2 cities'])
  })

  it('uses a 36 px screen radius divided by the zoom factor', () => {
    expect(CLUSTER_RADIUS_PX).toBe(36)
    const [ax, ay] = projectPoint(MONTREAL.lat, MONTREAL.lon, '1152')
    const [bx, by] = projectPoint(ASHBURN.lat, ASHBURN.lon, '1152')
    const d = Math.hypot(ax - bx, ay - by)
    expect(d).toBeLessThan(36)
    expect(d).toBeGreaterThan(36 / 3)
  })

  it('renders one pill per multi-place cluster with the reference anatomy', () => {
    const layer = renderClusterLayer([LONGUEUIL, MONTREAL, TOKYO], 1)
    expect(layer).toContain('data-cluster-count="7"')
    expect(layer).toContain('data-cluster-members="2"')
    expect(layer).toContain('<span class="rt-pill-dot" aria-hidden="true"></span><span class="rt-pill-count">7</span><span class="rt-pill-sep" aria-hidden="true"></span><span class="rt-pill-label">Canada, 2 cities</span>')
    expect(layer).toContain('aria-label="Canada, 2 cities, 7 seats"')
    expect(layer).toContain('data-cluster-keys="[&quot;CA|Longueuil|45.53|-73.52&quot;,&quot;CA|Montreal|45.50|-73.57&quot;]"')
    // Tokyo is a single place, but one of the busiest, so it gets a pill too.
    expect(layer).toContain('<span class="rt-pill-label">Tokyo</span>')
  })

  it('pill layer is counter-scaled (data-pin-inner) so pills keep a constant screen size', () => {
    const layer = renderClusterLayer([LONGUEUIL, MONTREAL], 1)
    expect(layer).toMatch(/<g class="rt-cluster" [^>]*><g class="rt-cluster-inner" data-pin-inner><foreignObject x="-110" y="-40" width="220" height="32">/)
  })

  it('caps single-place pills at the 12 busiest and never overlaps two pills on screen', () => {
    // 20 single places spread across the world, far enough apart never to cluster.
    const spread: RealtimeMapPoint[] = Array.from({ length: 20 }, (_, i) => ({
      country: 'BR',
      city: `City ${i}`,
      lat: -30 + (i % 5) * 12,
      lon: -170 + i * 17,
      count: 20 - i
    }))
    const clusters = clusterPlaces(spread, 1)
    expect(clusters.length).toBe(20)
    const pills = pillClusters(clusters, 1)
    expect(pills.length).toBeLessThanOrEqual(12)
    expect(pills[0].count).toBe(20)
    for (let i = 0; i < pills.length; i++) {
      for (let j = i + 1; j < pills.length; j++) {
        const dx = Math.abs(pills[i].x - pills[j].x)
        const dy = Math.abs(pills[i].y - pills[j].y)
        expect(dx >= 150 || dy >= 30, `pills ${i} and ${j} overlap`).toBe(true)
      }
    }
  })

  it('zoom buckets change only at 1.25 / 1.9 / 2.7', () => {
    expect([1, 1.2, 1.3, 1.8, 2, 2.6, 2.8, 8].map(zoomBucket)).toEqual([1, 1, 1.5, 1.5, 2.25, 2.25, 3, 3])
  })

  it('renderPinLayer draws exactly the supplied places', () => {
    const layer = renderPinLayer([LONGUEUIL, MONTREAL, ASHBURN])
    expect((layer.match(/class="rt-pin"/g) || []).length).toBe(3)
  })
})

describe('placeToPoint / placeKey', () => {
  it('maps a live.json place onto a map point with the shared key format', () => {
    const place = { iso2: 'ca', country: 'Canada', region: 'Quebec', city: 'Longueuil', lat: 45.531, lon: -73.518, seats: 3, sessions: 2 }
    const point = placeToPoint(place)
    expect(point).toEqual({
      country: 'CA',
      city: 'Longueuil',
      lat: 45.531,
      lon: -73.518,
      count: 3,
      iso2: 'CA',
      region: 'Quebec',
      sessions: 2,
      placeKey: 'CA|Longueuil|45.53|-73.52'
    })
    expect(placeKey({ iso2: 'CA', city: null, lat: 1, lon: 2 })).toBe('CA||1.00|2.00')
    expect(renderPinLayer([point])).toContain('data-sessions="2"')
  })
})

describe('clusterPopoverHtml', () => {
  const [cluster] = clusterPlaces(
    [
      { ...LONGUEUIL, sessions: 1, placeKey: 'CA|Longueuil|45.53|-73.52' },
      { ...MONTREAL, sessions: 2, placeKey: 'CA|Montreal|45.50|-73.57' }
    ],
    1
  )

  it('renders the reference sections with real numbers', () => {
    const html = clusterPopoverHtml(cluster, {
      modes: [['interview', 4], ['sales', 1]],
      skills: [['Draft recruiting', 2]],
      sessions: [{ hostname: 'tony-mbp', email: null, city: 'Montreal', country: 'CA', lastSeen: 1_000_000 - 120_000 }],
      now: 1_000_000
    })
    expect(html).toContain('>REALTIME CLUSTER<')
    expect(html).toContain('<h3 class="rt-pop-title">Canada, 2 cities</h3>')
    expect(html).toContain('<p class="rt-pop-sub">7 seats · 3 sessions</p>')
    expect(html).toContain('<div class="rt-pop-tile"><span>Locations</span><b>2</b></div><div class="rt-pop-tile"><span>Countries</span><b>1</b></div><div class="rt-pop-tile"><span>Cities</span><b>2</b></div>')
    expect(html).toContain('<li><span class="rt-pop-name">interview</span><span class="rt-pop-n">4</span></li>')
    expect(html).toContain('<li><span class="rt-pop-name">Draft recruiting</span><span class="rt-pop-n">2</span></li>')
    expect(html).toContain('<span class="rt-pop-who">tony-mbp</span><span class="rt-pop-where">Montreal, Canada</span><span class="rt-pop-when">2m ago</span>')
    expect(html).toContain('data-rt-popover-close')
  })

  it('says so honestly when there is nothing to show, and omits sessions count when unknown', () => {
    const [bare] = clusterPlaces([LONGUEUIL, MONTREAL], 1)
    const html = clusterPopoverHtml(bare, { modes: [], skills: [], sessions: [] })
    expect(html).toContain('No asks here in the last 30 minutes.')
    expect(html).toContain('No skills used here in the last 30 minutes.')
    expect(html).toContain('No open sessions here right now.')
    expect(html).toContain('<p class="rt-pop-sub">7 seats</p>')
  })

  it('escapes names', () => {
    const html = clusterPopoverHtml(cluster, { modes: [['<b>x</b>', 1]], skills: [], sessions: [] })
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })
})

describe('renderCornerMapSvg', () => {
  it('renders the 520x292 choropleth: --chart-0 fill with the reference 0.2 → 0.8 linear opacity', () => {
    const svg = renderCornerMapSvg({
      countries: [
        { iso: 'CA', count: 4 },
        { iso: 'US', count: 1 }
      ]
    })
    expect(svg).toContain('viewBox="0 0 520 292"')
    expect(svg).toMatch(/<path class="world-land has-data" data-iso="CA" data-count="4" d="[^"]+" fill="var\(--chart-0\)" fill-opacity="0.800" stroke="var\(--map-stroke\)" stroke-width="0.5"><title>Canada · 4 seats<\/title><\/path>/)
    expect(svg).toMatch(/<path class="world-land has-data" data-iso="US" data-count="1" d="[^"]+" fill="var\(--chart-0\)" fill-opacity="0.350" stroke="var\(--map-stroke\)" stroke-width="0.5"><title>United States · 1 seat<\/title><\/path>/)
  })

  it('choroplethOpacity is linear from 0.2 to 0.8 and 0 for no data', () => {
    expect(choroplethOpacity(0, 10)).toBe(0)
    expect(choroplethOpacity(10, 10)).toBeCloseTo(0.8, 10)
    expect(choroplethOpacity(5, 10)).toBeCloseTo(0.5, 10)
    expect(choroplethOpacity(1, 0)).toBe(0)
  })

  it('countries with no data use the current theme land colour, not a fabricated activity colour', () => {
    const svg = renderCornerMapSvg({ countries: [{ iso: 'CA', count: 1 }] })
    expect(svg).toMatch(/<path class="world-land" data-iso="US" d="[^"]+" fill="var\(--map-land\)" stroke="var\(--map-stroke\)" stroke-width="0.5" \/>/)
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(svg).not.toContain('oklch(')
  })

  it('a zero count is treated as no data (no pin, no fill)', () => {
    const svg = renderCornerMapSvg({ countries: [{ iso: 'CA', count: 0 }] })
    expect(svg).not.toContain('has-data')
    expect(svg).not.toContain('data-pin')
  })

  it('empty input renders land only, no hit pins, and no Antarctica', () => {
    const svg = renderCornerMapSvg({ countries: [] })
    expect(svg).toContain('data-iso=')
    expect(svg).not.toContain('data-pin')
    expect(svg).not.toContain('data-iso="AQ"')
  })
})

describe('map frame', () => {
  it('1152 is 1152x642 and 520 is 520x292', () => {
    expect(MAP_DIMENSIONS['1152']).toEqual({ width: 1152, height: 642 })
    expect(MAP_DIMENSIONS['520']).toEqual({ width: 520, height: 292 })
  })

  it('the far north (83.6°N, Cape Morris Jesup) and far south (55.98°S, Cape Horn) are both inside both frames', () => {
    for (const variant of ['1152', '520'] as const) {
      const { height } = MAP_DIMENSIONS[variant]
      const [, north] = projectPoint(83.6, -33.4, variant)
      const [, south] = projectPoint(-55.98, -67.27, variant)
      expect(north, `${variant} north`).toBeGreaterThan(0)
      expect(south, `${variant} south`).toBeLessThan(height)
    }
  })
})

describe('countryPillsFromPoints', () => {
  it('rolls seats and places by country and prefers countries rollup for seat totals', () => {
    const pills = countryPillsFromPoints(
      [
        { country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 2 },
        { country: 'CA', city: 'Montréal', lat: 45.5, lon: -73.57, count: 3 }
      ],
      [{ iso: 'CA', devices: 12 }]
    )
    expect(pills).toHaveLength(1)
    expect(pills[0].iso).toBe('CA')
    expect(pills[0].seats).toBe(12)
    expect(pills[0].places).toBe(2)
    expect(pills[0].name).toBe('Canada')
  })
})
