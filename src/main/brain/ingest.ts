import { basename, join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import type { Settings, AskStart } from '@shared/ipc'
import { PROVIDERS, resolveModelTier, type ProviderId } from '@shared/providers'
import {
  BRAIN_EXTRACTION_PROMPT,
  BRAIN_SCHEMA_VERSION,
  classifyMeetingSourceUse,
  MeetingExtractionSchema,
  type MeetingExtraction,
  type MeetingRef,
  type BrainGraph,
  type BrainIndex,
  type Confidence,
  type ProvenantField,
  type EntityKind
} from '@shared/brain'
import { INJECTION_GUARD } from '@shared/prompts'
import { redactSecrets } from '@shared/redact'
import { getSettings, getApiKey } from '../store'
import { createStream } from '../llm'
import { readSavedFile, resolveMeetingsFolder } from '../transcripts'
import { auditLog, mainLog } from '../logger'
import {
  slugify,
  commitmentKey,
  pushUnique,
  pushSuperseded,
  outranks,
  eqStrict,
  eqVelocity,
  readIndex,
  writeIndex,
  readGraph,
  writeGraph,
  writeMeetingExtraction,
  readPerson,
  writePerson,
  readAccount,
  writeAccount,
  readDeal,
  writeDeal,
  listEntities,
  listMeetingExtractions,
  withEntityLock,
  purgeBrain
} from './store'
import { applyCorrections, readAliasMap, resolveEntitySlug, replayCorrections, readCorrectionsJournalSafe } from './corrections'

/**
 * Brain ingest — turns one saved transcript into a structured extraction, then merges it into the
 * compounding entity files. One LLM call per meeting (active provider, non-streaming semantics by
 * accumulating the stream), deterministic merge code, then a cheap rule-based lint pass. Queued and
 * background: a failed ingest is recorded in index.json and retried on the next rebuild — it can never
 * block or corrupt a meeting save.
 */

// ── LLM call ─────────────────────────────────────────────────────────────────

/** Cheap "is any provider usable at all" check — reuses pickProvider's own resolution logic so the two
 *  can never drift out of sync. Used to bail out of backfill work BEFORE burning a queued job (and its
 *  one reinforcement retry) on a call that's guaranteed to reject with "No configured AI provider". */
function hasUsableProvider(s: Settings): boolean {
  return pickProvider(s) !== null
}

/** Pick the first usable text provider: the active one, then any other with credentials + a model. */
function pickProvider(s: Settings): { provider: ProviderId; model: string; key: string } | null {
  const order = [s.provider, ...(Object.keys(PROVIDERS) as ProviderId[])]
  for (const p of order) {
    const def = PROVIDERS[p]
    if (!def) continue
    const key = getApiKey(p)
    const connected = def.kind === 'cli' ? !!s.cliConnected[p] : key.length > 0
    if (!connected) continue
    if (p === 'dust' && !s.dustWorkspaceId) continue
    const model = resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'deep', s.providerModelsDeep)
    if (!model) continue
    return { provider: p, model, key }
  }
  return null
}

/** Run one accumulate-the-stream completion against the picked provider. Rejects on stream error. */
function runCompletion(s: Settings, system: string, userText: string, id: string): Promise<string> {
  const picked = pickProvider(s)
  if (!picked) return Promise.reject(new Error('No configured AI provider for brain ingest.'))
  const { provider, model, key } = picked
  const def = PROVIDERS[provider]
  const req: AskStart = { id, mode: 'answer', prompt: userText, history: [] } as AskStart
  return new Promise<string>((resolve, reject) => {
    let out = ''
    createStream({
      providerId: provider,
      kind: def.kind,
      apiKey: key,
      baseURL: provider === 'custom' ? s.customBaseUrl : provider === 'dust' ? s.dustBaseUrl : def.baseUrl,
      workspaceId: s.dustWorkspaceId,
      model,
      temperature: 0, // extraction wants determinism, not creativity
      idleMs: 120_000,
      freshConversation: true, // Dust: never join/replace the live meeting's cached conversation
      system,
      req,
      handlers: {
        onDelta: (t) => {
          out += t
        },
        onDone: () => resolve(out),
        onError: (m) => reject(new Error(m))
      }
    })
  })
}

/** Strip markdown fences / stray prose around the JSON object a model may still emit. */
export function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in model output')
  return body.slice(start, end + 1)
}

/** Lead with the injection guard, exactly like personas.ts's buildSystem does for its other untrusted-
 *  transcript modes (suggest/summary/recap/vision) — the meeting transcript is third-party data the
 *  model must never treat as instructions. Exported so the assembly itself is directly testable. */
export const buildExtractionSystem = (extra = ''): string =>
  INJECTION_GUARD.trimStart() + '\n\n' + BRAIN_EXTRACTION_PROMPT + extra

async function extractMeeting(s: Settings, transcriptMd: string, sourceFile: string): Promise<MeetingExtraction> {
  // Same redaction discipline as the live ask path (index.ts's askStart handler): the locally-saved
  // transcript file keeps the verbatim original on disk — only the copy sent to the cloud model for
  // extraction is stripped of high-confidence secrets, and only when the user has redaction enabled.
  const safeMd = s.redactSensitive ? redactSecrets(transcriptMd) : transcriptMd
  const user = `Meeting transcript (file: ${basename(sourceFile)}):\n\n"""\n${safeMd.slice(0, 24000)}\n"""`
  const attempt = async (extra: string): Promise<MeetingExtraction> => {
    const raw = await runCompletion(s, buildExtractionSystem(extra), user, `brain-${Date.now()}`)
    return MeetingExtractionSchema.parse(JSON.parse(extractJsonObject(raw)))
  }
  try {
    return await attempt('')
  } catch (e) {
    // One reinforcement retry — malformed JSON is the dominant failure mode, not content.
    mainLog.warn('[brain] first extraction attempt failed, retrying once:', e instanceof Error ? e.message : e)
    return attempt('\n\nREMINDER: your ENTIRE reply must be one valid JSON object. No fences, no prose.')
  }
}

// ── Deterministic merge ──────────────────────────────────────────────────────

// commitmentKey/pushUnique now live in store.ts (beside slugify) so the correction engine
// (corrections.ts) can reuse the exact same normalization/de-dup semantics without a corrections.ts
// <-> ingest.ts import cycle; re-exported here unchanged for every existing caller/test of this module.
export { commitmentKey }

