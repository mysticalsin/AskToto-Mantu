import { describe, expect, it } from 'vitest'
import { fixtureDashboard, FIXTURE_EMAIL } from '../fixture'
import {
  renderPlatformHealthEnriched,
  renderProposalCard,
  renderQuestionTypeMixCard,
  renderQuestionsAnalytics,
  renderSettings,
  renderSkillsBoard,
  renderSkillsHistory,
  renderTierCard,
  type HealthEnriched,
  type ProposalCardData
} from './settings'
import type { QuestionsPayloadFull, SkillsPayloadFull } from '../../routes/insights'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderSettings (QA fixture)', () => {
  it('renders the header, all seven tabs and the sliding underline, no inline style=, no em dash', async () => {
    const data = await fixtureDashboard()
    const html = renderSettings(data, CTX)
    expect(html).toContain('>Settings<')
    expect(html).toContain('Operator configuration.')
    for (const label of ['Tiers', 'Value', 'Skills', 'Questions', 'Platform health', 'Session', 'Appearance']) {
      expect(html).toContain(`>${label}<`)
    }
    expect(html).toContain('data-settings-underline')
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })

  it('shows Tiers active on first paint and every other tab hidden', async () => {
    const data = await fixtureDashboard()
    const html = renderSettings(data, CTX)
    expect(html).toContain('data-settings-panel="tiers"')
    expect(html).not.toMatch(/data-settings-panel="tiers"[^>]*hidden/)
    for (const id of ['value', 'skills', 'questions', 'health', 'session', 'appearance']) {
      const re = new RegExp(`data-settings-panel="${id}"[^>]*hidden`)
      expect(html).toMatch(re)
    }
  })

  it('Tiers tab: two cards with the default entitlement checkboxes checked, seats loading', async () => {
    const data = await fixtureDashboard()
    const html = renderSettings(data, CTX)
    expect(html).toContain('data-tier-card="metis"')
    expect(html).toContain('data-tier-card="metis-light"')
    expect(html).toContain('Counting seats…')
    // Métis gets all 7, Métis Light gets exactly ask + intelligence (store.ts DEFAULT_TIER_ENTITLEMENTS).
    const metisSection = html.slice(html.indexOf('data-tier-card="metis"'), html.indexOf('data-tier-card="metis-light"'))
    for (const key of ['ask', 'listen', 'recap', 'crm_push', 'operator_keys', 'intelligence', 'integrations']) {
      expect(metisSection).toContain(`value="${key}" data-tier-entitlement checked`)
    }
    const lightSection = html.slice(html.indexOf('data-tier-card="metis-light"'))
    expect(lightSection).toContain('value="ask" data-tier-entitlement checked')
    expect(lightSection).toContain('value="intelligence" data-tier-entitlement checked')
    expect(lightSection).toContain('value="listen" data-tier-entitlement >')
  })

  it('Value tab: an unset hourly rate renders an empty, placeholder input, never a fabricated 0', async () => {
    const data = await fixtureDashboard()
    expect(data.roi.hourlyRate).toBeNull() // fixtureDashboard() passes no valueSettings
    const html = renderSettings(data, CTX)
    expect(html).toMatch(/name="hourlyRate"[^>]*value=""/)
    expect(html).toContain('placeholder="Loading…" disabled data-value-field="dailyTokenBudgetPerSeat"')
    expect(html).toContain('Set an hourly rate to see value')
  })

  it('Skills tab: renders the fixture proposals with status chips, a diff view with added/removed tints, and an Edit toggle, never Approve on a rejected proposal', async () => {
    const data = await fixtureDashboard()
    const html = renderSettings(data, CTX)
    expect(html).toContain('data-proposal-card="fx-proposal-0"') // pending
    expect(html).toContain('data-approve="fx-proposal-0"')
    expect(html).toContain('data-reject="fx-proposal-0"')
    expect(html).toContain('data-push="fx-proposal-1"') // approved
    expect(html).toContain('diff-add')
    expect(html).toContain('diff-del')
    expect(html).toContain('data-diff-edit-toggle="fx-proposal-0"')
    expect(html).toContain('data-diff="fx-proposal-2" hidden') // textarea for the rejected proposal, no approve/reject/push
    const rejectedCard = html.slice(html.indexOf('data-proposal-card="fx-proposal-2"'), html.indexOf('</article>', html.indexOf('data-proposal-card="fx-proposal-2"')))
    expect(rejectedCard).not.toContain('data-approve=')
    expect(rejectedCard).not.toContain('data-push=')
    expect(html).toContain('data-skills-history')
  })

  it('Questions tab: renders the fixture question type mix and a range control, with a loading skeleton for the fetched analytics', async () => {
    const data = await fixtureDashboard()
    const html = renderSettings(data, CTX)
    expect(html).toContain('data-questions-range')
    expect(html).toContain('data-questions-analytics')
    if (data.questions.mix.bars.length) {
      expect(html).toContain(data.questions.mix.bars[0].label)
    }
  })

  it('Platform health tab: renders the four real binding flags honestly and a loading region for the rest', async () => {
    const data = await fixtureDashboard()
    expect(data.keys.ingestBound).toBe(false) // fixtureDashboard() passes no key flags
    const html = renderSettings(data, CTX)
    expect(html).toContain('Not bound')
    expect(html).toContain('data-health-enriched')
  })

  it('Session tab: shows the real signed-in email, an honest gap for signed-in-since/expires, and a working Sign out form', async () => {
    const data = await fixtureDashboard()
    const html = renderSettings(data, CTX)
    expect(html).toContain(FIXTURE_EMAIL)
    expect(html).toContain('not reported')
    expect(html).toContain('action="/logout"')
  })

  it('Appearance tab: theme control mirrors the rail markup exactly (theme.ts selects on data-theme-choice), plus density and reduced motion controls', async () => {
    const data = await fixtureDashboard()
    const html = renderSettings(data, CTX)
    expect(html).toContain('data-theme-choice="system"')
    expect(html).toContain('data-theme-choice="light" aria-pressed="true"')
    expect(html).toContain('data-theme-choice="dark" aria-pressed="false"')
    expect(html).toContain('data-density-seg')
    expect(html).toContain('data-motion-seg')
  })
})

