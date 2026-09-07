import { describe, expect, it } from 'vitest'
import { FIXTURE_NOW, fixtureDashboard, fixtureRows } from './fixture'

describe('QA fixture', () => {
  it('is deterministic across calls', () => {
    const a = fixtureRows()
    const b = fixtureRows()
    expect(a.seats).toEqual(b.seats)
    expect(a.asks.length).toEqual(b.asks.length)
    expect(a.asks).toEqual(b.asks)
    expect(a.pulses).toEqual(b.pulses)
  })

  it('has 12 seats across 6 countries', () => {
    const rows = fixtureRows()
    expect(rows.seats).toHaveLength(12)
    const countries = new Set(rows.seats.map((s) => s.country))
    expect(countries).toEqual(new Set(['CA', 'FR', 'DE', 'US', 'BR', 'IN']))
  })

  it('has exactly 4 seats live within 2 minutes of now', () => {
    const rows = fixtureRows()
    const live = rows.seats.filter((s) => rows.now - s.last_seen < 2 * 60 * 1000)
    expect(live).toHaveLength(4)
  })

  it('mixes macOS and Windows and a 1.8.x version spread', () => {
    const rows = fixtureRows()
    const osSet = new Set(rows.seats.map((s) => s.os))
    expect(osSet).toEqual(new Set(['darwin', 'win32']))
    for (const s of rows.seats) {
      expect(['1.8.3', '1.8.4', '1.8.5']).toContain(s.app_version)
    }
  })

  it('has no plaintext prompt anywhere in an ask row', () => {
    const rows = fixtureRows()
    expect(rows.asks.length).toBeGreaterThan(0)
    for (const ask of rows.asks) {
      expect(ask.prompt_cipher).toBeTruthy()
      expect(ask.prompt_iv).toBeTruthy()
      // A placeholder ciphertext is base64: no spaces, no natural-language content possible.
      expect(ask.prompt_cipher).toMatch(/^[A-Za-z0-9+/]+=*$/)
      expect(ask.prompt_iv).toMatch(/^[A-Za-z0-9+/]+=*$/)
      expect(ask.preview ?? '').not.toMatch(/\?/) // previews are labels, never a real question
    }
  })

  it('has no em dash in any string field on any row', () => {
    const rows = fixtureRows()
    const emDash = '—'
    const strings: string[] = []
    const collect = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value)
      else if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(rows.seats)
    collect(rows.asks)
    collect(rows.events)
    collect(rows.issuedLicenses)
    collect(rows.groups)
    collect(rows.groupMembers)
    collect(rows.integrations)
    collect(rows.crmSends)
    collect(rows.proposals)
    collect(rows.audit)
    for (const s of strings) expect(s).not.toContain(emDash)
  })

  it('has 3 groups, 8 issued licenses (2 revoked, 5 activated), 5 connectors (2 failing), 6 CRM sends, 3 proposals', () => {
    const rows = fixtureRows()
    expect(rows.groups).toHaveLength(3)
    expect(rows.issuedLicenses).toHaveLength(8)
    expect(rows.issuedLicenses.filter((l) => l.revoked === 1)).toHaveLength(2)
    expect(rows.issuedLicenses.filter((l) => l.activated_device)).toHaveLength(5)
    expect(rows.integrations).toHaveLength(5)
    expect(rows.integrations.filter((i) => i.status === 'failing')).toHaveLength(2)
    expect(rows.crmSends).toHaveLength(6)
    expect(new Set(rows.crmSends.map((c) => c.status)).size).toBe(6)
    expect(rows.proposals).toHaveLength(3)
  })

  it('builds a DashboardPayload through the real buildDashboard without throwing', async () => {
    const dashboard = await fixtureDashboard()
    expect(dashboard.now).toBe(FIXTURE_NOW)
    expect(dashboard.profiles.length).toBe(12)
  })

  it('reports 4 live seats on the fixture dashboard', async () => {
    const dashboard = await fixtureDashboard()
    expect(dashboard.roi.liveSeats).toBe(4)
    expect(dashboard.kpis.live).toBe(4)
  })

  it('every KPI number is derivable, never a hand typed constant: asks and licenses agree with the rows', async () => {
    const rows = fixtureRows()
    const dashboard = await fixtureDashboard()
    expect(dashboard.roi.asksToday).toBe(rows.asks.filter((a) => a.ts >= rows.now - 24 * 60 * 60 * 1000).length)
    expect(dashboard.licenses.issued).toHaveLength(rows.issuedLicenses.length)
  })
})