// ── Provenant field merge (A1 fix: D1 "latest-INGESTED-wins" → "latest-MEETING-DATE-wins") ──────────
//
// Backfill enqueues files in readdirSync order and completes in extraction-COMPLETION order, so a
// chronologically OLD meeting processed LAST could silently overwrite a NEWER meeting's deal state
// (defect D1). This is the single implementation every provenant field (role/org, sector, stage,
// win_likelihood_band, velocity) goes through, so the rule is enforced exactly once, everywhere.
//
// THE ORDER-INDEPENDENCE GUARANTEE: the final field state (value + provenance + superseded history)
// is a pure function of the SET of {value, date, source_file, confidence} candidates ever merged —
// never of their arrival order. Every rule below exists to keep that true:
//   1. A value pinned/edited by a human is NEVER overwritten by merge — but the incoming (rejected)
//      value is still logged to `superseded` so the full history stays visible even though it lost.
//   2. Winner selection is the deterministic TOTAL order `outranks`: EXTRACTED-grade evidence beats
//      weaker tiers in BOTH directions (the old sector-only "never downgrade" rule, generalized —
//      a one-directional guard would let the winner depend on arrival order in mixed-confidence
//      sets), then meeting date, then source_file as the final tiebreak. Without the source_file
//      tiebreak, two same-day meetings with bare `date:` frontmatter (common) or two blank-date
//      meetings (the statSync-failure fallback) would resolve by arrival order — and backfill's
//      completion order is nondeterministic.
//   3. A value-identical incoming (same fact re-confirmed) refreshes the field's metadata only when
//      it OUTRANKS the evidence already held; it is never a superseded push.
//   4. `superseded` is deduped per value (keeping the max-(date, source_file) sighting), never
//      contains the current value, and stays sorted by the same (date, source_file) key desc,
//      capped at 10 — so the history array converges byte-for-byte too.
// Known bounded exception: two same-value candidates with DIFFERENT confidence tiers can leave a
// superseded entry citing either one's date/source depending on order (the superseded shape carries
// no confidence slot to dedupe on). The winner and its own provenance still converge; only that one
// history entry's metadata can vary, and only in mixed-confidence same-value sets.
type ProvenantIncoming<T> = { value: T; source_file: string; date: string; quote?: string; confidence: Confidence }

// `outranks` (the deterministic total-order winner selection every rule above refers to) now lives in
// store.ts beside laterEntry/pushSuperseded: corrections.ts's merge-time provenance fold ranks
// machine-extracted candidates by the same order and cannot import from this module. Its
// date-comparison caveat and totality note moved with it.

function mergeProvenant<T>(
  current: ProvenantField<T> | undefined,
  incoming: ProvenantIncoming<T>,
  valuesEqual: (a: T, b: T) => boolean
): ProvenantField<T> {
  if (!current) {
    return { value: incoming.value, source_file: incoming.source_file, date: incoming.date, quote: incoming.quote, confidence: incoming.confidence, state: 'extracted', superseded: [] }
  }
  if (current.state === 'pinned' || current.state === 'edited') {
    if (valuesEqual(current.value, incoming.value)) return current
    return { ...current, superseded: pushSuperseded(current.superseded, { value: incoming.value, date: incoming.date, source_file: incoming.source_file }, current.value, valuesEqual) }
  }
  if (valuesEqual(current.value, incoming.value)) {
    // Re-confirmation refreshes metadata only when the incoming evidence outranks what we already
    // hold. Deliberately NO refresh from a weaker-confidence (or older, or tied-but-lower-file)
    // sighting of the same value: provenance keeps citing the strongest, then most recent, evidence.
    if (!outranks(incoming, current)) return current
    return { ...current, source_file: incoming.source_file, date: incoming.date, quote: incoming.quote, confidence: incoming.confidence }
  }
  if (outranks(incoming, current)) {
    return {
      value: incoming.value,
      source_file: incoming.source_file,
      date: incoming.date,
      quote: incoming.quote,
      confidence: incoming.confidence,
      state: 'extracted',
      superseded: pushSuperseded(current.superseded, { value: current.value, date: current.date, source_file: current.source_file }, incoming.value, valuesEqual)
    }
  }
  return { ...current, superseded: pushSuperseded(current.superseded, { value: incoming.value, date: incoming.date, source_file: incoming.source_file }, current.value, valuesEqual) }
}