describe('renderTierCard (client enrichment contract)', () => {
  it('renders a real seat count once resolved', () => {
    const html = renderTierCard({ id: 'metis', label: 'Métis', entitlements: ['ask'], seats: 4 })
    expect(html).toContain('4 seats resolve to this tier')
    expect(html).not.toContain('Counting seats')
  })
})

describe('renderProposalCard / renderSkillsBoard (client enrichment contract)', () => {
  const base: ProposalCardData = {
    id: 'p1',
    skillId: 'answer',
    fromVersion: '1.0.0',
    status: 'pending',
    rationale: 'Clustered 3 recent asks.',
    diff: '- old line\n+ new line\n unchanged line',
    createdBy: 'tony.walteur@gmail.com',
    createdAt: 1_724_000_000_000,
    now: 1_725_000_000_000
  }

  it('shows a loading placeholder for evidence until it is supplied', () => {
    expect(renderProposalCard(base)).toContain('Loading evidence')
  })

  it('renders real evidence chips computed from asks, never raw text', () => {
    const html = renderProposalCard({
      ...base,
      evidence: { askCount: 5, topTypes: [{ type: 'code', label: 'Code', count: 3 }], ratings: { up: 2, down: 1 } }
    })
    expect(html).toContain('5 asks, last 30 d')
    expect(html).toContain('3 code')
    expect(html).toContain('2 up / 1 down')
  })

  it('renders an empty state with no proposals', () => {
    expect(renderSkillsBoard([])).toContain('No skill proposals yet.')
  })

  it('sorts pending before approved before rejected', () => {
    const html = renderSkillsBoard([
      { ...base, id: 'rej', status: 'rejected' },
      { ...base, id: 'app', status: 'approved' },
      { ...base, id: 'pen', status: 'pending' }
    ])
    expect(html.indexOf('data-proposal-card="pen"')).toBeLessThan(html.indexOf('data-proposal-card="app"'))
    expect(html.indexOf('data-proposal-card="app"')).toBeLessThan(html.indexOf('data-proposal-card="rej"'))
  })
})

describe('renderSkillsHistory (client enrichment contract)', () => {
  it('renders an honest empty state with nothing pushed', () => {
    expect(renderSkillsHistory([], 1_725_000_000_000)).toContain('Nothing pushed yet.')
  })

  it('renders a real pushed row with its adoption count', () => {
    const history: SkillsPayloadFull['history'] = [
      { id: 'pack1', skillId: 'answer', version: '1.1.0', sha256: 'a'.repeat(64), pushedAt: 1_724_000_000_000, pushedBy: 'tony.walteur@gmail.com', pulledBySeats: 3 }
    ]
    const html = renderSkillsHistory(history, 1_725_000_000_000)
    expect(html).toContain('1.1.0')
    expect(html).toContain('3 seats')
  })
})

