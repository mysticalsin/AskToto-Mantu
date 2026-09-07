import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { areaChartWithPrevious, miniBars, recolorChoroplethMini, tokenStackBar } from './overview-charts'
import { fixtureForOverview, fixtureOverviewConnectors } from './overview.fixture'
import { renderConnectorsCardRows, renderFleetContactBanner, renderOverview, type OverviewConnectorSummary } from './overview'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderOverview (QA fixture)', () => {
  it('renders the toolbar, metric tiles, tokens card, area chart, six cards and the license card', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(html).toContain('>Overview<')
    expect(html).toContain('data-ov-range')
    expect(html).toContain('data-ov-granularity')
    expect(html).toContain('data-ov-filters-toggle')
    expect(html).toContain('data-ov-search')
    expect(html).toContain('data-world-live')
    expect(html).toContain('>Private<')
    expect(html).toContain('mtiles-grid')
    expect(html).toContain('Live seats')
    expect(html).toContain('Time saved')
    expect(html).toContain('Live, 30 min')
    expect(html).toContain('data-ov-tokens')
    expect(html).toContain('data-ov-area')
    expect(html).toContain('data-overview-grid')
    expect(html).toContain('data-ov-tlc-card="seats"')
    expect(html).toContain('data-ov-tlc-card="asks"')
    expect(html).toContain('data-ov-tlc-card="licenses"')
    expect(html).toContain('data-ov-tlc-card="countries"')
    expect(html).toContain('data-ov-map-card')
    expect(html).toContain('data-license-generate')
    expect(html).toContain('data-license-once')
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })

  it('shows real seat and country rows from the fixture, never a placeholder', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(data.profiles.length).toBeGreaterThan(0)
    expect(data.geo.length).toBeGreaterThan(0)
    expect(html).toContain('data-os=')
    expect(html).toContain('data-country=')
  })

  it('Value tile reads "Set an hourly rate" and links to #settings when no rate is stored', async () => {
    const data = await fixtureDashboard()
    expect(data.roi.hourlyRate).toBeNull()
    const html = renderOverview(data, CTX)
    expect(html).toContain('Set an hourly rate to see value')
    expect(html).toContain('href="#settings"')
  })

  it('Value tile shows a real formatted amount once an hourly rate is set (overlay fixture)', async () => {
    const data = await fixtureForOverview()
    expect(data.roi.hourlyRate).not.toBeNull()
    expect(data.roi.valueMinor).not.toBeNull()
    const html = renderOverview(data, CTX)
    expect(html).not.toContain('Set an hourly rate to see value')
    expect(html).toMatch(/CA\$|CAD/)
  })

  it('Licenses card defaults to the real States tab and names the Tiers data gap', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(html).toContain('data-ov-tlc-pane="licenses:tiers" hidden')
    expect(html).toContain('data-ov-tlc-pane="licenses:states">')
    expect(html).toContain('Tier is not tracked per seat in this payload yet.')
  })

  it('recolours the corner map through data-iso classes instead of the raw fill', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    // The class names moved with the map rebuild (corner-cell plus a scale step, or no-data for a
    // country with no seats); the rule has not: every land path carries its ISO code and takes its
    // colour from a class, so the sequential scale lives in the token sheet and follows the theme.
    expect(html).toMatch(/class="world-land corner-cell (scale-0\d|no-data)" data-iso="[A-Z]{2}"/)
    // A raw fill on a land path would pin the colour outside the token sheet and break dark mode.
    expect(html).not.toMatch(/<path class="world-land[^>]*\sfill="/)
  })

  it('never renders a JS-driven fallback and stays HTML-only for first paint', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(html).not.toContain('<script')
  })

  it('places the Connectors card next to the Countries card, before the Map card (plan 6.2)', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(html).toContain('data-ov-connectors-card')
    expect(html).toContain('data-ov-connectors-root')
    expect(html).toContain('data-ov-connectors-state="loading"')
    const countriesIdx = html.indexOf('data-ov-tlc-card="countries"')
    const connectorsIdx = html.indexOf('data-ov-connectors-card')
    const mapIdx = html.indexOf('data-ov-map-card')
    expect(countriesIdx).toBeGreaterThan(-1)
    expect(countriesIdx).toBeLessThan(connectorsIdx)
    expect(connectorsIdx).toBeLessThan(mapIdx)
  })

  it('Connectors card renders a named loading skeleton on first paint, never a fake row', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(html).toContain('skeleton-row')
    expect(html).not.toContain('Needs attention')
    expect(html).not.toContain('connector-row-logo')
  })
})