/** Merge one meeting's extraction into the entity + graph files. Pure data transforms — no LLM here. */
export async function mergeExtraction(
  s: Settings,
  x: MeetingExtraction,
  ref: MeetingRef,
  // Optional (Task MI-2): when supplied, entity file routing resolves through it FIRST (an old alias
  // OR the entity's own current name — see readAliasMap's doc comment for why the current name is
  // registered too), falling back to slugify(name) exactly as before when there's no hit. Omitted
  // entirely, behavior is byte-identical to pre-MI-2 — every existing direct caller/test of this
  // function is unaffected. ingestExtraction (the production path) always passes the same aliasMap it
  // already computed for applyCorrections, so a renamed entity's immutable `id` (which can differ from
  // slugify(its current display name)) still resolves to the right file instead of silently forking a
  // second one.
  aliasMap?: Map<string, { kind: EntityKind; id: string; displayName: string }>
): Promise<void> {
  const graph = readGraph(s)
  const addNode = (id: string, type: 'account' | 'person' | 'deal' | 'sector' | 'meeting', label: string): void =>
    pushUnique(graph.nodes, { id, type, label }, (n) => n.id)
  const addEdge = (from: string, to: string, rel: string, confidence: MeetingExtraction['people'][number]['confidence']): void =>
    pushUnique(graph.edges, { from, to, rel, confidence }, (e) => `${e.from}|${e.to}|${e.rel}`)

  const meetingId = `meeting:${slugify(ref.file)}`
  addNode(meetingId, 'meeting', ref.title || ref.file)

  const accountSlug = x.account && x.account.name.trim() ? resolveEntitySlug(aliasMap, 'account', x.account.name) : null
  if (x.account && accountSlug) {
    const acc = readAccount(s, accountSlug) ?? {
      schema_version: BRAIN_SCHEMA_VERSION,
      id: accountSlug,
      aliases: [],
      name: x.account.name,
      sector: x.account.sector,
      sector_confidence: x.account.sector_confidence,
      strategic: false,
      people: [],
      deals: [],
      meetings: [],
      win_reasons: [],
      loss_reasons: []
    }
    // A1/B3: latest-MEETING-DATE-wins (not latest-ingested-wins), never downgrade EXTRACTED to INFERRED,
    // and a human pin/edit is never overwritten — all generalized in mergeProvenant (defect D1 for the
    // three deal fields below; sector's own "never downgrade" rule folds into the same implementation).
    acc.sector_provenance = mergeProvenant(
      acc.sector_provenance,
      { value: x.account.sector, source_file: ref.file, date: ref.date, confidence: x.account.sector_confidence },
      eqStrict
    )
    acc.sector = acc.sector_provenance.value
    acc.sector_confidence = acc.sector_provenance.confidence
    pushUnique(acc.meetings, ref, (m) => m.file)
    for (const sig of x.signals) {
      const bucket = sig.kind === 'positive' ? acc.win_reasons : sig.kind === 'objection' ? acc.loss_reasons : null
      if (bucket) pushUnique(bucket, { statement: sig.statement, quote: sig.quote, meeting: ref.file }, (r) => r.statement + r.meeting)
    }
    addNode(`account:${accountSlug}`, 'account', acc.name)
    addNode(`sector:${acc.sector}`, 'sector', acc.sector)
    addEdge(`account:${accountSlug}`, `sector:${acc.sector}`, 'in-sector', x.account.sector_confidence)
    addEdge(`account:${accountSlug}`, meetingId, 'discussed-in', x.account.confidence)
    await writeAccount(s, accountSlug, acc)
  }

  for (const p of x.people) {
    if (!p.name.trim()) continue
    const pslug = resolveEntitySlug(aliasMap, 'person', p.name)
    const person = readPerson(s, pslug) ?? {
      schema_version: BRAIN_SCHEMA_VERSION,
      id: pslug,
      aliases: [],
      name: p.name,
      role: null,
      account: null,
      meetings: [],
      quotes: [],
      stance_trail: [],
      commitments: []
    }
    // A2 fix (D8): org is now allowed to CHANGE across meetings (latest-date-wins via mergeProvenant,
    // same as the deal fields), with the full history in org_provenance.superseded — this is what makes
    // lintBrain's multi-account detection below possible at all; the old "first-write-wins, never
    // overwrite" rule meant a person's account froze at whichever meeting mentioned them first.
    const org = p.org || x.account?.name || null
    if (org) {
      person.org_provenance = mergeProvenant(
        person.org_provenance,
        { value: org, source_file: ref.file, date: ref.date, confidence: p.confidence },
        eqStrict
      )
      person.account = person.org_provenance.value
    }
    if (p.role) {
      person.role_provenance = mergeProvenant(
        person.role_provenance,
        { value: p.role, source_file: ref.file, date: ref.date, confidence: p.confidence },
        eqStrict
      )
      person.role = person.role_provenance.value
    }
    pushUnique(person.meetings, ref, (m) => m.file)
    for (const sig of x.signals) {
      if (sig.quote) pushUnique(person.stance_trail, { meeting: ref.file, kind: sig.kind, statement: sig.statement }, (t) => t.meeting + t.statement)
    }
    // Commitments spoken BY this person (matched by name) join their personal ledger — over time this
    // yields a kept-promise read per counterpart, a signal no transcript-only tool can compute.
    // Accepted design: in a deal-less meeting (x.deal is null, below) there is no ledger to also add
    // these to, so such commitments live ONLY here and stay 'open' forever (settleCommitment is
    // deal-keyed) — a known, accepted limitation, not a bug to fix.
    person.commitments ??= []
    for (const c of x.commitments) {
      if (c.by.toLowerCase() === p.name.toLowerCase()) {
        pushUnique(person.commitments, { ...c, meeting: ref.file, date: ref.date, status: 'open' as const }, (t) => commitmentKey(t.text))
      }
    }
    addNode(`person:${pslug}`, 'person', p.name)
    addEdge(`person:${pslug}`, meetingId, 'attends', p.confidence)
    if (accountSlug) {
      addEdge(`person:${pslug}`, `account:${accountSlug}`, 'works-at', p.org ? 'EXTRACTED' : 'INFERRED')
      const acc = readAccount(s, accountSlug)
      if (acc) {
        pushUnique(acc.people, p.name, (n) => n)
        await writeAccount(s, accountSlug, acc)
      }
    }
    await writePerson(s, pslug, person)
  }

  if (x.deal && (x.deal.name || accountSlug)) {
    const dslug = resolveEntitySlug(aliasMap, 'deal', x.deal.name || `${x.account?.name ?? 'unknown'} deal`)
    const deal = readDeal(s, dslug) ?? {
      schema_version: BRAIN_SCHEMA_VERSION,
      id: dslug,
      aliases: [],
      name: x.deal.name || `${x.account?.name ?? 'Unknown'} deal`,
      account: x.account?.name ?? '',
      stage: '',
      outcome: 'open' as const,
      win_likelihood_band: null,
      band_evidence: '',
      velocity: { signal: 'no-hard-date-found' as const, evidence: '' },
      meetings: [],
      signals: [],
      missed_signals: [],
      commitments: [],
      feedback: []
    }
    // A1 fix (D1): latest-MEETING-DATE-wins, not latest-ingested-wins — see mergeProvenant above.
    if (x.deal.stage) {
      deal.stage_provenance = mergeProvenant(
        deal.stage_provenance,
        { value: x.deal.stage, source_file: ref.file, date: ref.date, confidence: 'EXTRACTED' },
        eqStrict
      )
      deal.stage = deal.stage_provenance.value
    }
    if (x.deal.win_likelihood_band) {
      deal.win_likelihood_band_provenance = mergeProvenant(
        deal.win_likelihood_band_provenance,
        { value: x.deal.win_likelihood_band, source_file: ref.file, date: ref.date, quote: x.deal.band_evidence, confidence: 'EXTRACTED' },
        eqStrict
      )
      deal.win_likelihood_band = deal.win_likelihood_band_provenance.value
      deal.band_evidence = deal.win_likelihood_band_provenance.quote ?? ''
    }
    // 'no-hard-date-found' is the ABSENCE of information, not a competing fact: it never enters the
    // provenance merge at all. Merging it would let a bland report clobber a real calendar signal
    // (it can carry a newer date), and even just SEEDING provenance with it would leave a bland
    // "superseded" history entry only in the ingestion orders where it happened to arrive first —
    // breaking the order-independence guarantee. Deals whose meetings never surface a real signal
    // simply keep the bland default `velocity` with no provenance, exactly like a v1 file.
    if (x.deal.velocity.signal !== 'no-hard-date-found') {
      deal.velocity_provenance = mergeProvenant(
        deal.velocity_provenance,
        { value: x.deal.velocity, source_file: ref.file, date: ref.date, confidence: 'EXTRACTED' },
        eqVelocity
      )
      deal.velocity = deal.velocity_provenance.value
    }
    pushUnique(deal.meetings, ref, (m) => m.file)
    for (const sig of x.signals) pushUnique(deal.signals, { ...sig, meeting: ref.file }, (t) => t.meeting + t.statement)
    for (const ms of x.missed_signals) pushUnique(deal.missed_signals, { ...ms, meeting: ref.file }, (t) => t.meeting + t.statement)
    // Commitment Ledger: promises spoken in this meeting join the deal's ledger as open obligations.
    // Status stays 'open' until later evidence or a human marks it — the merge never guesses.
    for (const c of x.commitments) {
      pushUnique(
        deal.commitments,
        { ...c, meeting: ref.file, date: ref.date, status: 'open' as const },
        (t) => commitmentKey(t.text)
      )
    }
    for (const f of x.feedback) pushUnique(deal.feedback, { ...f, meeting: ref.file }, (t) => t.meeting + t.note)
    addNode(`deal:${dslug}`, 'deal', deal.name)
    addEdge(`deal:${dslug}`, meetingId, 'discussed-in', 'EXTRACTED')
    if (accountSlug) {
      addEdge(`deal:${dslug}`, `account:${accountSlug}`, 'belongs-to', x.account!.confidence)
      const acc = readAccount(s, accountSlug)
      if (acc) {
        pushUnique(acc.deals, deal.name, (n) => n)
        await writeAccount(s, accountSlug, acc)
      }
    }
    await writeDeal(s, dslug, deal)
  }

  await writeGraph(s, graph)
}

