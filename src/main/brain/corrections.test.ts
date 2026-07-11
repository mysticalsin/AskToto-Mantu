import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
  purgeBrain
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
  readCorrectionsJournal
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
})