describe('fleet-is-quiet banner', () => {
  /** The state Tony hit: Métis running on several Macs, console showing zero, nothing to click. */
  it('names the silence, its duration and the reason when the newest heartbeat is old', async () => {
    const data = await fixtureDashboard()
    const stale = { ...data, now: data.now + 3 * 60 * 60 * 1000 }
    const html = renderFleetContactBanner(stale)
    expect(html).toContain('data-ov-quiet')
    expect(html).toContain('No seat has reported in 3h')
    expect(html).toContain('an activated license or the shared ingest secret')
    // The zeros below must be explained, not left to be read as a real, idle fleet.
    expect(html).toContain('not because the fleet is idle')
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })

  it('says so plainly when no seat has ever reported', async () => {
    const data = await fixtureDashboard()
    const html = renderFleetContactBanner({ ...data, profiles: [] })
    expect(html).toContain('No seat has ever reported to this Operator.')
    // No fabricated "last contact" when there has never been one.
    expect(html).not.toContain('Last contact')
  })

  it('renders nothing at all while heartbeats are arriving', async () => {
    const data = await fixtureDashboard()
    const live = {
      ...data,
      profiles: data.profiles.map((p, i) => (i === 0 ? { ...p, lastSeen: data.now - 30_000 } : p))
    }
    expect(renderFleetContactBanner(live)).toBe('')
  })

  it('is absent from a healthy Overview and present on a silent one', async () => {
    const data = await fixtureDashboard()
    const live = {
      ...data,
      profiles: data.profiles.map((p, i) => (i === 0 ? { ...p, lastSeen: data.now - 30_000 } : p))
    }
    expect(renderOverview(live, CTX)).not.toContain('data-ov-quiet')
    expect(renderOverview({ ...data, now: data.now + 86_400_000 }, CTX)).toContain('data-ov-quiet')
  })
})

describe('renderConnectorsCardRows (plan 6.2 / 6.10b Connectors card)', () => {
  const attentionRow: OverviewConnectorSummary = {
    id: 'int-1',
    kind: 'plane',
    label: 'Plane project tracker',
    transport: 'rest',
    healthy: false,
    reason: 'Test failed 4d ago.'
  }
  const connectedRow: OverviewConnectorSummary = {
    id: 'int-2',
    kind: 'hubspot',
    label: 'HubSpot CRM',
    transport: 'rest',
    healthy: true,
    toolsCount: 5
  }

  it('renders "Needs attention" and "Connected" groups with real counts, reusing the 6.10b row markup', () => {
    const html = renderConnectorsCardRows([attentionRow, connectedRow])
    expect(html).toContain('Needs attention <span class="connector-group-count">1</span>')
    expect(html).toContain('Connected <span class="connector-group-count">1</span>')
    expect(html).toContain('src="/assets/logos/plane.svg"')
    expect(html).toContain('connector-row-dot-attention')
    expect(html).toContain('Test failed 4d ago.')
    expect(html).toContain('src="/assets/logos/hubspot.svg"')
    expect(html).toContain('connector-row-dot-connected')
    expect(html).toContain('<span data-count-to="5">5</span> tools enabled')
    expect(html).toContain('>API<')
    expect(html).toContain('connector-row-action">Fix<')
    expect(html).toContain('connector-row-action">Test<')
  })

  it('caps each group at three rows and links "Show N more" to #connectors instead of expanding in place', () => {
    const attention = Array.from({ length: 5 }, (_, i) => ({ ...attentionRow, id: `int-a${i}` }))
    const html = renderConnectorsCardRows(attention)
    expect(html).toContain('Needs attention <span class="connector-group-count">5</span>')
    expect((html.match(/class="connector-row"/g) || []).length).toBe(3)
    expect(html).toContain('<a class="connector-show-more" href="#connectors">Show 2 more</a>')
    expect(html).not.toContain('data-expand')
  })

  it('omits "Show N more" once a group has three rows or fewer', () => {
    const html = renderConnectorsCardRows([connectedRow])
    expect(html).not.toContain('Show')
  })

  it('an empty group disappears entirely (plan 6.10b), and no connectors at all renders the named empty state', () => {
    const onlyConnected = renderConnectorsCardRows([connectedRow])
    expect(onlyConnected).not.toContain('Needs attention')

    const none = renderConnectorsCardRows([])
    expect(none).toContain('No connectors yet.')
    expect(none).not.toContain('connector-row')
  })

  it('renders real needs-attention and connected examples from the fixture seed (never hand-typed)', () => {
    const rows = fixtureOverviewConnectors()
    const healthy = rows.filter((r) => r.healthy)
    const unhealthy = rows.filter((r) => !r.healthy)
    expect(healthy.length).toBeGreaterThan(0)
    expect(unhealthy.length).toBeGreaterThan(0)
    const html = renderConnectorsCardRows(rows)
    expect(html).toContain('HubSpot CRM')
    expect(html).toContain('Plane project tracker')
    expect(html).toMatch(/Test failed .+ ago\./)
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })
})

