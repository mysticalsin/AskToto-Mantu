import { describe, expect, it } from 'vitest'
import {
  clusterLabel,
  clusterPins,
  countryName,
  DEFAULT_CLUSTER_OPTIONS,
  projectPoint,
  renderCornerMapSvg,
  renderRealtimeMapSvg,
  type Cluster,
  type ClusterPoint
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

  it('the busiest cluster is 14 Brazilian points totalling 31 events, labelled "Brazil, 14 places"', () => {
    const { clusters } = clusterPins(toClusterPoints(), DEFAULT_CLUSTER_OPTIONS)
    const top = [...clusters].sort((a, b) => b.count - a.count)[0]
    expect(top.count).toBe(31)
    expect(top.members.length).toBe(14)
    expect(clusterLabel(top)).toBe('Brazil, 14 places')
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

  it('several members in one country: "Canada, 3 places"', () => {
    const c = cluster([
      { country: 'CA', city: 'Longueuil', count: 1, x: 0, y: 0 },
      { country: 'CA', city: 'Montreal', count: 1, x: 1, y: 1 },
      { country: 'CA', city: '', count: 1, x: 2, y: 2 }
    ])
    expect(clusterLabel(c)).toBe('Canada, 3 places')
  })

  it('members across several countries: "5 places"', () => {
    const c = cluster([
      { country: 'CA', city: 'Longueuil', count: 1, x: 0, y: 0 },
      { country: 'US', city: 'Ashburn', count: 1, x: 1, y: 1 },
      { country: 'FR', city: '', count: 1, x: 2, y: 2 },
      { country: 'DE', city: 'Gera', count: 1, x: 3, y: 3 },
      { country: 'JP', city: 'Tokyo', count: 1, x: 4, y: 4 }
    ])
    expect(clusterLabel(c)).toBe('5 places')
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

describe('renderRealtimeMapSvg', () => {
  it('renders land only, no pins, and an honest empty caption when there are no points', () => {
    const svg = renderRealtimeMapSvg({ points: [] })
    expect(svg).toContain('No heartbeats yet. The map stays empty until a seat checks in.')
    expect(svg).not.toContain('data-pin')
    expect(svg).toContain('data-iso=')
    expect(svg).toContain('viewBox="0 0 1152 576"')
  })

  it('never fakes a dot: exactly one pin per supplied point, no more', () => {
    const svg = renderRealtimeMapSvg({
      points: [
        { country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 },
        { country: 'US', city: 'Ashburn', lat: 39.05, lon: -77.49, count: 3 }
      ]
    })
    expect((svg.match(/class="rt-pin"/g) || []).length).toBe(2)
    expect(svg).not.toContain('class="empty')
  })

  it('drops the count-pill badges entirely (spec change): no foreignObject, no badge markup', () => {
    const svg = renderRealtimeMapSvg({
      points: REFERENCE_COORDINATES.slice(0, 20).map((c) => ({
        country: c.country,
        city: c.city,
        lat: c.lat,
        lon: c.long,
        count: c.count
      }))
    })
    expect(svg).not.toContain('foreignObject')
    expect(svg).not.toMatch(/class="[^"]*badge/)
  })

  it('a single seat renders a clearly visible dot (r=4.5); several seats at one point render larger (r=6.5)', () => {
    const svg = renderRealtimeMapSvg({
      points: [
        { country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 },
        { country: 'US', city: 'Ashburn', lat: 39.05, lon: -77.49, count: 4 }
      ]
    })
    expect(svg).toContain('data-seats="1"')
    expect(svg).toContain('data-seats="4"')
    expect(svg).toMatch(/data-seats="1"[^>]*>[\s\S]*?<circle class="rt-pin-dot" r="4.5"/)
    expect(svg).toMatch(/data-seats="4"[^>]*>[\s\S]*?<circle class="rt-pin-dot" r="6.5"/)
    expect(svg).toContain('stroke: #ffffff')
    expect(svg).toContain('stroke-width: 1.5')
  })

  it('carries tooltip data: country, city, seats, and asks when known', () => {
    const svg = renderRealtimeMapSvg({
      points: [{ country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 2, asks: 5 }]
    })
    expect(svg).toContain('data-country="Canada"')
    expect(svg).toContain('data-city="Longueuil"')
    expect(svg).toContain('data-seats="2"')
    expect(svg).toContain('data-asks="5"')
  })

  it('omits data-asks entirely when asks is not known (never a fabricated 0)', () => {
    const svg = renderRealtimeMapSvg({ points: [{ country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 }] })
    expect(svg).not.toContain('data-asks')
  })

  it('renders zoom/pan control buttons and a viewport group in the markup', () => {
    const svg = renderRealtimeMapSvg({ points: [] })
    expect(svg).toContain('data-zoom-in')
    expect(svg).toContain('data-zoom-out')
    expect(svg).toContain('data-viewport')
  })

  it('includes the pulsing-halo keyframes and a reduced-motion fallback', () => {
    const svg = renderRealtimeMapSvg({ points: [] })
    expect(svg).toMatch(/@keyframes\s+[\w-]+/)
    expect(svg).toMatch(/prefers-reduced-motion:\s*reduce/)
  })
})

describe('renderCornerMapSvg', () => {
  it('renders the 520x300 choropleth with oklch fill scaled by count', () => {
    const svg = renderCornerMapSvg({
      countries: [
        { iso: 'CA', count: 4 },
        { iso: 'US', count: 1 }
      ]
    })
    expect(svg).toContain('viewBox="0 0 520 300"')
    expect(svg).toContain('data-iso="CA"')
    expect(svg).toContain('stroke="rgb(255,255,255)"')
    expect(svg).toMatch(/oklch\(54\.6% 0\.22 263 \/ 1(\.000)?\)/) // max count -> alpha 1
  })

  it('countries with no data render flat grey, not a fabricated color', () => {
    const svg = renderCornerMapSvg({ countries: [{ iso: 'CA', count: 1 }] })
    expect(svg).toContain('data-iso="US"')
    expect(svg).toMatch(/data-iso="US"[^>]*fill="rgb\(240,240,240\)"/)
  })

  it('empty input renders land only, no hit pins', () => {
    const svg = renderCornerMapSvg({ countries: [] })
    expect(svg).toContain('data-iso=')
    expect(svg).not.toContain('data-pin')
  })
})
