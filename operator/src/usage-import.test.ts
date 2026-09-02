import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDashboard } from './dashboard'
import { memoryStore } from './store'
import {
  applyUsageImport,
  billedUsdFromOutcome,
  planUsageImport,
  USAGE_MODE,
  USAGE_PREVIEW
} from './usage-import'
import { renderOverviewMini10 } from './overview-cards'

const FIX = join(__dirname, '../fixtures/usage')
const amountCsv = readFileSync(join(FIX, 'amount-2026-08-04_2026-09-02.csv'), 'utf8')
const costCsv = readFileSync(join(FIX, 'cost-2026-08-04_2026-09-02.csv'), 'utf8')

describe('DeepSeek usage import → Overview', () => {
  it('parses the Aug–Sep zip CSVs into asks with billed cost and tokens', () => {
    const plan = planUsageImport(amountCsv, costCsv, Date.parse('2026-09-02T20:00:00Z'))
    expect(plan.from).toBe('2026-08-11')
    expect(plan.to).toBe('2026-09-02')
    expect(plan.totals.requests).toBeGreaterThan(1000)
    expect(plan.totals.tokens).toBeGreaterThan(10_000_000)
    expect(plan.totals.costUsd).toBeGreaterThan(1)
    expect(plan.asks.every((a) => a.provider === 'deepseek')).toBe(true)
    expect(plan.asks.every((a) => a.mode === USAGE_MODE)).toBe(true)
    expect(plan.asks.every((a) => a.preview === USAGE_PREVIEW)).toBe(true)
    expect(plan.vault.status).toBe('active')
    const billed = plan.asks.map((a) => billedUsdFromOutcome(a.outcome)).filter((n): n is number => n != null)
    expect(billed.length).toBeGreaterThan(0)
    expect(billed.reduce((a, b) => a + b, 0)).toBeCloseTo(plan.totals.costUsd, 4)
  })

  it('lands tokens, API calls, operator-key asks, and cost on #overview', async () => {
    const store = memoryStore()
    const now = Date.parse('2026-09-02T20:00:00Z')
    const plan = planUsageImport(amountCsv, costCsv, now)
    await applyUsageImport(store, plan, 'tony.walteur@gmail.com')
    const dash = await buildDashboard(store, 'tony.walteur@gmail.com', now)
    expect(dash.usageWindow).toMatchObject({
      from: '2026-08-11',
      to: '2026-09-02',
      count: plan.asks.length,
      tokens: plan.totals.tokens
    })
    expect(dash.usageWindow?.costUsd).toBeCloseTo(plan.totals.costUsd, 6)
    expect(dash.ops.apiCalls).toBeGreaterThan(0)
    expect(dash.ops.tokens).toBeGreaterThan(0)
    expect(dash.ops.operatorAsks).toBeGreaterThan(0)
    expect(dash.kpis.cost7d).toMatch(/^\$/)
    const html = renderOverviewMini10(dash)
    expect(html).toContain('data-usage-landed="1"')
    expect(html).toContain('DeepSeek usage imported')
    expect(html).toContain('2026-08-11')
    expect(html).toContain('2026-09-02')
    expect(html).toContain('data-usage-stat="tokens"')
    expect(html).toContain('data-overview-cards="10"')
    expect(html).toContain('stat-card-landed')
  })
})