// ── Lint (Karpathy's "health check" pass — flag, never auto-fix) ─────────────

/** One lintBrainDetailed finding, entity-linked so a consumer (brain:attention, Task MI-3) can offer a
 *  jump action straight to the record page — `lintBrain`'s plain string[] (idx.warnings, unchanged since
 *  before MI-3) throws that linkage away, keeping only `detail`. */
export interface LintFinding {
  entityKind: 'person' | 'deal'
  id: string
  label: string
  detail: string
}

export function lintBrainDetailed(s: Settings): LintFinding[] {
  const findings: LintFinding[] = []
  for (const slug of listEntities(s, 'person')) {
    const p = readPerson(s, slug)
    if (!p) continue
    // A2 fix (D8): the old check derived "orgs" from the single p.account field mapped once per
    // stance_trail entry, so it could never produce more than one distinct value — it never fired.
    // org_provenance's current value + its full superseded history (see mergeExtraction's org merge)
    // is the actual per-meeting account association record; dedupe by SLUG (not raw text) since two
    // spellings of the same account name must not falsely count as "multiple accounts".
    const bySlug = new Map<string, string>() // account slug -> a display value seen for it
    const consider = (v: string | null | undefined): void => {
      if (v && !bySlug.has(slugify(v))) bySlug.set(slugify(v), v)
    }
    consider(p.org_provenance?.value)
    for (const prior of p.org_provenance?.superseded ?? []) consider(prior.value)
    if (bySlug.size > 1) {
      findings.push({
        entityKind: 'person',
        id: slug,
        label: p.name,
        detail: `Person "${p.name}" is linked to multiple accounts: ${[...bySlug.values()].join(', ')}`
      })
    }
  }
  for (const slug of listEntities(s, 'deal')) {
    const d = readDeal(s, slug)
    if (!d) continue
    if (d.outcome !== 'open' && d.win_likelihood_band) {
      findings.push({
        entityKind: 'deal',
        id: slug,
        label: d.name,
        detail: `Deal "${d.name}" is ${d.outcome} but still carries a live win-likelihood band`
      })
    }
  }
  return findings
}

/** Plain-string lint warnings (idx.warnings — the shape the dashboard and index.json have always used).
 *  A thin projection over lintBrainDetailed so there is exactly one implementation of the checks
 *  themselves; behavior/wording is unchanged from before Task MI-3. */
export function lintBrain(s: Settings): string[] {
  return lintBrainDetailed(s).map((f) => f.detail)
}

/**
 * Settle a commitment — the human closes the loop the LLM never may. Flips the matching row (by
 * normalized text) on the deal's ledger AND any person ledger holding the same promise, so the two
 * copies can't diverge. This is what makes the ledger a live count of what is actually owed, and
 * what makes a per-person kept-promise rate computable at all.
 */
export async function settleCommitment(
  s: Settings,
  dealSlug: string,
  text: string,
  status: 'open' | 'kept' | 'broken'
): Promise<{ ok: boolean; error?: string }> {
  const key = commitmentKey(text)
  const deal = readDeal(s, dealSlug)
  if (!deal) return { ok: false, error: 'Deal not found.' }
  const row = deal.commitments.find((c) => commitmentKey(c.text) === key)
  if (!row) return { ok: false, error: 'Commitment not found on this deal.' }
  row.status = status
  await writeDeal(s, dealSlug, deal)
  // Mirror onto the named person's own ledger when one holds the same promise.
  for (const pslug of listEntities(s, 'person')) {
    const person = readPerson(s, pslug)
    const match = person?.commitments?.find((c) => commitmentKey(c.text) === key)
    if (person && match) {
      match.status = status
      await writePerson(s, pslug, person)
    }
  }
  return { ok: true }
}

// ── Queue + backfill ─────────────────────────────────────────────────────────

type Job = { file: string; source: 'meetings'; origin: 'live' | 'backfill' }
const queue: Job[] = []

