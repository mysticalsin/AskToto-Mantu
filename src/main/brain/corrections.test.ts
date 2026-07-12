import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { MeetingExtractionSchema, type MeetingExtraction, type CorrectionEntry } from '@shared/brain'
import { ingestExtraction } from './ingest'
import { buildBrainContext } from './context'
import {
  brainDir,
  slugify,
  readGraph,
  readPerson,
  readAccount,
  readDeal,
  readMeetingExtraction,
  listEntities,
  purgeBrain,
  writeJson,
  withEntityLock
} from './store'
import {
  renameEntity,
  mergeEntities,
  unmergeEntities,
  updateEntityField,
  rejectCommitment,
  replayCorrections,
  readAliasMap,
  aliasMapFromJournal,
  applyCorrections,
  readCorrectionsJournal,
  readCorrectionsJournalSafe,
  isJournalCorruptionBlocked,
  clearJournalCorruptionLock
} from './corrections'

vi.mock('electron')

/** Recursively sorts object keys, and sorts arrays-of-objects by their canonical JSON text — makes
 *  comparisons order-insensitive for arrays whose element order is an ingestion-order artifact, not
 *  part of what a given test is proving. Copied from brain.test.ts's own helper (same convention). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize)
    const allPlainObjects = mapped.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
    return allPlainObjects
      ? [...mapped].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : mapped
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

const settingsFor = (folder: string, encrypt = false): Settings =>
  ({ meetingsFolder: folder, encryptTranscripts: encrypt }) as Settings

/** Raw (schema-unchecked) snapshot of every entity file on disk, keyed by "kind/slug" — this is what
 *  proves rebuild+replay converges byte-for-byte, tombstones included (readPerson/readAccount/readDeal
 *  would silently drop a tombstone as "not found", hiding exactly the divergence this test must catch). */
function snapshotEntities(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const kind of ['person', 'account', 'deal'] as const) {
    for (const slug of listEntities(s, kind)) {
      const p = join(brainDir(s), 'entities', kind, `${slug}.json`)
      out[`${kind}/${slug}`] = canonicalize(JSON.parse(readFileSync(p, 'utf8')))
    }
  }
  return out
}

const transcriptMd = (date: string): string =>
  `---\ntype: meeting-transcript\nsource: Métis\nmode: "meeting"\ndate: ${date}\n---\n\n## Full transcript\n\n**[10:00:00] Them:** hello\n`

