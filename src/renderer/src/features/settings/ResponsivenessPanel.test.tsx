import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildResponsivenessReport, emptySnapshot, type ResponsivenessSnapshot } from '@shared/responsiveness-metrics'
import { readModuleSource } from '../../../../test-helpers/module-source'
import { ResponsivenessRows } from './ResponsivenessPanel'

const identity = { platform: 'darwin', arch: 'arm64', appVersion: '0.0.0-test' }
const at = new Date('2026-10-22T00:00:00.000Z')

function html(snapshot: ResponsivenessSnapshot): string {
  return renderToStaticMarkup(
    createElement(ResponsivenessRows, { report: buildResponsivenessReport(snapshot, { identity, generatedAt: at }) })
  )
}

describe('ResponsivenessRows', () => {
  it('says "not measured" for every metric when nothing has been measured, and shows no number', () => {
    const out = html(emptySnapshot())
    expect(out.match(/not measured/g)?.length).toBeGreaterThanOrEqual(14)
    expect(out).not.toMatch(/\d+ ms/)
    expect(out).toContain('First partial transcript')
    expect(out).toContain('Ask cancellation')
  })

  it('shows a measured latency with its sample count and its PROPOSED target', () => {
    const out = html({ ...emptySnapshot(), latencies: { first_partial_ms: Array.from({ length: 25 }, () => 640) } })
    expect(out).toContain('p50 640 ms, p95 640 ms, n=25')
    expect(out).toContain('Target p95 1000 ms (PROPOSED): within')
  })

  it('names the host and the budget status so a figure is never read without its conditions', () => {
    const out = html(emptySnapshot())
    expect(out).toContain('darwin arm64')
    expect(out).toContain('PROPOSED')
  })

  it('marks typed slots with the ticket that will wire them', () => {
    const out = html(emptySnapshot())
    expect(out).toContain('Not wired yet (G70)')
    expect(out).toContain('Not wired yet (G14)')
  })

  it('escapes nothing it should not render: no raw JSON of the snapshot reaches the page', () => {
    const out = html({ ...emptySnapshot(), counters: { asks_cancelled: 2 } })
    expect(out).not.toContain('asks_cancelled')
    expect(out).not.toContain('"snapshot"')
  })
})

describe('Settings wiring', () => {
  it('renders the responsiveness panel inside the Usage and diagnostics section, fed by the main report', () => {
    const section = readModuleSource(__dirname, './DiagnosticsSection').text
    expect(section).toMatch(/<ResponsivenessPanel \/>/)
    const panel = readModuleSource(__dirname, './ResponsivenessPanel').text
    expect(panel).toMatch(/window\.toto\s*\.readResponsiveness\(\)/)
    expect(panel).toMatch(/Retry/)
  })
})
