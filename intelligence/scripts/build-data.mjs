#!/usr/bin/env node
// Reads the vault's real, grounded deal-psychology extraction output and assembles public/data.json
// in the shape src/types/data.ts expects. This is the "small build step" the plan calls for — it never
// runs inside the deployed app; the app only ever reads the static data.json this produces.
//
// public/data.json is gitignored (see .gitignore) — real client quotes never get committed. Run this
// locally whenever the vault's extraction output changes.
//
// Usage: node scripts/build-data.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const VAULT = '/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/AI Second Brain'
const OUT = join(import.meta.dirname, '..', 'public', 'data.json')

function readJSON(relPath) {
  return JSON.parse(readFileSync(join(VAULT, relPath), 'utf8'))
}

// --- L'Oréal / latam-sap-ams — the one real deal processed so far ---
const bidId = 'latam-sap-ams'
const psychology = readJSON(`_brain_api/bid/${bidId}/deal_psychology.json`)
const insightsRaw = readJSON(`_brain_api/bid/${bidId}/coaching_insights.json`)
const riskScore = readJSON(`_brain_api/bid/${bidId}/risk_score.json`)
const brief = readJSON('_brain_api/account/loreal/brief.json')
const openBids = readJSON('_brain_api/bid/_open.json')
const graph = readJSON('_brain_api/graph/account_graph.json')

const bidMeta = openBids.bids.find((b) => b.bid_id === bidId)

const meetingSlugs = readdirSync(join(VAULT, '_brain_api', 'meeting'))
const callGrades = meetingSlugs
  .map((slug) => {
    const cg = readJSON(`_brain_api/meeting/${slug}/call_grade.json`)
    if (cg.bid_id !== bidId) return null
    return {
      date: cg.date,
      label: cg.meeting_name,
      grade: cg.call_quality.band, // 'good' | 'mixed' | 'concerning' | 'not-applicable'
      note: cg.call_quality.reason,
      is_client_facing: cg.is_client_facing,
    }
  })
  .filter(Boolean)
  .sort((a, b) => a.date.localeCompare(b.date))

const claims = psychology.claims.map((c) => ({
  claim_id: c.claim_id,
  statement: c.statement,
  category: c.category,
  raised_by: c.raised_by,
  stance: c.stance,
  was_deciding_factor: c.was_deciding_factor,
  source: c.source,
  confidence: c.confidence,
}))

// The real extraction didn't assign a `category` field per insight (it's implied by content) — classify
// both by what they're actually about, matching the Category enum's existing distinction between raw
// price objections ('pricing') and deal-structure/contract-shape issues ('commercial-model').
const insightCategoryOverrides = {
  'Resource-based pricing reads as value-blind on AMS/AI deals': 'commercial-model',
  'Coverage-model mismatch between RFP intent and proposal (desk-staffed vs. on-call)': 'commercial-model',
}

const coachingInsights = insightsRaw.insights.map((ins, i) => ({
  insight_id: `${bidId}-insight-${i + 1}`,
  pattern: ins.pattern,
  n_observations: ins.n_observations,
  deals: ins.deals,
  what_happened: ins.what_happened,
  why_it_matters: ins.why_it_matters,
  coaching_move: ins.coaching_move,
  category: insightCategoryOverrides[ins.pattern] ?? 'process',
  confidence: ins.confidence,
  grounding: ins.grounding,
  sources: ins.sources.map((s) => ({ file: s.file, quote_or_paraphrase: s.quote_or_paraphrase })),
}))

const deal = {
  bid_id: bidId,
  account: brief.slug,
  // Genuinely absent from the current vault brief (a planned taxonomy field, never populated) — omit
  // rather than fabricate. See the optionality comment on Deal.strategic_group in types/data.ts.
  ...(brief.strategic_group?.key ? { strategic_group: brief.strategic_group.key } : {}),
  sector: brief.industry,
  display_name: `${bidMeta.company} — ${bidMeta.topic} (${bidMeta.path.split('/').pop()})`,
  outcome: 'open',
  win_likelihood_band: riskScore.win_likelihood.band,
  value_usd: bidMeta.value,
  stage: bidMeta.stage,
  claims,
  call_grades: callGrades,
}

// account_graph.json's node/edge shape differs slightly from the dashboard's GraphNode/GraphEdge type
// (it has richer real fields — ref, date, is_client_facing — the dashboard type is a display-focused
// subset). Map explicitly rather than passing the raw vault shape through; carry the real optional
// fields forward instead of dropping them.
const typeMap = { account: 'account', bid: 'deal', sector: 'sector', meeting: 'person' }
const graphNodes = graph.nodes.map((n) => {
  const degree = graph.edges.filter((e) => e.from === n.id || e.to === n.id).length
  return {
    id: n.id,
    label: n.label,
    type: typeMap[n.type] ?? n.type,
    ...(n.type === 'meeting' || n.type === 'bid' ? { account: 'loreal' } : {}),
    ...(n.type !== 'sector' && brief.strategic_group?.key ? { strategic_group: brief.strategic_group.key } : {}),
    ...(n.type !== 'sector' ? { sector: brief.industry } : {}),
    ...(n.win_likelihood_band ? { win_likelihood_band: n.win_likelihood_band } : {}),
    ...(n.type === 'bid' ? { bid_id: bidId } : {}),
    ...(n.ref ? { ref: n.ref } : {}),
    ...(n.date ? { date: n.date } : {}),
    ...(n.is_client_facing !== undefined ? { is_client_facing: n.is_client_facing } : {}),
    degree,
  }
})
const graphEdges = graph.edges.map((e) => ({
  from: e.from,
  to: e.to,
  relation: e.type,
  // account_graph.json doesn't carry graphify's EXTRACTED/INFERRED/AMBIGUOUS confidence tiers (that's a
  // graphify-specific concept for text-mined relations) — every edge here was explicitly constructed by
  // the extraction pipeline from real, checked source references, so EXTRACTED is the honest tier.
  confidence: 'EXTRACTED',
}))