describe('corrections engine', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-corrections-test-'))
    s = settingsFor(folder)
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  // Three synthetic meetings — planted directly through ingestExtraction (the exact production path
  // minus the LLM call, mirroring e2e-proof.test.ts's convention), then corrected by hand.
  const meeting1 = (): MeetingExtraction =>
    MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      people: [{ name: 'Maria Silva', role: 'CFO', org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Acme Core Banking', stage: 'discovery' },
      commitments: [{ text: 'send the deck', by: 'you', quote: '"send the deck"', confidence: 'EXTRACTED' }]
    })
  const meeting2 = (): MeetingExtraction =>
    MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      people: [{ name: 'M Silva', role: null, org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Acme Core Banking', stage: 'proposal' }
    })
  const meeting3 = (): MeetingExtraction =>
    MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      people: [{ name: 'Maria Silva', role: null, org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Acme Core Banking', stage: 'closing' },
      commitments: [{ text: 'intro the CISO', by: 'Maria Silva', quote: '"intro the CISO"', confidence: 'EXTRACTED' }]
    })

  const ingestThreeMeetings = async (sx: Settings): Promise<void> => {
    await ingestExtraction(sx, meeting1(), transcriptMd('2026-06-01'), join(folder, 'm1.md'))
    await ingestExtraction(sx, meeting2(), transcriptMd('2026-06-02'), join(folder, 'm2.md'))
    await ingestExtraction(sx, meeting3(), transcriptMd('2026-06-03'), join(folder, 'm3.md'))
  }

  const DEAL_SLUG = slugify('Acme Core Banking')
  const ACCOUNT_SLUG = slugify('Acme Corp')
  const MARIA_SLUG = slugify('Maria Silva')
  const M_SILVA_SLUG = slugify('M Silva')

  /** Applies one of each starred correction kind (rename, merge, field pin, commitment reject) on top
   *  of the 3-meeting brain. Returns the deal slug once the rename/merge have run (both are id-stable). */
  const applyAllCorrections = async (sx: Settings): Promise<void> => {
    const renamed = await renameEntity(sx, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
    expect(renamed.ok).toBe(true)

    const merged = await mergeEntities(sx, { kind: 'person', fromId: M_SILVA_SLUG, intoId: MARIA_SLUG })
    expect(merged.ok).toBe(true)

    const pinned = await updateEntityField(sx, { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'contract' })
    expect(pinned.ok).toBe(true)

    const rejected = await rejectCommitment(sx, { personSlug: MARIA_SLUG, dealSlug: DEAL_SLUG, text: 'intro the CISO' })
    expect(rejected.ok).toBe(true)
  }

  // ── ★ Rebuild-converges ──────────────────────────────────────────────────
  it('rebuild + replay reproduces the live-corrected entity files byte-for-byte', async () => {
    await ingestThreeMeetings(s)
    await applyAllCorrections(s)

    const liveSnapshot = snapshotEntities(s)
    // Sanity: the corrections actually took effect before we assert convergence.
    expect((liveSnapshot[`account/${ACCOUNT_SLUG}`] as { name: string }).name).toBe('Acme')
    expect(liveSnapshot[`person/${M_SILVA_SLUG}`]).toMatchObject({ merged_into: MARIA_SLUG })
    expect((liveSnapshot[`deal/${DEAL_SLUG}`] as { stage: string }).stage).toBe('contract')

    // Simulate brain:rebuildAll: purge derived entities (preserving the correction journal, exactly
    // like the real IPC handler does), re-run ingest of the SAME extractions, then replay corrections.
    const purge = purgeBrain(s, { preserveCorrections: true })
    expect(purge.ok).toBe(true)
    expect(readCorrectionsJournal(s)).toHaveLength(4) // journal survived the purge

    await ingestThreeMeetings(s)
    const replay = await replayCorrections(s)
    expect(replay.warnings).toEqual([])
    expect(replay.applied).toBe(4)

    const rebuiltSnapshot = snapshotEntities(s)
    expect(rebuiltSnapshot).toEqual(liveSnapshot)
  })

  // ── ★ Rebuild-converges: rename BEFORE later meetings (reviewer's exact repro) ──
  // Root cause under test: replayCorrections runs only after full re-ingest, so during re-ingest no
  // entity-file alias exists yet for post-rename names — routing must come from the JOURNAL.
  const accountOnly = (name: string): MeetingExtraction =>
    MeetingExtractionSchema.parse({ account: { name, sector: 'banking', confidence: 'EXTRACTED' } })

  it('rebuild does not fork a duplicate when a rename precedes later meetings that use the corrected name', async () => {
    await ingestExtraction(s, accountOnly('Acme Corp'), transcriptMd('2026-06-01'), join(folder, 'r1.md'))
    const renamed = await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
    expect(renamed.ok).toBe(true)
    await ingestExtraction(s, accountOnly('Acme'), transcriptMd('2026-06-02'), join(folder, 'r2.md'))
    expect(listEntities(s, 'account')).toEqual([ACCOUNT_SLUG]) // live path already routes via entity aliases

    const liveSnapshot = snapshotEntities(s)

    expect(purgeBrain(s, { preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, accountOnly('Acme Corp'), transcriptMd('2026-06-01'), join(folder, 'r1.md'))
    await ingestExtraction(s, accountOnly('Acme'), transcriptMd('2026-06-02'), join(folder, 'r2.md'))
    const replay = await replayCorrections(s)
    expect(replay.warnings).toEqual([])

    // Reviewer reproduced ['acme', 'acme-corp'] here — the second meeting must NOT fork a new entity.
    expect(listEntities(s, 'account')).toEqual([ACCOUNT_SLUG])
    expect(snapshotEntities(s)).toEqual(liveSnapshot)
  })

  it('rebuild converges across a rename chain A→B→C with meetings under all three names', async () => {
    const ID = slugify('Alpha Analytics')
    await ingestExtraction(s, accountOnly('Alpha Analytics'), transcriptMd('2026-06-01'), join(folder, 'c1.md'))
    expect((await renameEntity(s, { kind: 'account', id: ID, newName: 'Beta Analytics' })).ok).toBe(true)
    await ingestExtraction(s, accountOnly('Beta Analytics'), transcriptMd('2026-06-02'), join(folder, 'c2.md'))
    expect((await renameEntity(s, { kind: 'account', id: ID, newName: 'Gamma Analytics' })).ok).toBe(true)
    await ingestExtraction(s, accountOnly('Gamma Analytics'), transcriptMd('2026-06-03'), join(folder, 'c3.md'))
    expect(listEntities(s, 'account')).toEqual([ID])

    const liveSnapshot = snapshotEntities(s)
    expect((liveSnapshot[`account/${ID}`] as { name: string; aliases: string[] }).name).toBe('Gamma Analytics')

    expect(purgeBrain(s, { preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, accountOnly('Alpha Analytics'), transcriptMd('2026-06-01'), join(folder, 'c1.md'))
    await ingestExtraction(s, accountOnly('Beta Analytics'), transcriptMd('2026-06-02'), join(folder, 'c2.md'))
    await ingestExtraction(s, accountOnly('Gamma Analytics'), transcriptMd('2026-06-03'), join(folder, 'c3.md'))
    const replay = await replayCorrections(s)
    expect(replay.warnings).toEqual([])

    expect(listEntities(s, 'account')).toEqual([ID]) // transitive: A and B must both resolve to the one entity
    expect(snapshotEntities(s)).toEqual(liveSnapshot)
  })

  // ── ★ Rebuild-converges: old-name-reuse-after-rename (FIX 1 — reviewer's exact probe) ───
  // Root cause under test: applyRename never retroactively rewrote already-baked dependent display
  // strings (deal.account, person.account/org_provenance.value) elsewhere, AND display rewrite used the
  // entity-file map alone — so a POST-rename meeting that reuses the OLD name, introducing a NEW deal +
  // NEW person, baked the OLD name during a rebuild's re-ingest (journal not yet replayed at that point)
  // while the live path baked the NEW name (entity-file alias already present by then). Divergent.
  it('rebuild converges when a post-rename meeting reuses the old account name for a NEW deal + person', async () => {
    const preRename = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      people: [{ name: 'Priya Patel', role: null, org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Acme Core Banking', stage: 'discovery' }
    })
    await ingestExtraction(s, preRename, transcriptMd('2026-06-01'), join(folder, 'g1.md'))
    const renamed = await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
    expect(renamed.ok).toBe(true)

    // Retroactive rewrite (FIX 1a): the PRE-rename person's already-baked org gets repainted too.
    const PRIYA_SLUG = slugify('Priya Patel')
    expect(readPerson(s, PRIYA_SLUG)!.org_provenance!.value).toBe('Acme')
    expect(readPerson(s, PRIYA_SLUG)!.account).toBe('Acme')
    expect(readDeal(s, DEAL_SLUG)!.account).toBe('Acme')

    // POST-rename meeting REUSES the old name "Acme Corp", introducing a NEW deal + NEW person.
    const postRenameReuse = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      people: [{ name: 'Noah Novak', role: null, org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Acme Renewal', stage: 'discovery' }
    })
    await ingestExtraction(s, postRenameReuse, transcriptMd('2026-07-01'), join(folder, 'g2.md'))
    const NEW_DEAL_SLUG = slugify('Acme Renewal')
    const NOAH_SLUG = slugify('Noah Novak')

    // Reviewer's exact assertions: live already shows the corrected name in all three spots.
    expect(readDeal(s, NEW_DEAL_SLUG)!.account).toBe('Acme')
    expect(readPerson(s, NOAH_SLUG)!.account).toBe('Acme')
    expect(readPerson(s, NOAH_SLUG)!.org_provenance!.value).toBe('Acme')
    expect(listEntities(s, 'account')).toEqual([ACCOUNT_SLUG]) // no fork

    const liveSnapshot = snapshotEntities(s)

    expect(purgeBrain(s, { preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, preRename, transcriptMd('2026-06-01'), join(folder, 'g1.md'))
    await ingestExtraction(s, postRenameReuse, transcriptMd('2026-07-01'), join(folder, 'g2.md'))
    const replay = await replayCorrections(s)
    expect(replay.warnings).toEqual([])

    // Reviewer reproduced "Acme Corp" here on all three — must now read "Acme", matching live.
    expect(readDeal(s, NEW_DEAL_SLUG)!.account).toBe('Acme')
    expect(readPerson(s, NOAH_SLUG)!.account).toBe('Acme')
    expect(readPerson(s, NOAH_SLUG)!.org_provenance!.value).toBe('Acme')
    expect(listEntities(s, 'account')).toEqual([ACCOUNT_SLUG])
    expect(snapshotEntities(s)).toEqual(liveSnapshot)
  })

  // ── ★ Rebuild-converges: rename chain A→B→C, each hop reused by a NEW deal + person (FIX 1) ─
  // Stronger variant of the existing A→B→C fixture above: here every intermediate meeting reuses an
  // EARLIER surface form (not just the immediately-preceding one) to introduce fresh entities, exercising
  // the sweep's "known surface forms" set (old name + all prior aliases), not just a single-hop rename.
  it('rebuild converges across a rename chain A→B→C when intermediate meetings reuse earlier names for new deals/people', async () => {
    const ID = slugify('Alpha Analytics')
    const m1 = MeetingExtractionSchema.parse({
      account: { name: 'Alpha Analytics', sector: 'other', confidence: 'EXTRACTED' },
      people: [{ name: 'Dana Diaz', role: null, org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Alpha Rollout', stage: 'discovery' }
    })
    await ingestExtraction(s, m1, transcriptMd('2026-06-01'), join(folder, 'ch1.md'))
    expect((await renameEntity(s, { kind: 'account', id: ID, newName: 'Beta Analytics' })).ok).toBe(true)

    // Reuses the OLDEST name ("Alpha Analytics") post-first-rename, introducing a new deal + person.
    const m2 = MeetingExtractionSchema.parse({
      account: { name: 'Alpha Analytics', sector: 'other', confidence: 'EXTRACTED' },
      people: [{ name: 'Evan Ellis', role: null, org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Alpha Expansion', stage: 'discovery' }
    })
    await ingestExtraction(s, m2, transcriptMd('2026-06-02'), join(folder, 'ch2.md'))
    expect((await renameEntity(s, { kind: 'account', id: ID, newName: 'Gamma Analytics' })).ok).toBe(true)

    // Reuses the MIDDLE name ("Beta Analytics") post-second-rename, introducing another new deal+person.
    const m3 = MeetingExtractionSchema.parse({
      account: { name: 'Beta Analytics', sector: 'other', confidence: 'EXTRACTED' },
      people: [{ name: 'Farah Faris', role: null, org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Beta Followup', stage: 'discovery' }
    })
    await ingestExtraction(s, m3, transcriptMd('2026-06-03'), join(folder, 'ch3.md'))
    expect(listEntities(s, 'account')).toEqual([ID]) // never forked across any hop

    const DEAL1 = slugify('Alpha Rollout')
    const DEAL2 = slugify('Alpha Expansion')
    const DEAL3 = slugify('Beta Followup')
    const DANA = slugify('Dana Diaz')
    const EVAN = slugify('Evan Ellis')
    const FARAH = slugify('Farah Faris')
    for (const dealSlug of [DEAL1, DEAL2, DEAL3]) expect(readDeal(s, dealSlug)!.account).toBe('Gamma Analytics')
    for (const personSlug of [DANA, EVAN, FARAH]) {
      expect(readPerson(s, personSlug)!.org_provenance!.value).toBe('Gamma Analytics')
    }

    const liveSnapshot = snapshotEntities(s)

    expect(purgeBrain(s, { preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, m1, transcriptMd('2026-06-01'), join(folder, 'ch1.md'))
    await ingestExtraction(s, m2, transcriptMd('2026-06-02'), join(folder, 'ch2.md'))
    await ingestExtraction(s, m3, transcriptMd('2026-06-03'), join(folder, 'ch3.md'))
    const replay = await replayCorrections(s)
    expect(replay.warnings).toEqual([])

    expect(listEntities(s, 'account')).toEqual([ID])
    for (const dealSlug of [DEAL1, DEAL2, DEAL3]) expect(readDeal(s, dealSlug)!.account).toBe('Gamma Analytics')
    for (const personSlug of [DANA, EVAN, FARAH]) {
      expect(readPerson(s, personSlug)!.org_provenance!.value).toBe('Gamma Analytics')
    }
    expect(snapshotEntities(s)).toEqual(liveSnapshot)
  })

  // ── ★ Rebuild-converges: account MERGE with a pre-merge meeting naming the loser (round-4 e1) ──
  // Root cause under test: applyMerge swept only person-kind dependents (account.people). An account
  // merge leaves deal.account / person.org_provenance.value baked with the LOSING account's name on the
  // live path, while a rebuild's union-map re-ingest bakes the SURVIVOR's name from the start. Divergent.
  it('rebuild converges when an account merge follows a meeting naming the merged-away account (e1 probe)', async () => {
    const m1 = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      people: [{ name: 'Rita Rossi', role: null, org: null, confidence: 'EXTRACTED' }],
      deal: { name: 'Acme Core Banking', stage: 'discovery' }
    })
    const m2 = MeetingExtractionSchema.parse({
      account: { name: 'Acme Holdings', sector: 'banking', confidence: 'EXTRACTED' }
    })
    await ingestExtraction(s, m1, transcriptMd('2026-06-01'), join(folder, 'am1.md'))
    await ingestExtraction(s, m2, transcriptMd('2026-06-02'), join(folder, 'am2.md'))
    const HOLDINGS = slugify('Acme Holdings')
    const RITA = slugify('Rita Rossi')
    expect((await mergeEntities(s, { kind: 'account', fromId: ACCOUNT_SLUG, intoId: HOLDINGS })).ok).toBe(true)

    // Retroactive sweep at merge time: dependents baked with the losing side's name are repainted.
    expect(readDeal(s, DEAL_SLUG)!.account).toBe('Acme Holdings')
    expect(readPerson(s, RITA)!.org_provenance!.value).toBe('Acme Holdings')
    expect(readPerson(s, RITA)!.account).toBe('Acme Holdings')

    const liveSnapshot = snapshotEntities(s)

    expect(purgeBrain(s, { preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, m1, transcriptMd('2026-06-01'), join(folder, 'am1.md'))
    await ingestExtraction(s, m2, transcriptMd('2026-06-02'), join(folder, 'am2.md'))
    const replay = await replayCorrections(s)
    expect(replay.warnings).toEqual([])

    expect(readDeal(s, DEAL_SLUG)!.account).toBe('Acme Holdings')
    expect(readPerson(s, RITA)!.org_provenance!.value).toBe('Acme Holdings')
    expect(snapshotEntities(s)).toEqual(liveSnapshot)
  })

  // ── ★ Rebuild-converges: deal RENAME repaints account.deals[] (round-4 e2) ──────────────
  // Root cause under test: account.deals[] holds bare deal display names pushed verbatim at ingest
  // (mergeExtraction) and never refreshed — a deal rename left the old name baked live, while a
  // rebuild's union-map re-ingest baked the new name from the start.
  it('rebuild converges on account.deals[] when a deal is renamed (e2 probe)', async () => {
    const m1 = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      deal: { name: 'Acme Core Banking', stage: 'discovery' }
    })
    await ingestExtraction(s, m1, transcriptMd('2026-06-01'), join(folder, 'dr1.md'))
    expect(readAccount(s, ACCOUNT_SLUG)!.deals).toEqual(['Acme Core Banking'])
    expect((await renameEntity(s, { kind: 'deal', id: DEAL_SLUG, newName: 'Acme Core Banking 2.0' })).ok).toBe(true)

    // Retroactive sweep: the account's baked deals[] entry is repainted at rename time.
    expect(readAccount(s, ACCOUNT_SLUG)!.deals).toEqual(['Acme Core Banking 2.0'])

    const liveSnapshot = snapshotEntities(s)

    expect(purgeBrain(s, { preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, m1, transcriptMd('2026-06-01'), join(folder, 'dr1.md'))
    const replay = await replayCorrections(s)
    expect(replay.warnings).toEqual([])

    expect(readAccount(s, ACCOUNT_SLUG)!.deals).toEqual(['Acme Core Banking 2.0'])
    expect(snapshotEntities(s)).toEqual(liveSnapshot)
  })

  // ── ★ Rebuild-converges: deal MERGE repaints + collapses account.deals[] (round-4 variant) ──
  it('rebuild converges on account.deals[] when a deal is merged away (deal-merge variant)', async () => {
    const m1 = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      deal: { name: 'Acme Core Banking', stage: 'discovery' }
    })
    const m2 = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      deal: { name: 'Acme Banking Program', stage: 'proposal' }
    })
    await ingestExtraction(s, m1, transcriptMd('2026-06-01'), join(folder, 'dm1.md'))
    await ingestExtraction(s, m2, transcriptMd('2026-06-02'), join(folder, 'dm2.md'))
    const PROGRAM = slugify('Acme Banking Program')
    expect(readAccount(s, ACCOUNT_SLUG)!.deals).toEqual(['Acme Core Banking', 'Acme Banking Program'])
    expect((await mergeEntities(s, { kind: 'deal', fromId: DEAL_SLUG, intoId: PROGRAM })).ok).toBe(true)

    // Sweep repaints the losing name to the survivor's and the re-dedupe collapses the collision —
    // exactly what a fresh ingest under the union alias map produces.
    expect(readAccount(s, ACCOUNT_SLUG)!.deals).toEqual(['Acme Banking Program'])

    const liveSnapshot = snapshotEntities(s)

    expect(purgeBrain(s, { preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, m1, transcriptMd('2026-06-01'), join(folder, 'dm1.md'))
    await ingestExtraction(s, m2, transcriptMd('2026-06-02'), join(folder, 'dm2.md'))
    const replay = await replayCorrections(s)
    expect(replay.warnings).toEqual([])

    expect(readAccount(s, ACCOUNT_SLUG)!.deals).toEqual(['Acme Banking Program'])
    expect(snapshotEntities(s)).toEqual(liveSnapshot)
  })

  // ── [documented, out of scope] stored meeting-extraction files do NOT converge (feeds MI-4) ──
  // applyRename's retroactive sweep (FIX 1a) intentionally touches only ENTITY files (deal.account,
  // person.account/org_provenance, account.people, graph labels) — never the stored
  // `.brain/meetings/<slug>.json` extraction itself, which is the as-extracted historical record of what
  // a meeting actually said. A meeting that PREDATES a rename is re-ingested under the UNION alias map
  // during a rebuild (the journal already knows the rename before replay runs), so its stored extraction
  // bakes the POST-rename name on rebuild — while the live path's stored extraction, written before the
  // rename ever happened in real time, keeps the PRE-rename name. This is a deliberate, accepted
  // asymmetry (entity files are the corrected view; extraction files are the historical record), not a
  // defect this task fixes — task MI-4 (verified numbers / windowed extraction) should be aware of it.
  it('[documented] a PRE-rename meeting\'s stored extraction file does NOT converge live vs rebuilt', async () => {
    const preRename = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' }
    })
    const file = join(folder, 'x1.md')
    await ingestExtraction(s, preRename, transcriptMd('2026-06-01'), file)
    expect((await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })).ok).toBe(true)

    const extractionSlug = slugify(basename(file))
    const liveExtraction = readMeetingExtraction(s, extractionSlug)
    expect(liveExtraction!.account!.name).toBe('Acme Corp') // written before the rename ever happened

    expect(purgeBrain(s, { preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, preRename, transcriptMd('2026-06-01'), file)
    await replayCorrections(s)
    const rebuiltExtraction = readMeetingExtraction(s, extractionSlug)
    // Diverges from live ON PURPOSE — see the comment above. This pins the KNOWN asymmetry: if this
    // assertion ever starts failing because the value flips back to 'Acme Corp', extraction-file
    // convergence behavior has changed and MI-4 should be told.
    expect(rebuiltExtraction!.account!.name).toBe('Acme')
    expect(rebuiltExtraction!.account!.name).not.toBe(liveExtraction!.account!.name)
  })

  // ── ★ Rebuild-converges: a pin on an entity later merged away (FIX 2) ────────────────────
  // Root cause under test: replayCorrections applied a field_update against its ORIGINAL id even when a
  // LATER journal entry merges that id away. During a rebuild, re-ingest routes the merged-away target's
  // meetings straight to the merge survivor (readAliasMap already knows the merge), so the original id's
  // file never materializes at replay time — the pin spuriously "fails" (warns "not found", undercounts
  // applied) even though it genuinely survives via the later merge's own snapshot fold.
  it('a pin on an entity later merged away replays with zero warnings and applied === entry count', async () => {
    const alice = MeetingExtractionSchema.parse({
      people: [{ name: 'Alice Adams', role: 'Analyst', org: null, confidence: 'EXTRACTED' }]
    })
    const bob = MeetingExtractionSchema.parse({
      people: [{ name: 'Bob Baker', role: null, org: null, confidence: 'EXTRACTED' }]
    })
    await ingestExtraction(s, alice, transcriptMd('2026-06-01'), join(folder, 'pin1.md'))
    await ingestExtraction(s, bob, transcriptMd('2026-06-02'), join(folder, 'pin2.md'))
    const ALICE = slugify('Alice Adams')
    const BOB = slugify('Bob Baker')

    const pinned = await updateEntityField(s, { kind: 'person', id: ALICE, field: 'role', value: 'Pinned Role' })
    expect(pinned.ok).toBe(true)
    const merged = await mergeEntities(s, { kind: 'person', fromId: ALICE, intoId: BOB })
    expect(merged.ok).toBe(true)

    expect(readPerson(s, BOB)!.role).toBe('Pinned Role')
    expect(readPerson(s, BOB)!.role_provenance?.state).toBe('pinned')

    expect(readCorrectionsJournal(s)).toHaveLength(2)
    const liveSnapshot = snapshotEntities(s)

    expect(purgeBrain(s, { preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, alice, transcriptMd('2026-06-01'), join(folder, 'pin1.md'))
    await ingestExtraction(s, bob, transcriptMd('2026-06-02'), join(folder, 'pin2.md'))
    const replay = await replayCorrections(s)

    expect(replay.warnings).toEqual([])
    expect(replay.applied).toBe(2)
    expect(readPerson(s, BOB)!.role).toBe('Pinned Role')
    expect(snapshotEntities(s)).toEqual(liveSnapshot)
  })

  // ── aliasMapFromJournal (pure) ───────────────────────────────────────────
  it('aliasMapFromJournal resolves rename chains transitively, maps merge surface forms, and honors unmerge annulment', () => {
    const at = '2026-07-11T00:00:00.000Z'
    const entries: CorrectionEntry[] = [
      {
        seq: 0,
        at,
        kind: 'entity_rename',
        payload: { kind: 'account', id: 'alpha', newName: 'Beta' },
        snapshot: { oldName: 'Alpha' }
      },
      {
        seq: 1,
        at,
        kind: 'entity_rename',
        payload: { kind: 'account', id: 'alpha', newName: 'Gamma' },
        snapshot: { oldName: 'Beta' }
      },
      {
        seq: 2,
        at,
        kind: 'entity_merge',
        payload: { kind: 'person', fromId: 'm-silva', intoId: 'maria-silva' },
        snapshot: {
          fromEntity: { name: 'M Silva', aliases: ['Silva, M.'] },
          intoEntity: { name: 'Maria Silva' }
        }
      }
    ]
    const map = aliasMapFromJournal(entries)
    // Transitive rename chain: A→B then B→C ⇒ A and B (and C, and the id) all resolve to C.
    const gamma = { kind: 'account', id: 'alpha', displayName: 'Gamma' }
    expect(map.get('alpha')).toEqual(gamma)
    expect(map.get('beta')).toEqual(gamma)
    expect(map.get('gamma')).toEqual(gamma)
    // Merge: every surface form of `from` (display name, snapshot aliases, id) → into's canonical.
    const maria = { kind: 'person', id: 'maria-silva', displayName: 'Maria Silva' }
    expect(map.get('m-silva')).toEqual(maria)
    expect(map.get(slugify('Silva, M.'))).toEqual(maria)
    expect(map.get('maria-silva')).toEqual(maria)

    // An unmerge annuls its target merge: from's surface forms must no longer route into `into`.
    const withUnmerge: CorrectionEntry[] = [
      ...entries,
      { seq: 3, at, kind: 'entity_unmerge', payload: { targetSeq: 2 } }
    ]
    const annulledMap = aliasMapFromJournal(withUnmerge)
    expect(annulledMap.get('m-silva')).toBeUndefined()
    expect(annulledMap.get('alpha')).toEqual(gamma) // renames unaffected by the unmerge
  })

  // ── Merge folds provenant fields (reviewer IMPORTANT 2) ──────────────────
  it('merge folds a source-only provenant field into the target (the CFO case), keeping plain/sidecar in sync', async () => {
    const withRole = MeetingExtractionSchema.parse({
      people: [{ name: 'Claire Fontaine', role: 'CFO', org: null, confidence: 'EXTRACTED' }]
    })
    const withoutRole = MeetingExtractionSchema.parse({
      people: [{ name: 'C Fontaine', role: null, org: null, confidence: 'EXTRACTED' }]
    })
    await ingestExtraction(s, withRole, transcriptMd('2026-06-01'), join(folder, 'f1.md'))
    await ingestExtraction(s, withoutRole, transcriptMd('2026-06-02'), join(folder, 'f2.md'))

    const merged = await mergeEntities(s, {
      kind: 'person',
      fromId: slugify('Claire Fontaine'),
      intoId: slugify('C Fontaine')
    })
    expect(merged.ok).toBe(true)

    const into = readPerson(s, slugify('C Fontaine'))!
    // Reviewer reproduced: from.role='CFO', into.role=null → merged role null (CFO only in snapshot).
    expect(into.role).toBe('CFO')
    expect(into.role_provenance?.value).toBe('CFO')
    expect(into.role).toBe(into.role_provenance!.value) // plain/sidecar sync invariant after fold
  })

  it('merge with BOTH sides pinned keeps the into value (the human chose the merge direction) and records the loser', async () => {
    const personX = MeetingExtractionSchema.parse({
      people: [{ name: 'Pat Winner', role: 'analyst', org: null, confidence: 'EXTRACTED' }]
    })
    const personY = MeetingExtractionSchema.parse({
      people: [{ name: 'P Winner', role: 'analyst', org: null, confidence: 'EXTRACTED' }]
    })
    await ingestExtraction(s, personX, transcriptMd('2026-06-01'), join(folder, 'p1.md'))
    await ingestExtraction(s, personY, transcriptMd('2026-06-02'), join(folder, 'p2.md'))
    const FROM = slugify('Pat Winner')
    const INTO = slugify('P Winner')
    expect((await updateEntityField(s, { kind: 'person', id: FROM, field: 'role', value: 'VP Engineering' })).ok).toBe(true)
    expect((await updateEntityField(s, { kind: 'person', id: INTO, field: 'role', value: 'CTO' })).ok).toBe(true)

    expect((await mergeEntities(s, { kind: 'person', fromId: FROM, intoId: INTO })).ok).toBe(true)

    const into = readPerson(s, INTO)!
    expect(into.role).toBe('CTO')
    expect(into.role_provenance?.value).toBe('CTO')
    expect(into.role_provenance?.state).toBe('pinned')
    expect(into.role_provenance?.superseded.some((e) => e.value === 'VP Engineering')).toBe(true)
    expect(into.role).toBe(into.role_provenance!.value) // sidecar sync after a both-pinned fold
  })

  // ── ★ applyCorrections rewrites future ingests ──────────────────────────
  it('a renamed account absorbs a later extraction that still uses the old name (alias hit)', async () => {
    await ingestExtraction(s, meeting1(), transcriptMd('2026-06-01'), join(folder, 'm1.md'))
    const renamed = await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
    expect(renamed.ok).toBe(true)

    // A brand-new extraction mentioning the OLD name — the exact ingest wiring path (applyCorrections
    // called from within ingestExtraction, not called directly here).
    const later = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      deal: { name: 'Acme Renewal', stage: 'discovery' }
    })
    await ingestExtraction(s, later, transcriptMd('2026-07-01'), join(folder, 'm4.md'))

    // Still exactly one account entity — no second "acme-corp" file was created.
    expect(listEntities(s, 'account')).toEqual([ACCOUNT_SLUG])
    const acc = readAccount(s, ACCOUNT_SLUG)!
    expect(acc.name).toBe('Acme')
    expect(acc.meetings.map((m) => m.file)).toContain('m4.md')

    // Unit-test the alias rewrite directly too, including the accented-name case from the brief.
    const aliasMap = readAliasMap(s)
    const x = MeetingExtractionSchema.parse({ account: { name: 'Acme Corp', sector: 'banking' } })
    applyCorrections(x, aliasMap)
    expect(x.account!.name).toBe('Acme')

    const loreal = MeetingExtractionSchema.parse({ account: { name: "L'Oréal", sector: 'retail' } })
    await ingestExtraction(s, loreal, transcriptMd('2026-06-05'), join(folder, 'loreal-1.md'))
    const renamedAccent = await renameEntity(s, { kind: 'account', id: slugify("L'Oréal"), newName: "L'Oréal Group" })
    expect(renamedAccent.ok).toBe(true)
    const accentMap = readAliasMap(s)
    const accentExtraction = MeetingExtractionSchema.parse({ account: { name: 'L\'Oreal', sector: 'retail' } })
    applyCorrections(accentExtraction, accentMap)
    expect(accentExtraction.account!.name).toBe("L'Oréal Group")
  })

  // ── ★ Merge -> unmerge round-trip ────────────────────────────────────────
  it('unmerge restores both entity files byte-equal to their pre-merge state; tombstone resolves in between', async () => {
    await ingestThreeMeetings(s)

    const beforeFrom = readPerson(s, M_SILVA_SLUG)
    const beforeInto = readPerson(s, MARIA_SLUG)
    expect(beforeFrom).not.toBeNull()
    expect(beforeInto).not.toBeNull()

    const merged = await mergeEntities(s, { kind: 'person', fromId: M_SILVA_SLUG, intoId: MARIA_SLUG })
    expect(merged.ok).toBe(true)
    const mergeSeq = readCorrectionsJournal(s).find((e) => e.kind === 'entity_merge')!.seq

    // Tombstone resolution: the alias map redirects the merged-away id/name to the survivor.
    expect(readPerson(s, M_SILVA_SLUG)).toBeNull() // fails PersonEntitySchema — correctly "absent"
    const aliasMap = readAliasMap(s)
    expect(aliasMap.get(M_SILVA_SLUG)).toEqual({ kind: 'person', id: MARIA_SLUG, displayName: 'Maria Silva' })
    const afterMerge = readPerson(s, MARIA_SLUG)!
    // 'M Silva' and the raw id 'm-silva' normalize to the SAME alias key — unionAliases correctly keeps
    // only the first-seen spelling, so only one of the two literal strings survives in the array.
    expect(afterMerge.aliases).toContain('M Silva')

    const unmerged = await unmergeEntities(s, { targetSeq: mergeSeq })
    expect(unmerged.ok).toBe(true)

    const afterFrom = readPerson(s, M_SILVA_SLUG)
    const afterInto = readPerson(s, MARIA_SLUG)
    expect(canonicalize(afterFrom)).toEqual(canonicalize(beforeFrom))
    expect(canonicalize(afterInto)).toEqual(canonicalize(beforeInto))

    // Tombstone is gone — 'm-silva' is a live, self-registered entity again, no longer a redirect to Maria.
    expect(readAliasMap(s).get(M_SILVA_SLUG)).toEqual({ kind: 'person', id: M_SILVA_SLUG, displayName: 'M Silva' })
  })

  it('refuses to unmerge a targetSeq that is not a merge entry, or one with no snapshot', async () => {
    await ingestThreeMeetings(s)
    const renamed = await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
    expect(renamed.ok).toBe(true)
    const renameSeq = readCorrectionsJournal(s).find((e) => e.kind === 'entity_rename')!.seq
    const r = await unmergeEntities(s, { targetSeq: renameSeq })
    expect(r.ok).toBe(false)

    const r2 = await unmergeEntities(s, { targetSeq: 999 })
    expect(r2.ok).toBe(false)
  })

  // ── ★ Pinned field survives a subsequent merge from a newer meeting ─────
  it('a pinned deal stage is not overwritten by a later meeting; the incoming value is recorded as superseded', async () => {
    await ingestThreeMeetings(s)
    const pinned = await updateEntityField(s, { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'contract' })
    expect(pinned.ok).toBe(true)
    expect(readDeal(s, DEAL_SLUG)!.stage_provenance!.state).toBe('pinned')

    const newer = MeetingExtractionSchema.parse({
      account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' },
      deal: { name: 'Acme Core Banking', stage: 'lost-to-competitor' }
    })
    await ingestExtraction(s, newer, transcriptMd('2026-08-01'), join(folder, 'm-newer.md'))

    const deal = readDeal(s, DEAL_SLUG)!
    expect(deal.stage).toBe('contract') // proposes nothing — the pin held
    expect(deal.stage_provenance!.value).toBe('contract')
    expect(deal.stage_provenance!.state).toBe('pinned')
    expect(deal.stage_provenance!.superseded.some((e) => e.value === 'lost-to-competitor')).toBe(true)
  })

  // ── rejectCommitment excludes it from open-commitment surfaces ──────────
  it('a rejected commitment disappears from open-commitment surfaces (buildBrainContext) but the row survives with status rejected', async () => {
    await ingestThreeMeetings(s)
    const before = buildBrainContext(s, 'What does Maria owe on Acme Core Banking?')
    expect(before.block).toContain('intro the CISO')

    const r = await rejectCommitment(s, { personSlug: MARIA_SLUG, dealSlug: DEAL_SLUG, text: 'intro the CISO' })
    expect(r.ok).toBe(true)

    const deal = readDeal(s, DEAL_SLUG)!
    const row = deal.commitments.find((c) => c.text === 'intro the CISO')!
    expect(row.status).toBe('rejected')
    const person = readPerson(s, MARIA_SLUG)!
    const prow = person.commitments.find((c) => c.text === 'intro the CISO')!
    expect(prow.status).toBe('rejected')

    const after = buildBrainContext(s, 'What does Maria owe on Acme Core Banking?')
    expect(after.block).not.toContain('intro the CISO')
  })

  it('rejects a commitment found only on the person ledger (deal-less meeting) with dealSlug omitted', async () => {
    const personOnly = MeetingExtractionSchema.parse({
      people: [{ name: 'Solo Person', role: null, org: null, confidence: 'EXTRACTED' }],
      commitments: [{ text: 'call back next week', by: 'Solo Person', quote: 'q', confidence: 'EXTRACTED' }]
    })
    await ingestExtraction(s, personOnly, transcriptMd('2026-06-01'), join(folder, 'solo.md'))
    const slug = slugify('Solo Person')
    const r = await rejectCommitment(s, { personSlug: slug, text: 'call back next week' })
    expect(r.ok).toBe(true)
    expect(readPerson(s, slug)!.commitments[0].status).toBe('rejected')
  })

  it('fails without mutating or journaling when no matching commitment exists', async () => {
    await ingestThreeMeetings(s)
    const before = readCorrectionsJournal(s).length
    const r = await rejectCommitment(s, { personSlug: MARIA_SLUG, text: 'never said this' })
    expect(r.ok).toBe(false)
    expect(readCorrectionsJournal(s).length).toBe(before)
  })

  // ── Journal encrypted round-trip ─────────────────────────────────────────
  it('corrections.json is ATKENC2-encrypted at rest when encryptTranscripts is on, and reads back correctly', async () => {
    const enc = settingsFor(folder, true)
    await ingestExtraction(enc, meeting1(), transcriptMd('2026-06-01'), join(folder, 'm1.md'))
    const renamed = await renameEntity(enc, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
    expect(renamed.ok).toBe(true)

    const raw = readFileSync(join(brainDir(enc), 'corrections.json'))
    expect(raw.subarray(0, 8).toString('utf8')).toBe('ATKENC2\n')
    expect(raw.toString('utf8')).not.toContain('Acme Corp')

    const journal = readCorrectionsJournal(enc)
    expect(journal).toHaveLength(1)
    expect(journal[0].kind).toBe('entity_rename')
    expect((journal[0].snapshot as { oldName: string }).oldName).toBe('Acme Corp')
  })

  // ── replayCorrections tolerance ──────────────────────────────────────────
  it('replay tolerates a stale entry (target already gone) and continues, logging a warning', async () => {
    await ingestExtraction(s, meeting1(), transcriptMd('2026-06-01'), join(folder, 'm1.md'))
    const r1 = await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
    expect(r1.ok).toBe(true)
    const r2 = await updateEntityField(s, { kind: 'person', id: MARIA_SLUG, field: 'role', value: 'CFO (confirmed)' })
    expect(r2.ok).toBe(true)

    expect(readCorrectionsJournal(s)).toHaveLength(2)
    // Delete just the person entity the field_update entry targets — the journal itself is untouched —
    // to force a stale replay target without a full rebuild.
    const personPath = join(brainDir(s), 'entities', 'person', `${MARIA_SLUG}.json`)
    rmSync(personPath, { force: true })

    const replay = await replayCorrections(s)
    expect(replay.applied).toBe(1) // the rename still applies
    expect(replay.warnings).toHaveLength(1)
    expect(replay.warnings[0]).toContain('Person not found')
  })

  // ── Graph node id consistency for a merge ───────────────────────────────
  it('merge rewrites graph edges from the source node to the target node and drops self-loops/dupes', async () => {
    await ingestThreeMeetings(s)
    const merged = await mergeEntities(s, { kind: 'person', fromId: M_SILVA_SLUG, intoId: MARIA_SLUG })
    expect(merged.ok).toBe(true)
    const graph = readGraph(s)
    const fromNode = `person:${M_SILVA_SLUG}`
    const intoNode = `person:${MARIA_SLUG}`
    expect(graph.edges.some((e) => e.from === fromNode || e.to === fromNode)).toBe(false)
    expect(graph.edges.some((e) => e.from === intoNode)).toBe(true)
    const edgeKeys = graph.edges.map((e) => `${e.from}|${e.to}|${e.rel}`)
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length) // no duplicate edges after rewrite
  })

  // ── MI-2.5 Fix A — corrupt journal is preserved-and-refused, never silently wiped ──────────
  describe('journal corruption handling (Fix A)', () => {
    it('preserves a truncated/corrupt journal instead of silently wiping it, and refuses further mutations', async () => {
      await ingestThreeMeetings(s)
      const renamed = await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
      expect(renamed.ok).toBe(true)
      expect(readCorrectionsJournal(s)).toHaveLength(1)

      // Simulate a partially-synced/truncated journal (OneDrive) — valid-looking prefix, cut off mid-entry.
      const journalPath = join(brainDir(s), 'corrections.json')
      writeFileSync(journalPath, '[{"seq":0,"at":"2026-01-01T00:00:00.000Z","kind":"entity_rena', 'utf8')

      const merged = await mergeEntities(s, { kind: 'person', fromId: M_SILVA_SLUG, intoId: MARIA_SLUG })
      expect(merged.ok).toBe(false)
      expect(merged.error).toMatch(/corrupt/i)

      // The original corrupt bytes are preserved verbatim under a corrections.corrupt-*.json sibling —
      // NEVER silently overwritten with a fresh single-entry journal.
      const files = readdirSync(brainDir(s))
      const quarantine = files.find((f) => f.startsWith('corrections.corrupt-'))
      expect(quarantine).toBeDefined()
      expect(readFileSync(join(brainDir(s), quarantine!), 'utf8')).toContain('entity_rena')
      expect(existsSync(journalPath)).toBe(false) // never silently rewritten

      // The refused merge never touched either entity file — no half-applied mutation.
      const fromRaw = JSON.parse(readFileSync(join(brainDir(s), 'entities', 'person', `${M_SILVA_SLUG}.json`), 'utf8'))
      expect(fromRaw.merged_into).toBeUndefined()
    })

    it('tolerates a single unknown-kind entry (version skew) on read — the rest still replay, and further mutations are allowed', async () => {
      await ingestThreeMeetings(s)
      const renamed = await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
      expect(renamed.ok).toBe(true)

      const journalPath = join(brainDir(s), 'corrections.json')
      const raw = JSON.parse(readFileSync(journalPath, 'utf8'))
      raw.push({ seq: 1, at: '2026-06-05T00:00:00.000Z', kind: 'entity_future_kind', payload: { whatever: true } })
      writeFileSync(journalPath, JSON.stringify(raw), 'utf8')

      const entries = readCorrectionsJournal(s)
      expect(entries).toHaveLength(1) // the unknown-kind entry is skipped, the valid one survives
      expect(entries[0].kind).toBe('entity_rename')

      // Tolerated, not corrupt — a further mutation must still be allowed.
      const pinned = await updateEntityField(s, { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'contract' })
      expect(pinned.ok).toBe(true)
    })

    it('a valid journal is read back unchanged', async () => {
      await ingestThreeMeetings(s)
      await applyAllCorrections(s)
      const before = readCorrectionsJournal(s)
      expect(before.length).toBeGreaterThan(0)
      const gate = await readCorrectionsJournalSafe(s)
      expect(gate.ok).toBe(true)
      expect(gate.entries).toEqual(before)
    })
  })

  // ── MI-2.5 Fix B — entity ids are sanitized before any fs access ──────────────────────────
  describe('entity id sanitization (Fix B)', () => {
    it('neutralizes a path-traversal id before any fs access — cannot read/write outside .brain', async () => {
      await ingestThreeMeetings(s)
      // A decoy file sitting one level ABOVE the meetings folder — if slugify() were bypassed, an
      // unsanitized '../../../evil' id could plausibly resolve to (something like) this path.
      const decoyPath = join(folder, '..', 'evil.json')
      writeFileSync(
        decoyPath,
        JSON.stringify({ schema_version: 2, id: 'evil', name: 'PWNED', role: null, account: null, meetings: [], quotes: [], stance_trail: [], commitments: [], aliases: [] }),
        'utf8'
      )
      try {
        const r = await renameEntity(s, { kind: 'person', id: '../../../evil', newName: 'Hacked' })
        // slugify('../../../evil') -> 'evil', a slug matching no real entity in this brain — a clean
        // "not found", never a traversal read of the decoy.
        expect(r.ok).toBe(false)
        expect(r.error).toBe('Entity not found.')
        expect(JSON.parse(readFileSync(decoyPath, 'utf8')).name).toBe('PWNED') // decoy untouched
      } finally {
        rmSync(decoyPath, { force: true })
      }
    })

    it('a legitimate slug still round-trips normally', async () => {
      await ingestThreeMeetings(s)
      const r = await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
      expect(r.ok).toBe(true)
      expect(readAccount(s, ACCOUNT_SLUG)?.name).toBe('Acme')
    })
  })

  // ── MI-2.5 Fix C — corrections serialize against the same lock ingest.ts's jobs use ───────
  describe('serialization with the shared entity-mutation lock (Fix C)', () => {
    it('a correction fired during a simulated in-flight ingest applies AFTER it, against the post-ingest state (no lost update)', async () => {
      await ingestThreeMeetings(s)

      let releaseIngest: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        releaseIngest = resolve
      })
      // Simulate an in-flight backfill job holding the SAME lock corrections.ts's mutations now share.
      const simulatedIngest = withEntityLock(async () => {
        await gate
        const acc = readAccount(s, ACCOUNT_SLUG)!
        acc.sector = 'other'
        const { writeAccount } = await import('./store')
        await writeAccount(s, ACCOUNT_SLUG, acc)
      })

      const renamePromise = renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })
      await new Promise((r) => setTimeout(r, 20))
      // The rename must still be queued behind the simulated ingest's lock — not yet applied.
      expect(readAccount(s, ACCOUNT_SLUG)?.name).not.toBe('Acme')

      releaseIngest()
      await simulatedIngest
      const renameResult = await renamePromise
      expect(renameResult.ok).toBe(true)

      // No lost update: both the concurrent "ingest" mutation AND the rename survive.
      const finalAccount = readAccount(s, ACCOUNT_SLUG)!
      expect(finalAccount.name).toBe('Acme')
      expect(finalAccount.sector).toBe('other')
    })
  })

  // ── MI-2.5 Fix D — journal entry commits BEFORE the mutation runs ─────────────────────────
  describe('journal-first ordering + crash-recovery via replay (Fix D)', () => {
    it('a journaled-but-not-yet-applied rename (simulating a crash between the journal commit and the sweep) fully converges on replay', async () => {
      await ingestThreeMeetings(s)
      // Hand-write the journal entry directly — exactly what renameEntity commits BEFORE running
      // applyRename — without ever calling renameEntity/applyRename, simulating a crash that landed
      // right after the journal append but before any entity file was touched.
      await writeJson(s, 'corrections.json', [
        {
          seq: 0,
          at: '2026-06-10T00:00:00.000Z',
          kind: 'entity_rename',
          payload: { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' },
          snapshot: { oldName: 'Acme Corp' }
        }
      ])
      expect(readAccount(s, ACCOUNT_SLUG)?.name).toBe('Acme Corp') // still unrenamed — the "crash" landed here

      const replay = await replayCorrections(s)
      expect(replay.applied).toBe(1)
      expect(replay.warnings).toHaveLength(0)

      // Converges to the SAME state a normal, uninterrupted renameEntity call would have produced,
      // including the full dependents sweep (deal.account is a plain field the sweep repaints).
      expect(readAccount(s, ACCOUNT_SLUG)?.name).toBe('Acme')
      expect(readDeal(s, DEAL_SLUG)?.account).toBe('Acme')
    })

    it('the live rename call itself commits the journal entry before the mutation — a failure mid-sweep still leaves a replayable record', async () => {
      await ingestThreeMeetings(s)
      const store = await import('./store')
      const writeDealSpy = vi.spyOn(store, 'writeDeal').mockImplementationOnce(() => {
        throw new Error('simulated crash mid-sweep')
      })

      // A genuine crash (uncaught exception) partway through the sweep — the live call rejects, exactly
      // like a real process crash would never return a graceful { ok: false } at all.
      await expect(renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })).rejects.toThrow(
        'simulated crash mid-sweep'
      )

      // Fix D's core property: despite the failure, the journal entry is ALREADY there.
      const journal = readCorrectionsJournal(s)
      expect(journal).toHaveLength(1)
      expect(journal[0].kind).toBe('entity_rename')

      writeDealSpy.mockRestore()

      // A rebuild's replay picks up the committed-but-incomplete rename and finishes it.
      const replay = await replayCorrections(s)
      expect(replay.applied).toBe(1)
      expect(readAccount(s, ACCOUNT_SLUG)?.name).toBe('Acme')
      expect(readDeal(s, DEAL_SLUG)?.account).toBe('Acme')
    })
  })

  // ── MI-2.5 Fix G — OneDrive conflict-copy detection + merge ───────────────────────────────
  describe('OneDrive conflict-copy resolution (Fix G)', () => {
    it('merges overlapping+distinct entries from a sibling conflict copy into one deterministic, resequenced journal', async () => {
      await ingestThreeMeetings(s)
      const shared = {
        seq: 0,
        at: '2026-06-01T00:00:00.000Z',
        kind: 'entity_rename',
        payload: { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' },
        snapshot: { oldName: 'Acme Corp' }
      }
      const primaryOnly = {
        seq: 1,
        at: '2026-06-02T00:00:00.000Z',
        kind: 'field_update',
        payload: { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'contract' }
      }
      const conflictOnly = {
        seq: 1,
        at: '2026-06-03T00:00:00.000Z',
        kind: 'commitment_reject',
        payload: { personSlug: MARIA_SLUG, dealSlug: DEAL_SLUG, text: 'intro the CISO' }
      }

      await writeJson(s, 'corrections.json', [shared, primaryOnly])
      await writeJson(s, 'corrections-DESKTOP-ABC.json', [shared, conflictOnly])

      const merged = readCorrectionsJournal(s)
      expect(merged).toHaveLength(3) // the shared entry deduped to one, plus both devices' distinct entries
      expect(merged.map((e) => e.seq)).toEqual([0, 1, 2]) // re-sequenced, contiguous
      // Deterministic chronological order: shared (06-01) < primaryOnly (06-02) < conflictOnly (06-03).
      expect(merged.map((e) => e.kind)).toEqual(['entity_rename', 'field_update', 'commitment_reject'])

      // The write-path gate durably resolves the fork: merged journal persisted, conflict copy renamed away.
      const gateResult = await readCorrectionsJournalSafe(s)
      expect(gateResult.ok).toBe(true)
      expect(gateResult.entries).toHaveLength(3)
      const files = readdirSync(brainDir(s))
      expect(files).not.toContain('corrections-DESKTOP-ABC.json') // resolved — renamed out of the way
      expect(files.some((f) => f.startsWith('corrections-DESKTOP-ABC') && f.includes('.merged-'))).toBe(true)
      expect(JSON.parse(readFileSync(join(brainDir(s), 'corrections.json'), 'utf8'))).toHaveLength(3)
    })

    it('remaps an entity_unmerge.targetSeq reference through a conflict-copy merge so it still points at its own merge entry', async () => {
      await ingestThreeMeetings(s)
      const pin = {
        seq: 0,
        at: '2026-06-01T00:00:00.000Z',
        kind: 'field_update',
        payload: { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'proposal' }
      }
      const merge = {
        seq: 1,
        at: '2026-06-02T00:00:00.000Z',
        kind: 'entity_merge',
        payload: { kind: 'person', fromId: M_SILVA_SLUG, intoId: MARIA_SLUG },
        snapshot: { fromEntity: {}, intoEntity: {} }
      }
      const unmerge = { seq: 2, at: '2026-06-04T00:00:00.000Z', kind: 'entity_unmerge', payload: { targetSeq: 1 } }
      await writeJson(s, 'corrections.json', [pin, merge, unmerge])

      // A distinct entry from another device, dated BEFORE the primary's pin — shifts everything later
      // in the merged chronological order, changing the merge entry's NEW index away from its old seq=1.
      const conflictEntry = {
        seq: 0,
        at: '2026-05-30T00:00:00.000Z',
        kind: 'field_update',
        payload: { kind: 'deal', id: DEAL_SLUG, field: 'velocity', value: { signal: 'hard-calendar-gate', evidence: 'x' } }
      }
      await writeJson(s, 'corrections-LAPTOP.json', [conflictEntry])

      const merged = readCorrectionsJournal(s)
      // Order: conflictEntry(05-30), pin(06-01), merge(06-02), unmerge(06-04) — merge is now at index 2.
      expect(merged.map((e) => e.kind)).toEqual(['field_update', 'field_update', 'entity_merge', 'entity_unmerge'])
      const remappedUnmerge = merged.find((e) => e.kind === 'entity_unmerge')!
      expect((remappedUnmerge.payload as { targetSeq: number }).targetSeq).toBe(2) // repointed, not the stale 1
    })
  })

  // ── MI-2.5 Fix H — minor bundle ────────────────────────────────────────────────────────────
  describe('minor hardening bundle (Fix H)', () => {
    it('a rename to the entity\'s own current name is a no-op — never appends (unbounded-journal guard)', async () => {
      await ingestThreeMeetings(s)
      const r1 = await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme Corp' }) // same as current name
      expect(r1.ok).toBe(true)
      expect(readCorrectionsJournal(s)).toHaveLength(0) // nothing appended
    })

    it('rejects an over-length string value for a human-pinned field before persisting it', async () => {
      await ingestThreeMeetings(s)
      const tooLong = 'x'.repeat(2001)
      const r = await updateEntityField(s, { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: tooLong })
      expect(r.ok).toBe(false)
      expect(readDeal(s, DEAL_SLUG)?.stage).not.toBe(tooLong)
      expect(readCorrectionsJournal(s)).toHaveLength(0) // rejected before any journal write
    })

    it('accepts a string value right at the length cap', async () => {
      await ingestThreeMeetings(s)
      const atCap = 'x'.repeat(2000)
      const r = await updateEntityField(s, { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: atCap })
      expect(r.ok).toBe(true)
      expect(readDeal(s, DEAL_SLUG)?.stage).toBe(atCap)
    })

    it('aliasMapFromJournal still resolves correctly through a longer rename+merge chain (reverse-index correctness)', () => {
      const entries: CorrectionEntry[] = [
        { seq: 0, at: 't0', kind: 'entity_rename', payload: { kind: 'account', id: 'acme', newName: 'Acme One' }, snapshot: { oldName: 'Acme' } },
        { seq: 1, at: 't1', kind: 'entity_rename', payload: { kind: 'account', id: 'acme', newName: 'Acme Two' }, snapshot: { oldName: 'Acme One' } },
        { seq: 2, at: 't2', kind: 'entity_rename', payload: { kind: 'account', id: 'acme', newName: 'Acme Three' }, snapshot: { oldName: 'Acme Two' } },
        { seq: 3, at: 't3', kind: 'entity_rename', payload: { kind: 'person', id: 'bob', newName: 'Bobby' }, snapshot: { oldName: 'Bob' } }
      ]
      const map = aliasMapFromJournal(entries)
      // Every historical surface form of the account resolves to the FINAL name, transitively.
      for (const name of ['Acme', 'Acme One', 'Acme Two', 'acme']) {
        expect(map.get(slugify(name))).toMatchObject({ kind: 'account', id: 'acme', displayName: 'Acme Three' })
      }
      expect(map.get(slugify('Bob'))).toMatchObject({ kind: 'person', id: 'bob', displayName: 'Bobby' })
    })
  })

  // ── MI-2.5 review Fix 1 — corruption block is DURABLE (survives the quarantine rename) ──────
  describe('durable corruption block (review Fix 1)', () => {
    it('keeps refusing EVERY subsequent mutation after quarantine (not just the detecting one), then resumes after explicit resolution', async () => {
      await ingestThreeMeetings(s)
      expect((await renameEntity(s, { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' })).ok).toBe(true)

      // Corrupt the journal, then let the FIRST mutation detect+quarantine it (renaming corrections.json
      // to a corrections.corrupt-*.json sibling — after which the primary path is 'absent', not 'corrupt').
      writeFileSync(join(brainDir(s), 'corrections.json'), '{ truncated not an array', 'utf8')
      const first = await updateEntityField(s, { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'contract' })
      expect(first.ok).toBe(false)
      expect(isJournalCorruptionBlocked(s)).toBe(true) // durable sentinel written

      // The reviewer's exact bug: WITHOUT the sentinel this second, unrelated mutation would see 'absent'
      // and silently start a fresh seq:0 journal. It must be REFUSED instead.
      const second = await rejectCommitment(s, { personSlug: MARIA_SLUG, dealSlug: DEAL_SLUG, text: 'intro the CISO' })
      expect(second.ok).toBe(false)
      expect(second.error).toMatch(/paused|corrupt|blocked/i)
      expect(existsSync(join(brainDir(s), 'corrections.json'))).toBe(false) // never rewritten to seq:0

      // Replay is also blocked (does not silently replay an empty journal).
      const replay = await replayCorrections(s)
      expect(replay.error).toBeTruthy()
      expect(replay.applied).toBe(0)

      // Explicit resolution unblocks — a fresh correction now succeeds and starts a clean journal.
      expect(clearJournalCorruptionLock(s)).toBe(true)
      expect(isJournalCorruptionBlocked(s)).toBe(false)
      const resumed = await updateEntityField(s, { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'contract' })
      expect(resumed.ok).toBe(true)
      expect(readCorrectionsJournal(s)).toHaveLength(1)
    })
  })

  // ── MI-2.5 review Fix 3 — field_update & commitment_reject are journal-first ────────────────
  describe('journal-first for field_update and commitment_reject (review Fix 3)', () => {
    it('field_update commits the journal entry BEFORE the entity write — a crashed write still converges on replay, never reverts', async () => {
      await ingestThreeMeetings(s)
      const store = await import('./store')
      const spy = vi.spyOn(store, 'writeDeal').mockImplementationOnce(() => {
        throw new Error('simulated crash after journal append, before entity write')
      })

      // The real write throws — but the dry-run precheck + journal append already ran first.
      await expect(updateEntityField(s, { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'contract' })).rejects.toThrow(
        /simulated crash/
      )
      spy.mockRestore()

      // The journal entry IS present (committed before the write) and the entity is NOT yet pinned.
      const journal = readCorrectionsJournal(s)
      expect(journal).toHaveLength(1)
      expect(journal[0].kind).toBe('field_update')
      expect(readDeal(s, DEAL_SLUG)?.stage_provenance?.state).not.toBe('pinned')

      // Replay finishes the committed-but-unapplied pin — the reviewer's revert-to-'discovery' is gone.
      const replay = await replayCorrections(s)
      expect(replay.applied).toBe(1)
      expect(readDeal(s, DEAL_SLUG)?.stage).toBe('contract')
      expect(readDeal(s, DEAL_SLUG)?.stage_provenance?.state).toBe('pinned')
    })

    it('field_update replay after a SUCCESSFUL live pin is idempotent (crash-after-write case)', async () => {
      await ingestThreeMeetings(s)
      expect((await updateEntityField(s, { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'contract' })).ok).toBe(true)
      const afterLive = canonicalize(JSON.parse(readFileSync(join(brainDir(s), 'entities', 'deal', `${DEAL_SLUG}.json`), 'utf8')))
      const replay = await replayCorrections(s)
      expect(replay.warnings).toHaveLength(0)
      const afterReplay = canonicalize(JSON.parse(readFileSync(join(brainDir(s), 'entities', 'deal', `${DEAL_SLUG}.json`), 'utf8')))
      expect(afterReplay).toEqual(afterLive) // byte-equal — replay is a pure no-op over the applied pin
    })

    it('commitment_reject commits the journal entry BEFORE the ledger write — a crashed write still converges on replay', async () => {
      await ingestThreeMeetings(s)
      const store = await import('./store')
      // Fail the FIRST ledger write of the reject (person OR deal, whichever applyRejectCommitment writes
      // first) to simulate a crash between the journal append and the entity write completing.
      const spyP = vi.spyOn(store, 'writePerson').mockImplementationOnce(() => {
        throw new Error('simulated crash mid-reject')
      })
      const spyD = vi.spyOn(store, 'writeDeal').mockImplementationOnce(() => {
        throw new Error('simulated crash mid-reject')
      })
      await expect(
        rejectCommitment(s, { personSlug: MARIA_SLUG, dealSlug: DEAL_SLUG, text: 'intro the CISO' })
      ).rejects.toThrow(/simulated crash/)
      spyP.mockRestore()
      spyD.mockRestore()

      const journal = readCorrectionsJournal(s)
      expect(journal).toHaveLength(1)
      expect(journal[0].kind).toBe('commitment_reject')

      const replay = await replayCorrections(s)
      expect(replay.applied).toBe(1)
      // The commitment is rejected on the deal ledger after replay (converged).
      const dealRow = readDeal(s, DEAL_SLUG)?.commitments.find((c) => c.text.toLowerCase().includes('ciso'))
      expect(dealRow?.status).toBe('rejected')
    })
  })

  // ── MI-2.5 review minors — conflict-copy idempotency + unmerge identity ─────────────────────
  describe('conflict-copy resolution is idempotent + robust (review minors a/c)', () => {
    it('resolving a conflict copy is idempotent — a second gate call does not re-detect the renamed .merged- copy', async () => {
      await ingestThreeMeetings(s)
      const shared = { seq: 0, at: '2026-06-01T00:00:00.000Z', kind: 'entity_rename', payload: { kind: 'account', id: ACCOUNT_SLUG, newName: 'Acme' }, snapshot: { oldName: 'Acme Corp' } }
      const conflictOnly = { seq: 1, at: '2026-06-03T00:00:00.000Z', kind: 'field_update', payload: { kind: 'deal', id: DEAL_SLUG, field: 'stage', value: 'contract' } }
      await writeJson(s, 'corrections.json', [shared])
      await writeJson(s, 'corrections-DESKTOP.json', [shared, conflictOnly])

      const first = await readCorrectionsJournalSafe(s)
      expect(first.ok).toBe(true)
      expect(first.entries).toHaveLength(2)
      const mergedCopies = () => readdirSync(brainDir(s)).filter((f) => f.includes('.merged-'))
      expect(mergedCopies()).toHaveLength(1)

      // Second call: the .merged- copy must NOT be treated as a fresh conflict copy (no re-merge, no
      // second .merged- accumulation).
      const second = await readCorrectionsJournalSafe(s)
      expect(second.ok).toBe(true)
      expect(second.entries).toHaveLength(2)
      expect(mergedCopies()).toHaveLength(1) // still exactly one — not re-renamed on every call
    })

    it('sets aside a CORRUPT conflict copy once instead of re-parsing it forever', async () => {
      await ingestThreeMeetings(s)
      await writeJson(s, 'corrections.json', [])
      writeFileSync(join(brainDir(s), 'corrections-LAPTOP.json'), '{ corrupt not array', 'utf8')

      const gate = await readCorrectionsJournalSafe(s)
      expect(gate.ok).toBe(true) // a corrupt CONFLICT copy never blocks the primary
      const files = readdirSync(brainDir(s))
      expect(files).not.toContain('corrections-LAPTOP.json') // set aside
      expect(files.some((f) => f.includes('.corrupt-') && f.includes('LAPTOP'))).toBe(true)
    })

    it('two unmerges from different devices with the same at+targetSeq but referencing DIFFERENT merges stay distinct through the conflict merge', async () => {
      await ingestThreeMeetings(s)
      // Primary device: merge(person p-a→p-b) at local seq0, then unmerge(targetSeq:0) at 'tX'.
      await writeJson(s, 'corrections.json', [
        { seq: 0, at: '2026-06-01T00:00:00.000Z', kind: 'entity_merge', payload: { kind: 'person', fromId: 'p-a', intoId: 'p-b' }, snapshot: { fromEntity: {}, intoEntity: {} } },
        { seq: 1, at: 'tX', kind: 'entity_unmerge', payload: { targetSeq: 0 } }
      ])
      // Conflict device: a DIFFERENT merge (deal d-c→d-d) at local seq0, unmerge with the SAME at+targetSeq.
      await writeJson(s, 'corrections-DEVICE2.json', [
        { seq: 0, at: '2026-06-02T00:00:00.000Z', kind: 'entity_merge', payload: { kind: 'deal', fromId: 'd-c', intoId: 'd-d' }, snapshot: { fromEntity: {}, intoEntity: {} } },
        { seq: 1, at: 'tX', kind: 'entity_unmerge', payload: { targetSeq: 0 } }
      ])

      const merged = readCorrectionsJournal(s)
      const unmerges = merged.filter((e) => e.kind === 'entity_unmerge')
      // WITHOUT the richer identity, the two same-{at,targetSeq} unmerges would dedup to ONE (silently
      // dropping one device's undo). They must both survive, each remapped to its OWN merge.
      expect(unmerges).toHaveLength(2)
      expect(merged.filter((e) => e.kind === 'entity_merge')).toHaveLength(2)
    })
  })
})
