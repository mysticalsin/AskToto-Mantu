/**
 * GraphView.notes.test.ts
 *
 * Two defects Tony reported as one sentence ("I don't see the nodes or note in relationships"):
 *
 *  1. An empty graph rendered the vis-network canvas anyway — a black rectangle with a footer reading
 *     "0 nodes · 0 edges" and nothing saying why. Indistinguishable from a broken renderer. People and
 *     Accounts already had EmptyState for exactly this; Relationships was missed.
 *  2. Meeting/note nodes were filtered out of the display graph entirely, so the SOURCE of every
 *     relationship was invisible: the graph asserted two people were connected while hiding the note
 *     that proves it. The stated reason was density, which is a filter problem, not a deletion problem.
 *
 * Source-contract rather than render tests: GraphView statically imports vis-network, which wants a
 * canvas this suite does not boot. The adapter half IS behavioural (see adaptBrain tests).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const view = readFileSync(join(__dirname, 'GraphView.tsx'), 'utf8')
const adapter = readFileSync(join(__dirname, '..', 'lib', 'brainAdapter.ts'), 'utf8')
const types = readFileSync(join(__dirname, '..', 'types', 'data.ts'), 'utf8')

describe('Relationships never renders an unexplained blank canvas', () => {
  it('returns EmptyState when the graph has no nodes', () => {
    expect(view).toMatch(/import \{ EmptyState \} from '\.\.\/components\/EmptyState'/)
    expect(view).toMatch(/if \(graph\.nodes\.length === 0\) \{/)
    const branch = view.slice(view.indexOf('if (graph.nodes.length === 0) {'))
    expect(branch).toMatch(/<EmptyState/)
    expect(branch).toMatch(/title="Relationships"/)
  })

  it('the empty branch sits AFTER every hook, so the early return cannot break rules of hooks', () => {
    const guard = view.indexOf('if (graph.nodes.length === 0) {')
    expect(guard).toBeGreaterThan(-1)
    const after = view.slice(guard)
    expect(after).not.toMatch(/\buseMemo\(/)
    expect(after).not.toMatch(/\buseEffect\(/)
    expect(after).not.toMatch(/\buseState\(/)
    expect(after).not.toMatch(/\buseRef\(/)
  })

  it('separates sample data from an ingested-but-unlinked brain from an empty one', () => {
    const branch = view.slice(view.indexOf('if (graph.nodes.length === 0) {'), view.indexOf('<EmptyState'))
    // Sample data must never tell someone to go record a meeting: that sends them to fix the wrong thing.
    expect(branch).toMatch(/data\.meta\.is_placeholder/)
    expect(branch).toMatch(/accounts\.length > 0 \|\| people\.length > 0/)
    expect(branch).toMatch(/bundled sample data/)
    expect(branch).toMatch(/none of them are linked yet/)
    expect(branch).toMatch(/Nothing has been ingested yet/)
  })
})

describe('notes are nodes', () => {
  it('the display type carries meeting', () => {
    expect(types).toMatch(/\| 'meeting'/)
  })

  it('the adapter keeps meeting nodes instead of dropping them', () => {
    expect(adapter).toMatch(/const keepTypes = new Set\(\['account', 'person', 'deal', 'sector', 'meeting'\]\)/)
    // The old comment justified deletion by density. If that reasoning comes back, so does the bug.
    expect(adapter).not.toMatch(/Meetings are dropped from the DISPLAY graph/)
  })

  it('a meeting node is its own source, not the latest meeting of some other entity', () => {
    expect(adapter).toMatch(/const meetingSelf =/)
    expect(adapter).toMatch(/indexedMeetings\.find\(\(m\) => slug\(m\.source_file\) === bare\)/)
    expect(adapter).toMatch(/\{ file: meetingSelf\.source_file, date: meetingSelf\.date \?\? '' \}/)
  })

  it('a meeting answers to its account filter, so hiding an account hides its notes too', () => {
    expect(adapter).toMatch(/n\.type === 'meeting' \? meetingSelf\?\.account\?\.name \?\? undefined/)
    expect(adapter).toMatch(/n\.type === 'meeting' && meetingSelf\?\.account\?\.name/)
  })

  it('notes are visible by default and have their own toggle', () => {
    expect(view).toMatch(/const \[showNotes, setShowNotes\] = useState\(true\)/)
    expect(view).toMatch(/if \(n\.type === 'meeting' && !showNotes\) return false/)
    expect(view).toMatch(/Show meeting notes/)
    // The toggle is dead unless both filter paths re-run when it flips.
    const deps = [...view.matchAll(/\}, \[[^\]]*hiddenAccounts[^\]]*\]\)/g)].map((m) => m[0])
    expect(deps.length).toBeGreaterThanOrEqual(2)
    for (const d of deps) expect(d).toMatch(/showNotes/)
  })

  it('a note is drawn as the smallest node and as a square, so it cannot outshout an entity', () => {
    expect(view).toMatch(/meeting: 10,/)
    expect(view).toMatch(/shape: n\.type === 'meeting' \? 'square' : 'dot'/)
    const sizes = /const TYPE_SIZE[^}]*}/.exec(view)?.[0] ?? ''
    const nums = [...sizes.matchAll(/(\w+): (\d+)/g)].map((m) => [m[1], Number(m[2])] as const)
    const meeting = nums.find(([k]) => k === 'meeting')?.[1] ?? 0
    for (const [k, v] of nums) if (k !== 'meeting') expect(meeting).toBeLessThan(v)
  })

  it('the legend explains the square, and the footer counts notes', () => {
    expect(view).toMatch(/Squares are meeting notes/)
    expect(view).toMatch(/note\$\{noteCount === 1 \? '' : 's'\}/)
  })
})