// --- Real graph-structural clustering (connected components) ---
// Not hand-assigned, not text-mined "communities" — a plain union-find over the actual edges. With one
// deal in the vault every node is one connected blob, so this will show a single component today; the
// algorithm itself doesn't change once more deals/accounts create genuinely separate or bridged
// components. Label each component by its dominant sector (falling back to account) so it reads as a
// real business grouping instead of graphify's generic "Community N".
function findComponents(nodes, edges) {
  const parent = new Map(nodes.map((n) => [n.id, n.id]))
  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const e of edges) {
    if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to)
  }
  const rootToId = new Map()
  const componentOf = new Map()
  for (const n of nodes) {
    const root = find(n.id)
    if (!rootToId.has(root)) rootToId.set(root, rootToId.size)
    componentOf.set(n.id, rootToId.get(root))
  }
  return componentOf
}

const componentOf = findComponents(graphNodes, graphEdges)
const componentMembers = new Map()
for (const n of graphNodes) {
  const cid = componentOf.get(n.id)
  if (!componentMembers.has(cid)) componentMembers.set(cid, [])
  componentMembers.get(cid).push(n)
}
function majorityLabel(members, field) {
  const counts = new Map()
  for (const m of members) {
    if (!m[field]) continue
    counts.set(m[field], (counts.get(m[field]) ?? 0) + 1)
  }
  let best = null
  let bestCount = 0
  for (const [k, c] of counts) {
    if (c > bestCount) {
      best = k
      bestCount = c
    }
  }
  return best
}
const componentLabel = new Map()
for (const [cid, members] of componentMembers) {
  const label = majorityLabel(members, 'sector') ?? majorityLabel(members, 'account') ?? `Cluster ${cid}`
  componentLabel.set(cid, label)
}
for (const n of graphNodes) {
  const cid = componentOf.get(n.id)
  n.community_id = cid
  n.community_label = componentLabel.get(cid)
}

// --- Account / sector rollups for the win/loss + ROI intelligence panel ---
// Honest ROI proxy: deal value at stake + win-likelihood distribution + the real coaching insights
// tied to those deals. No fabricated ROI percentage — there's no cost/spend data in the vault to divide
// against, and the plan's own design principle (see deal-psychology-coaching-dashboard.md) is no fake
// precision.
function buildSummaries(deals, insights, keyFn) {
  const byKey = new Map()
  for (const d of deals) {
    const key = keyFn(d)
    if (!key) continue
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        label: key,
        deal_count: 0,
        total_value_usd: 0,
        band_counts: { good: 0, mixed: 0, concerning: 0 },
        insight_ids: [],
      })
    }
    const s = byKey.get(key)
    s.deal_count += 1
    s.total_value_usd += d.value_usd ?? 0
    s.band_counts[d.win_likelihood_band] += 1
    for (const ins of insights) {
      if (ins.deals.includes(d.bid_id) && !s.insight_ids.includes(ins.insight_id)) {
        s.insight_ids.push(ins.insight_id)
      }
    }
  }
  return Array.from(byKey.values())
}
const accountSummaries = buildSummaries([deal], coachingInsights, (d) => d.account)
const sectorSummaries = buildSummaries([deal], coachingInsights, (d) => d.sector)

const data = {
  meta: {
    is_placeholder: false,
    note:
      "n=1 deal (L'Oréal LATAM SAP AMS) processed through the grounded extraction pipeline. " +
      'Every claim, call grade, and rollup cites a real source quote checked against the vault. ' +
      'win_likelihood is a qualitative LLM-as-judge estimate — no statistical/historical model exists ' +
      '(no deal in this vault has ever closed won or lost). Account/sector/community filtering all show ' +
      'a single bucket today because only one deal has been processed — the structure is real and ready ' +
      'to scale, the diversity to filter across is not there yet.',
    generated: new Date().toISOString(),
    n_deals: 1,
  },
  deals: [deal],
  coaching_insights: coachingInsights,
  account_graph: { nodes: graphNodes, edges: graphEdges },
  account_summaries: accountSummaries,
  sector_summaries: sectorSummaries,
}

writeFileSync(OUT, JSON.stringify(data, null, 2))
console.log(`Wrote ${OUT}`)
console.log(`  ${claims.length} claims, ${coachingInsights.length} coaching insights, ${callGrades.length} call grades`)
console.log(`  graph: ${graphNodes.length} nodes, ${graphEdges.length} edges, ${componentMembers.size} component(s)`)
console.log(`  ${accountSummaries.length} account summaries, ${sectorSummaries.length} sector summaries`)
