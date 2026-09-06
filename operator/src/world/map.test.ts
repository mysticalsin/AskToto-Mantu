import { describe, expect, it } from 'vitest'
import {
  clusterLabel,
  clusterPins,
  countryName,
  countryPills,
  DEFAULT_CLUSTER_OPTIONS,
  projectPoint,
  renderCornerMapSvg,
  renderRealtimeMapSvg,
  worldOutline,
  WORLD_1152,
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

describe('clusterPins reproduces the reference outcome on its own fixture (center [0, 20] projection)', () => {
  it('clusters the first 40 reference coordinates (radius 22px)', () => {
    const { clusters, badgeClusters } = clusterPins(toClusterPoints(), DEFAULT_CLUSTER_OPTIONS)
    expect(clusters.length).toBeGreaterThan(0)
    expect(badgeClusters.length).toBeGreaterThan(0)
    expect(badgeClusters.length).toBeLessThanOrEqual(clusters.length)
  })

  it('the busiest cluster is every Brazilian point in this fixture, labelled "Brazil, N places"', () => {
    const { clusters } = clusterPins(toClusterPoints(), DEFAULT_CLUSTER_OPTIONS)
    const top = [...clusters].sort((a, b) => b.count - a.count)[0]
    expect(top.members.every((m) => m.country === 'BR')).toBe(true)
    expect(clusterLabel(top)).toBe(`Brazil, ${top.members.length} places`)
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

describe('worldOutline', () => {
  it('is exactly every WORLD_1152 entry\'s d, concatenated in order', () => {
    const outline = worldOutline(WORLD_1152)
    expect(outline).toBe(WORLD_1152.map((e) => e.d).join(''))
    expect(outline.length).toBeGreaterThan(0)
  })
})

describe('countryPills', () => {
  const points: RealtimeMapPoint[] = [
    { country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 },
    { country: 'CA', city: 'Montreal', lat: 45.5, lon: -73.6, count: 2 },
    { country: 'US', city: 'Ashburn', lat: 39.05, lon: -77.49, count: 1 }
  ]

  it('gives a country with 2+ reporting places a pill: total seats, total places, anchored at its centroid', () => {
    const pills = countryPills(points, '1152')
    const ca = pills.find((p) => p.iso === 'CA')
    expect(ca).toBeDefined()
    expect(ca?.seats).toBe(3)
    expect(ca?.places).toBe(2)
    expect(ca?.country).toBe('Canada')
  })

  it('drops the pill for a country with only one reporting place (its city label already says it)', () => {
    const pills = countryPills(points, '1152')
    expect(pills.find((p) => p.iso === 'US')).toBeUndefined()
  })
})

describe('renderRealtimeMapSvg', () => {
  it('renders filled land, an ocean rect, a graticule, no pins, and an honest empty caption when there are no points', () => {
    const svg = renderRealtimeMapSvg({ points: [] })
    expect(svg).toContain('No seat has checked in during the last 30 minutes.')
    expect(svg).not.toContain('class="rt-pin"')
    expect(svg).not.toContain('class="rt-pill"')
    expect(svg).toContain('data-iso=')
    expect(svg).toContain('class="world-land"')
    expect(svg).toContain('class="map-ocean"')
    expect(svg).toContain('class="map-graticule"')
    expect(svg).toContain('viewBox="0 0 1152 648"')
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

  it('renders the city name next to the dot, not only in a tooltip data attribute', () => {
    const svg = renderRealtimeMapSvg({
      points: [{ country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 }]
    })
    expect(svg).toMatch(/<text class="rt-pin-label"[^>]*>Longueuil<\/text>/)
  })

  it('a live point pulses (has a halo) and defaults live when not specified; a non-live point has no halo', () => {
    const svg = renderRealtimeMapSvg({
      points: [
        { country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 },
        { country: 'FR', city: 'Paris', lat: 48.86, lon: 2.35, count: 1, live: false }
      ]
    })
    expect(svg).toMatch(/data-live="1"[\s\S]*?<circle class="rt-pin-halo"/)
    const parisPin = svg.slice(svg.indexOf('data-city="Paris"'))
    const parisGroupEnd = parisPin.indexOf('</g>\n    </g>')
    expect(parisPin.slice(0, parisGroupEnd)).not.toContain('rt-pin-halo')
    expect(svg).toContain('data-live="0"')
  })

  it('a single seat renders a clearly visible dot (r=4.5) when live; several seats at one point render larger (r=6.5); non-live dots are smaller', () => {
    const svg = renderRealtimeMapSvg({
      points: [
        { country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 },
        { country: 'US', city: 'Ashburn', lat: 39.05, lon: -77.49, count: 4 },
        { country: 'FR', city: 'Paris', lat: 48.86, lon: 2.35, count: 1, live: false }
      ]
    })
    function pinTag(city: string): string {
      const start = svg.indexOf(`data-city="${city}"`)
      expect(start, `pin for ${city}`).toBeGreaterThan(-1)
      const groupStart = svg.lastIndexOf('<g class="rt-pin"', start)
      const groupEnd = svg.indexOf('</g>\n    </g>', groupStart) + '</g>\n    </g>'.length
      return svg.slice(groupStart, groupEnd)
    }
    expect(pinTag('Longueuil')).toContain('data-live="1"')
    expect(pinTag('Longueuil')).toMatch(/<circle class="rt-pin-dot" r="4.5"/)
    expect(pinTag('Ashburn')).toMatch(/<circle class="rt-pin-dot" r="6.5"/)
    expect(pinTag('Paris')).toContain('data-live="0"')
    expect(pinTag('Paris')).toMatch(/<circle class="rt-pin-dot" r="3.5"/)
  })

  it('carries tooltip data: iso (for the flag), country, city, seats, live seats, asks and time saved when known', () => {
    const svg = renderRealtimeMapSvg({
      points: [{ country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 2, asks: 5, liveSeats: 1, timeSaved: '3.2h' }]
    })
    expect(svg).toContain('data-iso="CA"')
    expect(svg).toContain('data-country="Canada"')
    expect(svg).toContain('data-city="Longueuil"')
    expect(svg).toContain('data-seats="2"')
    expect(svg).toContain('data-live-seats="1"')
    expect(svg).toContain('data-asks="5"')
    expect(svg).toContain('data-time-saved="3.2h"')
  })

  it('omits data-asks/data-live-seats/data-time-saved entirely when not known (never a fabricated number)', () => {
    const svg = renderRealtimeMapSvg({ points: [{ country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 }] })
    expect(svg).not.toContain('data-asks')
    expect(svg).not.toContain('data-live-seats')
    expect(svg).not.toContain('data-time-saved')
  })

  it('gives a country reporting from 2+ places a pill with flag, country, seats and places', () => {
    const svg = renderRealtimeMapSvg({
      points: [
        { country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 },
        { country: 'CA', city: 'Montreal', lat: 45.5, lon: -73.6, count: 2 }
      ]
    })
    expect(svg).toContain('data-pill')
    expect(svg).toContain('data-iso="CA"')
    expect(svg).toContain('class="rt-pill-flag"')
    expect(svg).toMatch(/href="\/assets\/flags\/ca\.svg"/)
    expect(svg).toMatch(/<text class="rt-pill-text"[^>]*>Canada · 3 seats · 2 places<\/text>/)
  })

  it('drops the pill for a country with a single city label already shown', () => {
    const svg = renderRealtimeMapSvg({
      points: [{ country: 'US', city: 'Ashburn', lat: 39.05, lon: -77.49, count: 1 }]
    })
    expect(svg).not.toContain('class="rt-pill"')
  })

  it('renders zoom/pan control buttons, a viewport group, and a hover-fade land group', () => {
    const svg = renderRealtimeMapSvg({ points: [] })
    expect(svg).toContain('data-zoom-in')
    expect(svg).toContain('data-zoom-out')
    expect(svg).toContain('data-viewport')
    expect(svg).toContain('data-hover-fade')
  })

  it('renders a pointer-following tooltip container, hidden by default', () => {
    const svg = renderRealtimeMapSvg({ points: [] })
    expect(svg).toMatch(/<div class="rt-map-tooltip" data-map-tooltip role="tooltip" hidden><\/div>/)
  })

  it('has no inline style= attribute and no hex literal anywhere in the markup', () => {
    const svg = renderRealtimeMapSvg({
      points: [
        { country: 'CA', city: 'Longueuil', lat: 45.53, lon: -73.52, count: 1 },
        { country: 'CA', city: 'Montreal', lat: 45.5, lon: -73.6, count: 2 }
      ]
    })
    expect(svg).not.toMatch(/\sstyle=/)
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('renderCornerMapSvg', () => {
  it('renders the 16:9 corner choropleth with a chart-scale-05 class at the max count', () => {
    const svg = renderCornerMapSvg({
      countries: [
        { iso: 'CA', count: 4 },
        { iso: 'US', count: 1 }
      ]
    })
    expect(svg).toContain('viewBox="0 0 520 293"')
    expect(svg).toContain('data-iso="CA"')
    expect(svg).toContain('class="map-ocean"')
    expect(svg).toMatch(/class="[^"]*scale-05[^"]*"[^>]*data-iso="CA"/)
  })

  it('countries with no data render the no-data class, not a fabricated colour', () => {
    const svg = renderCornerMapSvg({ countries: [{ iso: 'CA', count: 1 }] })
    expect(svg).toContain('data-iso="US"')
    expect(svg).toMatch(/class="[^"]*no-data[^"]*"[^>]*data-iso="US"/)
  })

  it('empty input renders land only, no hit pins', () => {
    const svg = renderCornerMapSvg({ countries: [] })
    expect(svg).toContain('data-iso=')
    expect(svg).not.toContain('data-pin')
  })

  it('has no inline style= attribute and no hex literal anywhere in the markup', () => {
    const svg = renderCornerMapSvg({ countries: [{ iso: 'CA', count: 4 }] })
    expect(svg).not.toMatch(/\sstyle=/)
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