// The network-bound stage (extractMeeting, seconds-to-a-minute per call) is what a 100-meeting backfill
// was burning wall-clock time on serially, so up to EXTRACT_CONCURRENCY of those calls now run at once.
// The local-mutation stage (ingestExtraction, plus the error-path index write) stays on a single
// serialization lane — store.ts's withEntityLock (MI-2.5 Fix C) — so entity files (account/person/deal/
// graph, none of which have their own read-modify-write lock the way index.json has `indexLock` below)
// are never read-modify-written by two jobs (or a job and a human correction) at the same time.
// Concurrency lives entirely in "how many extractions can be in flight", not in "how many merges can run
// at once".
const EXTRACT_CONCURRENCY = 3
let backfillTotal = 0
let backfillDone = 0
// Jobs currently running extractMeeting — bounded to EXTRACT_CONCURRENCY. A job leaves this set the
// moment its extraction settles (success or failure), immediately freeing a slot for the next one,
// independent of how long that job's own serial ingest takes to reach the front of the withEntityLock lane.
const extracting = new Set<Job>()
// Every job that's been spliced out of `queue` but hasn't yet finished its FULL lifecycle (extracting,
// or sitting in/being processed by the withEntityLock lane). A superset of `extracting`. Replaces the old single
// `currentJob`: with concurrent extraction, more than one file can be "not in queue, not yet ingested"
// at a time, so startBackfill()'s in-flight dedup guard (a file being worked on right now must not get
// queued a second time by a re-click of "Index meetings") needs a set, not a single slot.
const inFlightJobs = new Set<Job>()
// Serializes ingestExtraction + the error-path index write, in the order each job's EXTRACTION finished
// (not the order jobs started) — see the EXTRACT_CONCURRENCY comment above for why this must stay serial.
// MI-2.5 Fix C: this lane is store.ts's shared `withEntityLock` (not a private variable here anymore) —
// corrections.ts's five human-correction mutations serialize through the exact same lane, so a rename/
// merge/field-pin/commitment-reject can never race an in-flight backfill's read-modify-write of the same
// entity file (the pre-fix gap: a correction running concurrently with a backfill job could lose an
// update or resurrect a tombstoned entity).

// index.json has several independent writers (each job's own success/failure record, the
// queue-drained cleanup, and startBackfill's `backfillRequested` flag) that all do a
// read-whole-file → mutate one field → write-whole-file-back round trip. Without serializing
// them, two overlapping round trips — e.g. a second startBackfill() call (re-clicking "Index
// meetings", or resumeBackfillIfPending firing) landing mid-run — silently drop whichever wrote
// last with the staler snapshot. Production symptom: every extraction kept succeeding, but
// idx.ingested ended up empty because a stale rewrite kept clobbering it. Every mutation of
// index.json now goes through this single serialized lane.
let indexLock: Promise<void> = Promise.resolve()
export function updateIndex(s: Settings, mutate: (idx: BrainIndex) => void): Promise<void> {
  const run = indexLock.then(async () => {
    const idx = readIndex(s)
    mutate(idx)
    await writeIndex(s, idx)
  })
  indexLock = run.catch(() => {})
  return run
}

export function brainBackfillProgress(): { total: number; done: number; running: boolean } {
  // "running" while anything is queued, extracting, or waiting on/undergoing its serial ingest —
  // inFlightJobs alone already covers both the extracting and the ingesting stage (see its declaration).
  return { total: backfillTotal, done: backfillDone, running: queue.length > 0 || inFlightJobs.size > 0 }
}