describe('overview-charts helpers', () => {
  it('areaChartWithPrevious draws a solid current line and an honest empty state for an all-zero series', () => {
    const withData = areaChartWithPrevious({ current: [1, 4, 2, 6, 3], labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] })
    expect(withData).toContain('data-ov-area-line')
    expect(withData).not.toContain('data-ov-area-prev')

    const withPrevious = areaChartWithPrevious({ current: [1, 4, 2], previous: [2, 3, 1] })
    expect(withPrevious).toContain('data-ov-area-prev')
    expect(withPrevious).toContain('stroke-dasharray')

    const empty = areaChartWithPrevious({ current: [0, 0, 0] })
    expect(empty).toContain('No seat activity in this window yet.')
    expect(empty).not.toContain('data-ov-area-line')
  })

  it('miniBars grows real bars with a stagger delay and degrades to a baseline line when empty', () => {
    const bars = miniBars([1, 3, 2, 5])
    expect(bars).toContain('data-grow')
    expect(bars).toContain('data-grow-delay="20"')
    const empty = miniBars([0, 0, 0])
    expect(empty).toContain('ov-mini-bars-empty')
  })

  it('miniBars draws nothing for a day with no activity, so a sparse week is not seven small events', () => {
    // One real day among six empty ones must produce exactly one bar. The 2px floor that keeps a
    // small real value visible used to apply to zero as well, colouring every empty day.
    const sparse = miniBars([0, 0, 0, 0, 0, 0, 3])
    expect((sparse.match(/<rect /g) || []).length).toBe(1)
    // ...and the one bar that is drawn is still a real, visible bar.
    expect(sparse).toMatch(/height="\d+"/)
    expect(sparse).not.toMatch(/height="0"/)

    const mixed = miniBars([2, 0, 5])
    expect((mixed.match(/<rect /g) || []).length).toBe(2)
  })

  it('the seat area chart keeps a headroom floor so one seat is not a full-height cliff', () => {
    // Scaling to the series max alone put a single seat at the very top of the frame, reading as a
    // traffic spike. The floor is 4, and the axis label still prints the true top of the scale.
    // Floor 4, plus the 1.2x headroom that keeps a flat series off the ceiling: top of scale 4.8.
    const oneSeat = areaChartWithPrevious({ current: [0, 0, 0, 0, 0, 0, 1], height: 150 })
    expect(oneSeat).toContain('>5<')
    expect(oneSeat).not.toContain('>1<')

    // Above the floor the data drives the scale again, still with headroom above the peak.
    const busy = areaChartWithPrevious({ current: [0, 3, 9], height: 150 })
    expect(busy).toContain('>11<')
  })

  it('tokenStackBar splits into four var(--data-N) segments that add up to the input, or renders the neutral track when empty', () => {
    const bar = tokenStackBar({ in: 40, out: 30, cacheRead: 20, cacheWrite: 10 })
    expect(bar).toContain('var(--data-1)')
    expect(bar).toContain('var(--data-2)')
    expect(bar).toContain('var(--data-3)')
    expect(bar).toContain('var(--data-4)')
    const empty = tokenStackBar({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
    expect(empty).toContain('var(--data-track)')
  })

  it('recolorChoroplethMini adds exactly one scale class per land path without duplicating class attributes', () => {
    const fakeSvg = '<svg class="corner-map-svg"><path class="world-land" data-iso="FR" d="M0 0" fill="oklch(1 0 0)" /><path class="world-land" data-iso="ZZ" d="M0 0" fill="oklch(1 0 0)" /></svg>'
    const out = recolorChoroplethMini(fakeSvg, [{ iso: 'FR', devices: 10 }])
    expect(out).toContain('class="world-land ov-map-scale-5" data-iso="FR"')
    expect(out).toContain('class="world-land ov-map-scale-0" data-iso="ZZ"')
    // Exactly one class="..." per element: the outer <svg> plus the two <path>s, never a
    // duplicated attribute on either path.
    expect(out.match(/class="/g)?.length).toBe(3)
  })
})
