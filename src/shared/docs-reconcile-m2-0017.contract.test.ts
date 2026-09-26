/**
 * docs-reconcile-m2-0017.contract.test.ts — M2-0017.
 *
 * "Reconcile the docs with the kit" is easy to say and easy to silently skip: nothing forced
 * `docs/design/OPERATOR.md`'s 8-tab rail to admit the kit's 11-surface requirement, nothing pointed a
 * reader of `docs/asktoto-architecture.md` at the 2.0 platform doc, and nothing kept
 * `docs/security/AUDIT-10.md` / `AUDIT-20.md` from being read as covering a contract (the AI Gateway
 * no-content-retention contract) they predate and never test. A prose banner cannot defend itself
 * against the next rewrite, so this file makes each reconciliation point — and the "every design doc
 * carries a currency Status" rule the ticket's own verification line asks for — self-enforcing: a doc
 * that regresses (a rewrite that drops the pointer, a new design doc that ships with no Status line)
 * fails a named test instead of silently reintroducing the drift M2-0017 closed.
 *
 * Deliberately NOT asserted: any doc's full prose, or that a specific file was deleted. The ticket's own
 * rule is "never delete a doc outright" — these tests only check that the required pointer exists
 * somewhere in the file.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

describe('M2-0017 — every docs/design/*.md file carries a Status: line', () => {
  const dir = join(REPO, 'docs/design')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()

  it('found the design doc set (fails loudly if the directory moves or empties)', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  for (const file of files) {
    it(`docs/design/${file} contains a Status: line`, () => {
      expect(read(`docs/design/${file}`)).toMatch(/Status:/)
    })
  }
})

describe('M2-0017 — currency and supersession banners', () => {
  it('asktoto-architecture.md points readers at the 2.0 platform north star', () => {
    expect(read('docs/asktoto-architecture.md')).toMatch(/METIS-PLATFORM-NORTH-STAR\.md/)
  })

  it('MANTU-INTELLIGENCE.md is marked as the first increment of MASTER section 17', () => {
    const doc = read('docs/design/MANTU-INTELLIGENCE.md')
    expect(doc).toMatch(/first.{0,20}increment/i)
    expect(doc).toMatch(/section 17/i)
  })

  it('the compliance pack keeps its single-user scope and adds a multi-seat/Teams placeholder', () => {
    const doc = read('docs/compliance/README.md')
    expect(doc).toMatch(/single-user/i)
    expect(doc).toMatch(/multi-seat/i)
    expect(doc).toMatch(/Teams/)
  })

  it('AUDIT-10.md and AUDIT-20.md scope-note the AI Gateway no-content-retention contract', () => {
    for (const rel of ['docs/security/AUDIT-10.md', 'docs/security/AUDIT-20.md']) {
      const doc = read(rel)
      expect(doc, rel).toMatch(/no-content-retention/i)
      expect(doc, rel).toMatch(/AI Gateway/)
      expect(doc, rel).toMatch(/does not cover/i)
    }
  })

  it('OPERATOR.md and DESIGN.md route the 8-tab vs 11-surface question to decision D-16', () => {
    for (const rel of ['docs/design/OPERATOR.md', 'docs/design/DESIGN.md']) {
      expect(read(rel), rel).toMatch(/D-16/)
    }
  })

  it('the three overlapping voice/orb/bar designs route to the reconciliation ticket M2-0093', () => {
    for (const rel of [
      'docs/design/DESIGN.md',
      'docs/design/BAR-PILL.md',
      'docs/design/ORB-SELECTION.md',
      'docs/design/METIS-2.0-JARVIS-COMMAND.md',
      'docs/design/METIS-2.0-CAP2-WAKE-ADAPTERS.md'
    ]) {
      expect(read(rel), rel).toMatch(/M2-0093/)
    }
  })

  it('the meeting-intelligence 100x plan folds phases 6-8 into M2-0130, without deleting them', () => {
    const doc = read('docs/plans/2026-07-11-meeting-intelligence-100x-plan.md')
    expect(doc).toMatch(/M2-0130/)
    expect(doc).toMatch(/### Phase 6/)
    expect(doc).toMatch(/### Phase 7/)
    expect(doc).toMatch(/### Phase 8/)
  })

  it('never deletes a doc outright — every file named in the ticket scope still exists', () => {
    for (const rel of [
      'docs/asktoto-architecture.md',
      'docs/security/AUDIT-10.md',
      'docs/security/AUDIT-20.md',
      'docs/compliance/README.md',
      'docs/plans/2026-07-11-meeting-intelligence-100x-plan.md',
      'docs/plans/2026-07-10-packaged-local-ai-implementation-plan.md',
      'docs/plans/time-saved-and-summaries.md',
      'docs/design/MANTU-INTELLIGENCE.md'
    ]) {
      expect(() => read(rel), rel).not.toThrow()
    }
  })
})
