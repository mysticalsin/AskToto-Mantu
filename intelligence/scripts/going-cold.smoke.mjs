// Runtime smoke for the Going-Cold engine — this workspace has no test runner, so the pure logic is
// proven by executable assertions via Node type-stripping. Run: `npm run smoke` (in intelligence/).
// Cited by docs/proof-of-numbers.md; if you change goingCold.ts or slug.ts, this must stay green.
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const { buildGoingCold, freshnessOf } = await import(join(here, '..', 'src', 'lib', 'goingCold.ts'))
const { slug } = await import(join(here, '..', 'src', 'lib', 'slug.ts'))

const NOW = new Date('2026-07-02T12:00:00Z').getTime()
const DAY = 86400000
const iso = (d) => new Date(NOW - d * DAY).toISOString().slice(0, 10)

assert.equal(freshnessOf(3), 'fresh')
assert.equal(freshnessOf(20), 'cooling')
assert.equal(freshnessOf(60), 'cold')

const b = {
  index: { warnings: [] },
  graph: { nodes: [], edges: [] },
  people: [
    { name: 'Claire Dubois', role: 'CFO', account: 'Acme', meetings: [{ file: 'a.md', date: iso(50), title: 'Budget review' }], commitments: [] },
    { name: 'Tom Reed', role: null, account: 'Acme', meetings: [{ file: 'b.md', date: iso(2), title: 'Sync' }], commitments: [] },
    { name: 'Solo Person', role: null, account: 'LoneCo', meetings: [{ file: 'c.md', date: iso(30), title: 'Intro call' }],
      commitments: [{ text: 'send the case study', by: 'you', status: 'open' }] }
  ],
  accounts: [
    { name: 'Acme', sector: 'banking', strategic: false, people: ['Claire Dubois', 'Tom Reed'], deals: [], meetings: [{ file: 'a.md', date: iso(2), title: 'Sync' }], win_reasons: [], loss_reasons: [] },
    { name: 'LoneCo', sector: 'other', strategic: false, people: ['Solo Person'], deals: [], meetings: [{ file: 'c.md', date: iso(30), title: 'Intro call' }], win_reasons: [], loss_reasons: [] },
    { name: 'GhostCorp', sector: 'other', strategic: false, people: [], deals: [], meetings: [{ file: 'd.md', date: iso(80), title: 'One-off chat' }], win_reasons: [], loss_reasons: [] }
  ],
  deals: [
    { name: 'Lone Deal', account: 'LoneCo', stage: 'proposal', outcome: 'open', win_likelihood_band: 'mixed', band_evidence: '', velocity: { signal: '', evidence: '' }, meetings: [{ file: 'c.md', date: iso(30), title: 'Intro call' }], signals: [], missed_signals: [], feedback: [],
      commitments: [{ text: 'share pricing grid', by: 'you', status: 'open' }] },
    { name: 'Acme Deal', account: 'Acme', stage: 'defense', outcome: 'open', win_likelihood_band: 'good', band_evidence: '', velocity: { signal: '', evidence: '' }, meetings: [{ file: 'b.md', date: iso(2), title: 'Sync' }], signals: [], missed_signals: [], feedback: [], commitments: [] }
  ],
  meetings: []
}

const g = buildGoingCold(b, NOW)

// Freshness on nodes
assert.equal(g.touch.get('person:claire-dubois').freshness, 'cold')
assert.equal(g.touch.get('person:tom-reed').freshness, 'fresh')
assert.equal(g.touch.get('account:acme').freshness, 'fresh')
assert.equal(g.touch.get('deal:lone-deal').freshness, 'cooling')

// Rail: coldest first; fresh entities absent
const labels = g.rail.map((r) => r.label)
assert.ok(labels.includes('Claire Dubois') && labels.includes('GhostCorp') && labels.includes('Solo Person'))
assert.ok(!labels.includes('Tom Reed') && !labels.includes('Acme'))
assert.equal(g.rail[0].label, 'GhostCorp') // 80d quiet leads

// Hooks: own open commitment ("you owe") beats topic fallback; topic fallback used when no ledger
const solo = g.rail.find((r) => r.label === 'Solo Person')
assert.ok(solo.hook.includes('send the case study'), solo.hook)
const ghost = g.rail.find((r) => r.label === 'GhostCorp')
assert.ok(ghost.hook.includes('One-off chat'), ghost.hook)
// Claire has no own commitments → falls back to Acme's pool (empty) → topic hook
const claire = g.rail.find((r) => r.label === 'Claire Dubois')
assert.ok(claire.hook.includes('Budget review'), claire.hook)

// Structural risk
assert.ok(g.singleThreaded.has('deal:lone-deal'))
assert.ok(!g.singleThreaded.has('deal:acme-deal'))
assert.ok(g.unmapped.has('account:ghostcorp'))
assert.ok(!g.unmapped.has('account:acme'))

// Diacritic join: the adapter slug MUST match the host store's slugify or accented entities fall
// out of every Going-Cold join (the original local slug turned "José" into "jos", store says "jose").
assert.equal(slug('José Álvarez'), 'jose-alvarez')
assert.equal(slug("L'Oréal"), 'l-oreal')
const b2 = {
  index: { warnings: [] },
  graph: { nodes: [], edges: [] },
  people: [{ name: 'José Álvarez', role: null, account: null, meetings: [{ file: 'j.md', date: iso(50), title: 'Intro' }], commitments: [] }],
  accounts: [],
  deals: [],
  meetings: []
}
const g2 = buildGoingCold(b2, NOW)
assert.ok(g2.touch.has('person:jose-alvarez'), 'accented person must join under the store slug')
assert.equal(g2.touch.get('person:jose-alvarez').freshness, 'cold')

// Case-insensitive `by`: an LLM-cased "You" must still land in the yours-branch and read correctly —
// not be misread as a third party literally named "You" owing the user (the semantically-backwards bug).
const b3 = {
  index: { warnings: [] },
  graph: { nodes: [], edges: [] },
  people: [{ name: 'Case Upper', role: null, account: null, meetings: [{ file: 'k.md', date: iso(50), title: 'Kickoff' }],
    commitments: [{ text: 'send the deck', by: 'You', status: 'open' }] }],
  accounts: [],
  deals: [],
  meetings: []
}
const g3 = buildGoingCold(b3, NOW)
const caseUpper = g3.rail.find((r) => r.label === 'Case Upper')
assert.ok(caseUpper.hook.startsWith('You still owe them: send the deck'), caseUpper.hook)

// Legacy shape: a commitment record with no `status` key at all must still count as open (mirrors
// LedgerCommitmentSchema's own default) rather than silently falling back to the weaker topic hook.
const b4 = {
  index: { warnings: [] },
  graph: { nodes: [], edges: [] },
  people: [{ name: 'Legacy Status', role: null, account: null, meetings: [{ file: 'l.md', date: iso(50), title: 'Old sync' }],
    commitments: [{ text: 'send the proposal', by: 'you' }] }],
  accounts: [],
  deals: [],
  meetings: []
}
const g4 = buildGoingCold(b4, NOW)
const legacyStatus = g4.rail.find((r) => r.label === 'Legacy Status')
assert.ok(legacyStatus.hook.includes('send the proposal'), legacyStatus.hook)

console.log('goingCold smoke: ALL ASSERTIONS PASSED —', g.rail.length, 'rail rows,', g.touch.size, 'touched nodes, diacritic join OK')