describe('renderQuestionTypeMixCard', () => {
  it('renders an honest empty state with no asks', () => {
    expect(renderQuestionTypeMixCard({ bars: [] }, null)).toContain('No asks in this range yet.')
  })
})

describe('renderQuestionsAnalytics (client enrichment contract)', () => {
  const q: QuestionsPayloadFull = {
    ok: true,
    range: '7d',
    since: 1_724_000_000_000,
    until: 1_725_000_000_000,
    totalAsks: 10,
    mix: { classified: 10, total: 10, coverage: 1, bars: [{ type: 'code', label: 'Code', count: 6 }] },
    coverage: 1,
    byMode: [{ mode: 'answer', count: 10, topType: { type: 'code', label: 'Code', count: 6 }, ratings: { up: 3, down: 1 }, errorRate: 0.1, latencyP50Ms: 900 }],
    ratings: { rated: 4, up: 3, down: 1, positiveRate: 0.75 },
    errorRate: 0.1,
    latency: { p50Ms: 900, p95Ms: 2000, sampleSize: 10 },
    cache: { hitRate: 0.5, tokensRead: 100, tokensWrite: 50 },
    providers: [{ key: 'anthropic', count: 10 }],
    models: [{ key: 'anthropic / claude-sonnet-4-6', count: 10 }],
    cost: '≈$1.20',
    needsAttention: [
      { id: 'a1', ts: 1_724_900_000_000, mode: 'answer', questionType: 'code', provider: 'anthropic', model: 'claude-sonnet-4-6', outcome: 'error', rating: null, latencyMs: 3000, seat: 'Tonys-Mac' }
    ]
  }

  it('renders every stat, the by-mode table, provider and model mix, and an audited Reveal per needs-attention ask', () => {
    const html = renderQuestionsAnalytics(q)
    expect(html).toContain('75%') // positive rating
    expect(html).toContain('10%') // error rate
    expect(html).toContain('900 ms')
    expect(html).toContain('50%') // cache hit
    expect(html).toContain('≈$1.20')
    expect(html).toContain('answer')
    expect(html).toContain('anthropic')
    expect(html).toContain('data-reveal="a1"')
    expect(html).toContain('id="reveal"')
    expect(html).not.toContain('confidential')
  })

  it('reports honest not-reported values rather than a zero when a metric has no data', () => {
    const empty: QuestionsPayloadFull = {
      ...q,
      totalAsks: 0,
      byMode: [],
      ratings: { rated: 0, up: 0, down: 0, positiveRate: null },
      errorRate: null,
      latency: { p50Ms: null, p95Ms: null, sampleSize: 0 },
      cache: { hitRate: null, tokensRead: 0, tokensWrite: 0 },
      providers: [],
      models: [],
      cost: null,
      needsAttention: []
    }
    const html = renderQuestionsAnalytics(empty)
    expect(html).toContain('Nothing needs attention.')
    expect((html.match(/not reported/g) || []).length).toBeGreaterThan(0)
  })
})

describe('renderPlatformHealthEnriched (client enrichment contract)', () => {
  it('renders the real worker version, build time and schema status', () => {
    const h: HealthEnriched = {
      version: '1.2.3',
      builtAt: '2026-09-06T12:00:00Z',
      env: 'staging',
      d1Ok: true,
      schemaOk: true,
      schemaMissing: [],
      lastIngestAt: 1_725_000_000_000,
      lastCronAt: 1_724_990_000_000,
      sessionBound: true,
      oauthBound: false,
      teamDomainBound: true,
      policyAudBound: true
    }
    const html = renderPlatformHealthEnriched(h, 1_725_000_100_000)
    expect(html).toContain('1.2.3')
    expect(html).toContain('staging')
    expect(html).toContain('reachable')
    expect(html).toContain('every expected table is present')
  })

  it('names exactly which tables are missing rather than a generic failure', () => {
    const h: HealthEnriched = {
      version: 'dev',
      builtAt: null,
      env: 'production',
      d1Ok: false,
      schemaOk: false,
      schemaMissing: ['tiers', 'operator_settings'],
      lastIngestAt: null,
      lastCronAt: null,
      sessionBound: false,
      oauthBound: false,
      teamDomainBound: false,
      policyAudBound: false
    }
    const html = renderPlatformHealthEnriched(h, 1_725_000_000_000)
    expect(html).toContain('missing: tiers, operator_settings')
    expect(html).toContain('unreachable')
  })
})