/** Reads the app-written meeting mode from the leading YAML frontmatter only. */
export function readMeetingSourceMode(md: string): string {
  const frontmatter = md.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!frontmatter) return ''

  const raw = frontmatter.match(/^mode:\s*(.*?)\s*$/m)?.[1]?.trim() ?? ''
  const quoted = raw.match(/^(['"])(.*)\1$/)
  const mode = (quoted ? quoted[2] : raw).trim()
  return mode.length <= 100 ? mode : ''
}

/**
 * The full post-extraction ingest: stamp provenance from the transcript's frontmatter (the model
 * can't know its own source file/date), persist the extraction, merge into entities/graph, mark the
 * ingest log, and refresh lint warnings. Exported so the end-to-end proof can drive fixtures through
 * the EXACT production path — the UI's headline "meetings ingested" stat reads the index this writes.
 */
export async function ingestExtraction(s: Settings, x: MeetingExtraction, md: string, file: string): Promise<void> {
  const key = basename(file)
  const sourceMode = readMeetingSourceMode(md)
  // Frontmatter dates aren't always bare tokens: hand-authored or vault-exported files commonly quote
  // the value (`date: "2024-01-15T10:00:00.000Z"`), and a naive \S+ match would keep the quote marks,
  // producing a value that fails Date.parse() downstream and later renders as an obviously broken
  // 'NaN days'. Strip optional wrapping quotes and validate before trusting either field; `start:`
  // (the meeting's actual start time) is tried when `date:` is missing or unparseable, then the file's
  // own mtime as a last resort, so a blank/garbage date never silently sorts as the oldest thing on
  // the Commitment Ledger.
  const readFrontmatterDate = (field: 'date' | 'start'): string | null => {
    const raw = md.match(new RegExp(`^${field}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm'))?.[1]
    return raw && !Number.isNaN(Date.parse(raw)) ? raw : null
  }
  let date = readFrontmatterDate('date') ?? readFrontmatterDate('start')
  if (!date) {
    try {
      date = statSync(file).mtime.toISOString()
    } catch {
      date = ''
    }
    mainLog.warn(`[brain] ${key}: no usable date/start frontmatter, falling back to ${date || 'an empty date'}`)
  }
  const ref: MeetingRef = { file: key, date, title: x.title24 || key }
  // Stamp provenance the model can't know (its own source file + meeting date) so consumers can join
  // extractions back to meetings (call-grade timelines, meeting feeds) without re-reading entity refs.
  x.source_file = key
  x.date = ref.date
  // These are trusted provenance stamps, never model-authored extraction fields.
  x.source_mode = sourceMode
  x.source_use = classifyMeetingSourceUse(sourceMode)
  // Correction-engine wiring: BOTH display rewrite (applyCorrections) and file routing
  // (mergeExtraction) share the SAME union alias map (readAliasMap — entity-file aliases ∪
  // journal-derived aliases: rename chains resolved transitively, merges mapped from → into).
  //
  // Before the MI-2 review fix, display rewrite used the entity-file map ALONE: during a rebuild's
  // re-ingest (which runs BEFORE replayCorrections), entity files carry no aliases yet, so nothing got
  // rewritten — matching the live path's OWN pre-correction ingests, which also had nothing to rewrite
  // at that point in real time. That equivalence broke the moment a POST-correction meeting reused an
  // old surface form (e.g. "Acme Corp" after a rename to "Acme"): live already had the alias by then
  // (applyCorrections caught it), but a rebuild's re-ingest didn't yet (replay hadn't run) — a
  // live-vs-rebuilt divergence in deal.account, person.account/org, etc.
  //
  // The fix has two halves that only converge TOGETHER:
  //   1. applyRename (corrections.ts) now retroactively rewrites every already-baked dependent display
  //      string (deal.account, person.account + org_provenance.value/superseded, account.people, graph
  //      node labels) the moment a rename runs — live AND replay, since it's the same function. A
  //      PRE-correction meeting's baked strings get fixed up right then, regardless of which path baked
  //      them first.
  //   2. Display rewrite here switches to the UNION map, so a POST-correction meeting's strings are
  //      correct from the moment of ingest even during a rebuild's re-ingest (before replay reaches the
  //      correction) — matching what the live path already had by the time that same meeting was
  //      originally ingested for real.
  // Together: pre-correction meetings are fixed up retroactively (by 1), post-correction meetings are
  // fixed up immediately (by 2) — so live and rebuilt ENTITY files converge regardless of ingest order.
  // The raw STORED meeting-extraction files under `.brain/meetings/` are a deliberate exception: they
  // are the as-extracted historical record and are never retroactively rewritten by applyRename's sweep
  // (only entity files are) — see the MI-2 review report for the convergence check on those files.
  //
  // Persisting the (possibly rewritten) extraction rather than the raw one keeps the stored meeting
  // file and the merged entities in agreement.
  const aliasMap = readAliasMap(s)
  applyCorrections(x, aliasMap)
  await writeMeetingExtraction(s, slugify(key), x)
  await mergeExtraction(s, x, ref, aliasMap)
  await updateIndex(s, (idx) => {
    idx.ingested[key] = { at: Date.now(), ok: true }
  })
}

/** The network-bound half of a job: read the transcript, run the (possibly-retried) LLM extraction.
 *  Never rejects — a failure is carried as data (`ok: false`) so the caller can run up to
 *  EXTRACT_CONCURRENCY of these concurrently with Promise machinery, not try/catch across awaits. */
type JobResult =
  | { job: Job; s: Settings; ok: true; x: MeetingExtraction; md: string }
  | { job: Job; s: Settings; ok: false; error: unknown }

async function runExtractionStage(job: Job): Promise<JobResult> {
  // One Settings snapshot per job, taken at the moment its extraction starts, reused for its ingest and
  // live-lint below — matches the pre-concurrency behavior of reading Settings once per job rather than
  // re-reading (and risking a mid-job change) between the extraction and ingest stages.
  const s = getSettings()
  try {
    const md = readSavedFile(job.file)
    const x = await extractMeeting(s, md, job.file)
    return { job, s, ok: true, x, md }
  } catch (error) {
    return { job, s, ok: false, error }
  }
}

/** The local-mutation half of a job: ingest (or record the error), then a live job's own immediate lint.
 *  `origin: 'live'` = a just-saved/just-debriefed meeting ingested one at a time (enqueueIngest) — its
 *  warnings must refresh right away. `origin: 'backfill'` = a job queued by startBackfill; linting is
 *  deferred to maybeFinishDrain() so a 100+ meeting backfill re-lints the whole brain ONCE, not once per
 *  meeting (lintBrain walks every person + deal entity file — O(entities) work per call). Always called
 *  through store.ts's withEntityLock (never directly) so two of these never run concurrently. */
async function finishJob(result: JobResult): Promise<void> {
  const { job, s } = result
  try {
    if (!result.ok) throw result.error
    await ingestExtraction(s, result.x, result.md, job.file)
    auditLog('brain.ingest', { ok: true, source: job.source })
  } catch (e) {
    await updateIndex(s, (idx) => {
      idx.ingested[basename(job.file)] = { at: Date.now(), ok: false, error: e instanceof Error ? e.message : String(e) }
    })
    auditLog('brain.ingest', { ok: false, source: job.source })
  }
  if (job.origin === 'live') {
    await updateIndex(s, (idx) => {
      idx.warnings = lintBrain(s)
    })
  }
  // Only a backfill-origin job advances the backfill progress counter — a live (just-saved meeting) job
  // finishing while a backfill happens to be running must never nudge someone else's progress bar (this
  // is also what makes backfillDone/backfillTotal meaningful to reset per-run in startBackfill: they only
  // ever move in lockstep with backfill-origin work). Bumped here, inside the withEntityLock lane, so it
  // advances in the same strictly-serial order as the ingest/error-record it belongs to.
  if (job.origin === 'backfill') backfillDone = Math.min(backfillTotal, backfillDone + 1)
}

// Set true while a backfill's jobs are still queued/extracting/ingesting; cleared (with its one lint
// pass) the first time everything drains after it — so a later plain live ingest, which also drains the
// queue, doesn't re-trigger the backfill's one-time cleanup.
let backfillLintPending = false

// Logged at most once per no-provider stall, not once per bailed job — a 60+ transcript backfill with
// no provider configured would otherwise spam this warning once per queued job.
let loggedNoProviderStall = false

// brain:rebuildAll needs to run replayCorrections() only once its purge-then-startBackfill re-extraction
// has FULLY drained — startBackfill() itself only synchronously queues work; completion happens later,
// across pump()'s async extraction/ingest chain. Callbacks registered here fire the next time the whole
// queue (not just this one caller's jobs — see registerDrainCallback's doc comment) goes idle.
const pendingDrainCallbacks: Array<() => void | Promise<void>> = []

/** Registers `cb` to run the next time the queue is fully idle, firing immediately (still async, via
 *  the idle check below) if it already is. `startBackfill`'s only caller today (brain:rebuildAll) always
 *  pushes its own candidates onto `queue` before calling this, so "queue idle" can never mean "before my
 *  jobs were even queued" — by construction the check only ever fires once THIS batch (and anything
 *  else in flight) has actually finished. */
function registerDrainCallback(cb?: () => void | Promise<void>): void {
  if (!cb) return
  pendingDrainCallbacks.push(cb)
  maybeFinishDrain()
}

/** Runs after every state change (a job dequeued, an extraction settled, an ingest completed) to check
 *  for a TRUE drain: queue empty AND nothing extracting AND nothing waiting on/undergoing ingest AND the
 *  whole backfill batch has been accounted for. A stall (jobs stuck in `queue` because no provider is
 *  configured) must never trip this — inFlightJobs and queue both being empty is what makes it "true". */
function maybeFinishDrain(): void {
  if (queue.length === 0 && inFlightJobs.size === 0) {
    if (backfillLintPending && backfillTotal > 0 && backfillDone >= backfillTotal) {
      backfillLintPending = false
      const sx = getSettings()
      void updateIndex(sx, (i) => {
        i.backfillRequested = false
        i.warnings = lintBrain(sx)
      })
    }
    if (pendingDrainCallbacks.length > 0) {
      const cbs = pendingDrainCallbacks.splice(0, pendingDrainCallbacks.length)
      for (const cb of cbs) {
        try {
          void Promise.resolve(cb()).catch((e) => mainLog.error('[brain] onDrained callback failed:', e))
        } catch (e) {
          mainLog.error('[brain] onDrained callback threw:', e)
        }
      }
    }
  }
}

function pump(): void {
  // Keep starting extractions until EXTRACT_CONCURRENCY are in flight or nothing left qualifies. Each
  // iteration re-finds the first job pump() can actually act on: a live job always qualifies, a backfill
  // job only qualifies while a provider is configured. A provider can be removed (cleared key, CLI
  // disconnected) after startBackfill() already queued jobs — re-checking here, not just at queue time,
  // stops a mid-backfill provider loss from burning every remaining job on a guaranteed "No configured AI
  // provider" failure (each with its one reinforcement retry, i.e. 2 doomed calls per job). Backfill jobs
  // stay AT THE FRONT of the queue (never removed here) so a live job enqueued behind a stalled backfill
  // still gets picked and processed — the stall must never starve normal per-meeting ingests.
  while (extracting.size < EXTRACT_CONCURRENCY) {
    let s: Settings | null = null
    const idx = queue.findIndex((j) => {
      if (j.origin !== 'backfill') return true
      s ??= getSettings()
      return hasUsableProvider(s)
    })
    if (idx === -1) {
      // Every queued job is a backfill job and no provider is configured — nothing to do right now.
      if (queue.length > 0 && !loggedNoProviderStall) {
        loggedNoProviderStall = true
        mainLog.warn('[brain] backfill paused: no configured AI provider — will resume next time one is available')
      }
      break
    }
    loggedNoProviderStall = false
    const [job] = queue.splice(idx, 1)
    extracting.add(job)
    inFlightJobs.add(job)
    void runExtractionStage(job).then((result) => {
      extracting.delete(job)
      pump() // a slot just freed — start the next eligible extraction now, without waiting on this job's ingest
      void withEntityLock(() => finishJob(result))
        // Defensive: finishJob catches its own extraction/ingest errors internally and should never
        // reject, but if it somehow did, letting the rejection propagate unhandled would permanently wedge
        // the lane — every later caller's `.then()` chained onto a rejected promise skips straight to
        // re-rejecting, so no further job would ever ingest. Swallowing it here (like indexLock does
        // above) keeps the lane alive for the next job — withEntityLock itself also guards against this,
        // this is belt-and-suspenders.
        .catch((e) => mainLog.error('[brain] unexpected error finishing a brain ingest job:', e))
        .finally(() => {
          inFlightJobs.delete(job)
          pump() // this job's ingest just completed — re-check for a drain, and for newly-eligible backfill work
        })
    })
  }
  maybeFinishDrain()
}

/** Enqueue one just-saved meeting (fire-and-forget; called after saveMeeting completes). */
export function enqueueIngest(file: string): void {
  queue.push({ file, source: 'meetings', origin: 'live' })
  pump()
}

// MI-2.5 review Fix 2: a stable prefix for the human-visible warning finishRebuildReplay pushes into
// idx.warnings when a rebuild's replay could not run — surfaced by BrainView's "Needs a human read" list.
// A dedicated prefix lets a later successful replay find and remove exactly its own warning.
const REPLAY_FAILED_WARNING_PREFIX = 'Rebuild could not re-apply your saved corrections: '

/**
 * Runs the journal replay a rebuild depends on, then clears the `replayPending` flag that survives a
 * quit/crash mid-rebuild (MI-2.5 Fix E) — shared by brain:rebuildAll's own onDrained callback (index.ts)
 * and resumeBackfillIfPending below, so a replay interrupted by a quit still completes exactly the same
 * way a same-session rebuild would. replayCorrections is idempotent (Fix D), so re-running it here even
 * when it partially ran before the crash converges to the same fully-corrected state.
 *
 * MI-2.5 review Fix 2: when the replay could not run (a corrupt/blocked journal, or an exception),
 * `replayPending` is DELIBERATELY left set — a rebuild that replayed zero corrections must never look
 * finished. The reason is recorded durably (`idx.replayError`) and surfaced to the user (a warning in
 * the "Needs a human read" list). A later clean replay clears both. A brand-new AttentionItem kind was
 * intentionally NOT added: the renderer's exhaustive `Record<AttentionItem['kind'], number>` (a file this
 * task must not touch) would fail typecheck — the warnings list is the existing, renderer-safe surface.
 */
export async function finishRebuildReplay(s: Settings): Promise<void> {
  const r = await replayCorrections(s)
  if (r.error) {
    mainLog.error(`[brain] rebuild replay could not run: ${r.error}`)
    await updateIndex(s, (i) => {
      i.replayError = r.error
      // Leave replayPending TRUE — do not report a rebuild that replayed nothing as finished.
      if (!i.warnings.some((w) => w.startsWith(REPLAY_FAILED_WARNING_PREFIX))) {
        i.warnings = [...i.warnings, `${REPLAY_FAILED_WARNING_PREFIX}${r.error}`]
      }
    })
    return
  }
  await updateIndex(s, (i) => {
    i.replayPending = false
    i.replayError = undefined
    i.warnings = i.warnings.filter((w) => !w.startsWith(REPLAY_FAILED_WARNING_PREFIX))
  })
}

/**
 * The full brain:rebuildAll orchestration, extracted here (out of the IPC handler) so it is unit-testable
 * and so index.ts stays thin. Wipes the DERIVED store and re-extracts everything, then replays the
 * correction journal onto the fresh entities. Refuses up front — WITHOUT purging — when:
 *   - the correction journal is corrupt/blocked (MI-2.5 review Fix 2): replaying nothing onto a freshly
 *     wiped store while reporting success is exactly the silent-revert this guards against; and
 *   - the purge itself cannot fully reset the store (MI-2.5 Fix F): proceeding over a half-wiped store
 *     would re-ingest atop stale data.
 * Both return a typed `error` (queued: 0) the handler surfaces to the renderer.
 */
export async function startRebuild(s: Settings): Promise<{ queued: number; error?: string }> {
  // Fix 2 (sync guard): a corrupt/blocked journal fails the gate — refuse before touching the store.
  const gate = await readCorrectionsJournalSafe(s)
  if (!gate.ok) return { queued: 0, error: gate.error }
  // Fix F: preserveCorrections copies the journal to escrow and restores it even if the wipe fails —
  // check the result and abort (nothing re-extracted, corrections safe) rather than rebuild atop a
  // half-deleted store.
  const purge = purgeBrain(s, { preserveCorrections: true })
  if (!purge.ok) {
    return {
      queued: 0,
      error:
        'Could not fully reset the brain store before rebuilding — nothing was re-extracted, and your corrections are safe. Try again, or check for files OneDrive/antivirus may be holding open.'
    }
  }
  // Fix E: replayPending survives a crash independently of backfillRequested; clear any stale replayError.
  await updateIndex(s, (i) => {
    i.replayPending = true
    i.replayError = undefined
  })
  const r = startBackfill(() => finishRebuildReplay(s))
  return { queued: r.queued }
}

/**
 * Resume an interrupted backfill on app boot: the request flag persists in index.json until the queue
 * fully drains, so a quit/relaunch mid-backfill picks up the remaining transcripts automatically.
 * Never starts spontaneously — only when a backfill was explicitly requested and left unfinished.
 *
 * MI-2.5 Fix E: also resumes an interrupted brain:rebuildAll's journal replay. `replayPending` survives
 * independently of `backfillRequested` — the re-extraction backfill portion of a rebuild can finish (and
 * clear backfillRequested) BEFORE a crash interrupts the replay step itself, so checking backfillRequested
 * alone would miss that window entirely.
 */
export function resumeBackfillIfPending(): void {
  try {
    const s = getSettings()
    const idx = readIndex(s)
    if (idx.backfillRequested) {
      const onDrained = idx.replayPending ? () => finishRebuildReplay(s) : undefined
      const r = startBackfill(onDrained)
      if (r.queued > 0) mainLog.info(`[brain] resuming interrupted backfill: ${r.queued} transcripts remaining`)
    } else if (idx.replayPending) {
      // The backfill portion of an interrupted rebuild already finished (or never had any work) before
      // the crash, but the journal replay step itself never completed — nothing left to queue, just run
      // the replay now.
      void finishRebuildReplay(s)
    }
  } catch {
    /* brain store unreadable — a manual backfill will surface the real error */
  }
}

/** Queue every not-yet-ingested transcript from the meetings folder + the vault. Resumable via index.
 *  Safe to call again while a backfill is already running (re-clicking "Index meetings",
 *  resumeBackfillIfPending firing mid-session) — it tops up the queue instead of resetting progress,
 *  and skips files already queued or completed so nothing is double-processed.
 *
 *  `onDrained` (Task MI-2, brain:rebuildAll only): fires once every job this call queues — plus
 *  anything else already in flight — has fully finished (see registerDrainCallback's doc comment).
 *  Every other caller (the plain "Index meetings" button, resumeBackfillIfPending) omits it. */
export function startBackfill(onDrained?: () => void | Promise<void>): { queued: number } {
  const s = getSettings()
  const idx = readIndex(s)
  if (!idx.backfillRequested) void updateIndex(s, (i) => { i.backfillRequested = true })
  // No provider configured: skip the directory scan + queueing entirely rather than queueing 60+ jobs
  // that pump() would just re-queue one at a time anyway (see its own no-provider guard above). Cheaper,
  // and the log stays a single line instead of one per bailed job. backfillRequested is left true (set
  // just above) so resumeBackfillIfPending tries again on a later boot once a provider is configured.
  if (!hasUsableProvider(s)) {
    mainLog.warn('[brain] backfill requested but no configured AI provider — deferring until one is set up')
    registerDrainCallback(onDrained) // nothing will ever run — fire (once truly idle) rather than hang
    return { queued: 0 }
  }
  const already = new Set(Object.entries(idx.ingested).filter(([, v]) => v.ok).map(([k]) => k))
  // The ingest log is a cache of "already extracted", not the source of truth — if it's ever out of
  // sync with reality (the race above, a manual edit, a version before this log existed), a real
  // extraction file already on disk still means the work is done. Checking both means a lost/stale
  // log costs a status-count fib, never a re-burned Dust call re-processing finished meetings.
  const extractedSlugs = new Set(listMeetingExtractions(s))
  // pump() has already spliced any currently-extracting-or-ingesting job out of `queue` by the time it's
  // mid-flight — omitting those here would let a re-click of "Index meetings" queue the exact same file
  // a second time while it's still being extracted (or is sitting in the withEntityLock lane). inFlightJobs covers
  // both a backfill job and a live job (a live job can never collide with a backfill candidate by
  // content, but checking it unconditionally is simpler than branching on origin and costs nothing).
  const inFlight = new Set(queue.map((j) => basename(j.file)))
  for (const j of inFlightJobs) inFlight.add(basename(j.file))
  // A fresh run: no backfill-origin work left queued or in flight from a previous batch. Reset the
  // progress counters here rather than accumulate onto a finished run's stale total/done — otherwise a
  // live meeting save processed after backfill #1 finished (which left backfillTotal > 0 behind) would
  // still pass the old `if (backfillTotal > 0)` check and corrupt backfill #2's freshly-started progress
  // readout with counts left over from a completed, unrelated run.
  const backfillInFlight =
    queue.some((j) => j.origin === 'backfill') || [...inFlightJobs].some((j) => j.origin === 'backfill')
  if (!backfillInFlight) {
    backfillTotal = 0
    backfillDone = 0
  }
  const candidates: Job[] = []
  const folder = resolveMeetingsFolder(s)
  for (const f of existsSync(folder) ? readdirSync(folder) : []) {
    if (
      f.endsWith('.md') &&
      !f.startsWith('.') &&
      f !== 'index.md' &&
      !already.has(f) &&
      !inFlight.has(f) &&
      !extractedSlugs.has(slugify(f))
    ) {
      candidates.push({ file: join(folder, f), source: 'meetings', origin: 'backfill' })
    }
  }
  // Accumulate rather than overwrite: a re-entrant call must extend an in-flight backfill's progress
  // tracking, not reset it out from under the jobs already queued.
  if (candidates.length > 0) backfillLintPending = true
  backfillTotal += candidates.length
  queue.push(...candidates)
  pump()
  registerDrainCallback(onDrained)
  return { queued: candidates.length }
}
